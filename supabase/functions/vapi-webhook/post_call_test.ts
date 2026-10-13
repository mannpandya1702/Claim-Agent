// The post-call contract: the outcome and the caller's identity come from server facts first and
// VAPI's words second; every stored view (messages, transcript, transcript_lines) is redacted and
// masks the caller's answer to a DOB or phone question whatever shape the ASR gave it; integer
// columns get integers; missing analysis is backfilled off the request path, never invented, and
// the backfill never alerts anyone.
import { assert, assertEquals, assertFalse, assertNotMatch, assertRejects, assertStringIncludes } from "@std/assert";
import type { Outcome } from "./enums.ts";
import { createFakeStore, demoSeed, type FakeStore } from "./fake_store.ts";
import { handle } from "./handler.ts";
import { deliverOutbox } from "./outbox.ts";
import {
  BACKFILL_DELAYS_MS,
  buildInteractionRow,
  buildMessages,
  maskTranscript,
  onEndOfCallReport,
  onStatusUpdate,
  onTranscript,
  type PostCallFacts,
  type StoredMessage,
  UNKNOWN_CALLER,
} from "./post_call.ts";
import type { CallFacts } from "./post_call_facts.ts";
import { MASKED_ANSWER, redactPII } from "./redact.ts";
import { OUTBOX_LEASE_MS } from "./store_rules.ts";
import type { AttemptRow, CallerContact, Customer, Deps, Env, EscalationRow, Session, VapiMessage } from "./types.ts";

const ORG = "4f1c2d3e-0000-4000-8000-00000000a0a0";
const SECRET = "whsec-post-call-test";
const PRIVATE_KEY = "vapi-private-test-key";
const NOW = new Date("2026-10-12T15:00:00Z");
const FULL_ID = "3f6c1a2e-7b4d-4e8a-9c01-5d2e8f0a1b01";
const NEVER_ID = "3f6c1a2e-7b4d-4e8a-9c01-5d2e8f0a1b02";
const PHONE_CALL_ID = "3f6c1a2e-7b4d-4e8a-9c01-5d2e8f0a1b05";
const LIVE_ID = "7d1e2f30-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
const ZEROS = [0, 0, 0];

const SEED = demoSeed();
const withoutDob = (c: (typeof SEED.customers)[number]): Customer => ({
  id: c.id,
  phone_e164: c.phone_e164,
  first_name: c.first_name,
  last_name: c.last_name,
  policy_number: c.policy_number,
  email: c.email,
});
const TOBIAS = withoutDob(SEED.customers[0]);
const SLOANE = withoutDob(SEED.customers[2]);

const FIXTURES = new URL("../../../fixtures/eocr/", import.meta.url);
const FIXTURE_NAMES = [
  "full",
  "partial",
  "never_connected",
  "structured_outputs_only",
  "emergency",
  "escalation",
  "auth_failed",
  "not_found",
];

// Reports are untyped JSON; tests reach into them freely.
type Report = VapiMessage & { [k: string]: any };

function body(name: string): { message: Report } {
  return JSON.parse(Deno.readTextFileSync(new URL(`${name}.json`, FIXTURES)));
}

function fixture(name: string): Report {
  return body(name).message;
}

// ---------------------------------------------------------------------------------------------
// Facts and harness.
// ---------------------------------------------------------------------------------------------
function session(callKey: string, level: Session["level"], candidate: string | null = null): Session {
  return {
    call_key: callKey,
    channel: "webCall",
    caller_number: null,
    level,
    candidate_customer_id: candidate,
    verified_customer_id: level === "verified" ? candidate : null,
  };
}

let attemptSeq = 0;
function attempt(callKey: string, tool: string, kind: AttemptRow["kind"], code: string | null): AttemptRow {
  return {
    call_key: callKey,
    tool_call_id: `tc_${++attemptSeq}`,
    tool_name: tool,
    kind,
    code,
    created_at: "2026-10-12T15:02:20.000Z",
  };
}

function escalation(callKey: string, kind: EscalationRow["kind"], alert: EscalationRow["alert_status"] = "sent") {
  return {
    id: crypto.randomUUID(),
    call_key: callKey,
    kind,
    reason: kind === "emergency" ? "emergency" : "representative_requested",
    details: null,
    callback_phone: null,
    channel: "webCall",
    verified: false,
    callback_source: "none",
    alert_status: alert,
    delivery_error: null,
    status: "open",
    created_at: "2026-10-12T15:02:30.000Z",
  } satisfies EscalationRow;
}

function facts(p: Partial<CallFacts> = {}): CallFacts {
  return { session: null, verifiedCustomer: null, attempts: [], escalations: [], emails: [], ...p };
}

function verifiedFacts(callKey = FULL_ID, extra: AttemptRow[] = []): CallFacts {
  return facts({
    session: session(callKey, "verified", TOBIAS.id),
    verifiedCustomer: TOBIAS,
    attempts: [
      attempt(callKey, "lookup_customer", "lookup_hit", "needs_dob"),
      attempt(callKey, "verify_identity", "dob_ok", "verified"),
      attempt(callKey, "get_claim_status", "other", "ok"),
      ...extra,
    ],
  });
}

/** Walks the fake store through the same tool calls the full fixture shows. */
async function walkVerified(store: FakeStore, callKey = FULL_ID): Promise<void> {
  await store.lookupCustomerAttempt({
    callKey,
    channel: "webCall",
    phoneE164: TOBIAS.phone_e164,
    toolCallId: "call_lookup_9f2b1c",
    callerNumber: null,
  });
  await store.verifyDobAttempt({ callKey, year: 1986, month: 3, day: 14, toolCallId: "call_verify_4e7a2d" });
  await store.claimAttempt(callKey, "call_status_7c1d3e", "get_claim_status");
  await store.setAttemptCode(callKey, "call_status_7c1d3e", "ok");
}

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function harness(opts: {
  env?: Partial<Env>;
  store?: FakeStore;
  vapi?: Responder;
  telegram?: Responder;
  resend?: Responder;
  airtable?: Responder;
} = {}) {
  const store = opts.store ?? createFakeStore();
  const calls: { url: string; init: RequestInit }[] = [];
  const background: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://api.vapi.ai/")) {
      return await (opts.vapi ?? (() => json({ message: "Not Found" }, 404)))(url, init ?? {});
    }
    if (url.startsWith("https://api.telegram.org/")) {
      return await (opts.telegram ?? (() => json({ ok: true, result: { message_id: 1 } })))(url, init ?? {});
    }
    if (url === "https://api.resend.com/emails") {
      return await (opts.resend ?? (() => json({ id: "re_test_1" })))(url, init ?? {});
    }
    if (url.startsWith("https://api.airtable.com/")) {
      return await (opts.airtable ?? (() => json({ records: [{ id: "rec_test_1" }] })))(url, init ?? {});
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    store,
    fetch: fetchFn,
    env: { VAPI_ORG_ID: ORG, VAPI_WEBHOOK_SECRET: SECRET, ...opts.env },
    now: () => NOW,
    waitUntil: (p) => {
      background.push(p);
    },
    log: (e) => logs.push(e),
  };
  async function settle(): Promise<void> {
    while (background.length > 0) await background.shift();
  }
  return { store, deps, calls, background, logs, settle };
}

const ALERT_ENV: Partial<Env> = {
  TELEGRAM_BOT_TOKEN: "123456:post-call-test",
  TELEGRAM_CHAT_ID: "-100200300",
  RESEND_API_KEY: "re_post_call_test",
  CLAIMS_TEAM_EMAIL: "team@example.com",
  DASHBOARD_URL: "https://staff.example.com/",
};

function interaction(store: FakeStore, callKey: string) {
  const rows = store.tables.call_interactions.filter((r) => r.vapi_call_id === callKey);
  assert(rows.length <= 1, "one row per call");
  return rows[0];
}

function textsOf(messages: unknown, role: "user" | "assistant"): string[] {
  return (messages as StoredMessage[]).filter((m) => m.role === role).map((m) => (m as { text: string }).text);
}

function chipsOf(messages: unknown) {
  return (messages as StoredMessage[]).filter((m) => m.role === "tool");
}

// ---------------------------------------------------------------------------------------------
// Fixtures stay fictional.
// ---------------------------------------------------------------------------------------------
const SEED_NUMBERS = new Set([
  ...SEED.customers.map((c) => c.phone_e164.slice(2)),
  "6025550199", // the seed's not-found number
  "8005550142", // the published main line
]);
const SEED_DOBS = new Set(SEED.customers.map((c) => c.date_of_birth));

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

Deno.test("fixtures: every phone number and date of birth is a fictional seed value", () => {
  const phoneRun = /(?<![\d.])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\d.])/g;
  for (const name of FIXTURE_NAMES) {
    const all = body(name);
    for (const s of strings(all)) {
      for (const m of s.matchAll(phoneRun)) {
        assert(SEED_NUMBERS.has(m[1] + m[2] + m[3]), `${name}: ${m[0]} is not a seed number`);
      }
      // spoken numbers too: redaction recognises them and keeps the last four
      for (const m of redactPII(s).matchAll(/\[phone ending (\d{4})\]/g)) {
        assert([...SEED_NUMBERS].some((n) => n.endsWith(m[1])), `${name}: spoken number ending ${m[1]}`);
      }
      for (const y of s.match(/\b19\d\d\b/g) ?? []) {
        assert([...SEED_DOBS].some((d) => d.startsWith(y)), `${name}: year ${y} is not a seed birth year`);
      }
    }
    for (const m of (all.message.artifact?.messages ?? []) as Record<string, any>[]) {
      for (const call of m.toolCalls ?? []) {
        if (call.function?.name !== "verify_identity") continue;
        const a = typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
        const dob = `${a.dob_year}-${String(a.dob_month).padStart(2, "0")}-${String(a.dob_day).padStart(2, "0")}`;
        assert(SEED_DOBS.has(dob), `${name}: verify_identity with ${dob}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// buildInteractionRow: the happy path.
// ---------------------------------------------------------------------------------------------
Deno.test("buildInteractionRow: full report of a verified call maps every column", () => {
  const message = fixture("full");
  const row = buildInteractionRow(message, verifiedFacts());
  assertEquals(row.vapi_call_id, FULL_ID);
  assertEquals(row.channel, "webCall");
  assertEquals(row.customer_id, TOBIAS.id);
  assertEquals(row.caller_name, "Tobias Halvorsen");
  assertEquals(row.caller_phone, "+16025550101");
  assertEquals(row.summary, message.analysis.summary);
  assertEquals([row.sentiment, row.sentiment_source], ["positive", "vapi"]);
  assertEquals(row.outcome, "resolved");
  assertEquals([row.escalated, row.emergency], [false, false]);
  assertEquals(row.flags, []);
  assertEquals(row.started_at, "2026-10-12T15:02:11.512Z");
  assertEquals(row.ended_at, "2026-10-12T15:02:40.083Z");
  assertEquals(row.ended_reason, "assistant-ended-call");
  assertEquals(row.duration_seconds, 29);
  assertEquals(row.latency_avg_ms, 1403);
  assertEquals(row.recording_url, message.artifact.recording.mono.combinedUrl);
  assertEquals(row.cost, 0.0579);
  assertEquals(row.success_evaluation, "true");
  assertEquals(row.analysis_raw, message.analysis);
  assertEquals(row.cost_breakdown, {
    stt: 0.0048,
    llm: 0.0112,
    tts: 0.0143,
    vapi: 0.0238,
    transport: 0,
    analysis: 0.0038,
    total: 0.0579,
  });
  assertEquals(row.assistant_name, "Observe Claims Web");
  assertEquals(row.analysis_status, "ok");
  // integer columns get integers, or Postgres rejects the whole row with 22P02
  assert(Number.isInteger(row.duration_seconds) && Number.isInteger(row.latency_avg_ms));
});

Deno.test("buildInteractionRow: messages hold no tool arguments and none of the DOB or phone digits", () => {
  const message = fixture("full");
  // the fixture really carries the arguments the row must not
  const verify = message.artifact.messages.find((m: any) => m.toolCalls?.[0]?.function?.name === "verify_identity");
  assertEquals(verify.toolCalls[0].function.arguments, { dob_month: 3, dob_day: 14, dob_year: 1986 });

  const row = buildInteractionRow(message, verifiedFacts());
  const stored = JSON.stringify(row.messages);
  for (const banned of ["dob_month", "dob_day", "dob_year", "arguments", "toolCalls", '"phone"', "1986", "0101"]) {
    assertFalse(stored.includes(banned), banned);
  }
  for (const m of row.messages as StoredMessage[]) {
    assertFalse("args" in m || "arguments" in m);
    if ("text" in m) assertNotMatch(m.text, /\d/, m.text);
    assertFalse(/fourteenth|eighty six/i.test("text" in m ? m.text : ""));
  }
});

Deno.test("buildInteractionRow: the system prompt is dropped and only bubbles and {tool, code, t} chips remain", () => {
  const message = fixture("full");
  const row = buildInteractionRow(message, verifiedFacts());
  const messages = row.messages as StoredMessage[];
  assertFalse(messages.some((m) => (m.role as string) === "system"));
  const prompt = message.artifact.messages.find((m: any) => m.role === "system").message;
  assertFalse(JSON.stringify(messages).includes(prompt.slice(0, 40)));
  for (const m of messages) {
    const keys = Object.keys(m).sort();
    if (m.role === "tool") assertEquals(keys, ["code", "role", "t", "tool"]);
    else assertEquals(keys, ["role", "t", "text"]);
  }
  // the get_claim_status result arrives double-encoded; endCall never returned, so its chip has no code
  assertEquals(chipsOf(messages), [
    { role: "tool", tool: "lookup_customer", code: "needs_dob", t: 12 },
    { role: "tool", tool: "verify_identity", code: "verified", t: 18 },
    { role: "tool", tool: "get_claim_status", code: "ok", t: 22 },
    { role: "tool", tool: "endCall", code: null, t: 28 },
  ]);
  assertEquals(messages[0], {
    role: "assistant",
    text: "Thanks for calling Observe Insurance claims. How can I help you today?",
    t: 0,
  });
});

Deno.test("buildInteractionRow: the answers to the phone and DOB questions are masked in messages and transcript", () => {
  const message = fixture("full");
  const row = buildInteractionRow(message, verifiedFacts());
  assertEquals(textsOf(row.messages, "user"), [
    "Hi, I'd like to check on my claim.",
    MASKED_ANSWER,
    MASKED_ANSWER,
    "What's the status of my claims?",
    "No, that's everything. Thank you.",
  ]);
  const expected = (message.artifact.transcript as string)
    .replace("User: It's 602-555-0101.", `User: ${MASKED_ANSWER}`)
    .replace("User: march fourteenth nineteen eighty six", `User: ${MASKED_ANSWER}`);
  assertEquals(row.transcript, expected);
  for (const leak of ["0101", "602", "fourteenth", "eighty six"]) assertFalse(row.transcript!.includes(leak), leak);
});

// ---------------------------------------------------------------------------------------------
// Masking across ASR shapes, in all three stored views.
// ---------------------------------------------------------------------------------------------
const DOB_QUESTION = "Thanks! And just to keep your account safe, what's the date of birth on the account?";
const PHONE_QUESTION = "I can help with that. What's the phone number on your account?";
const ASR_ANSWERS: [string, string, string[]][] = [
  [DOB_QUESTION, "march 14th 1986", ["14", "1986"]],
  [DOB_QUESTION, "march fourteenth nineteen eighty six", ["fourteenth", "eighty"]],
  [DOB_QUESTION, "3 14 86", ["3 14 86"]],
  [DOB_QUESTION, "zero three one four one nine eight six", ["three one four"]],
  [DOB_QUESTION, "Three. Fourteen. Eighty-six.", ["Fourteen", "Eighty"]],
  [DOB_QUESTION, "It's 03/14/1986", ["03/14", "1986"]],
  [PHONE_QUESTION, "six zero two five five five zero one zero one", ["zero one zero one"]],
  [PHONE_QUESTION, "6 0 2 5 5 5 0 1 0 1", ["0 1 0 1"]],
  [PHONE_QUESTION, "(602) 555-0101", ["555", "0101"]],
  [PHONE_QUESTION, "six oh two... five five five... oh one oh one", ["oh one oh one"]],
];

function askAndAnswer(question: string, answer: string): VapiMessage {
  const message = fixture("full");
  message.artifact.messages = [
    { role: "bot", message: question, secondsFromStart: 1 },
    { role: "user", message: answer, secondsFromStart: 4 },
    { role: "bot", message: "Let me verify that.", secondsFromStart: 6 },
    { role: "user", message: "Okay.", secondsFromStart: 8 },
  ];
  message.artifact.transcript = `AI: ${question}\nUser: ${answer}\nAI: Let me verify that.\nUser: Okay.\n`;
  delete message.transcript;
  delete message.messages;
  return message;
}

Deno.test("masking: the answer is withheld in messages and transcript whatever shape the ASR produced", () => {
  for (const [question, answer, fragments] of ASR_ANSWERS) {
    const row = buildInteractionRow(askAndAnswer(question, answer), facts());
    assertEquals(textsOf(row.messages, "user"), [MASKED_ANSWER, "Okay."], answer);
    assertEquals(
      row.transcript,
      `AI: ${question}\nUser: ${MASKED_ANSWER}\nAI: Let me verify that.\nUser: Okay.\n`,
      answer,
    );
    for (const f of fragments) {
      assertFalse(JSON.stringify(row.messages).includes(f), `${answer}: ${f}`);
      assertFalse(row.transcript!.includes(f), `${answer}: ${f}`);
    }
  }
});

Deno.test("masking: the answer is withheld in transcript_lines whatever shape the ASR produced", async () => {
  for (const [question, answer, fragments] of ASR_ANSWERS) {
    const { store, deps } = harness();
    await onTranscript(liveLine("assistant", question, 1000), deps);
    await onTranscript(liveLine("user", answer, 4000), deps);
    const user = store.tables.transcript_lines.filter((l) => l.role === "user");
    assertEquals(user.map((l) => l.text), [MASKED_ANSWER], answer);
    // text only: created_at timestamps can contain the same digits by chance
    const stored = store.tables.transcript_lines.map((l) => l.text).join("\n");
    for (const f of fragments) {
      assertFalse(stored.includes(f), `${answer}: ${f}`);
    }
  }
});

Deno.test("masking: an answer split over several caller turns is withheld until the agent speaks again", async () => {
  const message = fixture("full");
  message.artifact.messages = [
    { role: "bot", message: DOB_QUESTION, secondsFromStart: 1 },
    { role: "user", message: "march fourteenth", secondsFromStart: 4 },
    { role: "user", message: "nineteen eighty six", secondsFromStart: 6 },
    { role: "tool_calls", toolCalls: [{ id: "c1", function: { name: "verify_identity", arguments: {} } }] },
    { role: "tool_call_result", toolCallId: "c1", name: "verify_identity", result: '{"code":"verified"}' },
    {
      role: "bot",
      message: "Thanks, Tobias. You're all verified. What can I help you with today?",
      secondsFromStart: 9,
    },
    { role: "user", message: "My claim status, please.", secondsFromStart: 12 },
  ];
  message.artifact.transcript =
    `AI: ${DOB_QUESTION}\nUser: march fourteenth\nUser: nineteen eighty six\nAI: Thanks, Tobias. You're all verified.\nUser: My claim status, please.`;
  const row = buildInteractionRow(message, facts());
  assertEquals(textsOf(row.messages, "user"), [MASKED_ANSWER, MASKED_ANSWER, "My claim status, please."]);
  assertEquals(
    row.transcript,
    `AI: ${DOB_QUESTION}\nUser: ${MASKED_ANSWER}\nUser: ${MASKED_ANSWER}\nAI: Thanks, Tobias. You're all verified.\nUser: My claim status, please.`,
  );

  const { store, deps } = harness();
  await onTranscript(liveLine("assistant", DOB_QUESTION, 1000), deps);
  await onTranscript(liveLine("user", "march fourteenth", 4000), deps);
  await onTranscript(liveLine("user", "nineteen eighty six", 6000), deps);
  await onTranscript(liveLine("assistant", "Thanks, Tobias. You're all verified.", 9000), deps);
  await onTranscript(liveLine("user", "My claim status, please.", 12000), deps);
  assertEquals(
    store.tables.transcript_lines.filter((l) => l.role === "user").map((l) => l.text),
    [MASKED_ANSWER, MASKED_ANSWER, "My claim status, please."],
  );
});

Deno.test("masking: a DOB question the model words itself withholds a two-digit-year answer", () => {
  assertEquals(
    maskTranscript("AI: When were you born?\nUser: march 14th 86\nAI: Thanks."),
    `AI: When were you born?\nUser: ${MASKED_ANSWER}\nAI: Thanks.`,
  );
  const row = buildInteractionRow(askAndAnswer("And what year?", "eighty six"), facts());
  assertEquals(textsOf(row.messages, "user"), [MASKED_ANSWER, "Okay."]);
  assertFalse(String(row.transcript).includes("eighty six"));
});

Deno.test("masking: a re-ask right after a DOB question still withholds the repeated answer", () => {
  const reask = "Sorry, I didn't quite catch that. Could you say that again?";
  const message = fixture("full");
  message.artifact.messages = [
    { role: "bot", message: DOB_QUESTION, secondsFromStart: 1 },
    { role: "user", message: "march fourt- sorry", secondsFromStart: 4 },
    { role: "bot", message: reask, secondsFromStart: 6 },
    { role: "user", message: "march fourteenth nineteen eighty six", secondsFromStart: 8 },
    { role: "bot", message: "Thanks, Tobias. You're all verified.", secondsFromStart: 10 },
    { role: "user", message: "Sorry, I didn't catch that either.", secondsFromStart: 12 },
  ];
  message.artifact.transcript = [
    `AI: ${DOB_QUESTION}`,
    "User: march fourt- sorry",
    `AI: ${reask}`,
    "User: march fourteenth nineteen eighty six",
    "AI: Thanks, Tobias. You're all verified.",
    "User: Sorry, I didn't catch that either.",
  ].join("\n");
  const row = buildInteractionRow(message, facts());
  // the re-ask carries the DOB question's masking; a re-ask with no sensitive question before it does not
  assertEquals(textsOf(row.messages, "user"), [MASKED_ANSWER, MASKED_ANSWER, "Sorry, I didn't catch that either."]);
  assertFalse(String(row.transcript).includes("eighty six"));
  assertEquals(
    maskTranscript(`AI: What happened?\nUser: a pipe burst\nAI: ${reask}\nUser: a pipe burst under the sink`),
    `AI: What happened?\nUser: a pipe burst\nAI: ${reask}\nUser: a pipe burst under the sink`,
  );
  assertEquals(
    maskTranscript(`AI: ${PHONE_QUESTION}\nUser: six oh two\nAI: ${reask}\nUser: six oh two five five five`),
    `AI: ${PHONE_QUESTION}\nUser: ${MASKED_ANSWER}\nAI: ${reask}\nUser: ${MASKED_ANSWER}`,
  );
});

Deno.test("masking: a phone number taken in pieces after a re-ask is withheld piece by piece", () => {
  const pieces = "Let's take the phone number three digits at a time.";
  assertEquals(
    maskTranscript(
      [
        `AI: ${PHONE_QUESTION}`,
        "User: six oh two five",
        `AI: Sorry, I missed part of that. ${pieces}`,
        "User: six oh two",
        "AI: Got it. And the next three digits?",
        "User: five five five",
        "AI: And the last four?",
        "User: oh one oh one",
        "AI: Thanks.",
        "User: What happens now?",
      ].join("\n"),
    ),
    [
      `AI: ${PHONE_QUESTION}`,
      `User: ${MASKED_ANSWER}`,
      `AI: Sorry, I missed part of that. ${pieces}`,
      `User: ${MASKED_ANSWER}`,
      "AI: Got it. And the next three digits?",
      `User: ${MASKED_ANSWER}`,
      "AI: And the last four?",
      `User: ${MASKED_ANSWER}`,
      "AI: Thanks.",
      "User: What happens now?",
    ].join("\n"),
  );
});

Deno.test("maskTranscript: labels, wrapped lines and blank lines", () => {
  const text = [
    "AI: Before I can check that, I need the phone number",
    "on the account. What's the number?",
    "",
    "Customer: six oh two",
    "five five five oh one oh one",
    "AI: Thanks.",
    "User: Call me at 602-555-0102 instead.",
  ].join("\n");
  assertEquals(
    maskTranscript(text),
    [
      "AI: Before I can check that, I need the phone number",
      "on the account. What's the number?",
      "",
      `Customer: ${MASKED_ANSWER}`,
      MASKED_ANSWER,
      "AI: Thanks.",
      "User: Call me at [phone ending 0102] instead.",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------------------------
// Outcome precedence and the name chain.
// ---------------------------------------------------------------------------------------------
function withLlmOutcome(message: VapiMessage, outcome: string): VapiMessage {
  message.analysis.structuredData = { ...(message.analysis.structuredData ?? {}), outcome };
  return message;
}

Deno.test("outcome: server facts first (emergency > escalated > auth_failed > not_found > resolved), then the LLM", () => {
  const K = FULL_ID;
  const miss = () => attempt(K, "lookup_customer", "lookup_miss", "not_found");
  const statusOk = () => attempt(K, "get_claim_status", "other", "ok");
  const cases: [string, CallFacts, (m: VapiMessage) => VapiMessage, Outcome][] = [
    [
      "emergency row beats everything",
      facts({
        session: session(K, "locked", SLOANE.id),
        attempts: [miss()],
        escalations: [escalation(K, "representative"), escalation(K, "emergency")],
      }),
      (m) => withLlmOutcome(m, "resolved"),
      "emergency",
    ],
    [
      "representative row beats locked",
      facts({ session: session(K, "locked", SLOANE.id), escalations: [escalation(K, "representative", "failed")] }),
      (m) => m,
      "escalated",
    ],
    ["artifact.transfers", facts(), (m) => {
      m.artifact.transfers = [{ destination: { type: "number" }, status: "completed" }];
      return m;
    }, "escalated"],
    ["endedReason assistant-forwarded-call", facts(), (m) => {
      m.endedReason = "assistant-forwarded-call";
      return m;
    }, "escalated"],
    ["a transferCall tool result", facts(), (m) => {
      m.artifact.messages.push({
        role: "tool_call_result",
        toolCallId: "x",
        name: "transferCall",
        result: "Transfer initiated.",
      });
      return m;
    }, "escalated"],
    [
      "locked beats not found",
      facts({ session: session(K, "locked", SLOANE.id), attempts: [miss()] }),
      (m) => m,
      "auth_failed",
    ],
    [
      "lookup misses and never verified",
      facts({ session: session(K, "none"), attempts: [miss(), miss()] }),
      (m) => withLlmOutcome(m, "resolved"),
      "not_found",
    ],
    [
      "verified with a status read beats the LLM",
      verifiedFacts(K),
      (m) => withLlmOutcome(m, "unsupported"),
      "resolved",
    ],
    [
      "verified after a miss, status read",
      facts({ session: session(K, "verified", TOBIAS.id), verifiedCustomer: TOBIAS, attempts: [miss(), statusOk()] }),
      (m) => m,
      "resolved",
    ],
    [
      "no_claims counts as a status read",
      facts({
        session: session(K, "verified", TOBIAS.id),
        verifiedCustomer: TOBIAS,
        attempts: [attempt(K, "get_claim_status", "other", "no_claims")],
      }),
      (m) => withLlmOutcome(m, "unsupported"),
      "resolved",
    ],
    ...(["claim_documents", "no_documents_needed", "claim_detail"] as const).map((code): [
      string,
      CallFacts,
      (m: VapiMessage) => VapiMessage,
      Outcome,
    ] => [
      `${code} counts as a status read`,
      facts({
        session: session(K, "verified", TOBIAS.id),
        verifiedCustomer: TOBIAS,
        attempts: [attempt(K, "get_claim_status", "other", code)],
      }),
      (m) => withLlmOutcome(m, "unsupported"),
      "resolved",
    ]),
    [
      "asking which claim is not a status read: the LLM decides",
      facts({
        session: session(K, "verified", TOBIAS.id),
        verifiedCustomer: TOBIAS,
        attempts: [attempt(K, "get_claim_status", "other", "claim_not_identified")],
      }),
      (m) => withLlmOutcome(m, "unsupported"),
      "unsupported",
    ],
    [
      "verified without a status read: the LLM decides",
      facts({ session: session(K, "verified", TOBIAS.id), verifiedCustomer: TOBIAS }),
      (m) => withLlmOutcome(m, "unsupported"),
      "unsupported",
    ],
    ["LLM outcome off the list falls through to resolved", facts(), (m) => {
      delete m.artifact.structuredOutputs;
      return withLlmOutcome(m, "in_progress");
    }, "resolved"],
    ["structured output outcome when structuredData has none", facts(), (m) => {
      delete m.analysis.structuredData;
      m.artifact.structuredOutputs = { a: { name: "claims_call", result: { outcome: "unsupported" } } };
      return m;
    }, "unsupported"],
    ["no caller turn at all is abandoned", facts(), (m) => {
      m = withLlmOutcome(m, "bogus");
      delete m.artifact.structuredOutputs;
      m.artifact.messages = m.artifact.messages.filter((x: any) => x.role !== "user");
      return m;
    }, "abandoned"],
    ["silence timeout with no server code is abandoned, whatever the LLM said", facts(), (m) => {
      m.endedReason = "silence-timed-out";
      return withLlmOutcome(m, "resolved");
    }, "abandoned"],
    ["max duration with no server code is abandoned, even after caller turns", facts(), (m) => {
      m.endedReason = "exceeded-max-duration";
      delete m.analysis.structuredData;
      delete m.artifact.structuredOutputs;
      return m;
    }, "abandoned"],
    ["max duration after a status read stays resolved: the codes say otherwise", verifiedFacts(K), (m) => {
      m.endedReason = "exceeded-max-duration";
      return m;
    }, "resolved"],
    [
      "silence timeout after an emergency stays emergency",
      facts({ escalations: [escalation(K, "emergency")] }),
      (m) => {
        m.endedReason = "silence-timed-out";
        return m;
      },
      "emergency",
    ],
  ];
  for (const [label, f, mutate, expected] of cases) {
    assertEquals(buildInteractionRow(mutate(fixture("full")), f).outcome, expected, label);
  }
});

Deno.test("outcome: escalated and emergency booleans follow the rows and transfers", () => {
  const rep = buildInteractionRow(fixture("full"), facts({ escalations: [escalation(FULL_ID, "representative")] }));
  assertEquals([rep.escalated, rep.emergency], [true, false]);
  const em = buildInteractionRow(fixture("emergency"), facts({ escalations: [escalation(FULL_ID, "emergency")] }));
  assertEquals([em.outcome, em.escalated, em.emergency], ["emergency", false, true]);
  const transfer = buildInteractionRow(fixture("escalation"), facts());
  assertEquals([transfer.outcome, transfer.escalated, transfer.emergency], ["escalated", true, false]);
});

Deno.test("name chain: the verified customer's name and number", () => {
  const row = buildInteractionRow(fixture("full"), verifiedFacts());
  assertEquals([row.customer_id, row.caller_name, row.caller_phone], [TOBIAS.id, "Tobias Halvorsen", "+16025550101"]);
});

Deno.test("name chain: an impostor who failed DOB is never labelled with the account holder's name", () => {
  const message = fixture("auth_failed");
  // the caller claimed the account holder's name; the structured output repeats it
  assertEquals(message.analysis.structuredData.caller_name, "Sloane Marchetti");
  const locked = facts({
    session: session(message.call!.id!, "locked", SLOANE.id),
    attempts: [
      attempt(message.call!.id!, "lookup_customer", "lookup_hit", "needs_dob"),
      attempt(message.call!.id!, "verify_identity", "dob_wrong", "auth_failed"),
      attempt(message.call!.id!, "verify_identity", "dob_wrong", "locked"),
    ],
  });
  const row = buildInteractionRow(message, locked);
  assertEquals([row.customer_id, row.caller_name, row.caller_phone], [null, UNKNOWN_CALLER, null]);
  assertEquals(row.outcome, "auth_failed");
  // even a customer row handed in by mistake is ignored unless the session verified that customer
  const mislabelled = buildInteractionRow(fixture("auth_failed"), { ...locked, verifiedCustomer: SLOANE });
  assertEquals([mislabelled.customer_id, mislabelled.caller_name], [null, UNKNOWN_CALLER]);
  // what the caller claimed stays in their own words (transcript, analysis_raw), never in the identity columns
  for (const k of ["caller_name", "customer_id", "caller_phone", "summary"] as const) {
    assertFalse(String(row[k]).includes("Marchetti"), k);
  }
});

Deno.test("name chain: structured caller_name for an unverified caller, else Unknown caller", () => {
  const notFound = fixture("not_found");
  const misses = facts({
    session: session(notFound.call!.id!, "none"),
    attempts: [
      attempt(notFound.call!.id!, "lookup_customer", "lookup_miss", "not_found"),
      attempt(notFound.call!.id!, "lookup_customer", "lookup_miss", "not_found_final"),
    ],
  });
  const row = buildInteractionRow(notFound, misses);
  assertEquals([row.caller_name, row.customer_id, row.outcome], ["Dana", null, "not_found"]);

  // two misses, then a different number found an account, and the caller never gave the date of birth:
  // an account was found, so the server does not force not_found; the analysis outcome stands (a report
  // whose analysis says resolved keeps it, where the old rule overrode it with not_found)
  const full = fixture("full");
  const foundLater = buildInteractionRow(
    full,
    facts({
      session: session(full.call!.id!, "phone_found"),
      attempts: [
        attempt(full.call!.id!, "lookup_customer", "lookup_miss", "not_found"),
        attempt(full.call!.id!, "lookup_customer", "lookup_miss", "not_found"),
        attempt(full.call!.id!, "lookup_customer", "lookup_hit", "needs_dob"),
      ],
    }),
  );
  assert(foundLater.outcome !== "not_found", `outcome ${foundLater.outcome}`);
  assertEquals(foundLater.caller_type, "existing");

  // structured outputs only (no analysis.structuredData)
  const so = buildInteractionRow(fixture("structured_outputs_only"), facts());
  assertEquals(so.caller_name, "Mara");

  for (
    const placeholder of ["unknown", "Unknown", "", "  ", "N/A", "Unknown caller", "{{caller_name}}", "602-555-0101"]
  ) {
    const m = fixture("structured_outputs_only");
    m.artifact.structuredOutputs = { a: { name: "claims_call", result: { caller_name: placeholder } } };
    assertEquals(buildInteractionRow(m, facts()).caller_name, UNKNOWN_CALLER, JSON.stringify(placeholder));
  }
});

// ---------------------------------------------------------------------------------------------
// Analysis fields.
// ---------------------------------------------------------------------------------------------
Deno.test("analysis_status: ok only with both summary and sentiment, else pending", () => {
  assertEquals(buildInteractionRow(fixture("full"), verifiedFacts()).analysis_status, "ok");
  const noSentiment = fixture("full");
  delete noSentiment.analysis.structuredData;
  delete noSentiment.artifact.structuredOutputs;
  const a = buildInteractionRow(noSentiment, verifiedFacts());
  assertEquals([a.summary !== null, a.sentiment, a.sentiment_source, a.analysis_status], [true, null, null, "pending"]);
  const noSummary = fixture("full");
  delete noSummary.analysis.summary;
  delete noSummary.summary;
  const b = buildInteractionRow(noSummary, verifiedFacts());
  assertEquals([b.summary, b.sentiment, b.analysis_status], [null, "positive", "pending"]);
});

Deno.test("sentiment: structuredData first ('vapi'), then structured outputs; off-list values are null", () => {
  const so = buildInteractionRow(fixture("structured_outputs_only"), facts());
  assertEquals([so.sentiment, so.sentiment_source, so.analysis_status], ["neutral", "structured_output", "ok"]);

  const cased = fixture("full");
  cased.analysis.structuredData.sentiment = " Negative ";
  assertEquals(buildInteractionRow(cased, facts()).sentiment, "negative");

  const offList = fixture("full");
  offList.analysis.structuredData.sentiment = "happy";
  offList.artifact.structuredOutputs = { a: { name: "claims_call", result: { sentiment: "ecstatic" } } };
  const row = buildInteractionRow(offList, facts());
  assertEquals([row.sentiment, row.sentiment_source, row.analysis_status], [null, null, "pending"]);

  // a structured output whose result is the bare value, named after the field
  const scalar = fixture("structured_outputs_only");
  scalar.artifact.structuredOutputs = { s: { name: "sentiment", result: "positive" } };
  assertEquals(buildInteractionRow(scalar, facts()).sentiment, "positive");
});

Deno.test("summary and analysis_raw are redacted; analysis_raw keeps the redacted copy, never the raw one", () => {
  const message = fixture("full");
  message.analysis.summary = "Tobias, born March 14, 1986, called from 602-555-0101 about his claim.";
  message.analysis.structuredData.notes = ["callback (602) 555 0101", { dob: "3/14/1986" }];
  const row = buildInteractionRow(message, verifiedFacts());
  assertEquals(row.summary, "Tobias, born [date of birth], called from [phone ending 0101] about his claim.");
  const raw = row.analysis_raw as Record<string, any>;
  assertEquals(raw.summary, row.summary);
  assertEquals(raw.structuredData.notes, ["callback [phone ending 0101]", { dob: "[date of birth]" }]);
  const stored = JSON.stringify(row);
  for (const leak of ["1986", "555-0101", "555 0101", "3/14"]) assertFalse(stored.includes(leak), leak);
  // the input is not modified
  assertStringIncludes(message.analysis.summary, "602-555-0101");
});

Deno.test("cost_breakdown: message.costBreakdown, else message.call.costBreakdown, else null; never 0 for an absent part", () => {
  const fromCall = fixture("full");
  fromCall.call!.costBreakdown = fromCall.costBreakdown;
  delete fromCall.costBreakdown;
  assertEquals(buildInteractionRow(fromCall, facts()).cost_breakdown, {
    stt: 0.0048,
    llm: 0.0112,
    tts: 0.0143,
    vapi: 0.0238,
    transport: 0,
    analysis: 0.0038,
    total: 0.0579,
  });

  const partial = fixture("partial");
  const p = buildInteractionRow(partial, facts()).cost_breakdown as Record<string, unknown>;
  assertEquals(p.analysis, null, "no analysisCostBreakdown");

  const sparse = fixture("full");
  sparse.costBreakdown = { stt: 0.01, total: 0.01, llmPromptTokens: 900 };
  assertEquals(buildInteractionRow(sparse, facts()).cost_breakdown, {
    stt: 0.01,
    llm: null,
    tts: null,
    vapi: null,
    transport: null,
    analysis: null,
    total: 0.01,
  });

  // token counts inside analysisCostBreakdown are counts, not dollars
  const tokens = fixture("full");
  tokens.costBreakdown.analysisCostBreakdown = { summary: 0.002, summaryPromptTokens: 5000, successEvaluation: 0.001 };
  assertEquals((buildInteractionRow(tokens, facts()).cost_breakdown as Record<string, unknown>).analysis, 0.003);

  assertEquals(buildInteractionRow(fixture("never_connected"), facts()).cost_breakdown, null);
});

Deno.test("integers: duration from durationSeconds, durationMs or the timestamps; latency rounded or null", () => {
  const ms = fixture("full");
  delete ms.durationSeconds;
  assertEquals(buildInteractionRow(ms, facts()).duration_seconds, 29);
  const stamps = fixture("full");
  delete stamps.durationSeconds;
  delete stamps.durationMs;
  assertEquals(buildInteractionRow(stamps, facts()).duration_seconds, 29);
  const none = fixture("full");
  delete none.durationSeconds;
  delete none.durationMs;
  delete none.startedAt;
  assertEquals(buildInteractionRow(none, facts()).duration_seconds, null);

  const latency = fixture("full");
  latency.artifact.performanceMetrics.turnLatencyAverage = "1403";
  assertEquals(buildInteractionRow(latency, facts()).latency_avg_ms, null);
  delete latency.artifact.performanceMetrics;
  assertEquals(buildInteractionRow(latency, facts()).latency_avg_ms, null);
});

Deno.test("timestamps come from the report only and must carry a zone", () => {
  const message = fixture("full");
  message.startedAt = "2026-10-12 15:02:11";
  message.endedAt = "yesterday";
  const row = buildInteractionRow(message, facts());
  assertEquals([row.started_at, row.ended_at], [null, null]);
});

Deno.test("never-connected report: nulls, Unknown caller, abandoned", () => {
  const row = buildInteractionRow(fixture("never_connected"), facts());
  assertEquals(row.vapi_call_id, NEVER_ID);
  assertEquals(row.caller_name, UNKNOWN_CALLER);
  assertEquals(row.outcome, "abandoned");
  for (
    const k of [
      "started_at",
      "duration_seconds",
      "summary",
      "sentiment",
      "transcript",
      "messages",
      "analysis_raw",
      "latency_avg_ms",
      "recording_url",
      "success_evaluation",
    ] as const
  ) {
    assertEquals(row[k], null, k);
  }
  assertEquals(row.ended_at, "2026-10-12T16:20:03.250Z");
  assertEquals(row.cost, 0);
  assertEquals(row.analysis_status, "pending");
});

Deno.test("recording_url: mono combinedUrl, else artifact.recordingUrl, else message.recordingUrl", () => {
  const m = fixture("full");
  const mono = m.artifact.recording.mono.combinedUrl;
  assertEquals(buildInteractionRow(m, facts()).recording_url, mono);
  delete m.artifact.recording;
  m.artifact.recordingUrl = "https://storage.vapi.ai/artifact.wav";
  assertEquals(buildInteractionRow(m, facts()).recording_url, "https://storage.vapi.ai/artifact.wav");
  delete m.artifact.recordingUrl;
  m.recordingUrl = "https://storage.vapi.ai/legacy.wav";
  assertEquals(buildInteractionRow(m, facts()).recording_url, "https://storage.vapi.ai/legacy.wav");
});

Deno.test("caller_phone: caller id for an unverified phone caller, never junk or our own number", () => {
  assertEquals(buildInteractionRow(fixture("escalation"), facts()).caller_phone, "+16025550104");
  assertEquals(buildInteractionRow(fixture("escalation"), facts(), ["+16025550104"]).caller_phone, null);
  const anonymous = fixture("escalation");
  anonymous.call!.customer = { number: "anonymous" };
  anonymous.customer = { number: "anonymous" };
  assertEquals(buildInteractionRow(anonymous, facts()).caller_phone, null);
  assertEquals(buildInteractionRow(fixture("structured_outputs_only"), facts()).caller_phone, null);
});

Deno.test("flags: computed from what the agent said and the server facts", () => {
  const m = fixture("structured_outputs_only");
  m.artifact.messages.push({
    role: "bot",
    message: "A representative will call you back this afternoon.",
    secondsFromStart: 33,
  });
  assertEquals(buildInteractionRow(m, facts()).flags, ["promised_callback_without_escalation"]);
  const backed = buildInteractionRow(m, facts({ escalations: [escalation(FULL_ID, "representative", "sent")] }));
  assertEquals(backed.flags, []);
  // a status read on a call that never verified
  assertEquals(buildInteractionRow(fixture("full"), facts()).flags, ["status_read_without_verified_identity"]);
});

Deno.test("buildMessages: result parsing, unknown codes, tool names, OpenAI-shaped and named assistant turns", () => {
  const out = buildMessages([
    { role: "assistant", content: "Hello from the Knowledge desk.", secondsFromStart: 2.4 },
    { role: "bot", message: "Back to you.", secondsFromStart: 3.6, assistantName: "Concierge" },
    { role: "tool_call_result", toolCallId: "a", name: "lookup_customer", result: "not json", secondsFromStart: 4 },
    {
      role: "tool_call_result",
      toolCallId: "b",
      name: "escalate",
      result: '{"code":"drop table"}',
      secondsFromStart: 5,
    },
    { role: "tool_call_result", toolCallId: "c", name: "<script>", result: '{"code":"rep_queued"}' },
    { role: "tool_call_result", toolCallId: "d", name: "get_claim_status", result: { code: "no_claims" } },
    { role: "user", message: "   " },
    {
      role: "tool_calls",
      toolCalls: [{ id: "a", function: { name: "lookup_customer", arguments: '{"phone":"6025550101"}' } }],
    },
    "junk",
    null,
  ]);
  assertEquals(out, [
    { role: "assistant", text: "Hello from the Knowledge desk.", t: 2 },
    { role: "assistant", text: "Back to you.", t: 4, name: "Concierge" },
    { role: "tool", tool: "lookup_customer", code: null, t: 4 },
    { role: "tool", tool: "escalate", code: null, t: 5 },
    { role: "tool", tool: "unknown", code: "rep_queued", t: null },
    { role: "tool", tool: "get_claim_status", code: "no_claims", t: null },
  ]);
  assertEquals(buildMessages(undefined), null);
  assertEquals(buildMessages([{ role: "system", message: "prompt" }]), null);
});

// ---------------------------------------------------------------------------------------------
// onEndOfCallReport.
// ---------------------------------------------------------------------------------------------
Deno.test("eocr: no call id is a 400 and writes nothing", async () => {
  const { store, deps, calls } = harness();
  const out = await onEndOfCallReport({ type: "end-of-call-report", call: { orgId: ORG } }, deps);
  assertEquals(out, { status: 400, body: { error: "missing_call_id" } });
  assertEquals(store.tables.call_interactions.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("eocr: full report writes the row from the stored facts and clears the live lines", async () => {
  const { store, deps, calls, background } = harness({ env: { VAPI_PRIVATE_KEY: PRIVATE_KEY } });
  await walkVerified(store);
  await store.insertTranscriptLine({ call_key: FULL_ID, role: "assistant", text: "Hello.", ts_ms: 1 });
  await store.insertTranscriptLine({ call_key: LIVE_ID, role: "assistant", text: "Another call.", ts_ms: 1 });

  const out = await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(out, { status: 200, body: {} });
  const row = interaction(store, FULL_ID);
  assertEquals(row.caller_name, "Tobias Halvorsen");
  assertEquals(row.customer_id, TOBIAS.id);
  assertEquals(row.outcome, "resolved");
  assertEquals(row.analysis_status, "ok");
  assertEquals(row.status, "completed");
  assertEquals(row.duration_seconds, 29);
  assertEquals(row.latency_avg_ms, 1403);
  assertEquals(row.flags, []);
  assertEquals(store.tables.transcript_lines.map((l) => l.call_key), [LIVE_ID]);
  // complete analysis: no backfill, no network
  assertEquals(background.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("eocr: partial then full; the full report completes the row", async () => {
  const { store, deps, calls } = harness();
  await walkVerified(store);
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  let row = interaction(store, FULL_ID);
  assertEquals([row.summary, row.sentiment, row.outcome], [null, null, "resolved"]);
  // no VAPI_PRIVATE_KEY: no backfill can run, so the status says so at once
  assertEquals(row.analysis_status, "missing");
  assertEquals(calls.length, 0);

  await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  row = interaction(store, FULL_ID);
  assertEquals([row.sentiment, row.sentiment_source, row.analysis_status], ["positive", "vapi", "ok"]);
  assertEquals(row.summary, fixture("full").analysis.summary);
  assertEquals((row.cost_breakdown as Record<string, unknown>).analysis, 0.0038);
});

function fetchedCallOf(report: Report) {
  return {
    id: FULL_ID,
    orgId: ORG,
    type: "webCall",
    status: "ended",
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    endedReason: report.endedReason,
    cost: report.cost,
    costBreakdown: report.costBreakdown,
    analysis: report.analysis,
    artifact: report.artifact,
  };
}

const COMPARED = ["summary", "sentiment", "sentiment_source", "caller_name", "messages", "transcript", "outcome"];

Deno.test("eocr: a partial after the full report cannot demote the row, with or without the backfill key", async () => {
  for (const env of [{ VAPI_PRIVATE_KEY: PRIVATE_KEY }, {}] as Partial<Env>[]) {
    const label = env.VAPI_PRIVATE_KEY ? "with VAPI_PRIVATE_KEY" : "without VAPI_PRIVATE_KEY";
    const { store, deps, calls, background, logs } = harness({ env, vapi: () => json(fetchedCallOf(fixture("full"))) });
    await walkVerified(store);
    await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
    const before = structuredClone(interaction(store, FULL_ID));
    assertEquals([before.analysis_status, before.sentiment_source], ["ok", "vapi"], label);

    // the partial also carries a shorter transcript, which the SQL merge would take
    const partial = fixture("partial");
    partial.artifact.transcript = "AI: Thanks for calling Observe Insurance claims. How can I help you today?";
    await store.insertTranscriptLine({ call_key: FULL_ID, role: "assistant", text: "Hello.", ts_ms: 1 });
    const out = await onEndOfCallReport(partial, deps, { backfillDelaysMs: ZEROS });
    assertEquals(out, { status: 200, body: {} }, label);
    const row = interaction(store, FULL_ID);
    for (const k of [...COMPARED, "analysis_status", "analysis_raw", "updated_at"]) {
      assertEquals(row[k], before[k], `${label}: ${k}`);
    }
    // nothing left to backfill, and the live lines are still cleared
    assertEquals([background.length, calls.length], [0, 0], label);
    assertEquals(store.tables.transcript_lines.length, 0, label);
    assert(logs.some((l) => l.event === "eocr_ignored" && l.reason === "row_already_complete"), label);
  }
});

Deno.test("eocr: a backfill that finishes after the full report landed leaves the full row alone", async () => {
  for (const vapi of [() => json(fetchedCallOf(fixture("full"))), () => json({ message: "Not Found" }, 404)]) {
    const { store, deps, settle, logs } = harness({ env: { VAPI_PRIVATE_KEY: PRIVATE_KEY }, vapi });
    await walkVerified(store);
    await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
    assertEquals(interaction(store, FULL_ID).analysis_status, "pending");
    await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
    const before = structuredClone(interaction(store, FULL_ID));

    await settle();
    const row = interaction(store, FULL_ID);
    assertEquals([row.analysis_status, row.sentiment, row.sentiment_source], ["ok", "positive", "vapi"]);
    for (const k of COMPARED) assertEquals(row[k], before[k], k);
    assert(logs.some((l) => l.event === "backfill" && l.result === "superseded"));
  }
});

Deno.test("eocr: a failed read of the stored status throws (5xx, VAPI redelivers) and writes nothing", async () => {
  const { store, deps } = harness();
  store.failNext("storedAnalysisStatus");
  await assertRejects(() => onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS }));
  assertEquals(store.tables.call_interactions.length, 0);
});

Deno.test("eocr: a duplicate delivery leaves one identical row", async () => {
  const { store, deps } = harness();
  await walkVerified(store);
  await onEndOfCallReport(fixture("full"), deps);
  const first = structuredClone(interaction(store, FULL_ID));
  await onEndOfCallReport(fixture("full"), deps);
  const second = interaction(store, FULL_ID);
  assertEquals(store.tables.call_interactions.length, 1);
  const { updated_at: _a, ...a } = first;
  const { updated_at: _b, ...b } = second;
  assertEquals(b, a);
});

Deno.test("eocr: a never-connected call is written as missing at once, with no backfill", async () => {
  const { store, deps, calls, background } = harness({ env: { VAPI_PRIVATE_KEY: PRIVATE_KEY } });
  const out = await onEndOfCallReport(fixture("never_connected"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(out.status, 200);
  const row = interaction(store, NEVER_ID);
  assertEquals([row.analysis_status, row.sentiment, row.outcome, row.caller_name], [
    "missing",
    null,
    "abandoned",
    UNKNOWN_CALLER,
  ]);
  assertEquals([row.started_at, row.cost_breakdown, row.status], [null, null, "incomplete"]);
  assertEquals(background.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("eocr backfill: analysis arriving after the first attempt -> backfilled, redacted, sourced 'backfill'", async () => {
  let n = 0;
  const { store, deps, calls, settle } = harness({
    env: { ...ALERT_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: () => {
      n++;
      if (n === 1) return json({ id: FULL_ID, status: "ended", analysis: {} });
      return json({
        id: FULL_ID,
        status: "ended",
        analysis: {
          summary: "Tobias (602-555-0101) checked his claims.",
          structuredData: { caller_name: "Tobias", sentiment: "neutral", outcome: "resolved" },
          successEvaluation: "true",
        },
      });
    },
  });
  await walkVerified(store);
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(interaction(store, FULL_ID).analysis_status, "pending");

  await settle();
  const row = interaction(store, FULL_ID);
  assertEquals(row.analysis_status, "backfilled");
  assertEquals([row.sentiment, row.sentiment_source], ["neutral", "backfill"]);
  assertEquals(row.summary, "Tobias ([phone ending 0101]) checked his claims.");
  assertEquals(row.status, "completed");

  assertEquals(calls.length, 2);
  for (const c of calls) {
    assertEquals(c.url, `https://api.vapi.ai/call/${FULL_ID}`);
    assertEquals(c.init.method, "GET");
    assertEquals(new Headers(c.init.headers).get("authorization"), `Bearer ${PRIVATE_KEY}`);
  }
});

Deno.test("eocr backfill: still nothing after every attempt -> missing, sentiment NULL", async () => {
  const { store, deps, calls, settle, logs } = harness({ env: { VAPI_PRIVATE_KEY: PRIVATE_KEY } });
  await walkVerified(store);
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  await settle();
  const row = interaction(store, FULL_ID);
  assertEquals([row.analysis_status, row.sentiment, row.sentiment_source, row.summary], ["missing", null, null, null]);
  assertEquals(calls.length, 3);
  assert(logs.some((l) => l.event === "backfill" && l.result === "missing" && l.attempts === 3));
});

Deno.test("eocr backfill: a summary without a sentiment is backfilled at once, sentiment NULL", async () => {
  const { store, deps, calls, settle, logs } = harness({
    env: { VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: () => json({ id: FULL_ID, status: "ended", analysis: { summary: "Tobias checked his claims." } }),
  });
  await walkVerified(store);
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  await settle();
  const row = interaction(store, FULL_ID);
  assertEquals([row.analysis_status, row.summary, row.sentiment, row.sentiment_source], [
    "backfilled",
    "Tobias checked his claims.",
    null,
    null,
  ]);
  // the summary ended the polling: one GET, not the whole schedule
  assertEquals(calls.length, 1);
  assert(logs.some((l) => l.event === "backfill" && l.result === "backfilled" && l.attempts === 1));
});

Deno.test("eocr backfill: network errors are survived and end as missing", async () => {
  const { store, deps, settle, logs } = harness({
    env: { VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: () => {
      throw new TypeError("connection reset");
    },
  });
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  await settle();
  assertEquals(interaction(store, FULL_ID).analysis_status, "missing");
  assert(logs.some((l) => l.event === "backfill_fetch_failed"));
});

Deno.test("eocr and backfill never send Telegram or email, even with a pending escalation on the call", async () => {
  const { store, deps, calls, settle } = harness({
    env: { ...ALERT_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: () => json({ id: FULL_ID, analysis: { summary: "A short call.", structuredData: { sentiment: "neutral" } } }),
  });
  await store.upsertEscalation({
    callKey: FULL_ID,
    kind: "representative",
    reason: "representative_requested",
    details: null,
    callbackPhone: null,
    callbackSource: "none",
    channel: "webCall",
    verified: false,
  });
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  await settle();
  assertEquals(interaction(store, FULL_ID).analysis_status, "backfilled");
  assertEquals(interaction(store, FULL_ID).outcome, "escalated");
  const hosts = calls.map((c) => new URL(c.url).hostname);
  assertFalse(hosts.includes("api.telegram.org"));
  assertFalse(hosts.includes("api.resend.com"));
  assertEquals(new Set(hosts), new Set(["api.vapi.ai"]));
  assertEquals(store.tables.escalations[0].alert_status, "pending");
  assertEquals(store.tables.emails.length, 0);
});

Deno.test("eocr: the default backfill schedule is 5, 15 and 45 seconds", () => {
  assertEquals([...BACKFILL_DELAYS_MS], [5000, 15000, 45000]);
});

Deno.test("eocr: a failed facts read throws (5xx, VAPI redelivers) and writes nothing", async () => {
  const { store, deps } = harness();
  store.failNext("listEscalations");
  await assertRejects(() => onEndOfCallReport(fixture("full"), deps));
  assertEquals(store.tables.call_interactions.length, 0);
});

Deno.test("eocr: a failed transcript cleanup is logged and the report still succeeds", async () => {
  const { store, deps, logs } = harness();
  store.failNext("deleteTranscriptLines");
  const out = await onEndOfCallReport(fixture("structured_outputs_only"), deps);
  assertEquals(out.status, 200);
  assert(interaction(store, "3f6c1a2e-7b4d-4e8a-9c01-5d2e8f0a1b03"));
  assert(logs.some((l) => l.step === "deleteTranscriptLines"));
});

Deno.test("eocr: every fixture produces a row the database accepts", async () => {
  for (const name of FIXTURE_NAMES) {
    const { store, deps } = harness();
    const out = await onEndOfCallReport(fixture(name), deps, { backfillDelaysMs: ZEROS });
    assertEquals(out.status, 200, name);
    const row = interaction(store, fixture(name).call!.id!);
    assert(row, name);
    assertFalse(JSON.stringify(row.messages ?? []).includes("arguments"), name);
  }
});

Deno.test("eocr through the handler: Bearer, org check, 200 {} and the stored row", async () => {
  const { store, deps } = harness();
  await walkVerified(store);
  const res = await handle(
    new Request("https://example.supabase.co/functions/v1/vapi-webhook", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body("full")),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {});
  assertEquals(interaction(store, FULL_ID).caller_name, "Tobias Halvorsen");
});

// ---------------------------------------------------------------------------------------------
// The call log: a row that has ended is queued for Airtable and tried once off the request path.
// ---------------------------------------------------------------------------------------------
const AIRTABLE_ENV: Partial<Env> = { AIRTABLE_TOKEN: "pat_post_call_test", AIRTABLE_BASE_ID: "appPOSTCALL" };

function queuedRow(store: FakeStore, callKey: string) {
  const rows = store.tables.outbox_events.filter((o) => o.ref_id === callKey);
  assert(rows.length <= 1, "one outbox row per call");
  return rows[0];
}

Deno.test("call log: a completed report is queued in the request and the fast path delivers it in the background", async () => {
  const { store, deps, calls, background, settle } = harness({
    env: AIRTABLE_ENV,
    airtable: () => json({ records: [{ id: "recFULL" }], createdRecords: ["recFULL"] }),
  });
  await walkVerified(store);
  const out = await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(out, { status: 200, body: {} });
  const queued = queuedRow(store, FULL_ID);
  assertEquals([queued.kind, queued.destination], ["interaction.completed", "airtable"]);
  assertEquals(background.length, 1, "delivery runs through waitUntil, never on the request path");

  await settle();
  assertEquals(calls.map((c) => c.url), ["https://api.airtable.com/v0/appPOSTCALL/Call%20Log"]);
  const fields = JSON.parse(String(calls[0].init.body)).records[0].fields;
  assertEquals([fields["Call ID"], fields["Caller Name"], fields["Outcome"]], [
    FULL_ID,
    "Tobias Halvorsen",
    "resolved",
  ]);
  assertEquals(fields["Analysis Status"], "ok");
  assertFalse(JSON.stringify(fields).includes("6025550101"), "the caller's number never crosses whole");
  assertEquals([queued.attempts, queued.external_id, queued.last_error], [1, "recFULL", null]);
  assert(queued.delivered_at);
});

Deno.test("call log: through the handler a completed report answers 200 and is delivered after the response", async () => {
  const { store, deps, calls, settle } = harness({ env: AIRTABLE_ENV });
  await walkVerified(store);
  const res = await handle(
    new Request("https://example.supabase.co/functions/v1/vapi-webhook", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body("full")),
    }),
    deps,
  );
  assertEquals([res.status, await res.json()], [200, {}]);
  await settle();
  assertEquals(calls.length, 1);
  assert(queuedRow(store, FULL_ID).delivered_at);
});

Deno.test("call log: stubs, live lines, a report without an end time and an ignored partial queue nothing", async () => {
  const { store, deps, calls, background, settle } = harness({ env: AIRTABLE_ENV });
  await onStatusUpdate(statusUpdate("in-progress"), deps);
  await onTranscript(liveLine("assistant", "Thanks for calling Observe Insurance claims."), deps);
  assert(store.tables.call_interactions.length > 0, "the stub rows were written");
  const noEnd = fixture("partial");
  delete noEnd.endedAt;
  await onEndOfCallReport(noEnd, deps, { backfillDelaysMs: ZEROS });
  assertEquals(interaction(store, FULL_ID).ended_at, null);
  assertEquals(store.tables.outbox_events.length, 0);
  assertEquals([background.length, calls.length], [0, 0]);

  // the full report queues the call once; a partial that arrives after it is ignored and re-arms nothing
  await walkVerified(store);
  await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  await settle();
  const before = structuredClone(queuedRow(store, FULL_ID));
  assertEquals([before.attempts, before.external_id], [1, "rec_test_1"]);
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(queuedRow(store, FULL_ID), before);
  assertEquals([background.length, calls.length], [0, 1]);
});

Deno.test("call log: the fast path delivers only the call's own row; an older backlog row is left to the job", async () => {
  const { store, deps, calls, settle, logs } = harness({ env: AIRTABLE_ENV });
  await store.upsertInteraction({ vapi_call_id: LIVE_ID, ended_at: "2026-10-12T14:00:00Z", outcome: "resolved" });
  await store.enqueueOutbox("interaction.completed", LIVE_ID); // waiting since an Airtable outage
  await walkVerified(store);
  await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  await settle();
  assertEquals(calls.map((c) => JSON.parse(String(c.init.body)).records[0].fields["Call ID"]), [FULL_ID]);
  assert(queuedRow(store, FULL_ID).delivered_at);
  assertEquals([queuedRow(store, LIVE_ID).attempts, queuedRow(store, LIVE_ID).delivered_at], [0, null]);
  assert(logs.some((l) => l.event === "outbox_fast_path" && l.call_key === FULL_ID && l.delivered === 1));
});

Deno.test("call log: a failed enqueue is logged and the report still answers 200 with the row written", async () => {
  const { store, deps, background, logs } = harness({ env: AIRTABLE_ENV });
  await walkVerified(store);
  store.failNext("enqueueOutbox");
  const out = await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(out, { status: 200, body: {} });
  assertEquals(interaction(store, FULL_ID).analysis_status, "ok");
  assertEquals(store.tables.outbox_events.length, 0);
  assertEquals(background.length, 0, "nothing queued, so no fast path");
  const failed = logs.find((l) => l.event === "outbox_enqueue_failed");
  assertEquals([failed?.call_key, failed?.source], [FULL_ID, "end-of-call-report"]);

  // and through the handler the same failure is still a 200 for VAPI
  store.failNext("enqueueOutbox");
  const res = await handle(
    new Request("https://example.supabase.co/functions/v1/vapi-webhook", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body("full")),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("call log: a failed fast path is only logged; the row stays queued for the every-minute job", async () => {
  const { store, deps, settle, logs } = harness({ env: AIRTABLE_ENV, airtable: () => json({ error: "X" }, 503) });
  await walkVerified(store);
  store.failNext("claimOutbox");
  const out = await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(out.status, 200);
  await settle();
  assert(logs.some((l) => l.event === "outbox_fast_path_failed"));
  assertEquals([queuedRow(store, FULL_ID).attempts, queuedRow(store, FULL_ID).delivered_at], [0, null]);
});

Deno.test("call log: the backfill re-arms a delivered row, so the improved record is delivered again", async () => {
  let t = NOW.getTime();
  const { store, deps, settle } = harness({
    store: createFakeStore(undefined, { now: () => new Date(t) }),
    env: { VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: () => json(fetchedCallOf(fixture("full"))),
  });
  await walkVerified(store);
  await onEndOfCallReport(fixture("partial"), deps, { backfillDelaysMs: ZEROS });
  const queued = queuedRow(store, FULL_ID);
  assertEquals(interaction(store, FULL_ID).analysis_status, "pending");
  // as if the first version had already gone out
  Object.assign(queued, { delivered_at: "2026-10-12T15:03:00.000Z", attempts: 1, external_id: "recFULL" });

  await settle();
  assertEquals(interaction(store, FULL_ID).analysis_status, "backfilled");
  assertEquals([queued.delivered_at, queued.attempts, queued.external_id], [null, 0, "recFULL"]);

  const sent: Record<string, unknown>[] = [];
  deps.env = { ...deps.env, ...AIRTABLE_ENV };
  deps.fetch = ((_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).records[0].fields);
    return Promise.resolve(json({ records: [{ id: "recFULL" }] }));
  }) as unknown as typeof fetch;
  // the re-arm holds the row for the lease, so a delivery of the old version has finished first
  assertEquals(await deliverOutbox(deps, { deadlineMs: 8000 }), { delivered: 0, retried: 0, dead: 0, errors: 0 });
  t += OUTBOX_LEASE_MS + 1000;
  const counts = await deliverOutbox(deps, { deadlineMs: 8000 });
  assertEquals(counts, { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(sent.map((f) => f["Analysis Status"]), ["backfilled"]);
  assertEquals(sent[0]["Summary"], fixture("full").analysis.summary);
});

// ---------------------------------------------------------------------------------------------
// onTranscript.
// ---------------------------------------------------------------------------------------------
function liveLine(role: string, transcript: string, timestamp?: number, extra: Partial<VapiMessage> = {}): VapiMessage {
  return {
    type: 'transcript[transcriptType="final"]',
    transcriptType: "final",
    role,
    transcript,
    ...(timestamp === undefined ? {} : { timestamp }),
    call: { id: LIVE_ID, orgId: ORG, type: "webCall" },
    ...extra,
  };
}

Deno.test("transcript: a partial transcript writes nothing", async () => {
  const { store, deps } = harness();
  await onTranscript(liveLine("user", "my number is", 1000, { transcriptType: "partial", type: "transcript" }), deps);
  assertEquals(store.tables.transcript_lines.length, 0);
  assertEquals(store.tables.call_interactions.length, 0);
});

Deno.test("transcript: both message.type literals are accepted and routed by the handler", async () => {
  const direct = harness();
  await onTranscript(liveLine("assistant", "Hello.", 1000, { type: "transcript" }), direct.deps);
  await onTranscript(liveLine("user", "Hi.", 2000, { type: 'transcript[transcriptType="final"]' }), direct.deps);
  assertEquals(direct.store.tables.transcript_lines.map((l) => l.text), ["Hello.", "Hi."]);

  const routed = harness();
  for (const [type, ts] of [["transcript", 1000], ['transcript[transcriptType="final"]', 2000]] as const) {
    const res = await handle(
      new Request("https://example.supabase.co/functions/v1/vapi-webhook", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: liveLine("assistant", `Line at ${ts}.`, ts, { type }) }),
      }),
      routed.deps,
    );
    assertEquals(res.status, 200, type);
    await res.body?.cancel();
  }
  assertEquals(routed.store.tables.transcript_lines.map((l) => l.ts_ms), [1000, 2000]);
});

Deno.test("transcript: the first line writes the stub row so the live call shows at once", async () => {
  const { store, deps } = harness();
  await onTranscript(liveLine("assistant", "Thanks for calling Observe Insurance claims.", 1000), deps);
  const row = interaction(store, LIVE_ID);
  assertEquals([row.outcome, row.channel, row.started_at, row.ended_at], [
    "in_progress",
    "webCall",
    NOW.toISOString(),
    null,
  ]);
  assertEquals(row.status, "in_progress");
  await onTranscript(liveLine("user", "Hi.", 2000), deps);
  assertEquals(store.tables.call_interactions.length, 1);
});

Deno.test("transcript: ts_ms is the rounded timestamp, else the clock; other roles and missing call ids are dropped", async () => {
  const { store, deps, logs } = harness();
  await onTranscript(liveLine("assistant", "One.", 1792076535123.6), deps);
  await onTranscript(liveLine("assistant", "Two."), deps);
  assertEquals(store.tables.transcript_lines.map((l) => l.ts_ms), [1792076535124, NOW.getTime()]);

  await onTranscript(liveLine("system", "prompt", 3000), deps);
  await onTranscript(liveLine("assistant", "   ", 4000), deps);
  await onTranscript({ ...liveLine("user", "Hello", 5000), call: undefined }, deps);
  assertEquals(store.tables.transcript_lines.length, 2);
  assert(logs.some((l) => l.event === "transcript_dropped" && l.reason === "missing_call_id"));
});

Deno.test("transcript: lines are redacted; the read-back question masks the next answer", async () => {
  const { store, deps } = harness();
  await onTranscript(
    liveLine(
      "assistant",
      "I'm not finding an account under six zero two... five five five... zero one nine nine. Is that the right number?",
      1000,
    ),
    deps,
  );
  await onTranscript(liveLine("user", "Yes, six zero two, five five five, zero one nine nine.", 2000), deps);
  await onTranscript(liveLine("assistant", "Okay.", 3000), deps);
  await onTranscript(liveLine("user", "I was born on May 9, 1990 if that helps.", 4000), deps);
  assertEquals(store.tables.transcript_lines.map((l) => l.text), [
    "I'm not finding an account under [phone ending 0199]. Is that the right number?",
    MASKED_ANSWER,
    "Okay.",
    "I was born on [date of birth] if that helps.",
  ]);
});

Deno.test("transcript: a line VAPI delivers after the report closed the call is dropped, not stored without its mask", async () => {
  const { store, deps, logs } = harness();
  await walkVerified(store);
  const onFull: Partial<VapiMessage> = { call: { id: FULL_ID, orgId: ORG, type: "webCall" } };
  await onTranscript(liveLine("assistant", "Could you tell me your date of birth?", 1000, onFull), deps);
  await onEndOfCallReport(fixture("full"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(store.tables.transcript_lines.length, 0, "the report cleared the live lines");
  // the answer arrives late, and the question that would have masked it went with the cleared lines
  await onTranscript(liveLine("user", "march fourteenth nineteen eighty six", 2000, onFull), deps);
  await onTranscript(liveLine("assistant", "Thank you.", 3000, onFull), deps);
  assertEquals(store.tables.transcript_lines.length, 0);
  assert(logs.some((l) => l.event === "transcript_dropped" && l.reason === "call_ended" && l.call_key === FULL_ID));
  // a call still on gets its first line and its stub row as before
  await onTranscript(liveLine("user", "Hello?", 1000), deps);
  assertEquals(store.tables.transcript_lines.map((l) => [l.call_key, l.text]), [[LIVE_ID, "Hello?"]]);
  assertEquals(interaction(store, LIVE_ID).ended_at, null);
});

Deno.test("transcript: when the call's end cannot be read, a caller line with no question before it is withheld", async () => {
  const { store, deps, logs } = harness();
  store.failNext("interactionEnded");
  await onTranscript(liveLine("user", "march fourteenth", 1000), deps);
  assertEquals(store.tables.transcript_lines.map((l) => l.text), [MASKED_ANSWER]);
  assert(logs.some((l) => l.event === "post_call_error" && l.step === "interactionEnded"));
  assert(interaction(store, LIVE_ID), "the stub row is still written");
});

Deno.test("transcript: when the previous question cannot be read, a caller line is withheld", async () => {
  const { store, deps } = harness();
  await onTranscript(liveLine("assistant", "How can I help?", 1000), deps);
  store.failNext("lastAssistantLine");
  await onTranscript(liveLine("user", "march fourteenth", 2000), deps);
  assertEquals(store.tables.transcript_lines.at(-1)?.text, MASKED_ANSWER);
});

// ---------------------------------------------------------------------------------------------
// onStatusUpdate.
// ---------------------------------------------------------------------------------------------
function statusUpdate(status: string, extra: Partial<VapiMessage> = {}): VapiMessage {
  return {
    type: "status-update",
    status,
    call: { id: PHONE_CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "+16025550104" } },
    ...extra,
  };
}

Deno.test("status-update in-progress: session and stub row", async () => {
  const { store, deps } = harness();
  await onStatusUpdate(statusUpdate("in-progress"), deps);
  const s = store.tables.call_sessions.find((x) => x.call_key === PHONE_CALL_ID);
  assertEquals([s?.channel, s?.caller_number, s?.level], ["inboundPhoneCall", "+16025550104", "none"]);
  const row = interaction(store, PHONE_CALL_ID);
  assertEquals([row.outcome, row.caller_phone, row.started_at, row.channel], [
    "in_progress",
    "+16025550104",
    NOW.toISOString(),
    "inboundPhoneCall",
  ]);
  // a redelivery changes nothing
  await onStatusUpdate(statusUpdate("in-progress"), deps);
  assertEquals(store.tables.call_interactions.length, 1);
  assertEquals(store.tables.call_sessions.length, 1);
});

Deno.test("status-update: ended and other statuses are ignored; no call id is dropped", async () => {
  const { store, deps, calls, logs } = harness();
  for (const s of ["ended", "ringing", "queued", "scheduled"]) await onStatusUpdate(statusUpdate(s), deps);
  await onStatusUpdate({ type: "status-update", status: "in-progress" }, deps);
  assertEquals(store.tables.call_interactions.length, 0);
  assertEquals(store.tables.call_sessions.length, 0);
  assertEquals(calls.length, 0);
  assert(logs.some((l) => l.event === "status_update_dropped"));
});

Deno.test("status-update in-progress: a failed write throws after both writes were tried", async () => {
  const { store, deps } = harness();
  store.failNext("ensureInteraction");
  await assertRejects(() => onStatusUpdate(statusUpdate("in-progress"), deps));
  assertEquals(store.tables.call_sessions.length, 1);
});

Deno.test("status-update forwarding: escalation row from caller id, Telegram and the callback email, once", async () => {
  const { store, deps, calls } = harness({ env: ALERT_ENV });
  await onStatusUpdate(statusUpdate("forwarding", { destination: { type: "number", number: "+18005550142" } }), deps);
  const rows = store.tables.escalations;
  assertEquals(rows.length, 1);
  assertEquals(
    [rows[0].kind, rows[0].reason, rows[0].callback_phone, rows[0].callback_source, rows[0].channel],
    ["representative", "representative_requested", "+16025550104", "caller_id", "inboundPhoneCall"],
  );
  assertEquals([rows[0].alert_status, rows[0].delivery_error, rows[0].verified], ["sent", null, false]);

  const telegram = calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
  const resend = calls.filter((c) => c.url === "https://api.resend.com/emails");
  assertEquals([telegram.length, resend.length], [1, 1]);
  const text = JSON.parse(String(telegram[0].init.body)).text as string;
  assertStringIncludes(text, "representative");
  for (const leak of ["0104", "602", "555"]) assertFalse(text.includes(leak), leak);
  assertEquals(new Headers(resend[0].init.headers).get("idempotency-key"), `${PHONE_CALL_ID}:callback_request`);
  assertEquals(store.tables.emails.map((e) => [e.kind, e.status]), [["callback_request", "sent"]]);

  // a redelivery (or escalate on the same call) finds the row and alerts nobody again
  await onStatusUpdate(statusUpdate("forwarding"), deps);
  assertEquals(calls.length, 2);
  assertEquals(store.tables.escalations.length, 1);
});

Deno.test("status-update forwarding: both channels down -> alert_status failed with both errors", async () => {
  const { store, deps } = harness({
    env: ALERT_ENV,
    telegram: () => json({ ok: false, description: "Bad Request: chat not found" }, 400),
    resend: () => json({ message: "Service unavailable" }, 503),
  });
  await onStatusUpdate(statusUpdate("forwarding"), deps);
  const row = store.tables.escalations[0];
  assertEquals(row.alert_status, "failed");
  assertStringIncludes(row.delivery_error, "telegram: telegram 400");
  assertStringIncludes(row.delivery_error, "email: resend 503");
  assertEquals(store.tables.emails[0].status, "failed");
});

Deno.test("status-update forwarding: the session decides the reason, as in escalate", async () => {
  const locked = harness({ env: ALERT_ENV });
  await locked.store.lookupCustomerAttempt({
    callKey: PHONE_CALL_ID,
    channel: "inboundPhoneCall",
    phoneE164: SLOANE.phone_e164,
    toolCallId: "l1",
    callerNumber: null,
  });
  await locked.store.verifyDobAttempt({ callKey: PHONE_CALL_ID, year: 1990, month: 5, day: 9, toolCallId: "v1" });
  await locked.store.verifyDobAttempt({ callKey: PHONE_CALL_ID, year: 1979, month: 11, day: 2, toolCallId: "v2" });
  await onStatusUpdate(statusUpdate("forwarding"), locked.deps);
  assertEquals(locked.store.tables.escalations[0].reason, "auth_locked");

  const missed = harness({ env: ALERT_ENV });
  await missed.store.lookupCustomerAttempt({
    callKey: PHONE_CALL_ID,
    channel: "inboundPhoneCall",
    phoneE164: "+16025550199",
    toolCallId: "l1",
    callerNumber: null,
  });
  await onStatusUpdate(statusUpdate("forwarding"), missed.deps);
  assertEquals(missed.store.tables.escalations[0].reason, "not_found");
});

Deno.test("status-update forwarding: a database error throws so VAPI redelivers", async () => {
  const { store, deps, calls } = harness({ env: ALERT_ENV });
  store.failNext("upsertEscalation");
  await assertRejects(() => onStatusUpdate(statusUpdate("forwarding"), deps));
  assertEquals(calls.length, 0, "no alert without a row");
});

Deno.test("status-update forwarding never overwrites the number or the details the caller gave to escalate", async () => {
  const { store, deps, calls } = harness({ env: ALERT_ENV });
  const escalated = await store.upsertEscalation({
    callKey: PHONE_CALL_ID,
    kind: "representative",
    reason: "representative_requested",
    details: "Needs help with the kitchen claim",
    callbackPhone: "+16025550177",
    callbackSource: "argument",
    channel: "inboundPhoneCall",
    verified: false,
  });
  await store.setEscalationDelivery(escalated.id, "sent", null);

  await onStatusUpdate(statusUpdate("forwarding"), deps);
  const rows = store.tables.escalations;
  assertEquals(rows.length, 1);
  assertEquals([rows[0].callback_phone, rows[0].callback_source, rows[0].details, rows[0].alert_status], [
    "+16025550177",
    "argument",
    "Needs help with the kitchen claim",
    "sent",
  ]);
  assertEquals(calls.length, 0, "escalate already told the team");
});

Deno.test("status-update forwarding: a failed second write still alerts, with the caller id in the email", async () => {
  const { store, deps, calls, logs } = harness({ env: ALERT_ENV });
  const upsert = store.upsertEscalation;
  let writes = 0;
  store.upsertEscalation = (p) => (++writes === 2 ? Promise.reject(new Error("connection reset")) : upsert(p));
  await onStatusUpdate(statusUpdate("forwarding"), deps);
  const row = store.tables.escalations[0];
  assertEquals([row.callback_phone, row.details, row.alert_status], [null, null, "sent"]);
  const resend = calls.filter((c) => c.url === "https://api.resend.com/emails");
  assertEquals(resend.length, 1);
  assertStringIncludes(JSON.parse(String(resend[0].init.body)).html, "0104");
  assert(logs.some((l) => l.event === "post_call_error" && l.step === "upsertEscalation"));
});

// ---------------------------------------------------------------------------------------------
// Who called: the confirmed captured name in the chain, caller_type, caller_email, caller_phone.
// ---------------------------------------------------------------------------------------------
const NOT_FOUND_ID = "3f6c1a2e-7b4d-4e8a-9c01-5d2e8f0a1b07";

function contact(callKey: string, over: Partial<CallerContact> = {}): CallerContact {
  return {
    call_key: callKey,
    kind: "new_customer",
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: "+16025550177",
    callback_source: "argument",
    customer_id: null,
    confirmed: true,
    confirmed_at: "2026-10-12T14:59:00Z",
    ...over,
  };
}

function newCallerFacts(c: CallerContact | null): PostCallFacts {
  return {
    ...facts({
      session: session(NOT_FOUND_ID, "none"),
      attempts: [
        attempt(NOT_FOUND_ID, "lookup_customer", "lookup_miss", "not_found"),
        attempt(NOT_FOUND_ID, "lookup_customer", "lookup_miss", "not_found_final"),
      ],
    }),
    contact: c,
  };
}

Deno.test("name chain: a new caller's confirmed name comes before the analysis' name; type new; their email", () => {
  const row = buildInteractionRow(fixture("not_found"), newCallerFacts(contact(NOT_FOUND_ID)));
  assertEquals([row.caller_name, row.caller_type, row.caller_email, row.customer_id, row.outcome], [
    "Jane Doe",
    "new",
    "jane.doe@gmail.com",
    null,
    "not_found",
  ]);
  // a web call has no caller id: the number they gave with their details stands in
  assertEquals(row.caller_phone, "+16025550177");

  // unconfirmed: the analysis' name, still a new caller, and no address in the record
  const unconfirmed = buildInteractionRow(
    fixture("not_found"),
    newCallerFacts(contact(NOT_FOUND_ID, { confirmed: false, confirmed_at: null })),
  );
  assertEquals([unconfirmed.caller_name, unconfirmed.caller_type, unconfirmed.caller_email], ["Dana", "new", null]);

  // no capture at all: unknown, as before
  const none = buildInteractionRow(fixture("not_found"), newCallerFacts(null));
  assertEquals([none.caller_name, none.caller_type, none.caller_email], ["Dana", "unknown", null]);
  assertEquals(buildInteractionRow(fixture("never_connected"), facts()).caller_type, "unknown");
});

Deno.test("name chain: the verified name wins; a pending email update is the record's email, never the account's", () => {
  const verified: PostCallFacts = {
    ...verifiedFacts(),
    contact: contact(FULL_ID, {
      kind: "email_update",
      first_name: "Tobias",
      last_name: "Halvorsen",
      customer_id: TOBIAS.id,
      email: "tobias.new@gmail.com",
    }),
  };
  const row = buildInteractionRow(fixture("full"), verified);
  assertEquals([row.caller_name, row.caller_type, row.caller_email, row.caller_phone], [
    "Tobias Halvorsen",
    "existing",
    "tobias.new@gmail.com",
    "+16025550101",
  ]);
  // the customer's on-file email is never written to the call record
  const plain = buildInteractionRow(fixture("full"), verifiedFacts());
  assertEquals([plain.caller_type, plain.caller_email], ["existing", null]);
  assertFalse(JSON.stringify(plain).includes(String(TOBIAS.email)));
});

Deno.test("name chain: a name captured next to an account the caller did not verify is not used", () => {
  const message = fixture("auth_failed");
  const id = message.call!.id!;
  const locked: PostCallFacts = {
    ...facts({
      session: session(id, "locked", SLOANE.id),
      attempts: [
        attempt(id, "lookup_customer", "lookup_hit", "needs_dob"),
        attempt(id, "verify_identity", "dob_wrong", "auth_failed"),
        attempt(id, "verify_identity", "dob_wrong", "locked"),
      ],
    }),
    contact: contact(id, { first_name: "Sloane", last_name: "Marchetti" }),
  };
  const row = buildInteractionRow(message, locked);
  // the session reached an account, so the caller is an existing customer, but not that name
  assertEquals([row.caller_name, row.caller_type, row.customer_id], [UNKNOWN_CALLER, "existing", null]);
  // nor the address or number they gave: an attacker's details never sit on that account's record
  // (and so never reach the call log mirror's Email field)
  assertEquals([row.caller_email, row.caller_phone], [null, null]);
  // a phone_found session is existing too
  const found = buildInteractionRow(fixture("not_found"), {
    ...facts({ session: session(NOT_FOUND_ID, "phone_found", SLOANE.id) }),
    contact: null,
  });
  assertEquals(found.caller_type, "existing");
});

Deno.test("eocr: a new caller's capture lands in the stored row and the call log mirror", async () => {
  const { store, deps, calls, settle } = harness({
    env: { AIRTABLE_TOKEN: "pat_test", AIRTABLE_BASE_ID: "appTEST" },
  });
  for (const id of ["t1", "t2"]) {
    await store.lookupCustomerAttempt({
      callKey: NOT_FOUND_ID,
      channel: "webCall",
      phoneE164: "+16025550199",
      toolCallId: id,
      callerNumber: null,
    });
  }
  await store.upsertContact({
    callKey: NOT_FOUND_ID,
    kind: "new_customer",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@gmail.com",
    callbackPhone: "+16025550177",
    callbackSource: "argument",
    customerId: null,
  });
  await store.setContactConfirmed(NOT_FOUND_ID, true);
  const out = await onEndOfCallReport(fixture("not_found"), deps, { backfillDelaysMs: ZEROS });
  assertEquals(out.status, 200);
  await settle();
  const row = interaction(store, NOT_FOUND_ID);
  assertEquals(
    [row.caller_name, row.caller_type, row.caller_email, row.caller_email_masked, row.caller_phone],
    ["Jane Doe", "new", "jane.doe@gmail.com", "j***@gmail.com", "+16025550177"],
  );
  const airtable = calls.filter((c) => c.url.startsWith("https://api.airtable.com/"));
  assertEquals(airtable.length, 1);
  const fields = JSON.parse(String(airtable[0].init.body)).records[0].fields;
  assertEquals([fields["Caller Name"], fields["Caller Type"], fields["Email"], fields["Caller Phone"]], [
    "Jane Doe",
    "new",
    "jane.doe@gmail.com",
    "ending 0177",
  ]);
});

Deno.test("eocr: a failed contact read throws (5xx, VAPI redelivers) and writes nothing", async () => {
  const { store, deps } = harness();
  store.failNext("getContact");
  await assertRejects(() => onEndOfCallReport(fixture("not_found"), deps, { backfillDelaysMs: ZEROS }));
  assertEquals(store.tables.call_interactions.length, 0);
});

Deno.test("status-update forwarding: the callback email names a caller who confirmed their details", async () => {
  const { store, deps, calls } = harness({ env: ALERT_ENV });
  await store.upsertContact({
    callKey: PHONE_CALL_ID,
    kind: "new_customer",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@gmail.com",
    callbackPhone: null,
    callbackSource: "caller_id",
    customerId: null,
  });
  await store.setContactConfirmed(PHONE_CALL_ID, true);
  await onStatusUpdate(statusUpdate("forwarding"), deps);
  const resend = calls.filter((c) => c.url === "https://api.resend.com/emails");
  const html = JSON.parse(String(resend[0].init.body)).html as string;
  assertStringIncludes(html, "Jane Doe (caller-provided, unverified)");
  assertStringIncludes(html, "jane.doe@gmail.com");
  assertStringIncludes(html, "(602) 555-0104 (+16025550104)");
  const text = JSON.parse(String(calls.find((c) => c.url.startsWith("https://api.telegram.org/"))!.init.body)).text;
  for (const leak of ["Jane", "Doe", "@", "0104"]) assertFalse(String(text).includes(leak), leak);
});

Deno.test("status-update forwarding: a number the caller said with their details beats the caller id", async () => {
  // "Is the number you're calling from the best one to reach you?" "No, it's six zero two..."
  const { store, deps, calls } = harness({ env: ALERT_ENV });
  await store.upsertContact({
    callKey: PHONE_CALL_ID,
    kind: "new_customer",
    firstName: "Jane",
    lastName: "Doe",
    email: null,
    callbackPhone: "+16025550177",
    callbackSource: "argument",
    customerId: null,
  });
  await store.setContactConfirmed(PHONE_CALL_ID, true);
  await onStatusUpdate(statusUpdate("forwarding"), deps);
  const [row] = store.tables.escalations;
  assertEquals([row.callback_phone, row.callback_source], ["+16025550177", "argument"]);
  const resend = calls.filter((c) => c.url === "https://api.resend.com/emails");
  const html = JSON.parse(String(resend[0].init.body)).html as string;
  assertStringIncludes(html, "(602) 555-0177 (+16025550177)");
  assertFalse(html.includes("555-0104"), "the caller id they said not to use is not the callback number");
  assertStringIncludes(html, "Jane Doe (caller-provided, unverified)");
});

Deno.test("status-update forwarding: a contact from caller id, or a failed contact read, keeps the caller id", async () => {
  for (const failRead of [false, true]) {
    const { store, deps } = harness({ env: ALERT_ENV });
    await store.upsertContact({
      callKey: PHONE_CALL_ID,
      kind: "new_customer",
      firstName: "Jane",
      lastName: "Doe",
      email: null,
      callbackPhone: failRead ? "+16025550177" : "+16025550104",
      callbackSource: failRead ? "argument" : "caller_id",
      customerId: null,
    });
    if (failRead) store.failNext("getContact");
    await onStatusUpdate(statusUpdate("forwarding"), deps);
    const [row] = store.tables.escalations;
    assertEquals([row.callback_phone, row.callback_source], ["+16025550104", "caller_id"], `failRead=${failRead}`);
  }
});
