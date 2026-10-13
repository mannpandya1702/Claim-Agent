// deno task voice <scenario> [--assistant solo-web|solo-core|concierge] [--squad]
//
// A real voice call with a synthetic caller, for testing what text chats cannot show: native tool
// messages spoken exactly once, ASR of digits and dates, endpointing, fillers, barge-in, the real
// end-of-call report. It places a VAPI call over the raw WebSocket transport (16 kHz s16le PCM),
// streams silence in real time, and speaks the next scripted caller line once the assistant has
// been quiet for a moment, so turn-taking follows the assistant instead of a fixed timeline.
//
// A line written "!<seconds> <text>" is a barge-in: it is spoken that many seconds after the
// assistant starts its next turn, at a moment it is audibly talking, over whatever it is saying.
// For each one the run prints how long the assistant kept producing audio after the caller started
// talking, measured from the assistant audio's RMS inside the caller's own speech window (her real
// reply cannot start before the caller finishes), and PASS or FAIL against BARGE_IN_LIMIT_S. It
// prints INVALID instead when the assistant was quiet just before the caller started, because then
// nothing was interrupted.
//
// Caller lines are synthesized with Google TTS (scripts/voice_tts.py). Both sides are recorded to
// fixtures/raw/voice/<call id>/ (gitignored): assistant.wav, caller.wav and the call artifact. The
// caller is paced by the clock (one 20 ms frame per 20 ms elapsed) and caller.wav starts at the
// assistant's first audio, so the two recordings share one timeline and can be overlaid.
// The scenario's numbers are the fictional 555 seed numbers; every call costs normal VAPI usage.

import { loadEnv, need } from "./lib/env.ts";
import { readState } from "./lib/state.ts";
import { vapiClient } from "./lib/vapi.ts";

export const SCENARIOS: Record<string, string[]> = {
  happy: [
    "Hi, I'm calling to check on my claim.",
    "It's six zero two, five five five, zero one zero one.",
    "March fourteenth, nineteen eighty six.",
    "What is the status of my claims?",
    "No, that's everything. Thank you, goodbye.",
  ],
  "auth-failure": [
    "Hi, I need to check on my claim. My number is six zero two, five five five, zero one zero one.",
    "June second, nineteen eighty four.",
    "Sorry, June third, nineteen eighty four.",
    "Okay, yes please, have someone call me back.",
    "No, that's all. Goodbye.",
  ],
  "not-found": [
    "Hi, I want to check my claim status. My number is six zero two, five five five, zero one nine nine.",
    "Yes, that's right.",
    "Okay, no thanks. Goodbye.",
  ],
  escalation: [
    "Hi, this is about my auto claim. My number is six zero two, five five five, zero one zero two.",
    "November second, nineteen seventy nine.",
    "I'd like to talk to a real person, please.",
    "No, that's all. Goodbye.",
  ],
  emergency: [
    "Hi, there's a fire in my kitchen right now.",
    "Yes, I'm outside now, I'm safe.",
    "No, that's all. Goodbye.",
  ],
  // Not found twice, then Ava takes a new caller's details: a spoken name, a spelled email (ASR of
  // letters, endpointing while spelling), the read-back, the confirmation and the emailed steps.
  // The address is on example.com, so no real inbox can ever receive the steps.
  "new-customer": [
    "Hi, I'm new and I'd like to know how to start a claim. My number is six zero two, five five five, zero one nine nine.",
    "Yes, that's right.",
    "It's John Smith.",
    "j o h n dot s m i t h at example dot com",
    "You can reach me at six zero two, five five five, zero one seven seven.",
    "Yes, that's right.",
    "Please email me the steps.",
    "No, that's all. Thank you, goodbye.",
  ],
  // Voice FNOL for a verified customer: intent first, verify with intent file_claim, the loss and its
  // day in one answer, the server's read-back (claim type inferred, the date spoken in full), the
  // yes, and the claim number read back with the confirmation email to the address on file.
  "fnol-verified": [
    "Hi, I need to file a claim. Someone backed into my car in a parking lot.",
    "It's six zero two, five five five, zero one zero one.",
    "March fourteenth, nineteen eighty six.",
    "It was parked at the grocery store yesterday afternoon. Someone dented the rear bumper and drove off.",
    "Yes, that's correct.",
    "No, that's all. Thank you, goodbye.",
  ],
  // A correction on the read-back: the no goes to confirm_claim(false), the fix to a second
  // start_claim with every detail, and only the corrected read-back's yes files the claim.
  "fnol-correction": [
    "Hi, I need to file a claim. My number is six zero two, five five five, zero one zero one.",
    "March fourteenth, nineteen eighty six.",
    "A pipe burst under my kitchen sink on Sunday and flooded the floor.",
    "No, that's not right.",
    "It happened on Friday, not Sunday.",
    "Yes, that's right.",
    "No, that's all. Thank you, goodbye.",
  ],
  // Voice FNOL for a new caller: not found twice, details captured and confirmed, then the loss taken
  // down for a specialist (a lead intake: no claim number) with a confirmation to the confirmed email.
  "fnol-new-caller": [
    "Hi, I'd like to report a claim. My number is six zero two, five five five, zero one nine nine.",
    "Yes, that's right.",
    "It's John Smith.",
    "j o h n dot s m i t h at example dot com",
    "You can reach me at six zero two, five five five, zero one seven seven.",
    "Yes, that's right.",
    "Let's do it now. My basement flooded yesterday after a pipe burst.",
    "Yes, that's correct.",
    "No, that's all. Thank you, goodbye.",
  ],
  // Barge-in: Tobias asks about his claims, so the answer to his date of birth reads them. That turn
  // opens with the verify filler, a silent tool gap and the verified sentence (about 2 s in on
  // recorded calls); 9 s in he is well past them and inside the claims read, long or summarized. He
  // talks over Ava; she should stop within BARGE_IN_LIMIT_S, then answer what he asked.
  "barge-in": [
    "Hi, I'm calling to check on my claims.",
    "It's six zero two, five five five, zero one zero one.",
    "March fourteenth, nineteen eighty six.",
    "!9 Sorry, wait, just the home claim please.",
    "Okay, thank you. That's everything, goodbye.",
  ],
  // The control for barge-in: the same interruption during a turn the model speaks itself (an answer
  // in its own words), to tell VAPI's handling of model speech from its handling of tool messages.
  "barge-in-model": [
    "Hi, can you walk me through how the claims process works, step by step?",
    "!4 Sorry, wait, how long does a review usually take?",
    "Okay, thanks. That's all, goodbye.",
  ],
};

export const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS / 1000) * 2;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Assistant silence that ends its turn (fillers and tool gaps are shorter). */
export const QUIET_MS = 2600;
export const SPEECH_RMS = 500; // s16 RMS above this counts as speech
const MAX_CALL_MS = 360_000; // the longest scenario (fnol-new-caller) runs about four minutes
/** A barge-in passes when the assistant stops within this long after the caller starts talking. */
export const BARGE_IN_LIMIT_S = 1.5;
/** The assistant counts as audibly speaking while its last speech audio is this recent. */
export const SPEAKING_MS = 200;
/** A barge-in only tests something when the assistant's audio carried speech in this long before
 *  the caller's onset; otherwise the verdict is INVALID. */
export const PRIOR_SPEECH_MS = 300;
/** The measurement window runs from the caller's onset to this long after the caller's last speech:
 *  the assistant's real reply needs endpointing and a model turn first, so it never falls inside. */
export const CALLER_GRACE_MS = 500;
/** Assistant speech in this last part of the window: still talking when the caller finished. */
export const STILL_TALKING_MS = 200;
/** With no following caller line, user-interrupted events are looked for this long after the onset. */
export const INTERRUPT_LOOKUP_MS = 5000;

export interface CallerLine {
  text: string;
  /** Seconds after the assistant starts its next turn; null: after it goes quiet. */
  bargeInSeconds: number | null;
}

/** "!2.5 Sorry, wait" -> a barge-in 2.5 s into the assistant's turn; any other line is spoken once
 *  the assistant has gone quiet. A "!" line that does not parse throws, so a typo in a scenario
 *  fails before a call is placed. */
export function parseCallerLine(raw: string): CallerLine {
  const line = raw.trim();
  if (!line.startsWith("!")) return { text: line, bargeInSeconds: null };
  const m = /^!(\d+(?:\.\d+)?)\s+(\S.*)$/.exec(line);
  const seconds = m ? Number(m[1]) : NaN;
  if (!m || !(seconds > 0 && seconds <= 30)) {
    throw new Error(`caller line ${JSON.stringify(raw)}: write a barge-in as "!<seconds> <text>", 0 < seconds <= 30`);
  }
  return { text: m[2].trim(), bargeInSeconds: seconds };
}

/** RMS of s16le PCM. */
export function rms(buf: Uint8Array): number {
  const v = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  let s = 0;
  for (const x of v) s += x * x;
  return v.length ? Math.sqrt(s / v.length) : 0;
}

/** Milliseconds of lead-in before the first 20 ms frame of speech in a PCM clip (TTS clips start
 *  with a little silence); null when the clip has no speech at all. */
export function speechOnsetMs(pcm: Uint8Array, threshold = SPEECH_RMS): number | null {
  for (let at = 0; at + 2 <= pcm.byteLength; at += FRAME_BYTES) {
    if (rms(pcm.subarray(at, at + FRAME_BYTES)) > threshold) return (at / BYTES_PER_SECOND) * 1000;
  }
  return null;
}

/** Milliseconds from the start of a PCM clip to the end of its last 20 ms frame of speech (scanning
 *  back from the end); null when the clip has no speech at all. */
export function speechEndMs(pcm: Uint8Array, threshold = SPEECH_RMS): number | null {
  for (let i = Math.ceil(pcm.byteLength / FRAME_BYTES) - 1; i >= 0; i--) {
    const at = i * FRAME_BYTES;
    const frame = pcm.subarray(at, Math.min(at + FRAME_BYTES, pcm.byteLength));
    if (rms(frame) > threshold) return ((at + frame.byteLength) / BYTES_PER_SECOND) * 1000;
  }
  return null;
}

const msToBytes = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE) * 2;

/** The caller's speech onset as a byte position in the assistant's audio: the assistant bytes
 *  received when the line was queued plus the clip's lead-in, aligned to a sample. */
export function onsetByte(assistantBytes: number, leadMs: number): number {
  return assistantBytes + msToBytes(leadMs);
}

export interface BargeInMeasure {
  /** The assistant's audio carried speech in the PRIOR_SPEECH_MS before the caller started. */
  wasSpeaking: boolean;
  /** Seconds from the caller's onset to the end of the assistant's last speech frame inside the
   *  window (onset to the caller's last speech plus CALLER_GRACE_MS); 0 when it said nothing there. */
  keptSeconds: number;
  /** It was still speaking in the last STILL_TALKING_MS of that window (or of the recording). */
  stillTalking: boolean;
}

/** How the assistant's audio behaved while the caller talked over it. The window is the caller's
 *  own speech (callerSpeechMs from the onset at startByte) plus CALLER_GRACE_MS, so a pause inside
 *  the assistant's turn cannot end the measurement early and its real reply, which comes only after
 *  the caller finishes and is endpointed, is never counted. Speech that starts after the onset
 *  counts too: an assistant that begins a new sentence over the caller has not stopped. */
export function measureBargeIn(
  pcm: Uint8Array,
  startByte: number,
  callerSpeechMs: number,
  opts: { threshold?: number } = {},
): BargeInMeasure {
  const threshold = opts.threshold ?? SPEECH_RMS;
  const start = Math.max(0, startByte - (startByte % 2));
  const speechIn = (from: number, to: number) => {
    for (let at = from; at < to; at += FRAME_BYTES) {
      if (rms(pcm.subarray(at, Math.min(at + FRAME_BYTES, to))) > threshold) return true;
    }
    return false;
  };
  const wasSpeaking = speechIn(Math.max(0, start - msToBytes(PRIOR_SPEECH_MS)), Math.min(start, pcm.byteLength));
  const end = Math.min(pcm.byteLength, start + msToBytes(Math.max(0, callerSpeechMs) + CALLER_GRACE_MS));
  let lastSpeechEnd = start;
  for (let at = start; at < end; at += FRAME_BYTES) {
    const to = Math.min(at + FRAME_BYTES, end);
    if (rms(pcm.subarray(at, to)) > threshold) lastSpeechEnd = to;
  }
  return {
    wasSpeaking,
    keptSeconds: (lastSpeechEnd - start) / BYTES_PER_SECOND,
    stillTalking: end > start && lastSpeechEnd > end - msToBytes(STILL_TALKING_MS),
  };
}

export type BargeInResult = "PASS" | "FAIL" | "INVALID";

/** INVALID when the assistant was quiet as the caller started (nothing was interrupted); FAIL when
 *  it was still talking as the caller finished or kept on past the limit; PASS otherwise. */
export function bargeInVerdict(m: BargeInMeasure, limit = BARGE_IN_LIMIT_S): BargeInResult {
  if (!m.wasSpeaking) return "INVALID";
  if (m.stillTalking) return "FAIL";
  return m.keptSeconds <= limit ? "PASS" : "FAIL";
}

/** The verdict as the report prints it. */
export function describeBargeIn(m: BargeInMeasure, limit = BARGE_IN_LIMIT_S): string {
  const verdict = bargeInVerdict(m, limit);
  if (verdict === "INVALID") return "INVALID: assistant was quiet when the caller started";
  if (m.stillTalking) {
    return `still talking when the caller finished (${
      m.keptSeconds.toFixed(2)
    } s after the caller started) -> FAIL (limit ${limit} s)`;
  }
  return `kept talking ${m.keptSeconds.toFixed(2)} s after the caller started -> ${verdict} (limit ${limit} s)`;
}

export interface CallEvent {
  t: number; // ms from the start of the run
  type?: string;
}

/** The first user-interrupted event for a barge-in: at or after the caller's onset and before the
 *  next caller line was queued (or INTERRUPT_LOOKUP_MS after the onset when there was none), so an
 *  interruption in a later turn is never credited to this one. */
export function interruptionFor(
  events: CallEvent[],
  b: { atMs: number; nextLineAtMs: number | null },
): CallEvent | undefined {
  const bound = b.nextLineAtMs ?? b.atMs + INTERRUPT_LOOKUP_MS;
  return events.find((e) => e.type === "user-interrupted" && e.t >= b.atMs && e.t < bound);
}

/** Turn-taking state, from the assistant's audio; times are performance.now() milliseconds. */
export interface TurnState {
  /** When the assistant's audio last carried speech. */
  lastSpeechAt: number;
  /** The assistant has spoken since the caller's last line was queued and finished. */
  heardSpeech: boolean;
  /** Its first such speech: the start of its turn; null until then. */
  turnStartAt: number | null;
}

export const FIRST_TURN: TurnState = { lastSpeechAt: 0, heardSpeech: false, turnStartAt: null };

/** One chunk of assistant audio. Speech while caller audio is still going out (the assistant talking
 *  over the caller, or not yet stopped after a barge-in) is not the start of a new turn. */
export function onTurnAudio(s: TurnState, now: number, isSpeech: boolean, callerTalking: boolean): TurnState {
  if (!isSpeech) return s;
  if (callerTalking) return { ...s, lastSpeechAt: now };
  return { lastSpeechAt: now, heardSpeech: true, turnStartAt: s.turnStartAt ?? now };
}

/** A caller line was queued: the assistant's next turn starts with its next speech after it. */
export function onLineQueued(s: TurnState): TurnState {
  return { ...s, heardSpeech: false, turnStartAt: null };
}

/** Whether the next caller line should be queued now. A plain line goes once the assistant has
 *  spoken and then been quiet for QUIET_MS. A barge-in goes bargeInSeconds after the assistant's
 *  turn starts, and only while it is audibly speaking, so a silent gap (a tool running) is never
 *  "interrupted"; if the turn ends first (quiet for QUIET_MS), it goes anyway so the call carries on,
 *  and the report marks it INVALID. Nothing is queued while caller audio is still going out. */
export function lineDue(
  next: CallerLine | undefined,
  s: TurnState & { callerTalking: boolean },
  now: number,
): boolean {
  if (!next || s.callerTalking) return false;
  const quietFor = now - s.lastSpeechAt;
  if (next.bargeInSeconds === null) return s.heardSpeech && quietFor > QUIET_MS;
  if (s.turnStartAt === null || now - s.turnStartAt < next.bargeInSeconds * 1000) return false;
  return quietFor < SPEAKING_MS || quietFor > QUIET_MS;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) out.set(c, o), (o += c.byteLength);
  return out;
}

function wav(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(44 + len);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"), dv.setUint32(4, 36 + len, true), w(8, "WAVE"), w(12, "fmt ");
  dv.setUint32(16, 16, true), dv.setUint16(20, 1, true), dv.setUint16(22, 1, true);
  dv.setUint32(24, SAMPLE_RATE, true), dv.setUint32(28, SAMPLE_RATE * 2, true);
  dv.setUint16(32, 2, true), dv.setUint16(34, 16, true), w(36, "data"), dv.setUint32(40, len, true);
  let o = 44;
  for (const c of chunks) out.set(c, o), (o += c.byteLength);
  return out;
}

interface BargeIn {
  text: string;
  atMs: number; // the caller's speech onset, ms from the start of the run (the clock of events[].t)
  intoTurnMs: number; // how far into the assistant's turn it was
  startByte: number; // the caller's speech onset, as a position in the assistant's audio
  speechMs: number; // the caller's speech, onset to the end of its last speech frame
  nextLineAtMs: number | null; // when the following caller line was queued, on the clock of atMs
}

async function main() {
  const args = Deno.args;
  const scenario = args.find((a) => !a.startsWith("--")) ?? "happy";
  if (!SCENARIOS[scenario]) {
    console.error(`unknown scenario ${scenario}; one of: ${Object.keys(SCENARIOS).join(", ")}`);
    Deno.exit(2);
  }
  const lines = SCENARIOS[scenario].map(parseCallerLine);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const env = loadEnv();
  need(env, "VAPI_PRIVATE_KEY");
  const state = readState();
  const target = args.includes("--squad")
    ? { squadId: state.squadId }
    : { assistantId: state.assistants?.[flag("assistant") ?? "solo-web"] };
  if (!target.squadId && !target.assistantId) {
    console.error("no assistant/squad id in .sync-state.json; run deno task sync:apply first");
    Deno.exit(2);
  }

  // 1. synthesize the caller lines
  const ttsDir = new URL(`../fixtures/raw/voice/tts/${scenario}/`, import.meta.url).pathname;
  const tts = new Deno.Command("python3", {
    args: ["-I", new URL("./voice_tts.py", import.meta.url).pathname, ttsDir, ...lines.map((l) => l.text)],
    env: { REQUESTS_CA_BUNDLE: env.REQUESTS_CA_BUNDLE ?? "/root/.ccr/ca-bundle.crt" },
  });
  const ttsOut = await tts.output();
  if (!ttsOut.success) {
    console.error(new TextDecoder().decode(ttsOut.stderr));
    Deno.exit(1);
  }
  const pcm = new TextDecoder().decode(ttsOut.stdout).trim().split("\n").map((p) => Deno.readFileSync(p));

  // 2. create the call over the WebSocket transport
  const vapi = vapiClient(env);
  const call = await vapi.post("/call", {
    ...target,
    name: `INTERNAL voice test ${scenario}`,
    transport: {
      provider: "vapi.websocket",
      audioFormat: { format: "pcm_s16le", container: "raw", sampleRate: SAMPLE_RATE },
    },
  });
  const wsUrl: string | undefined = call?.transport?.websocketCallUrl;
  if (!wsUrl) {
    console.error("no websocketCallUrl in the call response:", JSON.stringify(call).slice(0, 400));
    Deno.exit(1);
  }
  console.log(`call ${call.id} (${scenario}, ${lines.length} caller lines)`);

  const outDir = new URL(`../fixtures/raw/voice/${call.id}/`, import.meta.url).pathname;
  Deno.mkdirSync(outDir, { recursive: true });
  const assistantAudio: Uint8Array[] = [];
  const callerAudio: Uint8Array[] = [];
  const events: CallEvent[] = [];
  const bargeIns: BargeIn[] = [];

  // 3. drive the conversation
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  let turn = FIRST_TURN;
  let assistantBytes = 0;
  let closed = false;
  let queue: Uint8Array | null = null as Uint8Array | null; // caller audio still to send
  let queueAt = 0;
  let lineIdx = 0;
  const t0 = performance.now();
  let tSend0 = t0; // the socket opened: caller frame n covers [tSend0 + 20n, tSend0 + 20(n + 1)) ms
  let framesSent = 0;
  let callerWavFrom: number | null = null; // the caller frame playing when the assistant's audio began
  const silence = new Uint8Array(FRAME_BYTES);

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const m = JSON.parse(ev.data);
        events.push({ t: Math.round(performance.now() - t0), ...m });
        if (m.type === "transcript" && m.transcriptType === "final") console.log(`  [${m.role}] ${m.transcript}`);
      } catch { /* non-JSON control text */ }
      return;
    }
    const buf = new Uint8Array(ev.data as ArrayBuffer);
    const now = performance.now();
    // assistant.wav starts here, so caller.wav is written from the caller frame playing now
    callerWavFrom ??= Math.max(0, Math.floor((now - tSend0) / FRAME_MS));
    assistantAudio.push(buf);
    assistantBytes += buf.byteLength;
    turn = onTurnAudio(turn, now, rms(buf) > SPEECH_RMS, queue !== null);
  };
  ws.onclose = () => (closed = true);
  ws.onerror = (e) => console.error("ws error", (e as ErrorEvent).message ?? e);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      tSend0 = performance.now();
      resolve();
    };
    setTimeout(() => reject(new Error("websocket did not open")), 15_000);
  });

  /** The next 20 ms of caller audio: the queued line, else silence. */
  const nextFrame = (): Uint8Array => {
    if (!queue) return silence;
    let frame = queue.subarray(queueAt, queueAt + FRAME_BYTES);
    queueAt += FRAME_BYTES;
    if (frame.byteLength < FRAME_BYTES) {
      const padded = new Uint8Array(FRAME_BYTES);
      padded.set(frame);
      frame = padded;
    }
    if (queueAt >= queue.byteLength) queue = null;
    return frame;
  };

  while (!closed && performance.now() - t0 < MAX_CALL_MS) {
    const now = performance.now();
    const next = lines[lineIdx];
    if (lineDue(next, { ...turn, callerTalking: queue !== null }, now)) {
      queue = pcm[lineIdx];
      queueAt = 0;
      const queuedAtMs = Math.round(now - t0);
      const previous = bargeIns.at(-1);
      if (previous && previous.nextLineAtMs === null) previous.nextLineAtMs = queuedAtMs;
      if (next.bargeInSeconds !== null) {
        const leadMs = speechOnsetMs(queue) ?? 0;
        bargeIns.push({
          text: next.text,
          atMs: queuedAtMs + Math.round(leadMs),
          intoTurnMs: Math.round(now - turn.turnStartAt! + leadMs),
          startByte: onsetByte(assistantBytes, leadMs),
          speechMs: (speechEndMs(queue) ?? leadMs) - leadMs,
          nextLineAtMs: null,
        });
        console.log(`  >> caller (barge-in): ${next.text}`);
      } else console.log(`  >> caller: ${next.text}`);
      lineIdx++;
      turn = onLineQueued(turn);
    }
    // paced by the clock, not by the timer: send every frame owed since the socket opened, so the
    // caller stays real time (and caller.wav on assistant.wav's timeline) however late a tick runs
    for (let owed = Math.floor((now - tSend0) / FRAME_MS) - framesSent; owed > 0; owed--) {
      const frame = nextFrame();
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      callerAudio.push(frame);
      framesSent++;
    }
    // after the last line, give the assistant time to answer and end the call itself
    if (lineIdx >= lines.length && !queue && turn.heardSpeech && now - turn.lastSpeechAt > 8000) break;
    await new Promise((r) => setTimeout(r, FRAME_MS / 2));
  }
  if (ws.readyState === WebSocket.OPEN) ws.close();
  console.log(`call finished after ${Math.round((performance.now() - t0) / 1000)} s`);

  // 4. save audio + artifact (both recordings start at the assistant's first audio)
  Deno.writeFileSync(`${outDir}assistant.wav`, wav(assistantAudio));
  Deno.writeFileSync(`${outDir}caller.wav`, wav(callerAudio.slice(callerWavFrom ?? 0)));
  Deno.writeTextFileSync(`${outDir}events.json`, JSON.stringify(events, null, 1));

  // the report and artifact land a few seconds after the end
  let final: any = null;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await vapi.get(`/call/${call.id}`);
    if (final?.status === "ended" && final?.artifact?.messages) break;
  }
  Deno.writeTextFileSync(`${outDir}call.json`, JSON.stringify(final, null, 1));
  const msgs: any[] = final?.artifact?.messages ?? [];
  console.log(
    `\nendedReason: ${final?.endedReason}  duration: ${final?.durationSeconds ?? "?"} s  cost: ${final?.cost ?? "?"}`,
  );
  console.log("artifact.messages:");
  for (const m of msgs) {
    if (m.role === "system") continue;
    if (m.role === "tool_calls") {
      console.log(`  TOOL CALL ${(m.toolCalls ?? []).map((t: any) => t.function?.name).join(", ")}`);
    } else if (m.role === "tool_call_result") {
      console.log(`  TOOL RESULT ${m.name}: ${String(m.result).slice(0, 90)}`);
    } else console.log(`  ${m.role.toUpperCase()}: ${m.message ?? m.content ?? ""}`);
  }
  // P4: after each tool result, how many bot turns before the next user turn
  let doubles = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "tool_call_result") continue;
    let bots = 0;
    for (let j = i + 1; j < msgs.length && msgs[j].role !== "user" && msgs[j].role !== "tool_calls"; j++) {
      if (msgs[j].role === "bot") bots++;
    }
    if (bots > 1) doubles++;
  }
  console.log(
    `\nnative-message check: ${
      doubles === 0
        ? "PASS (one bot turn after each tool result)"
        : `FAIL (${doubles} tool results followed by more than one bot turn)`
    }`,
  );
  // Barge-in: how long the assistant's audio carried speech while the caller talked over it.
  if (bargeIns.length) {
    const audio = concat(assistantAudio);
    for (const [i, b] of bargeIns.entries()) {
      const measured = measureBargeIn(audio, b.startByte, b.speechMs);
      const interrupted = interruptionFor(events, b);
      console.log(
        `barge-in ${i + 1} "${b.text}" at assistant.wav @ ${(b.startByte / BYTES_PER_SECOND).toFixed(2)} s, ${
          (b.intoTurnMs / 1000).toFixed(1)
        } s into the assistant's turn: ${describeBargeIn(measured)}; ${
          interrupted
            ? `VAPI user-interrupted after ${((interrupted.t - b.atMs) / 1000).toFixed(2)} s`
            : "no user-interrupted event"
        }`,
      );
    }
  }
  console.log(`saved ${outDir}`);
}

if (import.meta.main) await main();
