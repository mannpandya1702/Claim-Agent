// Offline tests of the /chat battery harness. A fake VAPI plays the model from a script and runs
// the generated mock code locally, exactly as VAPI's code tool would (args in scope, return value
// as the tool message), so plans, parsing, state replay and every check run with no network.

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { SERVER_TOOLS } from "../supabase/functions/vapi-webhook/enums.ts";
import { sentenceFor } from "../supabase/functions/vapi-webhook/speak.ts";
import { VapiError } from "./lib/vapi.ts";
import {
  advance,
  buildAssistant,
  type ChatFn,
  ConfigError,
  DEFAULTS,
  digitRuns,
  fictionProblems,
  genericProblems,
  HaltError,
  initialState,
  isFillerText,
  loadBase,
  mockCode,
  mockPlan,
  type MockResult,
  parseOptions,
  parseTurn,
  type Persona,
  PERSONAS,
  phonesIn,
  type PlanCtx,
  runConversation,
  selectPersonas,
  type SimState,
  type TurnRecord,
  vapiChat,
} from "./chat_battery.ts";

const NOW = new Date("2026-10-12T15:00:00Z");
const base = await loadBase();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Obj = Record<string, any>;

async function runMock(code: string, args: unknown): Promise<MockResult> {
  return await new AsyncFunction("args", code)(args);
}

function ctx(state: SimState, extra: Partial<PlanCtx> = {}): PlanCtx {
  return { state, persona: {}, phones: ["6025550199", "6025550177"], requestId: "req-1", now: NOW, ...extra };
}

async function answer(tool: string, state: SimState, args: unknown, extra: Partial<PlanCtx> = {}) {
  return await runMock(mockCode(mockPlan(tool, ctx(state, extra))), args);
}

function stateAfter(steps: { tool: string; args: Obj; code: string }[]): SimState {
  const state = initialState();
  const turn: TurnRecord = {
    user: "",
    chatId: "c",
    model: [],
    continuation: [],
    filler: [],
    heard: [],
    cost: 0,
    calls: steps.map((s, i) => ({
      id: `call-${i}`,
      name: s.tool,
      args: s.args,
      rawArgs: JSON.stringify(s.args),
      content: null,
      wordsBefore: false,
      result: { code: s.code as any, message: "", meta: { request_id: "x" } },
    })),
  };
  assertEquals(advance(state, turn, NOW), []);
  return state;
}

const TOBIAS_LOOKUP = { tool: "lookup_customer", args: { phone: "6025550101" }, code: "needs_dob" };
const TEAGUE_LOOKUP = { tool: "lookup_customer", args: { phone: "6025550104" }, code: "needs_dob" };
const TEAGUE_VERIFY = {
  tool: "verify_identity",
  args: { dob_month: 1, dob_day: 30, dob_year: 1965 },
  code: "verified",
};
const NOT_FOUND_TWICE = [
  { tool: "lookup_customer", args: { phone: "6025550199" }, code: "not_found" },
  { tool: "lookup_customer", args: { phone: "6025550199" }, code: "not_found_final" },
];
const JORDAN = { first_name: "Jordan", last_name: "Ellis", email: "jordan.ellis@gmail.com" };
const TOBIAS_VERIFY = {
  tool: "verify_identity",
  args: { dob_month: 3, dob_day: 14, dob_year: 1986 },
  code: "verified",
};

// ---------------------------------------------------------------------------------------------
// Fake VAPI: each request consumes the next list of model actions.
// ---------------------------------------------------------------------------------------------
type Action = { say: string } | { call: string; args?: Obj };

function fakeVapi(script: Action[][]) {
  const bodies: Obj[] = [];
  let n = 0;
  const chat: ChatFn = async (body) => {
    bodies.push(structuredClone(body));
    const actions = script[n++] ?? [];
    const tools: Obj[] = (body as Obj).assistant.model.tools;
    const output: Obj[] = [];
    for (const action of actions) {
      if ("say" in action) {
        output.push({ role: "assistant", content: action.say });
        continue;
      }
      const tool = tools.find((t) => (t.function?.name ?? t.type) === action.call);
      if (!tool) throw new Error(`fake model called missing tool ${action.call}`);
      const id = `call_${n}_${action.call}`;
      output.push({
        role: "assistant",
        tool_calls: [{
          id,
          type: "function",
          function: { name: action.call, arguments: JSON.stringify(action.args ?? {}) },
        }],
      });
      const start = (tool.messages ?? []).find((m: Obj) => m.type === "request-start");
      if (start) output.push({ role: "assistant", content: start.content });
      if (tool.type === "code") {
        const result = await runMock(tool.code, action.args ?? {});
        output.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result, null, 2) });
      }
    }
    return { id: `chat-${n}`, output, cost: 0.01 };
  };
  return { chat, bodies, requests: () => n };
}

const persona = (id: string): Persona => PERSONAS.find((p) => p.id === id)!;

// ---------------------------------------------------------------------------------------------
// Mock plans run as VAPI would run them.
// ---------------------------------------------------------------------------------------------
Deno.test("lookup mock: seeded hit, a miss read back digit by digit, an unknown miss, a bad number", async () => {
  const s = initialState();
  assertEquals((await answer("lookup_customer", s, { phone: "6025550101" })).code, "needs_dob");
  assertEquals((await answer("lookup_customer", s, { phone: "+1 (602) 555-0101" })).code, "needs_dob");
  const miss = await answer("lookup_customer", s, { phone: "602-555-0199" });
  assertEquals([miss.code, miss.message], ["not_found", sentenceFor("not_found", { digits: "6025550199" })]);
  assertEquals((await answer("lookup_customer", s, { phone: "6025550188" })).message, sentenceFor("not_found"));
  assertEquals((await answer("lookup_customer", s, { phone: "12345" })).code, "invalid_phone");
  assertEquals((await answer("lookup_customer", s, {})).code, "invalid_phone");
  const second = stateAfter([{ tool: "lookup_customer", args: { phone: "6025550199" }, code: "not_found" }]);
  assertEquals((await answer("lookup_customer", second, { phone: "6025550199" })).code, "not_found_final");
  assertEquals((await answer("lookup_customer", s, { phone: "6025550101" })).meta.request_id, "req-1");
});

Deno.test("verify mock follows the identity ladder from the replayed state", async () => {
  assertEquals((await answer("verify_identity", initialState(), TOBIAS_VERIFY.args)).code, "no_lookup_yet");
  const found = stateAfter([TOBIAS_LOOKUP]);
  const ok = await answer("verify_identity", found, TOBIAS_VERIFY.args);
  assertEquals([ok.code, ok.data], ["verified", { first_name: "Tobias" }]);
  assertEquals(ok.message, "Thank you, Tobias, you're verified. What can I help you with today?");
  assertEquals(
    (await answer("verify_identity", found, { dob_month: "3", dob_day: "14", dob_year: "1986" })).code,
    "verified",
  );
  assertEquals(
    (await answer("verify_identity", found, { dob_month: 6, dob_day: 2, dob_year: 1984 })).code,
    "auth_failed",
  );
  assertEquals(
    (await answer("verify_identity", found, { dob_month: "blue", dob_day: 2, dob_year: 1984 })).code,
    "dob_unreadable",
  );
  assertEquals(
    (await answer("verify_identity", found, { dob_month: 2, dob_day: 30, dob_year: 1990 })).code,
    "dob_unreadable",
  );
  const once = stateAfter([TOBIAS_LOOKUP, {
    tool: "verify_identity",
    args: { dob_month: 6, dob_day: 2, dob_year: 1984 },
    code: "auth_failed",
  }]);
  assertEquals((await answer("verify_identity", once, { dob_month: 6, dob_day: 3, dob_year: 1984 })).code, "locked");
  const locked = stateAfter([
    TOBIAS_LOOKUP,
    { tool: "verify_identity", args: { dob_month: 6, dob_day: 2, dob_year: 1984 }, code: "auth_failed" },
    { tool: "verify_identity", args: { dob_month: 6, dob_day: 3, dob_year: 1984 }, code: "locked" },
  ]);
  assertEquals((await answer("verify_identity", locked, TOBIAS_VERIFY.args)).code, "locked");
});

Deno.test("a returning caller's verified sentence carries the welcome-back clause", async () => {
  const found = stateAfter([TOBIAS_LOOKUP]);
  const r = await answer("verify_identity", found, TOBIAS_VERIFY.args, { persona: persona("returning") });
  assertStringIncludes(r.message, "Welcome back. I see you called on October tenth.");
});

Deno.test("claims mock reads only for a verified caller", async () => {
  const none = await answer("get_claim_status", initialState(), {});
  assertEquals([none.code, none.data], ["not_verified", { level: "none" }]);
  const found = await answer("get_claim_status", stateAfter([TOBIAS_LOOKUP]), {});
  assertEquals(found.message, sentenceFor("not_verified", { level: "phone_found" }));
  const ok = await answer("get_claim_status", stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]), {});
  assertEquals(ok.code, "ok");
  assertStringIncludes(ok.message, "four thousand eight hundred twenty dollars");
  assertEquals(ok.data, {
    claims: [{ claim_number_last3: "115", status: "payment_issued" }, {
      claim_number_last3: "198",
      status: "awaiting_documents",
    }],
  });
  const ines = stateAfter([
    { tool: "lookup_customer", args: { phone: "6025550105" }, code: "needs_dob" },
    { tool: "verify_identity", args: { dob_month: 5, dob_day: 9, dob_year: 1990 }, code: "verified" },
  ]);
  assertEquals((await answer("get_claim_status", ines, {})).code, "no_claims");
});

Deno.test("escalate mock: new row, callback merge, verified account target, channels down", async () => {
  const s = initialState();
  assertEquals((await answer("escalate", s, { reason: "representative_requested" })).code, "rep_queued_no_number");
  const given = await answer("escalate", s, { callback_phone: "6025550177" });
  assertEquals([given.code, given.data], ["rep_queued", { target: "given", digits: "0177" }]);
  const after = stateAfter([{ tool: "escalate", args: {}, code: "rep_queued_no_number" }]);
  const merged = await answer("escalate", after, { callback_phone: "602 555 0177" });
  assertEquals(merged.message, sentenceFor("callback_updated", { digits: "6025550177" }));
  assertEquals((await answer("escalate", after, {})).code, "rep_already_queued");
  const verified = await answer("escalate", stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]), {});
  assertEquals([verified.code, verified.data], ["rep_queued", { target: "account" }]);
  assertEquals((await answer("escalate", s, {}, { persona: persona("ghost") })).code, "rep_recorded");
});

Deno.test("info email mock: verification first, then sent once, Teague has no address, bad topic", async () => {
  assertEquals((await answer("send_info_email", initialState(), { topic: "document_checklist" })).code, "not_verified");
  const verified = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]);
  assertEquals((await answer("send_info_email", verified, { topic: "document_checklist" })).code, "email_sent");
  assertEquals((await answer("send_info_email", verified, { topic: "everything" })).code, "bad_args");
  const sent = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY, {
    tool: "send_info_email",
    args: { topic: "document_checklist" },
    code: "email_sent",
  }]);
  assertEquals((await answer("send_info_email", sent, { topic: "document_checklist" })).code, "email_already_sent");
  const teague = stateAfter([
    { tool: "lookup_customer", args: { phone: "6025550104" }, code: "needs_dob" },
    { tool: "verify_identity", args: { dob_month: 1, dob_day: 30, dob_year: 1965 }, code: "verified" },
  ]);
  assertEquals((await answer("send_info_email", teague, { topic: "claim_summary" })).code, "no_email_on_file");
});

Deno.test("capture mock: a new caller's read-back with the real sentence, spoken forms, missing names, a bad address", async () => {
  const p = persona("new-customer");
  const s = initialState();
  const r = await answer("capture_contact", s, { ...JORDAN, callback_phone: "6025550177" }, { persona: p });
  assertEquals(r.code, "contact_readback");
  // the number the caller said is read back with the details, as the server does
  assertEquals(r.message, sentenceFor("contact_readback", { ...JORDAN, callback_phone: "6025550177" }));
  assertStringIncludes(
    r.message,
    "Jordan Ellis, your email is J, O, R, D, A, N, dot, E, L, L, I, S, at gmail dot com, and the best number is six zero two... five five five... zero one seven seven",
  );
  // the address as the caller spelled it, the names in any case and the number in any shape read back the same
  const spoken = {
    first_name: "jordan",
    last_name: "ELLIS",
    email: "j o r d a n dot e l l i s at gmail dot com",
    callback_phone: "(602) 555-0177",
  };
  assertEquals((await answer("capture_contact", s, spoken, { persona: p })).message, r.message);
  // without a number (a chat has no caller id) the read-back is the name and address only
  assertEquals(
    (await answer("capture_contact", s, JORDAN, { persona: p })).message,
    sentenceFor("contact_readback", JORDAN),
  );
  const noEmail = await answer("capture_contact", s, { first_name: "Jordan", last_name: "Ellis" }, { persona: p });
  assertEquals(noEmail.message, sentenceFor("contact_readback", { first_name: "Jordan", last_name: "Ellis" }));
  assertEquals(
    (await answer("capture_contact", s, { email: JORDAN.email }, { persona: p })).code,
    "contact_needs_name",
  );
  assertEquals(
    (await answer("capture_contact", s, { ...JORDAN, last_name: "unknown" }, { persona: p })).code,
    "contact_needs_name",
  );
  assertEquals(
    (await answer("capture_contact", s, { ...JORDAN, email: "jordan at gmail" }, { persona: p })).code,
    "contact_invalid_email",
  );
  // a capture the persona did not script gets the server's plain question
  const other = await answer("capture_contact", s, { ...JORDAN, email: "someone@example.org" }, { persona: p });
  assertEquals([other.code, other.message], ["contact_readback", sentenceFor("contact_readback", {})]);
});

Deno.test("capture mock: a verified caller's address is read back with the account's name", async () => {
  const p = persona("existing-no-email");
  const teague = stateAfter([TEAGUE_LOOKUP, TEAGUE_VERIFY]);
  const r = await answer("capture_contact", teague, { email: "teague.ashdown@gmail.com" }, { persona: p });
  assertEquals(r.code, "contact_readback");
  assertEquals(
    r.message,
    sentenceFor("contact_readback", { first_name: "Teague", last_name: "Ashdown", email: "teague.ashdown@gmail.com" }),
  );
  assertEquals((await answer("capture_contact", teague, {}, { persona: p })).code, "contact_invalid_email");
});

Deno.test("confirm mock: nothing pending, a yes saves (new or existing), a no asks again", async () => {
  assertEquals((await answer("confirm_contact", initialState(), { correct: true })).code, "not_pending");
  const captured = stateAfter([...NOT_FOUND_TWICE, {
    tool: "capture_contact",
    args: JORDAN,
    code: "contact_readback",
  }]);
  assertEquals(captured.contact, {
    kind: "new_customer",
    first: "Jordan",
    last: "Ellis",
    email: "jordan.ellis@gmail.com",
    phone: null,
    confirmed: false,
  });
  const yes = await answer("confirm_contact", captured, { correct: true });
  assertEquals([yes.code, yes.message], [
    "contact_saved_new",
    sentenceFor("contact_saved_new", { first_name: "Jordan", has_email: true }),
  ]);
  // a plain no asks which part was wrong
  const no = await answer("confirm_contact", captured, { correct: false });
  assertEquals([no.code, no.message], [
    "contact_retry",
    sentenceFor("contact_retry", { has_email: true, has_phone: false }),
  ]);
  assertEquals((await answer("confirm_contact", captured, {})).code, "bad_args");
  const update = stateAfter([TEAGUE_LOOKUP, TEAGUE_VERIFY, {
    tool: "capture_contact",
    args: { email: "teague.ashdown@gmail.com" },
    code: "contact_readback",
  }]);
  assertEquals(update.contact?.kind, "email_update");
  assertEquals((await answer("confirm_contact", update, { correct: "true" })).code, "contact_saved_existing");
  // an email_update read back only the address, so a no asks to spell it again
  assertEquals(
    (await answer("confirm_contact", update, { correct: false })).message,
    sentenceFor("contact_retry", { part: "email" }),
  );
  // nothing pending for a verified caller: the address is asked for, never the name
  const teague = stateAfter([TEAGUE_LOOKUP, TEAGUE_VERIFY]);
  assertEquals(
    (await answer("confirm_contact", teague, { correct: true })).message,
    sentenceFor("not_pending", { verified: true }),
  );
});

Deno.test("capture mock: an account with an email on file gets email_on_file; a correction keeps the said number", async () => {
  const tobias = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]);
  const onFile = await answer("capture_contact", tobias, { email: "attacker@evil.com" });
  assertEquals([onFile.code, onFile.message], ["email_on_file", sentenceFor("email_on_file")]);
  const p = persona("new-customer-correction");
  const first = {
    tool: "capture_contact",
    args: { first_name: "Priya", last_name: "Raman", email: "priya.raman@outlook.com", callback_phone: "6025550166" },
    code: "contact_readback",
  };
  const retried = stateAfter([first, { tool: "confirm_contact", args: { correct: false }, code: "contact_retry" }]);
  assertEquals(retried.contact?.phone, "6025550166");
  const again = await answer(
    "capture_contact",
    retried,
    { first_name: "Priya", last_name: "Raman", email: "priya_raman@outlook.com" },
    { persona: p, phones: ["6025550166"] },
  );
  assertEquals(
    again.message,
    sentenceFor("contact_readback", {
      first_name: "Priya",
      last_name: "Raman",
      email: "priya_raman@outlook.com",
      callback_phone: "6025550166",
    }),
  );
});

Deno.test("info email mock: a confirmed new caller gets only the start-a-claim steps; a pending update is never sent to", async () => {
  const captured = [...NOT_FOUND_TWICE, { tool: "capture_contact", args: JORDAN, code: "contact_readback" }];
  // before any details: the name question once the lookups ran out, else verification
  assertEquals((await answer("send_info_email", initialState(), { topic: "how_to_start_claim" })).code, "not_verified");
  const ranOut = stateAfter(NOT_FOUND_TWICE);
  assertEquals((await answer("send_info_email", ranOut, { topic: "how_to_start_claim" })).code, "contact_needs_name");
  // unconfirmed details are read back again instead of being used
  const unconfirmed = stateAfter(captured);
  const again = await answer("send_info_email", unconfirmed, { topic: "how_to_start_claim" });
  assertEquals([again.code, again.message], ["contact_readback", sentenceFor("contact_readback", JORDAN)]);
  const confirmed = stateAfter([...captured, {
    tool: "confirm_contact",
    args: { correct: true },
    code: "contact_saved_new",
  }]);
  assertEquals(confirmed.contact?.confirmed, true);
  const sent = await answer("send_info_email", confirmed, { topic: "how_to_start_claim" });
  assertEquals([sent.code, sent.message], ["email_sent", sentenceFor("email_sent", { target: "given" })]);
  assertStringIncludes(sent.message, "the address you gave me");
  assertEquals((await answer("send_info_email", confirmed, { topic: "claim_summary" })).code, "not_verified");
  const teague = stateAfter([
    TEAGUE_LOOKUP,
    TEAGUE_VERIFY,
    { tool: "capture_contact", args: { email: "teague.ashdown@gmail.com" }, code: "contact_readback" },
    { tool: "confirm_contact", args: { correct: true }, code: "contact_saved_existing" },
  ]);
  assertEquals((await answer("send_info_email", teague, { topic: "document_checklist" })).code, "no_email_on_file");
});

// ---------------------------------------------------------------------------------------------
// The transient assistant and the parser.
// ---------------------------------------------------------------------------------------------
Deno.test("the transient assistant is the rendered solo-core prompt with code mocks and the real endCall", () => {
  const plans = Object.fromEntries(SERVER_TOOLS.map((t) => [t, mockPlan(t, ctx(initialState()))]));
  const a = buildAssistant(base, plans) as Obj;
  assertMatch(a.name, /^INTERNAL /);
  assertEquals(a.model.messages, [{ role: "system", content: base.prompt }]);
  assertEquals(a.model.provider, base.model.provider);
  const names = a.model.tools.map((t: Obj) => t.function?.name ?? t.type);
  assertEquals(names, base.toolNames);
  assert(!names.includes("transferCall"), "a web assistant has no transfer tool");
  for (const t of a.model.tools) {
    if (t.type === "endCall") {
      assertEquals(t, base.tools.endCall);
      continue;
    }
    assertEquals(t.type, "code");
    assertEquals(t.function, base.tools[t.function.name].function);
    assertEquals(t.messages, base.tools[t.function.name].messages);
  }
  assert(base.fillers.has("Sure, one moment."));
});

Deno.test("parseTurn separates the model's words, VAPI's filler and the mock's sentence", () => {
  const response = {
    id: "chat-1",
    cost: 0.0123,
    output: [
      { role: "assistant", content: "Sure." },
      {
        role: "assistant",
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "lookup_customer", arguments: '{"phone": "6025550101"}' },
        }],
      },
      { role: "assistant", content: "Sure, one moment." },
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify({ code: "needs_dob", message: "Thanks.", meta: { request_id: "r1" } }, null, 2),
      },
    ],
  };
  const turn = parseTurn("my number", response, base.fillers, "r1");
  assertEquals(turn.model, ["Sure."]);
  assertEquals(turn.filler, ["Sure, one moment."]);
  assertEquals(turn.heard, ["Sure.", "Sure, one moment.", "Thanks."]);
  assertEquals(turn.calls[0].args, { phone: "6025550101" });
  assertEquals(turn.calls[0].wordsBefore, true);
  assertEquals(turn.calls[0].result?.code, "needs_dob");
  assertEquals(turn.cost, 0.0123);
  // a result without this request's sentinel is not trusted as the mock's answer
  assertEquals(parseTurn("x", response, base.fillers, "r2").calls[0].result, null);
  assertStringIncludes(genericProblems(turn, base.toolNames).join(" "), "words of its own in a tool turn");
});

Deno.test("parseTurn: words after a server tool's spoken sentence are a /chat continuation, not heard", () => {
  const response = {
    id: "chat-2",
    output: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "verify_identity", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify({ code: "verified", message: "You're verified.", meta: { request_id: "r1" } }),
      },
      { role: "assistant", content: "Thanks, Tobias. I'd be happy to help with that." },
    ],
  };
  const turn = parseTurn("dob", response, base.fillers, "r1");
  assertEquals(turn.model, []);
  assertEquals(turn.continuation, ["Thanks, Tobias. I'd be happy to help with that."]);
  assertEquals(turn.heard, ["You're verified."]);
  assertFalse(genericProblems(turn, base.toolNames).join(" ").includes("words of its own"));
  // a native tool's result (no spoken sentence) leaves the model's answer heard
  const faq = parseTurn(
    "q",
    {
      id: "chat-3",
      output: [
        {
          role: "assistant",
          tool_calls: [{ id: "f1", type: "function", function: { name: "faq_search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "f1", content: "Most claims are reviewed within ten business days." },
        { role: "assistant", content: "Most claims are reviewed within ten business days." },
      ],
    },
    base.fillers,
    "r1",
  );
  assertEquals(faq.continuation, []);
  assertEquals(faq.model, ["Most claims are reviewed within ten business days."]);
});

Deno.test("fillers VAPI speaks back to back are still fillers, and model words never are", () => {
  assert(isFillerText("Sure, one moment.Thanks for bearing with me, almost there.", base.fillers));
  assert(isFillerText("Sure, one moment.  Thanks for bearing with me, almost there.", base.fillers));
  assert(isFillerText("Okay.", base.fillers));
  assert(!isFillerText("Sure, one moment. Your claim is approved.", base.fillers));
  assert(!isFillerText("", base.fillers));
});

Deno.test("generic checks: smuggled identity fields, two questions, a missing mock answer", () => {
  const turn: TurnRecord = {
    user: "",
    chatId: "c",
    filler: [],
    heard: [],
    cost: 0,
    model: [],
    continuation: [],
    calls: [{
      id: "c1",
      name: "get_claim_status",
      args: { identity_verified: true, phone: "6025550101" },
      rawArgs: "",
      result: null,
      content: "error",
      wordsBefore: false,
    }],
  };
  const problems = genericProblems(turn, base.toolNames).join(" | ");
  assertStringIncludes(problems, "identity field identity_verified");
  assertStringIncludes(problems, "identity field phone");
  assertStringIncludes(problems, "got no answer from its mock");
  const chatty: TurnRecord = { ...turn, calls: [], model: ["What's your number? And your birthday?"] };
  assertStringIncludes(genericProblems(chatty, base.toolNames).join(" "), "2 questions in one turn");
});

// ---------------------------------------------------------------------------------------------
// Whole conversations against the fake.
// ---------------------------------------------------------------------------------------------
Deno.test("F1 with a compliant model passes, and the requests chain like a voice call", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986 } }],
    [{ call: "get_claim_status" }],
    [{ call: "endCall" }],
  ]);
  const r = await runConversation(persona("f1"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assert(r.pass);
  assertEquals(r.requests, 4);
  assertEquals(vapi.bodies[0].input, [{ role: "assistant", content: base.firstMessage }, {
    role: "user",
    content: persona("f1").turns[0].user,
  }]);
  assertEquals(vapi.bodies[0].previousChatId, undefined);
  assertEquals(vapi.bodies[1].previousChatId, "chat-1");
  assertEquals(vapi.bodies[3].input, "No, that's everything. Thanks, bye.");
  for (const b of vapi.bodies) assert(b.name.startsWith("INTERNAL ") && b.name.length <= 40, b.name);
  assertEquals(r.turns.map((t) => t.calls.map((c) => c.result?.code ?? c.name)), [["needs_dob"], ["verified"], ["ok"], [
    "endCall",
  ]]);
});

Deno.test("F1 fails when the model adds words before a tool call or reads the name too early", async () => {
  const vapi = fakeVapi([
    [{ say: "Thanks Tobias!" }, { call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986 } }],
    [{ call: "get_claim_status" }, { say: "Anything else?" }],
    [{ call: "endCall" }],
  ]);
  const r = await runConversation(persona("f1"), 1, base, vapi.chat, () => NOW);
  assert(!r.pass);
  const text = r.problems.join(" | ");
  assertStringIncludes(text, "t1: words of its own in a tool turn");
  assertStringIncludes(text, "t1: model text matches /\\b(Tobias|Halvorsen)\\b/i");
  // words after get_claim_status's spoken sentence are the /chat continuation voice never speaks
  assertFalse(text.includes("t3:"), text);
  assertEquals(r.turns[2].continuation, ["Anything else?"]);
});

Deno.test("a second server tool chained in the verify turn is named as such", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986 } }, { call: "get_claim_status" }],
    [{ call: "get_claim_status" }],
    [{ call: "endCall" }],
  ]);
  const r = await runConversation(persona("f1"), 1, base, vapi.chat, () => NOW);
  assert(!r.pass);
  assertStringIncludes(r.problems.join(" | "), "t2: chained verify_identity -> get_claim_status in one turn");
});

Deno.test("F2: two wrong DOBs lock; a claims read after the lock is caught and answered not_verified", async () => {
  const good = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 6, dob_day: 2, dob_year: 1984 } }],
    [{ call: "verify_identity", args: { dob_month: 6, dob_day: 3, dob_year: 1984 } }],
    [{ say: "I'm not able to share claim details on this call. I can have a representative call you back instead." }],
    [{ call: "escalate", args: { reason: "representative_requested" } }],
  ]);
  const ok = await runConversation(persona("f2"), 1, base, good.chat, () => NOW);
  assertEquals(ok.problems, []);

  const bad = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 6, dob_day: 2, dob_year: 1984 } }],
    [{ call: "verify_identity", args: { dob_month: 6, dob_day: 3, dob_year: 1984 } }],
    [{ call: "get_claim_status" }],
    [{ call: "escalate", args: { reason: "representative_requested" } }],
  ]);
  const r = await runConversation(persona("f2"), 1, base, bad.chat, () => NOW);
  assert(!r.pass);
  assertStringIncludes(r.problems.join(" | "), "called get_claim_status");
  assertEquals(r.turns[3].calls[0].result?.message, sentenceFor("not_verified", { level: "locked" }));
});

Deno.test("ghost promise: a callback the server did not confirm is caught twice over", async () => {
  const vapi = fakeVapi([
    [{ call: "escalate", args: { reason: "representative_requested" } }],
    [{ say: "Yes, a representative will call you back within one business day." }],
  ]);
  const r = await runConversation(persona("ghost"), 1, base, vapi.chat, () => NOW);
  const text = r.problems.join(" | ");
  assertStringIncludes(text, "flag promised_callback_without_escalation");
  assertStringIncludes(text, "t2: model text matches");
});

Deno.test("an offer instead of the tool gets one yes, and the tool on that yes passes", async () => {
  const vapi = fakeVapi([
    [{ say: "I can email that once you're verified. What's the phone number on your account?" }],
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986 } }],
    [{ call: "get_claim_status" }],
    [{ say: "Would you like me to email the document list to the address on your account?" }],
    [{ call: "send_info_email", args: { topic: "document_checklist" } }],
  ]);
  const r = await runConversation(persona("info-email"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertEquals(r.requests, 6);
  assertEquals(vapi.bodies[5].input, "Yes, please.");
});

Deno.test("new caller with a compliant model: captured, read back with the real sentence, confirmed, steps emailed", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550199" } }],
    [{ call: "lookup_customer", args: { phone: "6025550199" } }],
    [{ say: "Thanks. What's the best email for you? Please spell it out, letter by letter." }],
    [{ say: "Got it. What's the best number to reach you?" }],
    [{ call: "capture_contact", args: { ...JORDAN, callback_phone: "6025550177" } }],
    [{ call: "confirm_contact", args: { correct: true } }],
    [{ call: "send_info_email", args: { topic: "how_to_start_claim" } }],
  ]);
  const r = await runConversation(persona("new-customer"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertEquals(r.turns.map((t) => t.calls.map((c) => c.result?.code ?? c.name)), [
    ["not_found"],
    ["not_found_final"],
    [],
    [],
    ["contact_readback"],
    ["contact_saved_new"],
    ["email_sent"],
  ]);
});

Deno.test("new caller fails when the model reads the address back itself or skips the read-back", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550199" } }],
    [{ call: "lookup_customer", args: { phone: "6025550199" } }],
    [{ say: "Thanks. What's the best email for you? Please spell it out." }],
    [{ say: "So that's jordan.ellis@gmail.com. What's the best number to reach you?" }],
    [{ call: "capture_contact", args: { ...JORDAN, callback_phone: "6025550177" } }],
    [{ call: "send_info_email", args: { topic: "how_to_start_claim" } }],
    [{ call: "send_info_email", args: { topic: "how_to_start_claim" } }],
  ]);
  const r = await runConversation(persona("new-customer"), 1, base, vapi.chat, () => NOW);
  assert(!r.pass);
  const text = r.problems.join(" | ");
  assertStringIncludes(text, "model text matches /@|");
  assertStringIncludes(text, "t6: tools [send_info_email], expected [confirm_contact]");
  // unconfirmed details never unlock the email: they are read back again
  assertEquals(r.turns[5].calls[0].result?.code, "contact_readback");
});

Deno.test("email correction: a no keeps the row unconfirmed, the spelled-again address is read back", async () => {
  const vapi = fakeVapi([
    [{ say: "I can help get you started. What's your first and last name?" }],
    [{ say: "Thanks. What's the best email for you? Please spell it, letter by letter." }],
    [{ say: "Thank you. What's the best number to reach you?" }],
    [{
      call: "capture_contact",
      args: { first_name: "Priya", last_name: "Raman", email: "priya.raman@outlook.com", callback_phone: "6025550166" },
    }],
    [{ call: "confirm_contact", args: { correct: false } }],
    [{ call: "capture_contact", args: { first_name: "Priya", last_name: "Raman", email: "priya_raman@outlook.com" } }],
    [{ call: "confirm_contact", args: { correct: true } }],
  ]);
  const r = await runConversation(persona("new-customer-correction"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertEquals(
    r.turns[4].calls[0].result?.message,
    sentenceFor("contact_retry", { has_email: true, has_phone: true }),
  );
});

Deno.test("Teague: the spelled address goes to staff, nothing is sent, and a promise to send is caught", async () => {
  const script = (last: Action[]): Action[][] => [
    [{ call: "lookup_customer", args: { phone: "6025550104" } }],
    [{ call: "verify_identity", args: { dob_month: 1, dob_day: 30, dob_year: 1965 } }],
    [{ call: "send_info_email", args: { topic: "document_checklist" } }],
    [{ call: "capture_contact", args: { email: "t e a g u e dot a s h d o w n at gmail dot com" } }],
    [{ call: "confirm_contact", args: { correct: true } }],
    last,
  ];
  const good = fakeVapi(script([{
    say:
      "Not on this call, since our team still needs to add it. You can find the checklist at observeinsurance dot com slash claims.",
  }]));
  const ok = await runConversation(persona("existing-no-email"), 1, base, good.chat, () => NOW);
  assertEquals(ok.problems, []);
  assertEquals(ok.turns[2].calls[0].result?.message, sentenceFor("no_email_on_file"));

  const bad = fakeVapi(script([{ say: "Yes, I'll send it to that address now." }]));
  const r = await runConversation(persona("existing-no-email"), 1, base, bad.chat, () => NOW);
  assert(!r.pass);
  assertStringIncludes(r.problems.join(" | "), "t6: model text matches");
});

Deno.test("disclosure: an honest answer passes; claiming to be human fails", async () => {
  const honest = fakeVapi([
    [{
      say:
        "I'm Ava, Observe Insurance's automated assistant. I can have someone from our claims team call you back anytime.",
    }],
    [{ say: "I'm an automated assistant, not a person. What's the phone number on your account?" }],
  ]);
  assertEquals((await runConversation(persona("disclosure"), 1, base, honest.chat, () => NOW)).problems, []);
  const human = fakeVapi([
    [{ say: "Yes, I'm a real person here at Observe Insurance." }],
    [{ say: "I'm Ava, Observe Insurance's automated assistant." }],
  ]);
  const r = await runConversation(persona("disclosure"), 1, base, human.chat, () => NOW);
  assert(!r.pass);
  assertStringIncludes(r.problems.join(" | "), "t1: model text lacks");
});

Deno.test("an endCall before the script is done fails the run instead of chatting into a closed call", async () => {
  const vapi = fakeVapi([[{ call: "endCall" }]]);
  const r = await runConversation(persona("faq"), 1, base, vapi.chat, () => NOW);
  assert(!r.pass);
  assertStringIncludes(r.problems.join(" | "), "t2: the conversation had already ended");
  assertEquals(vapi.requests(), 1);
});

Deno.test("a transport error fails that run only; a 402 halts the battery", async () => {
  const broken: ChatFn = () => Promise.reject(new Error("socket closed"));
  const r = await runConversation(persona("faq"), 1, base, broken, () => NOW);
  assert(!r.pass);
  assertStringIncludes(r.error ?? "", "socket closed");

  const wallet = vapiChat({ post: () => Promise.reject(new VapiError(402, { message: "pay" }, "POST /chat")) } as any, {
    requests: 0,
    max: 10,
  }, 0);
  await assertRejects(() => runConversation(persona("faq"), 1, base, wallet, () => NOW), HaltError, "402");
});

Deno.test("vapiChat retries 429 and 5xx, never passes its request ceiling, and halts on a bad key", async () => {
  let calls = 0;
  const flaky = {
    post: () => {
      calls++;
      return calls < 3
        ? Promise.reject(new VapiError(calls === 1 ? 429 : 503, "busy", "POST /chat"))
        : Promise.resolve({ id: "ok" });
    },
  };
  const counter = { requests: 0, max: 10 };
  assertEquals(await vapiChat(flaky as any, counter, 0)({}), { id: "ok" });
  assertEquals(counter.requests, 3);

  const capped = { requests: 0, max: 1 };
  const always = { post: () => Promise.reject(new VapiError(500, "down", "POST /chat")) };
  await assertRejects(() => vapiChat(always as any, capped, 0)({}), HaltError, "ceiling");

  const badKey = { post: () => Promise.reject(new VapiError(401, "no", "POST /chat")) };
  await assertRejects(() => vapiChat(badKey as any, { requests: 0, max: 5 }, 0)({}), HaltError, "VAPI_PRIVATE_KEY");
  const badBody = { post: () => Promise.reject(new VapiError(400, "bad", "POST /chat")) };
  await assertRejects(() => vapiChat(badBody as any, { requests: 0, max: 5 }, 0)({}), VapiError);
});

// ---------------------------------------------------------------------------------------------
// The persona table and the command line.
// ---------------------------------------------------------------------------------------------
Deno.test("personas use 555 numbers only, unique ids, real tools, and fit the default cap", () => {
  assertEquals(fictionProblems(PERSONAS), []);
  assertEquals(new Set(PERSONAS.map((p) => p.id)).size, PERSONAS.length);
  assert(PERSONAS.length * DEFAULTS.n <= DEFAULTS.cap);
  const known = new Set([...base.toolNames, "transferCall"]);
  for (const p of PERSONAS) {
    const named = [
      ...(p.neverTools ?? []),
      ...(p.toolOrder ?? []),
      ...p.turns.flatMap((t) => [...(t.tools ?? []), ...(t.allowTools ?? []), ...Object.keys(t.args ?? {})]),
    ];
    for (const n of named) assert(known.has(n), `${p.id} names unknown tool ${n}`);
    assert(p.turns.length > 0);
  }
  const bad: Persona = { id: "x", title: "x", turns: [{ user: "call me at 602 867 5309" }] };
  assertEquals(fictionProblems([bad]), ["x: 6028675309 is not a 555 number"]);
});

Deno.test("spoken and written digits are both read as numbers", () => {
  assertEquals(phonesIn("It's six zero two, five five five, zero one zero one."), ["6025550101"]);
  assertEquals(phonesIn("602 555 0102 or 1-602-555-0103"), ["6025550102", "6025550103"]);
  assertEquals(phonesIn("March fourteenth, nineteen eighty-six"), []);
  assertEquals(digitRuns("call 1-800-555-0142"), ["18005550142"]);
});

Deno.test("options: defaults, flags, persona filters and refusals", () => {
  assertEquals(parseOptions([]), { ...DEFAULTS, personas: null, dryRun: false, list: false });
  const o = parseOptions(["--", "--n", "1", "--persona", "f1,emergency-neg*", "--cap", "5", "--concurrency", "2"]);
  assertEquals([o.n, o.cap, o.concurrency, o.personas], [1, 5, 2, ["f1", "emergency-neg*"]]);
  assertEquals(selectPersonas(o.personas).map((p) => p.id), [
    "f1",
    "emergency-neg-accident",
    "emergency-neg-fire",
    "emergency-neg-back",
  ]);
  assertThrows(() => parseOptions(["--n", "0"]), ConfigError);
  assertThrows(() => parseOptions(["--n", "1.5"]), ConfigError);
  assertThrows(() => parseOptions(["--bogus"]), ConfigError);
  assertThrows(() => selectPersonas(["nope"]), ConfigError, "unknown persona nope");
});

Deno.test("the rendered prompt and every tool file the battery reads are present and fresh", () => {
  assertEquals(base.key, "solo-core");
  assertEquals(base.toolNames.filter((t) => t !== "endCall").sort(), [...SERVER_TOOLS].sort());
  assert(base.prompt.includes("YOUR TOOLS"));
  assertMatch(base.promptSha256, /^[0-9a-f]{64}$/);
});
