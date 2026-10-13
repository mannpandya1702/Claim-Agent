// deno task voice <scenario> [--assistant solo-web|solo-core|concierge] [--squad]
//
// A real voice call with a synthetic caller, for testing what text chats cannot show: native tool
// messages spoken exactly once, ASR of digits and dates, endpointing, fillers, the real
// end-of-call report. It places a VAPI call over the raw WebSocket transport (16 kHz s16le PCM),
// streams silence in real time, and speaks the next scripted caller line once the assistant has
// been quiet for a moment, so turn-taking follows the assistant instead of a fixed timeline.
//
// Caller lines are synthesized with Google TTS (scripts/voice_tts.py). Both sides are recorded to
// fixtures/raw/voice/<call id>/ (gitignored): assistant.wav, caller.wav and the call artifact.
// The scenario's numbers are the fictional 555 seed numbers; every call costs normal VAPI usage.

import { loadEnv, need } from "./lib/env.ts";
import { readState } from "./lib/state.ts";
import { vapiClient } from "./lib/vapi.ts";

const SCENARIOS: Record<string, string[]> = {
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
};

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS / 1000) * 2;
const QUIET_MS = 2600; // assistant silence that ends its turn (fillers and tool gaps are shorter)
const SPEECH_RMS = 500; // s16 RMS above this counts as assistant speech
const MAX_CALL_MS = 360_000; // the longest scenario (fnol-new-caller) runs about four minutes

const args = Deno.args;
const scenario = args.find((a) => !a.startsWith("--")) ?? "happy";
const lines = SCENARIOS[scenario];
if (!lines) {
  console.error(`unknown scenario ${scenario}; one of: ${Object.keys(SCENARIOS).join(", ")}`);
  Deno.exit(2);
}
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
  args: ["-I", new URL("./voice_tts.py", import.meta.url).pathname, ttsDir, ...lines],
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
  transport: { provider: "vapi.websocket", audioFormat: { format: "pcm_s16le", container: "raw", sampleRate: SAMPLE_RATE } },
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
const events: unknown[] = [];

// 3. drive the conversation
const ws = new WebSocket(wsUrl);
ws.binaryType = "arraybuffer";
let lastSpeechAt = 0;
let heardSpeech = false;
let closed = false;
let queue: Uint8Array | null = null as Uint8Array | null; // caller audio still to send
let queueAt = 0;
let lineIdx = 0;
const t0 = performance.now();
const silence = new Uint8Array(FRAME_BYTES);

function rms(buf: Uint8Array): number {
  const v = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  let s = 0;
  for (const x of v) s += x * x;
  return v.length ? Math.sqrt(s / v.length) : 0;
}

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
  assistantAudio.push(buf);
  if (rms(buf) > SPEECH_RMS) {
    lastSpeechAt = performance.now();
    heardSpeech = true;
  }
};
ws.onclose = () => (closed = true);
ws.onerror = (e) => console.error("ws error", (e as ErrorEvent).message ?? e);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  setTimeout(() => reject(new Error("websocket did not open")), 15_000);
});

while (!closed && performance.now() - t0 < MAX_CALL_MS) {
  const now = performance.now();
  // the caller's turn starts after the assistant has spoken and then been quiet
  if (!queue && lineIdx < lines.length && heardSpeech && now - lastSpeechAt > QUIET_MS) {
    queue = pcm[lineIdx];
    queueAt = 0;
    console.log(`  >> caller: ${lines[lineIdx]}`);
    lineIdx++;
    heardSpeech = false;
  }
  let frame: Uint8Array = silence;
  if (queue) {
    frame = queue.subarray(queueAt, queueAt + FRAME_BYTES);
    queueAt += FRAME_BYTES;
    if (frame.byteLength < FRAME_BYTES) {
      const padded = new Uint8Array(FRAME_BYTES);
      padded.set(frame);
      frame = padded;
    }
    if (queueAt >= queue.byteLength) queue = null;
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  callerAudio.push(frame);
  // after the last line, give the assistant time to answer and end the call itself
  if (lineIdx >= lines.length && !queue && heardSpeech && now - lastSpeechAt > 8000) break;
  await new Promise((r) => setTimeout(r, FRAME_MS));
}
if (ws.readyState === WebSocket.OPEN) ws.close();
console.log(`call finished after ${Math.round((performance.now() - t0) / 1000)} s`);

// 4. save audio + artifact
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
Deno.writeFileSync(`${outDir}assistant.wav`, wav(assistantAudio));
Deno.writeFileSync(`${outDir}caller.wav`, wav(callerAudio));
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
console.log(`\nendedReason: ${final?.endedReason}  duration: ${final?.durationSeconds ?? "?"} s  cost: ${final?.cost ?? "?"}`);
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
console.log(`\nnative-message check: ${doubles === 0 ? "PASS (one bot turn after each tool result)" : `FAIL (${doubles} tool results followed by more than one bot turn)`}`);
console.log(`saved ${outDir}`);
