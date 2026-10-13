// Offline pieces of the voice harness: the caller-line syntax, the scenarios, the turn-taking
// decisions the call loop makes, and the barge-in measurement on synthetic audio. No call is placed
// (importing voice_call.ts does not run it).

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  BARGE_IN_LIMIT_S,
  bargeInVerdict,
  CALLER_GRACE_MS,
  type CallerLine,
  describeBargeIn,
  FIRST_TURN,
  INTERRUPT_LOOKUP_MS,
  interruptionFor,
  lineDue,
  measureBargeIn,
  onLineQueued,
  onsetByte,
  onTurnAudio,
  parseCallerLine,
  PRIOR_SPEECH_MS,
  QUIET_MS,
  rms,
  SAMPLE_RATE,
  SCENARIOS,
  SPEAKING_MS,
  SPEECH_RMS,
  speechEndMs,
  speechOnsetMs,
  type TurnState,
} from "./voice_call.ts";

/** s16le PCM from segments of [seconds, amplitude]: a square wave at that amplitude, 0 is silence. */
function pcm(...segments: [number, number][]): Uint8Array {
  const samples: number[] = [];
  for (const [seconds, amplitude] of segments) {
    const n = Math.round(seconds * SAMPLE_RATE);
    for (let i = 0; i < n; i++) samples.push(i % 2 === 0 ? amplitude : -amplitude);
  }
  return new Uint8Array(Int16Array.from(samples).buffer);
}

const SPEECH = 4000;
const byteAt = (seconds: number) => Math.round(seconds * SAMPLE_RATE) * 2;
const FRAME_S = 0.021; // one 20 ms frame of slack, plus rounding

Deno.test("parseCallerLine: plain lines wait for quiet, !<seconds> lines barge in", () => {
  assertEquals(parseCallerLine("Yes, that's right."), { text: "Yes, that's right.", bargeInSeconds: null });
  assertEquals(parseCallerLine("!9 Sorry, wait, just the home claim please."), {
    text: "Sorry, wait, just the home claim please.",
    bargeInSeconds: 9,
  });
  assertEquals(parseCallerLine("  !2.5   Hold on.  "), { text: "Hold on.", bargeInSeconds: 2.5 });
  // an exclamation inside a line is just punctuation
  assertEquals(parseCallerLine("Great! Thanks."), { text: "Great! Thanks.", bargeInSeconds: null });
  for (const bad of ["!", "!2.5", "!2.5   ", "!abc Sorry", "!-1 Sorry", "!0 Sorry", "!45 Sorry", "!2.5Sorry"]) {
    assertThrows(() => parseCallerLine(bad), Error, "barge-in", JSON.stringify(bad));
  }
});

Deno.test("scenarios: every line parses; barge-in talks over the claims read once, the rest never", () => {
  for (const [name, lines] of Object.entries(SCENARIOS)) {
    assert(lines.length > 0, name);
    const parsed = lines.map(parseCallerLine);
    for (const l of parsed) assert(l.text && !l.text.startsWith("!"), `${name}: ${l.text}`);
    // a call cannot open with a barge-in: the greeting is never interrupted
    assertEquals(parsed[0].bargeInSeconds, null, name);
    const barges = parsed.filter((l) => l.bargeInSeconds !== null);
    if (name === "barge-in") {
      assertEquals(barges.length, 1);
      // the barge-in follows the date of birth, whose answer reads the claims, and the call goes on
      assertEquals(parsed.findIndex((l) => l.bargeInSeconds !== null), 3);
      assert(parsed.length > 4, "the caller continues after the barge-in");
      // well past the verify filler and tool gap (the verified sentence starts about 2 s in on recorded
      // calls), and still inside even a summarized claims read (about 20 s)
      const at = barges[0].bargeInSeconds!;
      assert(at >= 6 && at <= 15, `barge-in at ${at} s`);
    } else assertEquals(barges, [], name);
  }
});

Deno.test("rms, speechOnsetMs and speechEndMs on synthetic PCM", () => {
  assertEquals(rms(pcm([0.1, 0])), 0);
  assertAlmostEquals(rms(pcm([0.1, SPEECH])), SPEECH, 1);
  assertEquals(rms(new Uint8Array(0)), 0);
  assertEquals(speechOnsetMs(pcm([0.3, 0], [1, SPEECH])), 300);
  assertEquals(speechOnsetMs(pcm([1, SPEECH])), 0);
  assertEquals(speechOnsetMs(pcm([1, 0])), null);
  // quiet room noise under the threshold is not speech
  assertEquals(speechOnsetMs(pcm([0.5, SPEECH_RMS - 100], [0.5, SPEECH])), 500);
  // the end of the last speech frame, scanning back over trailing silence
  assertEquals(speechEndMs(pcm([0.2, 0], [1.5, SPEECH], [0.4, 0])), 1700);
  assertEquals(speechEndMs(pcm([0.2, 0], [1.5, SPEECH])), 1700);
  // a pause inside the clip does not end it early
  assertEquals(speechEndMs(pcm([0.5, SPEECH], [0.6, 0], [0.5, SPEECH], [0.3, 0])), 1600);
  assertEquals(speechEndMs(pcm([1, 0])), null);
  assertEquals(speechEndMs(new Uint8Array(0)), null);
  // a clip whose length is not a whole number of frames: the short last frame still counts
  assertAlmostEquals(speechEndMs(pcm([0.205, SPEECH]))!, 205, 0.1);
});

Deno.test("onsetByte: the assistant bytes so far plus the clip's lead-in, on a sample boundary", () => {
  assertEquals(onsetByte(1000, 0), 1000);
  assertEquals(onsetByte(1000, 250), 1000 + byteAt(0.25));
  assertEquals(onsetByte(0, 1000), SAMPLE_RATE * 2);
  // a fraction of a sample rounds to the nearest whole sample, so the offset stays even
  assertEquals(onsetByte(1000, 0.03), 1000);
  assertEquals(onsetByte(1000, 0.04), 1002);
});

Deno.test("measureBargeIn: the assistant stops while the caller is talking -> PASS", () => {
  // talking from 0 s, stops at 3 s; the caller starts at 2.4 s and talks for 2 s
  const m = measureBargeIn(pcm([3, SPEECH], [5, 0]), byteAt(2.4), 2000);
  assert(m.wasSpeaking);
  assertAlmostEquals(m.keptSeconds, 0.6, FRAME_S);
  assertEquals(m.stillTalking, false);
  assertEquals(bargeInVerdict(m), "PASS");
  // an odd byte offset is aligned to a sample, never read across one
  assertAlmostEquals(measureBargeIn(pcm([3, SPEECH], [5, 0]), byteAt(2.4) + 1, 2000).keptSeconds, 0.6, FRAME_S);
});

Deno.test("measureBargeIn: a 1.1 s pause inside the turn does not end the measurement", () => {
  // she pauses 1.1 s between sentences (longer than the old 1.0 s quiet heuristic) and reads on
  const audio = pcm([2, SPEECH], [1.1, 0], [8, SPEECH]);
  const m = measureBargeIn(audio, byteAt(1.5), 2500);
  assert(m.wasSpeaking);
  assert(m.stillTalking, "still reading when the caller finished");
  assertAlmostEquals(m.keptSeconds, 2.5 + CALLER_GRACE_MS / 1000, FRAME_S);
  assertEquals(bargeInVerdict(m), "FAIL");
  assert(describeBargeIn(m).startsWith("still talking when the caller finished"), describeBargeIn(m));
});

Deno.test("measureBargeIn: her reply after the caller finishes is outside the window", () => {
  // stops 0.5 s after the caller starts; replies 3.5 s later, once the caller (2 s) has finished
  const audio = pcm([2, SPEECH], [3, 0], [3, SPEECH], [1, 0]);
  const m = measureBargeIn(audio, byteAt(1.5), 2000);
  assertAlmostEquals(m.keptSeconds, 0.5, FRAME_S);
  assertEquals(m.stillTalking, false);
  assertEquals(bargeInVerdict(m), "PASS");
});

Deno.test("measureBargeIn: a sentence started over the caller counts as talking on", () => {
  // a short gap right after the caller starts, then a 2 s sentence over them
  const audio = pcm([1, SPEECH], [0.4, 0], [2, SPEECH], [4, 0]);
  const m = measureBargeIn(audio, byteAt(1), 3000);
  assert(m.wasSpeaking);
  assertAlmostEquals(m.keptSeconds, 2.4, FRAME_S);
  assertEquals(m.stillTalking, false);
  assertEquals(bargeInVerdict(m), "FAIL");
});

Deno.test("measureBargeIn: a short caller line cannot hide an assistant that talks straight on", () => {
  // the window (0.5 s of caller + the grace) is shorter than the limit, but she never stopped
  const m = measureBargeIn(pcm([10, SPEECH]), byteAt(2), 500);
  assert(m.keptSeconds <= BARGE_IN_LIMIT_S);
  assert(m.stillTalking);
  assertEquals(bargeInVerdict(m), "FAIL");
  // the recording ending mid-sentence is still talking too
  const cut = measureBargeIn(pcm([3, SPEECH]), byteAt(2), 2000);
  assertAlmostEquals(cut.keptSeconds, 1, FRAME_S);
  assertEquals(bargeInVerdict(cut), "FAIL");
});

Deno.test("measureBargeIn: the assistant quiet when the caller starts -> INVALID, never PASS", () => {
  // after her turn ended
  const ended = measureBargeIn(pcm([3, SPEECH], [3, 0]), byteAt(4), 2000);
  assertEquals(ended.wasSpeaking, false);
  assertEquals(ended.keptSeconds, 0);
  assertEquals(bargeInVerdict(ended), "INVALID");
  assertEquals(describeBargeIn(ended), "INVALID: assistant was quiet when the caller started");
  // inside the silent tool gap between the filler and the verified sentence, even though she speaks
  // again over the caller a moment later
  const gap = pcm([1.2, SPEECH], [0.9, 0], [6, SPEECH]);
  const inGap = measureBargeIn(gap, byteAt(1.2 + PRIOR_SPEECH_MS / 1000 + 0.1), 2000);
  assertEquals(bargeInVerdict(inGap), "INVALID");
  // speech just inside the prior window is enough
  assertEquals(measureBargeIn(gap, byteAt(1.2 + PRIOR_SPEECH_MS / 1000 - 0.04), 2000).wasSpeaking, true);
  // past the end of the recording
  assertEquals(bargeInVerdict(measureBargeIn(pcm([1, SPEECH]), byteAt(5), 2000)), "INVALID");
  // a custom threshold above the speech level hears nothing
  assertEquals(bargeInVerdict(measureBargeIn(pcm([5, SPEECH]), byteAt(2), 2000, { threshold: SPEECH + 1 })), "INVALID");
});

Deno.test("bargeInVerdict and describeBargeIn", () => {
  assertEquals(BARGE_IN_LIMIT_S, 1.5);
  const ok = { wasSpeaking: true, stillTalking: false };
  assertEquals(bargeInVerdict({ ...ok, keptSeconds: 0 }), "PASS");
  assertEquals(bargeInVerdict({ ...ok, keptSeconds: 1.5 }), "PASS");
  assertEquals(bargeInVerdict({ ...ok, keptSeconds: 1.51 }), "FAIL");
  assertEquals(bargeInVerdict({ ...ok, keptSeconds: 0.8 }, 0.5), "FAIL");
  assertEquals(bargeInVerdict({ ...ok, keptSeconds: 0.8, stillTalking: true }), "FAIL");
  assertEquals(bargeInVerdict({ wasSpeaking: false, keptSeconds: 3, stillTalking: true }), "INVALID");
  assertEquals(
    describeBargeIn({ ...ok, keptSeconds: 0.62 }),
    "kept talking 0.62 s after the caller started -> PASS (limit 1.5 s)",
  );
  assertEquals(
    describeBargeIn({ ...ok, keptSeconds: 2.9 }),
    "kept talking 2.90 s after the caller started -> FAIL (limit 1.5 s)",
  );
});

Deno.test("interruptionFor: only a user-interrupted event inside the barge-in's own window", () => {
  const events = [
    { t: 900, type: "user-interrupted" }, // before the caller started: an earlier turn
    { t: 1200, type: "speech-update" },
    { t: 1700, type: "user-interrupted" },
    { t: 1900, type: "user-interrupted" },
    { t: 15800, type: "user-interrupted" }, // the goodbye line overlapping her, a later turn
  ];
  assertEquals(interruptionFor(events, { atMs: 1000, nextLineAtMs: 9000 }), { t: 1700, type: "user-interrupted" });
  assertEquals(interruptionFor(events, { atMs: 1000, nextLineAtMs: 1700 }), undefined);
  assertEquals(interruptionFor(events.slice(4), { atMs: 1000, nextLineAtMs: 15000 }), undefined);
  // with no following line, a fixed window after the onset
  assertEquals(interruptionFor(events.slice(4), { atMs: 1000, nextLineAtMs: null }), undefined);
  assertEquals(
    interruptionFor(events.slice(4), { atMs: 15800 - INTERRUPT_LOOKUP_MS + 1, nextLineAtMs: null })?.t,
    15800,
  );
  assertEquals(interruptionFor([], { atMs: 0, nextLineAtMs: null }), undefined);
});

Deno.test("onTurnAudio and onLineQueued: when the assistant's turn starts", () => {
  // silence changes nothing
  assertEquals(onTurnAudio(FIRST_TURN, 100, false, false), FIRST_TURN);
  // speech while caller audio is still going out is not a new turn, only the latest speech
  const over = onTurnAudio(FIRST_TURN, 100, true, true);
  assertEquals(over, { lastSpeechAt: 100, heardSpeech: false, turnStartAt: null });
  // the first speech once the caller is done starts the turn; later speech keeps that start
  let s = onTurnAudio(over, 400, true, false);
  assertEquals(s, { lastSpeechAt: 400, heardSpeech: true, turnStartAt: 400 });
  s = onTurnAudio(s, 900, true, false);
  assertEquals(s, { lastSpeechAt: 900, heardSpeech: true, turnStartAt: 400 });
  s = onTurnAudio(s, 1000, false, false);
  assertEquals(s.lastSpeechAt, 900);
  // queueing a line resets the turn but remembers when she last spoke
  assertEquals(onLineQueued(s), { lastSpeechAt: 900, heardSpeech: false, turnStartAt: null });
});

Deno.test("lineDue: plain lines after the assistant goes quiet", () => {
  const plain: CallerLine = { text: "Yes.", bargeInSeconds: null };
  const spoke: TurnState = { lastSpeechAt: 1000, heardSpeech: true, turnStartAt: 0 };
  assertEquals(lineDue(undefined, { ...spoke, callerTalking: false }, 99_000), false);
  assertEquals(lineDue(plain, { ...FIRST_TURN, callerTalking: false }, 99_000), false, "she has not spoken yet");
  assertEquals(lineDue(plain, { ...spoke, callerTalking: false }, 1000 + QUIET_MS), false);
  assertEquals(lineDue(plain, { ...spoke, callerTalking: false }, 1001 + QUIET_MS), true);
  assertEquals(lineDue(plain, { ...spoke, callerTalking: true }, 1001 + QUIET_MS), false, "caller still talking");
});

Deno.test("lineDue: a barge-in fires N s into the turn, only over audible speech", () => {
  const barge: CallerLine = { text: "Sorry, wait.", bargeInSeconds: 9 };
  const at = (s: Partial<TurnState>, now: number, callerTalking = false) =>
    lineDue(barge, { ...FIRST_TURN, ...s, callerTalking }, now);
  // the turn has not started: never, however long
  assertEquals(at({ lastSpeechAt: 50_000 }, 50_000), false);
  // talking, turn started at 10 s: not before 19 s, then yes
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 18_990 }, 18_999), false);
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 18_990 }, 19_000), true);
  // never while caller audio is still going out
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 18_990 }, 19_000, true), false);
  // quiet for SPEAKING_MS or more at 19 s (a tool gap): wait for her to speak again
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 19_000 - SPEAKING_MS }, 19_000), false);
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 19_600 }, 19_610), true);
  // the turn ended before N s (quiet for QUIET_MS): it goes anyway so the call carries on (INVALID)
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 15_000 }, 15_000 + QUIET_MS), false);
  assertEquals(at({ heardSpeech: true, turnStartAt: 10_000, lastSpeechAt: 15_000 }, 19_000), true);
});

Deno.test("turn-taking: a 20 ms simulation of the call loop fires the barge-in where intended", () => {
  // the caller's previous line is 2 s of audio queued at 0; Ava talks over its end (0.5 to 2.5 s),
  // stops, then answers: a filler 4 to 5.2 s, a silent tool gap, and speech from 6.1 s, with a gap
  // 12.9 to 13.4 s; the barge-in is "!9"
  const speaking = (t: number) =>
    (t >= 500 && t < 2500) || (t >= 4000 && t < 5200) || (t >= 6100 && t < 12_900) ||
    t >= 13_400;
  const run = (seconds: number) => {
    const line: CallerLine = { text: "Sorry, wait.", bargeInSeconds: seconds };
    let turn = onLineQueued(FIRST_TURN);
    for (let t = 0; t < 30_000; t += 20) {
      const callerTalking = t < 2000;
      turn = onTurnAudio(turn, t, speaking(t), callerTalking);
      if (lineDue(line, { ...turn, callerTalking }, t)) return { t, turnStartAt: turn.turnStartAt };
    }
    return null;
  };
  // the turn starts with the first speech after the caller's line went out (2.0 s, Ava still talking
  // over it), not with her speech over the line at 0.5 s
  assertEquals(run(9), { t: 11_000, turnStartAt: 2000 });
  // landing inside the 12.9 to 13.4 s pause, it waits for her next speech
  assertEquals(run(11.2), { t: 13_400, turnStartAt: 2000 });
});
