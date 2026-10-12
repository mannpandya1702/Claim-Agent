// Offline tests of the /chat battery harness. A fake VAPI plays the model from a script and runs
// the generated mock code locally, exactly as VAPI's code tool would (args in scope, return value
// as the tool message), so plans, parsing, state replay and every check run with no network.

import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
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
  assert(base.fillers.has("One moment while I look that up."));
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
      { role: "assistant", content: "One moment while I look that up." },
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify({ code: "needs_dob", message: "Thanks.", meta: { request_id: "r1" } }, null, 2),
      },
    ],
  };
  const turn = parseTurn("my number", response, base.fillers, "r1");
  assertEquals(turn.model, ["Sure."]);
  assertEquals(turn.filler, ["One moment while I look that up."]);
  assertEquals(turn.heard, ["Sure.", "One moment while I look that up.", "Thanks."]);
  assertEquals(turn.calls[0].args, { phone: "6025550101" });
  assertEquals(turn.calls[0].wordsBefore, true);
  assertEquals(turn.calls[0].result?.code, "needs_dob");
  assertEquals(turn.cost, 0.0123);
  // a result without this request's sentinel is not trusted as the mock's answer
  assertEquals(parseTurn("x", response, base.fillers, "r2").calls[0].result, null);
  assertStringIncludes(genericProblems(turn, base.toolNames).join(" "), "words of its own in a tool turn");
});

Deno.test("generic checks: smuggled identity fields, two questions, a missing mock answer", () => {
  const turn: TurnRecord = {
    user: "",
    chatId: "c",
    filler: [],
    heard: [],
    cost: 0,
    model: [],
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

Deno.test("F1 fails when the model adds words to a tool turn or reads the name too early", async () => {
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
  assertStringIncludes(text, "t3: words of its own in a tool turn");
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
