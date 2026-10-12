import { assertEquals } from "@std/assert";
import { computeFlags, type FlagInput } from "./flags.ts";
import { FLAGS } from "./enums.ts";
import type { AttemptRow, EmailRow, EscalationRow } from "./types.ts";

const KEY = "call-flags-1";

const bot = (message: string, secondsFromStart = 1) => ({
  role: "bot",
  message,
  time: 1760000000000,
  secondsFromStart,
});
const user = (message: string) => ({ role: "user", message, time: 1760000000000, secondsFromStart: 2 });
const toolResult = (name: string, code: string) => ({
  role: "tool_call_result",
  name,
  toolCallId: `tc-${name}`,
  result: JSON.stringify({ code, message: "..." }),
});

function attempt(tool_name: string, code: string | null): AttemptRow {
  return {
    call_key: KEY,
    tool_call_id: `tc-${tool_name}-${code}`,
    tool_name,
    kind: null,
    code,
    created_at: "2026-10-12T15:00:00Z",
  };
}

function escalation(
  alert_status: EscalationRow["alert_status"],
  kind: EscalationRow["kind"] = "representative",
): EscalationRow {
  return {
    id: "esc-1",
    call_key: KEY,
    kind,
    reason: kind === "emergency" ? "emergency" : "representative_requested",
    details: null,
    callback_phone: "+16025550101",
    channel: "webCall",
    verified: true,
    callback_source: "account",
    alert_status,
    delivery_error: alert_status === "failed" ? "telegram 500: boom" : null,
    status: "open",
    created_at: "2026-10-12T15:00:00Z",
  };
}

function email(status: EmailRow["status"], kind: EmailRow["kind"] = "claim_summary"): EmailRow {
  return {
    call_key: KEY,
    kind,
    to_masked: "o***@example.com",
    resend_id: status === "sent" ? "re_1" : null,
    status,
    error: null,
  };
}

const VERIFIED = [attempt("lookup_customer", "needs_dob"), attempt("verify_identity", "verified")];

function flags(p: Partial<FlagInput>) {
  return computeFlags({ messages: [], attempts: [], escalations: [], emails: [], ...p });
}

// ---------------------------------------------------------------------------------------------
// promised_callback_without_escalation
// ---------------------------------------------------------------------------------------------
const PROMISE =
  "A representative will call you back within one business day. Is there anything else I can help you with?";

Deno.test("promised_callback: fires when the agent promises a callback and no escalation exists", () => {
  assertEquals(flags({ messages: [user("Can I talk to someone?"), bot(PROMISE)] }), [
    "promised_callback_without_escalation",
  ]);
});

Deno.test("promised_callback: does not fire when an escalation alert was sent", () => {
  assertEquals(flags({ messages: [bot(PROMISE)], escalations: [escalation("sent")] }), []);
});

Deno.test("promised_callback: fires when the escalation row exists but delivery failed", () => {
  assertEquals(flags({ messages: [bot(PROMISE)], escalations: [escalation("failed")] }), [
    "promised_callback_without_escalation",
  ]);
});

Deno.test("promised_callback: each phrasing in the rule fires; none fires with a sent alert", () => {
  for (
    const line of [
      "A representative is going to reach out tomorrow.",
      "Someone will call you shortly.",
      "Our team will call you back today.",
      "A representative will reach you at the number on your account.",
    ]
  ) {
    assertEquals(flags({ messages: [bot(line)] }), ["promised_callback_without_escalation"], line);
    assertEquals(flags({ messages: [bot(line)], escalations: [escalation("sent")] }), [], line);
  }
});

Deno.test("promised_callback: an offer or a question is not a promise", () => {
  for (
    const line of [
      // the server's system_error and locked sentences: an offer with nothing recorded yet
      "I'm having trouble reaching our claims system right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?",
      "I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?",
      "Would you like a representative to call you back?",
      "If you'd like, someone will call you back.",
    ]
  ) {
    assertEquals(flags({ messages: [bot(line)] }), [], line);
  }
});

Deno.test("promised_callback: the caller saying it never counts", () => {
  assertEquals(flags({ messages: [user("Will a representative call you back? Someone will call me?")] }), []);
});

// ---------------------------------------------------------------------------------------------
// status_read_without_verified_identity
// ---------------------------------------------------------------------------------------------
const STATUS =
  "Your auto claim ending in one one five was approved, and a payment of four thousand eight hundred twenty dollars was issued on October eighth.";

Deno.test("status_read: fires when claim status is spoken and the session never verified", () => {
  assertEquals(flags({ messages: [bot(STATUS)], attempts: [attempt("lookup_customer", "needs_dob")] }), [
    "status_read_without_verified_identity",
  ]);
});

Deno.test("status_read: does not fire after verify_identity returned verified", () => {
  assertEquals(flags({ messages: [bot(STATUS)], attempts: VERIFIED }), []);
});

Deno.test("status_read: a failed DOB is not verification", () => {
  const attempts = [
    attempt("lookup_customer", "needs_dob"),
    attempt("verify_identity", "auth_failed"),
    attempt("verify_identity", "locked"),
  ];
  for (
    const line of [
      "Your claim is under review with your adjuster.",
      "It was denied, I'm afraid.",
      "Your home claim was received on October tenth.",
    ]
  ) {
    assertEquals(flags({ messages: [bot(line)], attempts }), ["status_read_without_verified_identity"], line);
    assertEquals(flags({ messages: [bot(line)], attempts: VERIFIED }), [], line);
  }
});

Deno.test("status_read: a model-supplied tool result claiming verified does not count; only the ledger does", () => {
  assertEquals(
    flags({ messages: [toolResult("verify_identity", "verified"), bot(STATUS)], attempts: [] }),
    ["status_read_without_verified_identity"],
  );
});

Deno.test("status_read: generic help without status words does not fire", () => {
  assertEquals(
    flags({ messages: [bot("I can help you check on a claim. What's the phone number on your account?")] }),
    [],
  );
});

// ---------------------------------------------------------------------------------------------
// tool_markup_spoken
// ---------------------------------------------------------------------------------------------
Deno.test("tool_markup: fires on a tool name, a brace, function or JSON in a bot turn", () => {
  for (
    const line of [
      "Let me run lookup_customer for you.",
      "I'll call verify_identity now.",
      '{"code":"ok"}',
      "Here is the result } done",
      "I'm calling the function to check.",
      "The JSON says you're verified.",
      "Sending a tool_call now.",
      "I'll use transferCall to connect you.",
      "Let me escalate( that.",
      "I'll use the escalate tool.",
    ]
  ) {
    assertEquals(flags({ messages: [bot(line)], attempts: VERIFIED }), ["tool_markup_spoken"], line);
  }
});

Deno.test("tool_markup: plain speech does not fire, including the English word escalate", () => {
  for (
    const line of [
      "Let me look that up for you.",
      "I'll escalate this to a representative.",
      "Your water heater stopped functioning, I understand.",
      "Thanks for calling Observe Insurance claims support.",
    ]
  ) {
    assertEquals(flags({ messages: [bot(line)] }), [], line);
  }
});

Deno.test("tool_markup: braces in the caller's words or in tool results never count", () => {
  assertEquals(
    flags({ messages: [user("my code is {abc} and JSON function"), toolResult("lookup_customer", "needs_dob")] }),
    [],
  );
});

// ---------------------------------------------------------------------------------------------
// email_promised_without_send
// ---------------------------------------------------------------------------------------------
const EMAILED = "Done, I've emailed that to the address on your account. It should arrive within a few minutes.";

Deno.test("email_promised: fires when the agent says it emailed and no email was sent", () => {
  assertEquals(flags({ messages: [bot(EMAILED)], attempts: VERIFIED }), ["email_promised_without_send"]);
});

Deno.test("email_promised: does not fire when an email row is sent", () => {
  assertEquals(flags({ messages: [bot(EMAILED)], attempts: VERIFIED, emails: [email("sent")] }), []);
});

Deno.test("email_promised: fires when the only email row failed or is still sending", () => {
  for (const status of ["failed", "sending", "pending"] as const) {
    assertEquals(
      flags({ messages: [bot("I have sent that over to you.")], attempts: VERIFIED, emails: [email(status)] }),
      ["email_promised_without_send"],
      status,
    );
  }
});

Deno.test("email_promised: curly apostrophes and the other phrasings match", () => {
  for (const line of ["I\u2019ve emailed you the checklist.", "I've sent it to your inbox.", "I've sent the summary."]) {
    assertEquals(flags({ messages: [bot(line)], attempts: VERIFIED }), ["email_promised_without_send"], line);
    assertEquals(flags({ messages: [bot(line)], attempts: VERIFIED, emails: [email("sent")] }), [], line);
  }
});

Deno.test("email_promised: the rep_queued sentence (request sent to the team) is not an email promise", () => {
  const line =
    "I've sent your request and a summary to our claims team. A representative will call you back at the number on your account within one business day.";
  assertEquals(flags({ messages: [bot(line)], escalations: [escalation("sent")] }), []);
});

// ---------------------------------------------------------------------------------------------
// shape and output
// ---------------------------------------------------------------------------------------------
Deno.test("computeFlags: role assistant with content is read like bot with message", () => {
  assertEquals(flags({ messages: [{ role: "assistant", content: PROMISE }] }), [
    "promised_callback_without_escalation",
  ]);
});

Deno.test("computeFlags: system prompts and tool_calls entries are ignored", () => {
  assertEquals(
    flags({
      messages: [
        { role: "system", message: "Never say lookup_customer or JSON. A representative will call you back." },
        {
          role: "tool_calls",
          toolCalls: [{ function: { name: "lookup_customer", arguments: '{"phone":"6025550101"}' } }],
        },
      ],
    }),
    [],
  );
});

Deno.test("computeFlags: every flag at once comes back sorted and unique", () => {
  const out = flags({
    messages: [bot(PROMISE), bot(PROMISE), bot(STATUS), bot("calling lookup_customer"), bot(EMAILED), bot(EMAILED)],
  });
  assertEquals(out, [...FLAGS].sort());
  assertEquals(out, [
    "email_promised_without_send",
    "promised_callback_without_escalation",
    "status_read_without_verified_identity",
    "tool_markup_spoken",
  ]);
});

Deno.test("computeFlags: a clean verified call has no flags", () => {
  assertEquals(
    flags({
      messages: [
        bot(
          "Thanks for calling Observe Insurance claims support. To get started, what's the phone number on your account?",
        ),
        user("six oh two five five five oh one oh one"),
        toolResult("lookup_customer", "needs_dob"),
        bot("Thanks. For security, what's the date of birth on the account?"),
        user("March fourteenth nineteen eighty six"),
        toolResult("verify_identity", "verified"),
        bot("Thank you, Tobias, you're verified. What can I help you with today?"),
        toolResult("get_claim_status", "ok"),
        bot(STATUS),
      ],
      attempts: [...VERIFIED, attempt("get_claim_status", "ok")],
    }),
    [],
  );
});

Deno.test("computeFlags: empty and malformed input yields no flags and never throws", () => {
  assertEquals(flags({}), []);
  assertEquals(flags({ messages: [null, 42, "text", { role: "bot" }, { role: "bot", message: 7 }] }), []);
  assertEquals(
    computeFlags({ messages: undefined as unknown as unknown[], attempts: [], escalations: [], emails: [] }),
    [],
  );
});
