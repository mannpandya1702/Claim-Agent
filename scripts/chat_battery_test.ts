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
import { parseLossDate } from "../supabase/functions/vapi-webhook/loss_date.ts";
import {
  sentenceFor,
  verifiedFileClaimSentence,
  verifiedStatusSentence,
} from "../supabase/functions/vapi-webhook/speak.ts";
import { VapiError } from "./lib/vapi.ts";
import {
  advance,
  buildAssistant,
  type ChatFn,
  ConfigError,
  datePhraseKey,
  DEFAULTS,
  digitRuns,
  fictionProblems,
  flagProblems,
  genericProblems,
  HaltError,
  initialState,
  isFillerText,
  loadBase,
  lossDateCandidates,
  mockCode,
  mockPlan,
  type MockResult,
  parseOptions,
  parseTurn,
  type Persona,
  PERSONAS,
  phonesIn,
  type PlanCtx,
  readbackPhrase,
  runConversation,
  selectPersonas,
  SIM_CLAIM_NUMBER,
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

function stateAfter(steps: { tool: string; args: Obj; code: string; data?: Obj }[]): SimState {
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
      result: { code: s.code as any, message: "", ...(s.data ? { data: s.data } : {}), meta: { request_id: "x" } },
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
// Reporting a loss: verify_identity's intent, start_claim and confirm_claim.
// ---------------------------------------------------------------------------------------------
const TODAY = "2026-10-12"; // NOW in New York, a Monday
const TOBIAS_FILE_VERIFY = { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "file_claim" };
const PIPE = {
  claim_type: "home",
  loss_date: "on Sunday",
  description: "A pipe burst under my kitchen sink and flooded the floor.",
  summary: "a burst pipe under the sink",
};
// start_claim's read-back of PIPE on NOW: Sunday is the day before
const PIPE_READBACK = {
  tool: "start_claim",
  args: PIPE,
  code: "claim_readback",
  data: { claim_type: "home", loss_date: "2026-10-11" },
};
// with a number to call back on: a new caller's intake promises a call
const NEW_CALLER_CONFIRMED = [
  ...NOT_FOUND_TWICE,
  { tool: "capture_contact", args: { ...JORDAN, callback_phone: "6025550177" }, code: "contact_readback" },
  { tool: "confirm_contact", args: { correct: true }, code: "contact_saved_new" },
];

Deno.test("verify mock with an intent: straight into the claim, or the claims read in the same answer", async () => {
  const found = stateAfter([TOBIAS_LOOKUP]);
  const plain = sentenceFor("verified", { first_name: "Tobias" });
  const file = await answer("verify_identity", found, TOBIAS_FILE_VERIFY);
  assertEquals([file.code, file.message], ["verified", verifiedFileClaimSentence(plain)]);
  const status = await answer("verify_identity", found, { ...TOBIAS_FILE_VERIFY, intent: " Claim_Status " });
  const claims = await answer("get_claim_status", stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]), {});
  assertEquals(status.message, verifiedStatusSentence(plain, claims.message));
  assertEquals(status.data, { first_name: "Tobias", status_read: true, claims: claims.data?.claims });
  // other, an unknown intent or none: the plain answer
  for (const intent of ["other", "something", undefined]) {
    assertEquals((await answer("verify_identity", found, { ...TOBIAS_VERIFY.args, intent })).message, plain);
  }
  // Ines has no claims: the opening and the no-claims sentence
  const ines = stateAfter([{ tool: "lookup_customer", args: { phone: "6025550105" }, code: "needs_dob" }]);
  const none = await answer("verify_identity", ines, {
    dob_month: 5,
    dob_day: 9,
    dob_year: 1990,
    intent: "claim_status",
  });
  assertEquals(none.message, `Thank you, Ines, you're verified. ${sentenceFor("no_claims")}`);
  assertEquals(none.data?.claims, []);
  // the welcome-back variant keeps its opening and loses only its closing question
  const back = await answer("verify_identity", found, { ...TOBIAS_FILE_VERIFY }, { persona: persona("returning") });
  assertMatch(back.message, /Welcome back\. I see you called on October tenth\. Let's get your claim started\./);
  // a wrong date of birth never reads anything, whatever the intent
  assertEquals(
    (await answer("verify_identity", found, { dob_month: 6, dob_day: 2, dob_year: 1984, intent: "claim_status" })).code,
    "auth_failed",
  );
});

Deno.test("start_claim mock: who may report a loss comes from the call's state, before any argument", async () => {
  const code = async (state: SimState, args: Obj = PIPE) => (await answer("start_claim", state, args)).code;
  assertEquals(await code(initialState()), "claim_needs_lookup");
  // an unreadable number was never a lookup
  assertEquals(
    await code(stateAfter([{ tool: "lookup_customer", args: { phone: "12345" }, code: "invalid_phone" }])),
    "claim_needs_lookup",
  );
  assertEquals(await code(stateAfter(NOT_FOUND_TWICE.slice(0, 1))), "claim_needs_contact");
  // unconfirmed details are not enough
  assertEquals(await code(stateAfter(NEW_CALLER_CONFIRMED.slice(0, 3))), "claim_needs_contact");
  assertEquals(await code(stateAfter([TOBIAS_LOOKUP])), "claim_needs_verification");
  const locked = stateAfter([
    TOBIAS_LOOKUP,
    { tool: "verify_identity", args: { dob_month: 6, dob_day: 2, dob_year: 1984 }, code: "auth_failed" },
    { tool: "verify_identity", args: { dob_month: 6, dob_day: 3, dob_year: 1984 }, code: "locked" },
  ]);
  assertEquals(await code(locked), "claim_locked");
  assertEquals(await code(locked, {}), "claim_locked");
  assertEquals(await code(stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY])), "claim_readback");
  assertEquals(await code(stateAfter(NEW_CALLER_CONFIRMED)), "claim_readback");
  // confirmed details with no number to call back on (a chat has no caller id): the number first
  const noNumber = [
    ...NOT_FOUND_TWICE,
    { tool: "capture_contact", args: JORDAN, code: "contact_readback" },
    { tool: "confirm_contact", args: { correct: true }, code: "contact_saved_new" },
  ];
  assertEquals(await code(stateAfter(noNumber)), "claim_needs_phone");
});

Deno.test("mocks: a loss told before verification or the details is taken down on the next yes", async () => {
  // start_claim sent the caller to verify first: the verified answer asks to take it down now
  const found = stateAfter([TOBIAS_LOOKUP, { tool: "start_claim", args: PIPE, code: "claim_needs_verification" }]);
  const plain = sentenceFor("verified", { first_name: "Tobias" });
  assertEquals(
    (await answer("verify_identity", found, TOBIAS_FILE_VERIFY)).message,
    verifiedFileClaimSentence(plain, true),
  );
  // start_claim asked for a new caller's details first: the saved answer asks the same
  const told = stateAfter([
    ...NOT_FOUND_TWICE,
    { tool: "start_claim", args: PIPE, code: "claim_needs_contact" },
    { tool: "capture_contact", args: { ...JORDAN, callback_phone: "6025550177" }, code: "contact_readback" },
  ]);
  const saved = await answer("confirm_contact", told, { correct: true });
  assertEquals(saved.message, sentenceFor("contact_saved_new", { first_name: "Jordan", resume_claim: true }));
  // otherwise the saved answer offers taking it down first
  const plainSaved = await answer("confirm_contact", stateAfter(NEW_CALLER_CONFIRMED.slice(0, 3)), { correct: true });
  assertStringIncludes(plainSaved.message, "I can take down what happened now");
});

Deno.test("start_claim mock: a second date it cannot read offers a specialist", async () => {
  const verified = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]);
  assertEquals((await answer("start_claim", verified, { ...PIPE, loss_date: "the other day" })).code, "claim_bad_date");
  const once = stateAfter([
    TOBIAS_LOOKUP,
    TOBIAS_VERIFY,
    { tool: "start_claim", args: { ...PIPE, loss_date: "the other day" }, code: "claim_bad_date" },
  ]);
  const help = await answer("start_claim", once, { ...PIPE, loss_date: "a few days ago" });
  assertEquals([help.code, help.message], ["claim_date_help", sentenceFor("claim_date_help")]);
  // a readable day still reads back
  assertEquals((await answer("start_claim", once, PIPE)).code, "claim_readback");
});

Deno.test("start_claim mock: the read-back is the server's sentence, and bad arguments get the server's answers", async () => {
  const verified = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]);
  const r = await answer("start_claim", verified, PIPE);
  assertEquals(r.data, { claim_type: "home", loss_date: "2026-10-11" });
  assertEquals(
    r.message,
    sentenceFor("claim_readback", { claim_type: "home", loss_date: "2026-10-11", summary: PIPE.summary, today: TODAY }),
  );
  assertEquals(
    r.message,
    "Let me make sure I have this right. A home claim, for a burst pipe under the sink, from Sunday, October eleventh. Is that correct?",
  );
  // the summary as the server stores and says it: cleaned, lower-cased (an acronym kept), or left out
  const cases: [unknown, string][] = [
    ["A cracked windshield.", "a cracked windshield"],
    ["TV knocked off the wall", "TV knocked off the wall"],
    ["hail damage, roof", "hail damage, roof"],
    ["Home claim", ""],
    ["water everywhere in the kitchen and the hallway and the basement", ""],
    [undefined, ""],
    // the caller's first person: "my" read as "your", anything else left out
    ["a tree branch on my roof", "a tree branch on your roof"],
    ["Our basement flooded", "your basement flooded"],
    ["I hit a deer", ""],
    ["someone hit me", ""],
  ];
  for (const [summary, said] of cases) {
    const got = await answer("start_claim", verified, { ...PIPE, summary });
    const want = sentenceFor("claim_readback", {
      claim_type: "home",
      loss_date: "2026-10-11",
      today: TODAY,
      ...(said ? { summary: said } : {}),
    });
    assertEquals(got.message, want, String(summary));
    assertEquals(readbackPhrase(summary, "home"), said, String(summary));
  }
  const auto = await answer("start_claim", verified, { ...PIPE, claim_type: "AUTO", summary: "a dented door" });
  assertStringIncludes(auto.message, "An auto claim, for a dented door, from Sunday, October eleventh.");
  assertEquals((await answer("start_claim", verified, { ...PIPE, claim_type: "boat" })).code, "bad_args");
  assertEquals(
    (await answer("start_claim", verified, { ...PIPE, description: "pipe burst" })).code,
    "claim_needs_description",
  );
  assertEquals((await answer("start_claim", verified, { ...PIPE, loss_date: "a while back" })).code, "claim_bad_date");
  assertEquals((await answer("start_claim", verified, { ...PIPE, loss_date: "tomorrow" })).code, "claim_bad_date");
  // a phrase the persona says is read exactly as the server reads it, an old one included
  const old = await answer("start_claim", verified, { ...PIPE, loss_date: "January fifth, 2025" }, {
    persona: { lossDates: ["January fifth, 2025"] },
  });
  assertEquals(old.code, "claim_too_old");
});

Deno.test("start_claim mock reads common date phrases exactly as loss_date.ts does", async () => {
  const verified = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]);
  const phrases = [
    "yesterday",
    "Yesterday afternoon",
    "last night",
    "the day before yesterday",
    "three days ago",
    "5 days ago",
    "a week ago",
    "Saturday",
    "last Saturday",
    "this past Saturday",
    "Saturday night",
    "it happened on Sunday",
    "Monday",
    "last Monday",
    "October 10th",
    "Oct 10",
    "October tenth",
    "the tenth of October",
    "Saturday, October tenth",
    "10/10",
    "10/10/2026",
    "2026-10-10",
    "the 10th",
    "yesterday at 3 pm",
    "October 2nd",
    "the second of October",
    // hedges, nights, a couple of days and the weekend (Saturday) read as the server reads them
    "Saturday, I think",
    "I'm not sure, maybe Saturday",
    "late last night",
    "early this morning",
    "two nights ago",
    "a couple of days ago",
    "over the weekend",
    "last weekend",
    "the night before last",
  ];
  for (const phrase of phrases) {
    const want = parseLossDate(phrase, NOW);
    assert("date" in want, `${phrase} is a date the server reads`);
    const r = await answer("start_claim", verified, { ...PIPE, loss_date: phrase });
    assertEquals([r.code, r.data?.loss_date], ["claim_readback", want.date], phrase);
  }
  // keys are the parser's own cleaning, so a filler or punctuation never changes the lookup
  assertEquals(datePhraseKey("It happened on Saturday, October 10th."), "saturday october 10th");
  assertEquals(datePhraseKey("10 / 10"), "10/10");
  assert(lossDateCandidates(NOW).length < 600, "the candidate table stays small enough to send every turn");
});

Deno.test("start_claim mock: a filed claim is never rewritten", async () => {
  const filed = stateAfter([
    TOBIAS_LOOKUP,
    TOBIAS_VERIFY,
    PIPE_READBACK,
    { tool: "confirm_claim", args: { correct: true }, code: "claim_filed" },
  ]);
  assertEquals(filed.intake, {
    kind: "claim",
    claimType: "home",
    lossDate: "2026-10-11",
    confirmed: true,
    number: SIM_CLAIM_NUMBER,
  });
  const again = await answer("start_claim", filed, PIPE);
  assertEquals([again.code, again.message], [
    "claim_already_filed",
    sentenceFor("claim_already_filed", { claim_last3: "472" }),
  ]);
  assertEquals((await answer("confirm_claim", filed, { correct: false })).code, "claim_already_filed");
});

Deno.test("confirm_claim mock: nothing pending, a no, a yes that files a claim or a new caller's intake", async () => {
  assertEquals((await answer("confirm_claim", initialState(), { correct: true })).code, "claim_not_pending");
  const pending = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY, PIPE_READBACK]);
  assertEquals(pending.intake?.confirmed, false);
  const yes = await answer("confirm_claim", pending, { correct: true });
  assertEquals([yes.code, yes.message], [
    "claim_filed",
    sentenceFor("claim_filed", { claim_last3: "472", emailed: true }),
  ]);
  assertEquals((await answer("confirm_claim", pending, { correct: "Yes" })).code, "claim_filed");
  const no = await answer("confirm_claim", pending, { correct: "no" });
  assertEquals([no.code, no.message], ["claim_retry", "No problem. What should I change?"]);
  assertEquals((await answer("confirm_claim", pending, { correct: "maybe" })).code, "bad_args");
  // a no keeps the intake unfiled for the corrected read-back
  const retried = stateAfter([
    TOBIAS_LOOKUP,
    TOBIAS_VERIFY,
    PIPE_READBACK,
    { tool: "confirm_claim", args: { correct: false }, code: "claim_retry" },
  ]);
  assertEquals(retried.intake?.confirmed, false);
  // Teague has no address on file: filed, and nothing emailed
  const teague = stateAfter([TEAGUE_LOOKUP, TEAGUE_VERIFY, PIPE_READBACK]);
  assertEquals(
    (await answer("confirm_claim", teague, { correct: true })).message,
    sentenceFor("claim_filed", { claim_last3: "472", emailed: false }),
  );
  // a new caller's loss goes to a specialist, with a confirmation to the address they confirmed
  const lead = stateAfter([...NEW_CALLER_CONFIRMED, PIPE_READBACK]);
  assertEquals(lead.intake?.kind, "lead_intake");
  const saved = await answer("confirm_claim", lead, { correct: true });
  assertEquals([saved.code, saved.message], [
    "claim_intake_saved",
    sentenceFor("claim_intake_saved", { first_name: "Jordan", emailed: true }),
  ]);
});

Deno.test("advance names a date phrase the mock could not read but the server would", () => {
  const state = stateAfter([TOBIAS_LOOKUP, TOBIAS_VERIFY]);
  const turn: TurnRecord = {
    user: "",
    chatId: "c",
    model: [],
    continuation: [],
    filler: [],
    heard: [],
    cost: 0,
    calls: [{
      id: "call-1",
      name: "start_claim",
      args: { ...PIPE, loss_date: "two weeks ago" },
      rawArgs: "",
      content: null,
      wordsBefore: false,
      result: { code: "claim_bad_date", message: "", meta: { request_id: "x" } },
    }],
  };
  const notes = advance(state, turn, NOW);
  assertEquals(notes, ['harness: the mock could not read loss_date "two weeks ago" (the server reads 2026-09-28)']);
  assertEquals(state.intake, null);
});

Deno.test("a claim spoken of as filed before confirm_claim filed it is flagged; a filed one is not", () => {
  const turn = (model: string[], calls: TurnRecord["calls"] = []): TurnRecord => ({
    user: "",
    chatId: "c",
    model,
    continuation: [],
    filler: [],
    heard: [],
    cost: 0,
    calls,
  });
  assertEquals(flagProblems([turn(["Great, I've filed your claim."])]), ["flag claim_promised_without_filing"]);
  const filed = turn([], [{
    id: "c1",
    name: "confirm_claim",
    args: { correct: true },
    rawArgs: "",
    content: null,
    wordsBefore: false,
    result: {
      code: "claim_filed",
      message: "",
      data: { claim_last3: "472", emailed: true },
      meta: { request_id: "x" },
    },
  }]);
  assertEquals(flagProblems([filed, turn(["Yes, your claim has been filed and I've emailed the details."])]), []);
});

// The compliant model for each reporting-a-loss persona, request by request.
const FNOL_VERIFIED: Action[][] = [
  [{ call: "lookup_customer", args: { phone: "6025550101" } }],
  [{ call: "verify_identity", args: TOBIAS_FILE_VERIFY }],
  [{ say: "I'm so sorry that happened. When did it happen?" }],
  [{
    call: "start_claim",
    args: {
      claim_type: "auto",
      loss_date: "last Saturday",
      description: "Someone rear-ended me at a red light and cracked my back bumper.",
      summary: "a cracked rear bumper",
    },
  }],
  [{ call: "confirm_claim", args: { correct: true } }],
  [{ call: "endCall" }],
];

Deno.test("FNOL verified with a compliant model: the opening, the date question, the read-back, filed", async () => {
  const vapi = fakeVapi(FNOL_VERIFIED);
  const r = await runConversation(persona("fnol-verified"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertEquals(
    r.turns[3].calls[0].result?.message,
    sentenceFor("claim_readback", {
      claim_type: "auto",
      loss_date: "2026-10-10",
      summary: "a cracked rear bumper",
      today: TODAY,
    }),
  );
  assertStringIncludes(r.turns[4].heard.join(" "), "Your claim number ends in four seven two");
});

Deno.test("FNOL verified fails on a read-back of its own, a date worked out, or a claim called filed too soon", async () => {
  const script = structuredClone(FNOL_VERIFIED);
  script[2] = [{ say: "Sorry to hear it. When was that? And do you have your policy number?" }];
  // the day the caller meant, worked out by the model instead of passed in their words
  const worked = parseLossDate("last Saturday", new Date());
  (script[3][0] as { call: string; args: Obj }).args.loss_date = "date" in worked ? worked.date : "";
  script[4] = [{ say: "Great, I've filed your claim." }];
  const r = await runConversation(persona("fnol-verified"), 1, base, fakeVapi(script).chat, () => NOW);
  const text = r.problems.join(" | ");
  assertStringIncludes(text, "t3: 2 questions in one turn");
  assertStringIncludes(text, "model text matches /\\bpolicy number\\b/i");
  assertStringIncludes(text, "is a date worked out by the model");
  assertStringIncludes(text, "t5: tools [], expected [confirm_claim]");
  assertStringIncludes(text, "flag claim_promised_without_filing");
});

Deno.test("FNOL new caller with a compliant model: details confirmed first, then the loss taken as a lead", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550199" } }],
    [{ call: "lookup_customer", args: { phone: "6025550199" } }],
    [{ say: "Thanks, Dana. What's the best email address for you? Please spell it out, letter by letter." }],
    [{ say: "Got it. What's the best number to reach you?" }],
    [{
      call: "capture_contact",
      args: {
        first_name: "Dana",
        last_name: "Whitfield",
        email: "dana.whitfield@gmail.com",
        callback_phone: "6025550188",
      },
    }],
    [{ call: "confirm_contact", args: { correct: true } }],
    [{
      call: "start_claim",
      args: {
        claim_type: "home",
        loss_date: "last night",
        description: "A big tree branch came down on my roof in the storm.",
        summary: "a tree branch on the roof",
      },
    }],
    [{ call: "confirm_claim", args: { correct: true } }],
  ]);
  const r = await runConversation(persona("fnol-new-caller"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertEquals(
    r.turns.at(-1)?.calls[0].result?.message,
    sentenceFor("claim_intake_saved", {
      first_name: "Dana",
      emailed: true,
    }),
  );
});

Deno.test("FNOL correction with a compliant model: a no, the corrected day read back, filed", async () => {
  const pipe = { ...PIPE, loss_date: "Sunday" };
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: TOBIAS_FILE_VERIFY }],
    [{ call: "start_claim", args: pipe }],
    [{ call: "confirm_claim", args: { correct: false } }],
    [{ call: "start_claim", args: { ...pipe, loss_date: "Friday" } }],
    [{ call: "confirm_claim", args: { correct: true } }],
  ]);
  const r = await runConversation(persona("fnol-correction"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertStringIncludes(r.turns[4].calls[0].result?.message ?? "", "from Friday, October ninth.");
});

Deno.test("FNOL locked: the server's refusal or the model's own both pass; asking for the details fails", async () => {
  const head: Action[][] = [
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 6, dob_day: 2, dob_year: 1984 } }],
    [{ call: "verify_identity", args: { dob_month: 6, dob_day: 3, dob_year: 1984 } }],
  ];
  const tail: Action[] = [{
    call: "escalate",
    args: { reason: "representative_requested", details: "Wants to report a claim." },
  }];
  const server = fakeVapi([...head, [{ call: "start_claim", args: PIPE }], tail]);
  const viaTool = await runConversation(persona("fnol-locked"), 1, base, server.chat, () => NOW);
  assertEquals(viaTool.problems, []);
  assertEquals(viaTool.turns[3].calls[0].result?.message, sentenceFor("claim_locked"));
  const own = fakeVapi([
    ...head,
    [{
      say:
        "Since I couldn't verify your identity, I can't take a claim on this call. I can have a claims representative call you back. Would you like that?",
    }],
    tail,
  ]);
  assertEquals((await runConversation(persona("fnol-locked"), 1, base, own.chat, () => NOW)).problems, []);
  const asks = fakeVapi([...head, [{ say: "I'm sorry to hear that. When did it happen?" }], tail]);
  const r = await runConversation(persona("fnol-locked"), 1, base, asks.chat, () => NOW);
  assertStringIncludes(r.problems.join(" | "), "t4: model text matches /\\bwhen\\b");
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
const TOBIAS_STATUS_VERIFY = { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "claim_status" };

Deno.test("F1 with a compliant model passes, and the requests chain like a voice call", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: TOBIAS_STATUS_VERIFY }],
    [{ call: "endCall" }],
  ]);
  const r = await runConversation(persona("f1"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assert(r.pass);
  assertEquals(r.requests, 3);
  assertEquals(vapi.bodies[0].input, [{ role: "assistant", content: base.firstMessage }, {
    role: "user",
    content: persona("f1").turns[0].user,
  }]);
  assertEquals(vapi.bodies[0].previousChatId, undefined);
  assertEquals(vapi.bodies[1].previousChatId, "chat-1");
  assertEquals(vapi.bodies[2].input, "No, that's everything. Thanks, bye.");
  for (const b of vapi.bodies) assert(b.name.startsWith("INTERNAL ") && b.name.length <= 40, b.name);
  assertEquals(r.turns.map((t) => t.calls.map((c) => c.result?.code ?? c.name)), [["needs_dob"], ["verified"], [
    "endCall",
  ]]);
  // the verified answer carried the claims read, as the server's chained read does
  assertStringIncludes(r.turns[1].heard.join(" "), "four thousand eight hundred twenty dollars");
});

Deno.test("F1 fails when the verified answer is not asked for the claims and they are read separately", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986 } }],
    [{ call: "get_claim_status" }],
  ]);
  const r = await runConversation(persona("f1"), 1, base, vapi.chat, () => NOW);
  const text = r.problems.join(" | ");
  assertStringIncludes(text, "t2: verify_identity: intent was null");
  assertStringIncludes(text, "t3: tools [get_claim_status], expected [endCall]");
  assertStringIncludes(text, "called get_claim_status");
});

Deno.test("F1 fails when the model adds words before a tool call or reads the name too early", async () => {
  const vapi = fakeVapi([
    [{ say: "Thanks Tobias!" }, { call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: TOBIAS_STATUS_VERIFY }, { say: "Anything else?" }],
    [{ call: "endCall" }],
  ]);
  const r = await runConversation(persona("f1"), 1, base, vapi.chat, () => NOW);
  assert(!r.pass);
  const text = r.problems.join(" | ");
  assertStringIncludes(text, "t1: words of its own in a tool turn");
  assertStringIncludes(text, "t1: model text matches /\\b(Tobias|Halvorsen)\\b/i");
  // words after verify_identity's spoken sentence are the /chat continuation voice never speaks
  assertFalse(text.includes("t2:"), text);
  assertEquals(r.turns[1].continuation, ["Anything else?"]);
});

Deno.test("a second server tool chained in the verify turn is named as such", async () => {
  const vapi = fakeVapi([
    [{ call: "lookup_customer", args: { phone: "6025550101" } }],
    [{ call: "verify_identity", args: TOBIAS_STATUS_VERIFY }, { call: "get_claim_status" }],
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
    [{ call: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "other" } }],
    [{ say: "Would you like me to email the document list to the address on your account?" }],
    [{ call: "send_info_email", args: { topic: "document_checklist" } }],
  ]);
  const r = await runConversation(persona("info-email"), 1, base, vapi.chat, () => NOW);
  assertEquals(r.problems, []);
  assertEquals(r.requests, 5);
  assertEquals(vapi.bodies[4].input, "Yes, please.");
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
