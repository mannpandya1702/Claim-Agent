import { assert, assertEquals, assertFalse, assertMatch, assertNotMatch, assertStringIncludes } from "@std/assert";
import { createFakeStore } from "./fake_store.ts";
import {
  BATCH_BUDGET_MS,
  createHandler,
  handle,
  NATIVE_MAX_WORDS,
  type Routes,
  speaksNatively,
  timingSafeEqual,
  TOOL_BACKSTOP_MS,
} from "./handler.ts";
import { sentenceFor, spokenWords } from "./speak.ts";
import { TOOL_BUDGET_MS as TOOLS_OWN_BUDGET_MS } from "./tools.ts";
import type { Deps, Env, ParsedToolCall, Store, ToolCtx, ToolResult, VapiMessage } from "./types.ts";

const SECRET = "whsec-test-0123456789abcdef";
const ORG = "4f1c2d3e-0000-4000-8000-00000000a0a0";
const CALL_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const URL_BASE = "https://example.supabase.co/functions/v1/vapi-webhook";
const TOBIAS_PHONE = "602-555-0101";

type Ctx = Omit<ToolCtx, "toolCallId">;

// No unit test may reach the network; a tool that tries gets a rejected promise, not a socket.
/** What the handler adds for a sentence it leaves to the model (longer than NATIVE_MAX_WORDS). */
function spokenFlag(sentence: string): { spoken?: false } {
  return speaksNatively(sentence, true) ? {} : { spoken: false };
}

/** The native message VAPI speaks for a sentence, or undefined when the model reads it. */
function nativeContent(sentence: string): string | undefined {
  return speaksNatively(sentence, true) ? sentence : undefined;
}

const noNetwork = (() => Promise.reject(new Error("network disabled in unit tests"))) as typeof fetch;

// A store that fails the test if anything touches it (routes that must never reach the DB).
const untouchableStore = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`store.${String(prop)} must not be used here`);
  },
}) as Store;

function makeDeps(env: Partial<Env> = {}, store: Store = createFakeStore()) {
  const logs: Record<string, unknown>[] = [];
  const background: Promise<unknown>[] = [];
  const deps: Deps = {
    store,
    fetch: noNetwork,
    env: { VAPI_ORG_ID: ORG, VAPI_WEBHOOK_SECRET: SECRET, ...env },
    now: () => new Date("2026-10-12T15:00:00Z"),
    waitUntil: (p) => {
      background.push(p);
    },
    log: (e) => logs.push(e),
  };
  return { deps, logs, background };
}

function post(body: unknown, opts: { path?: string; auth?: string | null; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = opts.auth === undefined ? `Bearer ${SECRET}` : opts.auth;
  if (auth !== null) headers.Authorization = auth;
  return new Request(URL_BASE + (opts.path ?? ""), {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

function callEnvelope(extra: Partial<VapiMessage> = {}): VapiMessage {
  return {
    type: "tool-calls",
    call: { id: CALL_ID, orgId: ORG, type: "webCall" },
    ...extra,
  };
}

function chatEnvelope(chatId: string, sessionId: string, extra: Partial<VapiMessage> = {}): VapiMessage {
  return { type: "tool-calls", chat: { id: chatId, sessionId, orgId: ORG }, ...extra };
}

function fnCall(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: args } };
}

interface Parsed {
  name: string;
  toolCallId: string;
  result: string;
  json: { code: string; message: string; spoken?: false; data?: Record<string, unknown> };
  message?: { type: string; content: string };
}

async function results(res: Response): Promise<Parsed[]> {
  const body = await res.json();
  assert(Array.isArray(body.results), JSON.stringify(body));
  return body.results.map((r: Parsed) => ({ ...r, json: JSON.parse(r.result) }));
}

function fakeRoutes(answer?: (call: ParsedToolCall, ctx: Ctx) => ToolResult | Promise<ToolResult>) {
  const seen: { call: ParsedToolCall; ctx: Ctx }[] = [];
  const routed: { route: string; message: VapiMessage }[] = [];
  const routes: Partial<Routes> = {
    runTool: async (call, ctx) => {
      seen.push({ call, ctx });
      return answer ? await answer(call, ctx) : { code: "needs_dob", sentence: sentenceFor("needs_dob") };
    },
    onStatusUpdate: (message) => {
      routed.push({ route: "status-update", message });
      return Promise.resolve();
    },
    onTranscript: (message) => {
      routed.push({ route: "transcript", message });
      return Promise.resolve();
    },
    onEndOfCallReport: (message) => {
      routed.push({ route: "end-of-call-report", message });
      return Promise.resolve({ status: 200, body: {} });
    },
  };
  return { routes, seen, routed };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------------------------------------
Deno.test("timingSafeEqual: equal and unequal strings", () => {
  assert(timingSafeEqual("", ""));
  assert(timingSafeEqual(SECRET, SECRET));
  // built from code points so the source stays ASCII (deno fmt rewrites \u escapes as literals)
  const accented = String.fromCodePoint(0x63, 0x61, 0x66, 0xe9, 0x2d, 0x4e2d);
  const eAcute = String.fromCodePoint(0xe9);
  assert(timingSafeEqual(accented, String.fromCodePoint(0x63, 0x61, 0x66, 0xe9, 0x2d, 0x4e2d)));
  assertFalse(timingSafeEqual(SECRET, SECRET.replace(/^w/, "x")), "first byte differs");
  assertFalse(timingSafeEqual(SECRET, SECRET.slice(0, -1) + "0"), "last byte differs");
  assertFalse(timingSafeEqual(SECRET, SECRET.slice(0, -1)), "prefix of the secret");
  assertFalse(timingSafeEqual(SECRET, SECRET + "x"), "secret plus a suffix");
  assertFalse(timingSafeEqual("", SECRET));
  assertFalse(timingSafeEqual(SECRET, ""));
  // same UTF-16 length, different UTF-8 bytes: the comparison is over bytes, not code units
  assertFalse(timingSafeEqual(eAcute, "e"));
  assertFalse(timingSafeEqual("a\u0000", "a"), "a trailing NUL is not the padding");
  assertFalse(timingSafeEqual(undefined as unknown as string, undefined as unknown as string));
});

Deno.test("timingSafeEqual: a length mismatch does not return early", () => {
  const src = timingSafeEqual.toString();
  assertNotMatch(src, /length\s*!==?\s*\w+\.length\)?\s*\{?\s*return/, "no early return on length");
  assertMatch(src, /Math\.max\(/, "loops over the longer input");
});

// ---------------------------------------------------------------------------------------------
// /health, methods, auth, org
// ---------------------------------------------------------------------------------------------
Deno.test("GET and OPTIONS /health answer without auth, with CORS headers and no data", async () => {
  const { deps, logs } = makeDeps({}, untouchableStore);
  for (const method of ["GET", "OPTIONS"]) {
    for (const path of ["/health", "/health/", "/functions/v1/vapi-webhook/health"]) {
      const res = await handle(new Request(`https://example.supabase.co${path}`, { method }), deps);
      assertEquals(res.status, 200, `${method} ${path}`);
      assertEquals(await res.json(), { ok: true });
      assertEquals(res.headers.get("access-control-allow-origin"), "*");
      assertStringIncludes(res.headers.get("access-control-allow-methods") ?? "", "GET");
      assertStringIncludes(res.headers.get("access-control-allow-methods") ?? "", "OPTIONS");
      assertStringIncludes((res.headers.get("access-control-allow-headers") ?? "").toLowerCase(), "authorization");
      assertStringIncludes((res.headers.get("access-control-allow-headers") ?? "").toLowerCase(), "content-type");
    }
  }
  assertEquals(logs.length, 6);
});

Deno.test("POST /health is not a bypass: it still needs the Bearer", async () => {
  const { deps } = makeDeps({}, untouchableStore);
  const res = await handle(post({ message: callEnvelope() }, { path: "/health", auth: null }), deps);
  assertEquals(res.status, 401);
});

Deno.test("other methods are 405", async () => {
  const { deps } = makeDeps({}, untouchableStore);
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
    const res = await handle(new Request(URL_BASE, { method }), deps);
    assertEquals(res.status, 405, method);
    await res.body?.cancel();
  }
});

Deno.test("missing Bearer -> 401, nothing runs", async () => {
  const { routes, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps, logs } = makeDeps({ CAPTURE_WEBHOOKS: "true" }, untouchableStore);
  const res = await run(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) }, { auth: null }),
    deps,
  );
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "unauthorized" });
  assertEquals(res.headers.get("www-authenticate"), "Bearer");
  assertEquals(seen.length, 0);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].status, 401);
  assertEquals(logs[0].call_key, null, "an unauthenticated body is never parsed");
});

Deno.test("wrong Bearer -> 401 in every shape", async () => {
  const { routes, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps } = makeDeps({}, untouchableStore);
  const body = { message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) };
  for (
    const auth of [
      `Bearer ${SECRET.replace(/f$/, "e")}`,
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer ${SECRET}x`,
      `Basic ${SECRET}`,
      SECRET,
      "Bearer",
      "Bearer ",
      `Bearer ${SECRET} extra`,
    ]
  ) {
    const res = await run(post(body, { auth }), deps);
    assertEquals(res.status, 401, auth);
    await res.body?.cancel();
  }
  assertEquals(seen.length, 0);
});

Deno.test("the Bearer scheme is case-insensitive", async () => {
  const run = createHandler(fakeRoutes().routes);
  const { deps } = makeDeps({}, untouchableStore);
  const res = await run(
    post({ message: { type: "speech-update", call: { id: CALL_ID, orgId: ORG } } }, { auth: `bearer ${SECRET}` }),
    deps,
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("a blank configured secret authorises nothing", async () => {
  const run = createHandler(fakeRoutes().routes);
  for (const secret of ["", "   "]) {
    const { deps } = makeDeps({ VAPI_WEBHOOK_SECRET: secret }, untouchableStore);
    for (const auth of ["Bearer ", "Bearer", `Bearer ${SECRET}`, null]) {
      const res = await run(post({ message: callEnvelope() }, { auth }), deps);
      assertEquals(res.status, 401, `${JSON.stringify(secret)} / ${auth}`);
      await res.body?.cancel();
    }
  }
});

Deno.test("wrong or missing org -> 403, nothing runs or is captured", async () => {
  const { routes, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps, background } = makeDeps({ CAPTURE_WEBHOOKS: "true" }, untouchableStore);
  const calls = { toolCallList: [fnCall("t1", "lookup_customer", { phone: TOBIAS_PHONE })] };
  for (
    const message of [
      { type: "tool-calls", call: { id: CALL_ID, orgId: "someone-else" }, ...calls },
      { type: "tool-calls", call: { id: CALL_ID }, ...calls },
      { type: "tool-calls", chat: { id: "c1", sessionId: "s1", orgId: "someone-else" }, ...calls },
      { type: "tool-calls", ...calls },
      // call.orgId wins over chat.orgId (?? semantics): a wrong call org is not rescued
      { type: "tool-calls", call: { id: CALL_ID, orgId: "someone-else" }, chat: { orgId: ORG }, ...calls },
      { type: "tool-calls", call: { id: CALL_ID, orgId: 42 }, ...calls },
    ]
  ) {
    const res = await run(post({ message }), deps);
    assertEquals(res.status, 403, JSON.stringify(message));
    assertEquals(await res.json(), { error: "forbidden" });
  }
  assertEquals(seen.length, 0);
  assertEquals(background.length, 0);
});

Deno.test("a blank VAPI_ORG_ID refuses every message, even one with a blank org", async () => {
  const run = createHandler(fakeRoutes().routes);
  const { deps } = makeDeps({ VAPI_ORG_ID: "" }, untouchableStore);
  const res = await run(post({ message: { type: "tool-calls", call: { id: CALL_ID, orgId: "" } } }), deps);
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("chat envelope org (message.chat.orgId, no call) is accepted", async () => {
  const { routes, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps } = makeDeps({}, untouchableStore);
  const res = await run(
    post({ message: { type: "conversation-update", chat: { id: "c1", sessionId: "s1", orgId: ORG } } }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {});

  const res2 = await run(
    post({ message: chatEnvelope("c1", "s1", { toolCallList: [fnCall("t1", "get_claim_status", {})] }) }),
    deps,
  );
  assertEquals(res2.status, 200);
  assertEquals((await results(res2)).map((r) => r.toolCallId), ["t1"]);
  assertEquals(seen.length, 1);
});

Deno.test("bad JSON -> 400; a body without a message object -> 400", async () => {
  const run = createHandler(fakeRoutes().routes);
  const { deps } = makeDeps({}, untouchableStore);
  const bad = await run(post(null, { raw: "{not json" }), deps);
  assertEquals(bad.status, 400);
  assertEquals(await bad.json(), { error: "bad_json" });
  for (const body of [null, [], {}, { message: "tool-calls" }, { message: [] }]) {
    const res = await run(post(body), deps);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
});

// ---------------------------------------------------------------------------------------------
// tool-calls: envelope shapes and the response
// ---------------------------------------------------------------------------------------------
Deno.test("parseCalls variants all produce results with the matching toolCallId", async () => {
  const variants: Record<string, Partial<VapiMessage>> = {
    "string arguments": {
      toolCallList: [fnCall("call_str", "lookup_customer", JSON.stringify({ phone: TOBIAS_PHONE }))],
    },
    "object arguments": { toolCalls: [fnCall("call_obj", "lookup_customer", { phone: TOBIAS_PHONE })] },
    "flat parameters": {
      toolCallList: [{ id: "call_flat", name: "lookup_customer", parameters: { phone: TOBIAS_PHONE } }],
    },
    "toolWithToolCallList": {
      toolWithToolCallList: [{
        type: "function",
        function: {
          name: "lookup_customer",
          parameters: { type: "object", properties: { phone: { type: "string" } } },
        },
        toolCall: {
          id: "call_twtcl",
          type: "function",
          function: { name: "lookup_customer", arguments: { phone: TOBIAS_PHONE } },
        },
      }],
    },
  };
  for (const [label, shape] of Object.entries(variants)) {
    const { routes, seen } = fakeRoutes();
    const { deps } = makeDeps({}, untouchableStore);
    const res = await createHandler(routes)(post({ message: callEnvelope(shape) }), deps);
    assertEquals(res.status, 200, label);
    const out = await results(res);
    assertEquals(out.length, 1, label);
    assertEquals(out[0].toolCallId, seen[0].call.id, label);
    assertEquals(out[0].name, "lookup_customer", label);
    assertEquals(seen[0].call.args, { phone: TOBIAS_PHONE }, label);
    assertEquals(out[0].json.code, "needs_dob", label);
  }
});

Deno.test("unparseable arguments reach the tool as args null and still answer at HTTP 200", async () => {
  const { routes, seen } = fakeRoutes((call) =>
    call.args === null
      ? { code: "bad_args", sentence: sentenceFor("bad_args") }
      : { code: "needs_dob", sentence: sentenceFor("needs_dob") }
  );
  const { deps } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", "{phone: 602")] }) }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(seen[0].call.args, null);
  const [r] = await results(res);
  assertEquals(r.toolCallId, "t1");
  assertEquals(r.json.code, "bad_args");
});

Deno.test("missing tool list -> 200 {results: []} and nothing runs", async () => {
  const { routes, seen } = fakeRoutes();
  const { deps } = makeDeps({}, untouchableStore);
  for (
    const message of [
      callEnvelope(),
      callEnvelope({ toolCallList: [] }),
      callEnvelope({ toolCallList: [{ function: { name: "x" } }] }),
    ]
  ) {
    const res = await createHandler(routes)(post({ message }), deps);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { results: [] });
  }
  // no call key is needed when there is nothing to run
  const res = await createHandler(routes)(post({ message: { type: "tool-calls", call: { orgId: ORG } } }), deps);
  assertEquals(await res.json(), { results: [] });
  assertEquals(seen.length, 0);
});

Deno.test("tool calls without any call key -> 400", async () => {
  const { routes, seen } = fakeRoutes();
  const { deps } = makeDeps({}, untouchableStore);
  const message = { type: "tool-calls", call: { orgId: ORG }, toolCallList: [fnCall("t1", "get_claim_status", {})] };
  const res = await createHandler(routes)(post({ message }), deps);
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "missing_call_key" });
  assertEquals(seen.length, 0);
});

Deno.test("result is one-line JSON with code and message; the native message speaks the same sentence", async () => {
  const { routes } = fakeRoutes(() => ({
    code: "claim_retry",
    sentence: sentenceFor("claim_retry"),
    data: { digits: "6025550199", note: "two\nlines" },
  }));
  const { deps } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  const [r] = await results(res);
  assertFalse(r.result.includes("\n"), "one line");
  assertEquals(Object.keys(r.json), ["code", "message", "data"]);
  assertEquals(r.json.code, "claim_retry");
  assertEquals(r.json.message, sentenceFor("claim_retry"));
  assertEquals(r.json.data, { digits: "6025550199", note: "two\nlines" });
  assertEquals(r.message, { type: "request-complete", content: r.json.message });
});

Deno.test("a sentence over NATIVE_MAX_WORDS goes to the model to read: spoken false, no native message", async () => {
  // VAPI speaks a native tool message to the end with no way for the caller to interrupt it; the
  // model's own speech can be interrupted, so all but very short sentences (a spelled read-back here)
  // are the model's to read word for word. 12 words is about four seconds at voice speed 1.0.
  assertEquals(NATIVE_MAX_WORDS, 12);
  const long = sentenceFor("contact_readback", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: "+16025550177",
  });
  assert(spokenWords(long) > NATIVE_MAX_WORDS, `${spokenWords(long)} words`);
  const short = sentenceFor("claim_retry");
  assert(spokenWords(short) <= NATIVE_MAX_WORDS, `${spokenWords(short)} words`);
  assert(speaksNatively(short, true) && !speaksNatively(short, false) && !speaksNatively(long, true));
  // the date-of-birth question, a number read-back and the callback answers are model-read, so the
  // caller can cut in on any of them
  for (const [code, data] of [["needs_dob", {}], ["not_found", { digits: "6025550199" }]] as const) {
    assertFalse(speaksNatively(sentenceFor(code, data), true), code);
  }
  for (const target of ["account", "caller_id"]) {
    assertFalse(speaksNatively(sentenceFor("rep_queued", { target }), true), target);
  }
  assertFalse(speaksNatively(sentenceFor("rep_unavailable"), true));
  const { routes } = fakeRoutes(() => ({ code: "contact_readback", sentence: long, data: { pending: true } }));
  const { deps, logs } = makeDeps({}, untouchableStore);
  const [r] = await results(
    await createHandler(routes)(
      post({ message: callEnvelope({ toolCallList: [fnCall("t1", "capture_contact", {})] }) }),
      deps,
    ),
  );
  assertEquals(r.message, undefined);
  assertEquals(Object.keys(r.json), ["code", "message", "spoken", "data"]);
  assertEquals(r.json, { code: "contact_readback", message: long, spoken: false, data: { pending: true } });
  // a long sentence is not an error; only one over VAPI's character limit is logged
  assertFalse(String(logs.at(-1)?.error ?? "").includes("tool_message_too_long"));
});

Deno.test("data is omitted from the result when the tool returns none", async () => {
  const { routes } = fakeRoutes(() => ({ code: "claim_retry", sentence: sentenceFor("claim_retry") }));
  const { deps } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) }),
    deps,
  );
  const [r] = await results(res);
  assertEquals(r.result, JSON.stringify({ code: "claim_retry", message: sentenceFor("claim_retry") }));
});

Deno.test("NATIVE_TOOL_MESSAGES=false omits the message key; anything else keeps it", async () => {
  // a sentence short enough to be native, so only the flag decides
  const short = () => ({ code: "claim_retry" as const, sentence: sentenceFor("claim_retry") });
  const msg = { message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) };
  const off = makeDeps({ NATIVE_TOOL_MESSAGES: "false" }, untouchableStore);
  const [r] = await results(await createHandler(fakeRoutes(short).routes)(post(msg), off.deps));
  assertFalse("message" in r);
  assertEquals(r.json.message, sentenceFor("claim_retry"));
  assertEquals(r.json.spoken, false);
  for (const value of [undefined, "true", "FALSE ", ""]) {
    const on = makeDeps(value === undefined ? {} : { NATIVE_TOOL_MESSAGES: value }, untouchableStore);
    const [r2] = await results(await createHandler(fakeRoutes(short).routes)(post(msg), on.deps));
    assertEquals(r2.message, { type: "request-complete", content: sentenceFor("claim_retry") }, String(value));
  }
});

Deno.test("a tool that throws is a system_error sentence at HTTP 200", async () => {
  const { routes } = fakeRoutes(() => {
    throw new Error("connection reset");
  });
  const { deps, logs } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) }),
    deps,
  );
  assertEquals(res.status, 200);
  const [r] = await results(res);
  // spoken by VAPI, or left to the model (spoken: false) when longer than NATIVE_MAX_WORDS
  assertEquals(r.json, {
    code: "system_error",
    message: sentenceFor("system_error"),
    ...spokenFlag(sentenceFor("system_error")),
  });
  assertEquals(r.message?.content, nativeContent(sentenceFor("system_error")));
  assertEquals(logs.length, 1);
  assertEquals(logs[0].code, "system_error");
  assertStringIncludes(String(logs[0].error), "connection reset");
});

Deno.test("error text in the log line is redacted", async () => {
  const { routes } = fakeRoutes(() => {
    throw new Error("invalid input for +16025550101 born 1986-03-14");
  });
  const { deps, logs } = makeDeps({}, untouchableStore);
  await createHandler(routes)(post({ message: callEnvelope({ toolCallList: [fnCall("t1", "escalate", {})] }) }), deps);
  const error = String(logs[0].error);
  assertStringIncludes(error, "[phone ending 0101]");
  assertStringIncludes(error, "[date of birth]");
  assertFalse(error.includes("5550101") || error.includes("1986"), error);
});

Deno.test("when runTool itself fails, emergency and escalate keep their safer sentences", async () => {
  const failures: Record<string, () => unknown> = {
    throws: () => {
      throw new Error("boom");
    },
    malformed: () => ({ code: "made_up_code", sentence: "" }),
    hangs: () => new Promise(() => {}),
  };
  for (const [how, fail] of Object.entries(failures)) {
    const { routes } = fakeRoutes(() => fail() as ToolResult);
    const { deps } = makeDeps({}, untouchableStore);
    const message = callEnvelope({
      toolCallList: [
        fnCall("e1", "report_emergency", { note: "smoke in the kitchen" }),
        fnCall("e2", "escalate", {}),
        fnCall("e3", "send_info_email", { topic: "claim_summary" }),
      ],
    });
    const out = await results(await createHandler(routes, { backstopMs: 20 })(post({ message }), deps));
    assertEquals(out[0].json, {
      code: "emergency_logged",
      message: sentenceFor("emergency_logged", { db_failed: true }),
      ...spokenFlag(sentenceFor("emergency_logged", { db_failed: true })),
      data: { db_failed: true },
    }, how);
    assertEquals(out[0].json.message, "Please stay on the line. Are you safe right now?", how);
    assertEquals(
      out[1].json,
      {
        code: "rep_unavailable",
        message: sentenceFor("rep_unavailable"),
        ...spokenFlag(sentenceFor("rep_unavailable")),
      },
      how,
    );
    assertEquals(
      out[2].json,
      { code: "system_error", message: sentenceFor("system_error"), ...spokenFlag(sentenceFor("system_error")) },
      how,
    );
  }
});

Deno.test("the handler backstop fires after the tools' own budget and before VAPI's 10 s timeout", () => {
  assert(TOOL_BACKSTOP_MS > TOOLS_OWN_BUDGET_MS, "a backstop that fires first pre-empts the tool fallback");
  assert(TOOL_BACKSTOP_MS <= 8000, "VAPI's server timeoutSeconds is 10");
});

Deno.test("a malformed tool result is replaced by system_error", async () => {
  const bad = [
    { code: "made_up_code", sentence: "Hello." },
    { code: "ok", sentence: "" },
    { code: "ok" },
    null,
    "ok",
  ];
  for (const value of bad) {
    const { routes } = fakeRoutes(() => value as unknown as ToolResult);
    const { deps } = makeDeps({}, untouchableStore);
    const res = await createHandler(routes)(
      post({ message: callEnvelope({ toolCallList: [fnCall("t1", "get_claim_status", {})] }) }),
      deps,
    );
    const [r] = await results(res);
    assertEquals(r.json.code, "system_error", JSON.stringify(value));
  }
});

Deno.test("unserialisable data is dropped but the sentence survives", async () => {
  const { routes } = fakeRoutes(() => ({
    code: "rep_recorded",
    sentence: sentenceFor("rep_recorded"),
    data: { n: 1n },
  }));
  const { deps } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "escalate", {})] }) }),
    deps,
  );
  const [r] = await results(res);
  assertEquals(r.json, { code: "rep_recorded", message: sentenceFor("rep_recorded") });
});

Deno.test("the backstop answers a hung tool with system_error and keeps the work alive to finish", async () => {
  const release = deferred();
  const finished: string[] = [];
  const { routes } = fakeRoutes(async (call) => {
    if (call.id === "slow") {
      await release.promise;
      finished.push("slow");
    }
    return { code: "rep_recorded", sentence: sentenceFor("rep_recorded") };
  });
  const { deps, background, logs } = makeDeps({}, untouchableStore);
  const run = createHandler(routes, { backstopMs: 30 });
  const res = await run(
    post({
      message: callEnvelope({
        toolCallList: [fnCall("slow", "lookup_customer", {}), fnCall("fast", "get_claim_status", {})],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const out = await results(res);
  assertEquals(out.map((r) => [r.toolCallId, r.json.code]), [["slow", "system_error"], ["fast", "rep_recorded"]]);
  assertEquals(logs[0].error, "tool_timeout");
  assertEquals(background.length, 1, "the timed-out work is handed to waitUntil");
  release.resolve();
  await Promise.all(background);
  assertEquals(finished, ["slow"]);
});

Deno.test("a batch shares one deadline: calls after a slow one still run but answer in time", async () => {
  const release = deferred();
  const finished: string[] = [];
  const { routes, seen } = fakeRoutes(async (call) => {
    await release.promise;
    finished.push(call.id);
    return { code: "needs_dob", sentence: sentenceFor("needs_dob") };
  });
  const { deps, background } = makeDeps({}, untouchableStore);
  const started = performance.now();
  const res = await createHandler(routes, { backstopMs: 1000, batchMs: 40 })(
    post({
      message: callEnvelope({
        toolCallList: [fnCall("slow", "lookup_customer", {}), fnCall("sos", "report_emergency", {})],
      }),
    }),
    deps,
  );
  const elapsed = performance.now() - started;
  const out = await results(res);
  assertEquals(out.map((r) => [r.toolCallId, r.json.code]), [["slow", "system_error"], ["sos", "emergency_logged"]]);
  assertEquals(out[1].json.data, { db_failed: true });
  assert(elapsed < 500, `the whole delivery answered within the batch budget (${Math.round(elapsed)} ms)`);
  // the emergency was still started and runs to the end in the background
  assertEquals(seen.map((s) => s.call.id), ["slow", "sos"]);
  assertEquals(background.length, 2);
  release.resolve();
  await Promise.all(background);
  assertEquals(finished.sort(), ["slow", "sos"]);
});

Deno.test("each tool gets a budget that ends before its backstop, so its own fallback is what VAPI receives", async () => {
  const budgets: (number | undefined)[] = [];
  const routes: Partial<Routes> = {
    runTool: async (call, _ctx, budgetMs) => {
      budgets.push(budgetMs);
      if (call.id === "slow") await new Promise((r) => setTimeout(r, 60));
      return { code: "needs_dob", sentence: sentenceFor("needs_dob") };
    },
  };
  const { deps } = makeDeps({}, untouchableStore);
  const one = fnCall("only", "lookup_customer", {});
  await results(await createHandler(routes)(post({ message: callEnvelope({ toolCallList: [one] }) }), deps));
  assertEquals(budgets, [TOOLS_OWN_BUDGET_MS], "one call alone keeps the full tool budget");

  // a batch short of time hands the later call a budget that still ends a second before its backstop
  budgets.length = 0;
  const batch = [fnCall("slow", "lookup_customer", {}), fnCall("next", "get_claim_status", {})];
  await results(
    await createHandler(routes, { batchMs: 2000 })(post({ message: callEnvelope({ toolCallList: batch }) }), deps),
  );
  assert(budgets[0]! > 950 && budgets[0]! <= 1000, String(budgets[0]));
  assert(budgets[1]! < budgets[0]! - 50 && budgets[1]! >= 0, String(budgets[1]));
});

Deno.test("a sentence over VAPI's 1000-character limit goes out without the native message", async () => {
  const long = `${"Your claim is under review. ".repeat(40)}Do you have any questions?`;
  const { routes } = fakeRoutes(() => ({ code: "ok", sentence: long }));
  const { deps, logs } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "get_claim_status", {})] }) }),
    deps,
  );
  const [r] = await results(res);
  assertEquals(r.message, undefined);
  assertEquals(r.json, { code: "ok", message: long, spoken: false });
  assertStringIncludes(String(logs.at(-1)?.error), "tool_message_too_long");
});

Deno.test("the batch budget leaves one call its full backstop and stays under VAPI's 10 s", () => {
  assert(BATCH_BUDGET_MS >= TOOL_BACKSTOP_MS);
  assert(BATCH_BUDGET_MS <= 9000);
});

Deno.test("calls in one delivery run sequentially, in order", async () => {
  const events: string[] = [];
  const { routes } = fakeRoutes(async (call) => {
    events.push(`start ${call.id}`);
    await new Promise((r) => setTimeout(r, call.id === "a" ? 15 : 1));
    events.push(`end ${call.id}`);
    return { code: "needs_dob", sentence: sentenceFor("needs_dob") };
  });
  const { deps, logs } = makeDeps({}, untouchableStore);
  const message = callEnvelope({
    toolCallList: [
      fnCall("a", "lookup_customer", {}),
      fnCall("b", "verify_identity", {}),
      fnCall("c", "get_claim_status", {}),
    ],
  });
  const out = await results(await createHandler(routes)(post({ message }), deps));
  assertEquals(out.map((r) => r.toolCallId), ["a", "b", "c"]);
  assertEquals(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assertEquals(logs[0].tool, "lookup_customer,verify_identity,get_claim_status");
});

// ---------------------------------------------------------------------------------------------
// ToolCtx from the envelope
// ---------------------------------------------------------------------------------------------
Deno.test("ToolCtx comes from the envelope: call key, channel, caller id, chat flag", async () => {
  const { routes, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps } = makeDeps({ OWN_NUMBERS: " +15205210277 , +16025550142" }, untouchableStore);
  const list = { toolCallList: [fnCall("t1", "escalate", {})] };

  await run(
    post({
      message: {
        type: "tool-calls",
        call: {
          id: CALL_ID,
          orgId: ORG,
          type: "inboundPhoneCall",
          customer: { number: "+16025550101" },
          phoneNumber: { number: "+15205210277" },
        },
        ...list,
      },
    }),
    deps,
  );
  await run(
    post({
      message: {
        type: "tool-calls",
        call: { id: CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "+15205210277" } },
        ...list,
      },
    }),
    deps,
  );
  await run(
    post({
      message: {
        type: "tool-calls",
        call: { id: CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "anonymous" } },
        ...list,
      },
    }),
    deps,
  );
  await run(
    post({
      message: {
        type: "tool-calls",
        call: { id: CALL_ID, orgId: ORG, type: "webCall" },
        customer: { number: "+16025550103" },
        ...list,
      },
    }),
    deps,
  );
  await run(
    post({ message: { type: "tool-calls", call: { id: CALL_ID, orgId: ORG, type: "somethingNew" }, ...list } }),
    deps,
  );
  await run(post({ message: { ...chatEnvelope("chat-1", "sess-1"), ...list } }), deps);
  await run(post({ message: { type: "tool-calls", chat: { id: "chat-only", orgId: ORG }, ...list } }), deps);
  await run(
    post({
      message: {
        type: "tool-calls",
        call: { id: CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "+61491570156" } },
        ...list,
      },
    }),
    deps,
  );

  const ctxs = seen.map((s) => ({ ...s.ctx, deps: undefined }));
  assertEquals(ctxs[0], {
    callKey: CALL_ID,
    channel: "inboundPhoneCall",
    callerNumber: "+16025550101",
    isChat: false,
    deps: undefined,
  });
  assertEquals(ctxs[1].callerNumber, null, "our own number is never the caller id");
  assertEquals(ctxs[2].callerNumber, null, "carrier placeholders are not numbers");
  assertEquals(ctxs[3].callerNumber, "+16025550103", "falls back to the envelope customer");
  assertEquals(ctxs[3].channel, "webCall");
  assertEquals(ctxs[4].channel, "unknown");
  assertEquals(ctxs[5], { callKey: "sess-1", channel: "chat", callerNumber: null, isChat: true, deps: undefined });
  assertEquals(ctxs[6].callKey, "chat-only", "chat.id when there is no sessionId");
  assertEquals(ctxs[7].callerNumber, "+61491570156", "a caller id from abroad is a caller id");
  assert(seen.every((s) => s.ctx.deps === deps));
});

Deno.test("/chat envelope: two turns with new chat ids resolve the same session key", async () => {
  const { routes, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps } = makeDeps({}, untouchableStore);
  await run(
    post({
      message: chatEnvelope("chat-turn-1", "session-A", { toolCallList: [fnCall("t1", "lookup_customer", {})] }),
    }),
    deps,
  );
  await run(
    post({
      message: chatEnvelope("chat-turn-2", "session-A", { toolCallList: [fnCall("t2", "verify_identity", {})] }),
    }),
    deps,
  );
  assertEquals(seen.map((s) => s.ctx.callKey), ["session-A", "session-A"]);
  assert(seen.every((s) => s.ctx.isChat && s.ctx.channel === "chat"));
});

// ---------------------------------------------------------------------------------------------
// Other message types
// ---------------------------------------------------------------------------------------------
Deno.test("status-update, both transcript literals and end-of-call-report reach their handlers", async () => {
  const { routes, routed } = fakeRoutes();
  routes.onEndOfCallReport = (message) => {
    routed.push({ route: "end-of-call-report", message });
    return Promise.resolve({ status: 202, body: { stored: true } });
  };
  const run = createHandler(routes);
  const { deps } = makeDeps({}, untouchableStore);
  const call = { id: CALL_ID, orgId: ORG, type: "webCall" };

  const status = await run(post({ message: { type: "status-update", status: "in-progress", call } }), deps);
  assertEquals([status.status, await status.json()], [200, {}]);
  const t1 = await run(post({ message: { type: "transcript", transcriptType: "final", call } }), deps);
  assertEquals([t1.status, await t1.json()], [200, {}]);
  const t2 = await run(
    post({ message: { type: 'transcript[transcriptType="final"]', transcriptType: "final", call } }),
    deps,
  );
  assertEquals([t2.status, await t2.json()], [200, {}]);
  const eocr = await run(post({ message: { type: "end-of-call-report", call } }), deps);
  assertEquals([eocr.status, await eocr.json()], [202, { stored: true }]);

  assertEquals(routed.map((r) => r.route), ["status-update", "transcript", "transcript", "end-of-call-report"]);
  assertEquals(routed[0].message.status, "in-progress");
});

Deno.test("unknown message type -> 200 {} and no handler runs", async () => {
  const { routes, routed, seen } = fakeRoutes();
  const run = createHandler(routes);
  const { deps } = makeDeps({}, untouchableStore);
  for (const type of ["speech-update", "conversation-update", "hang", "model-output", undefined, 7]) {
    const res = await run(post({ message: { type, call: { id: CALL_ID, orgId: ORG } } }), deps);
    assertEquals(res.status, 200, String(type));
    assertEquals(await res.json(), {});
  }
  assertEquals(routed.length + seen.length, 0);
});

Deno.test("a post-call handler that throws is a 500 so VAPI can redeliver", async () => {
  const { routes } = fakeRoutes();
  routes.onEndOfCallReport = () => Promise.reject(new Error("db down"));
  routes.onStatusUpdate = () => Promise.reject(new Error("db down"));
  const run = createHandler(routes);
  const { deps, logs } = makeDeps({}, untouchableStore);
  for (const type of ["end-of-call-report", "status-update"]) {
    const res = await run(post({ message: { type, status: "forwarding", call: { id: CALL_ID, orgId: ORG } } }), deps);
    assertEquals(res.status, 500, type);
    assertEquals(await res.json(), { error: "internal_error" });
  }
  assertEquals(logs.map((l) => l.status), [500, 500]);
});

Deno.test("an end-of-call-report result with an unusable status becomes 500", async () => {
  const { routes } = fakeRoutes();
  routes.onEndOfCallReport = () => Promise.resolve({ status: 99, body: undefined });
  const { deps } = makeDeps({}, untouchableStore);
  const res = await createHandler(routes)(
    post({ message: { type: "end-of-call-report", call: { id: CALL_ID, orgId: ORG } } }),
    deps,
  );
  assertEquals(res.status, 500);
  assertEquals(await res.json(), {});
});

// ---------------------------------------------------------------------------------------------
// Capture, logging, jobs
// ---------------------------------------------------------------------------------------------
Deno.test("a captured body keeps no tool arguments and no unredacted phone, DOB or email", async () => {
  const store = createFakeStore();
  const { deps, background } = makeDeps({ CAPTURE_WEBHOOKS: "true" }, store);
  const dob = { dob_month: 3, dob_day: 14, dob_year: 1986 };
  const message = callEnvelope({
    call: { id: CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "+16025550101" } },
    toolCallList: [fnCall("t1", "verify_identity", JSON.stringify(dob)), {
      id: "t2",
      name: "lookup_customer",
      parameters: { phone: "602-555-0101" },
    }],
    toolWithToolCallList: [{ type: "function", toolCall: fnCall("t1", "verify_identity", dob) }],
    artifact: {
      messages: [
        { role: "user", message: "It's March 14, 1986, and my email is tobias.reyes@example.com" },
        { role: "tool_calls", toolCalls: [fnCall("t1", "verify_identity", JSON.stringify(dob))] },
      ],
    },
  });
  const res = await createHandler(fakeRoutes().routes)(post({ message }), deps);
  assertEquals(res.status, 200);
  await Promise.all(background);
  const captured = store.tables.webhook_captures[0].body;
  const text = JSON.stringify(captured);
  for (const leak of ["arguments", "parameters", "1986", "dob_year", "5550101", "555-0101", "tobias.reyes"]) {
    assertFalse(text.includes(leak), leak);
  }
  // the shape replays still need survives
  assertEquals(captured.message.call.id, CALL_ID);
  assertEquals(captured.message.toolCallList[0].function.name, "verify_identity");
  assertEquals(captured.message.call.customer.number, "[phone ending 0101]");
  assertStringIncludes(text, "[date of birth]");
  assertStringIncludes(text, "[email]");
});

Deno.test("CAPTURE_WEBHOOKS=true stores the body through waitUntil and never blocks or fails", async () => {
  const store = createFakeStore();
  const { deps, background, logs } = makeDeps({ CAPTURE_WEBHOOKS: "true" }, store);
  const body = { message: { type: "speech-update", call: { id: CALL_ID, orgId: ORG } } };
  const res = await createHandler(fakeRoutes().routes)(post(body), deps);
  assertEquals(res.status, 200);
  assertEquals(background.length, 1);
  await Promise.all(background);
  assertEquals(store.tables.webhook_captures.length, 1);
  assertEquals(store.tables.webhook_captures[0].message_type, "speech-update");
  assertEquals(store.tables.webhook_captures[0].call_key, CALL_ID);
  assertEquals(store.tables.webhook_captures[0].body, body);

  store.failNext("captureWebhook");
  const res2 = await createHandler(fakeRoutes().routes)(post(body), deps);
  assertEquals(res2.status, 200);
  await Promise.all(background);
  assert(logs.some((l) => l.event === "capture_failed"), "a capture failure is only logged");

  const off = makeDeps({}, untouchableStore);
  const res3 = await createHandler(fakeRoutes().routes)(post(body), off.deps);
  assertEquals(res3.status, 200);
  assertEquals(off.background.length, 0);
});

Deno.test("one JSON log line per webhook with ids, codes and timing only", async () => {
  const { routes } = fakeRoutes(() => ({ code: "needs_dob", sentence: sentenceFor("needs_dob") }));
  const { deps, logs } = makeDeps({}, untouchableStore);
  const message = callEnvelope({
    call: { id: CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "+16025550101" } },
    toolCallList: [
      fnCall("t1", "lookup_customer", { phone: TOBIAS_PHONE }),
      fnCall("t2", "verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 }),
    ],
  });
  await createHandler(routes)(post({ message }), deps);
  assertEquals(logs.length, 1);
  const line = logs[0];
  assertEquals(Object.keys(line).sort(), ["call_key", "code", "ms", "status", "tool", "type"]);
  assertEquals(line.call_key, CALL_ID);
  assertEquals(line.type, "tool-calls");
  assertEquals(line.tool, "lookup_customer,verify_identity");
  assertEquals(line.code, "needs_dob,needs_dob");
  assertEquals(line.status, 200);
  assert(typeof line.ms === "number" && line.ms >= 0);
  const text = JSON.stringify(line);
  for (const leak of ["0101", "555", "1986", '"phone', "dob_month", "dob_year", "arguments", "args"]) {
    assertFalse(text.includes(leak), leak);
  }
});

Deno.test("a logger that throws does not change the response", async () => {
  const { deps } = makeDeps({}, untouchableStore);
  deps.log = () => {
    throw new Error("log sink down");
  };
  const res = await createHandler(fakeRoutes().routes)(
    post({ message: callEnvelope({ toolCallList: [fnCall("t1", "lookup_customer", {})] }) }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals((await results(res))[0].json.code, "needs_dob");
});

Deno.test("jobs routes are 404 unless JOBS_BEARER matches", async () => {
  const jobsBearer = "jobs-bearer-0123456789";
  const run = createHandler(fakeRoutes().routes);
  const req = (name: string, auth: string | null) => post({ job: name }, { path: `/jobs/${name}`, auth });

  const unset = makeDeps({}, untouchableStore);
  for (const auth of [null, "Bearer ", `Bearer ${SECRET}`]) {
    const res = await run(req("sla", auth), unset.deps);
    assertEquals(res.status, 404, String(auth));
    await res.body?.cancel();
  }

  const set = makeDeps({ JOBS_BEARER: jobsBearer }, untouchableStore);
  for (const auth of [null, `Bearer ${SECRET}`, `Bearer ${jobsBearer}x`]) {
    const res = await run(req("digest", auth), set.deps);
    assertEquals(res.status, 404, String(auth));
    await res.body?.cancel();
  }
  const unknown = await run(req("drop_tables", `Bearer ${jobsBearer}`), set.deps);
  assertEquals(unknown.status, 404);
  await unknown.body?.cancel();
});

Deno.test("jobs: with the bearer each known job runs through runJob and answers its outcome as JSON", async () => {
  const jobsBearer = "jobs-bearer-0123456789";
  const ran: string[] = [];
  const { routes } = fakeRoutes();
  const run = createHandler({
    ...routes,
    runJob: (name) => {
      ran.push(name);
      return Promise.resolve({ job: name, period_key: "p1", skipped: false, result: { done: 1 } });
    },
  });
  const { deps, logs } = makeDeps({ JOBS_BEARER: jobsBearer }, untouchableStore);
  for (const name of ["sla", "digest", "reaper", "outbox"]) {
    const res = await run(post({ job: name }, { path: `/jobs/${name}`, auth: `Bearer ${jobsBearer}` }), deps);
    assertEquals(res.status, 200, name);
    assertEquals(res.headers.get("content-type"), "application/json");
    assertEquals(await res.json(), { job: name, period_key: "p1", skipped: false, result: { done: 1 } });
  }
  assertEquals(ran, ["sla", "digest", "reaper", "outbox"]);
  assertEquals(logs.map((l) => [l.type, l.tool, l.status]), [
    ["job", "sla", 200],
    ["job", "digest", 200],
    ["job", "reaper", 200],
    ["job", "outbox", 200],
  ]);

  // without the bearer the job never runs
  const res = await run(post({ job: "sla" }, { path: "/jobs/sla", auth: null }), deps);
  assertEquals(res.status, 404);
  await res.body?.cancel();
  assertEquals(ran.length, 4);
});

Deno.test("jobs: a job that throws is a 500 job_failed with the redacted reason in the log line", async () => {
  const jobsBearer = "jobs-bearer-0123456789";
  const run = createHandler({
    ...fakeRoutes().routes,
    runJob: () => Promise.reject(new Error("store.claimJobRun: 57014 canceling statement for +16025550101")),
  });
  const { deps, logs } = makeDeps({ JOBS_BEARER: jobsBearer }, untouchableStore);
  const res = await run(post({ job: "digest" }, { path: "/jobs/digest", auth: `Bearer ${jobsBearer}` }), deps);
  assertEquals(res.status, 500);
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals(await res.json(), { error: "job_failed" });
  assertEquals(logs.length, 1);
  assertEquals([logs[0].type, logs[0].tool, logs[0].status], ["job", "digest", 500]);
  assertStringIncludes(String(logs[0].error), "claimJobRun");
  assertFalse(String(logs[0].error).includes("5550101"));
});

Deno.test("jobs: the real runner over the store records one run per period and skips the re-fire", async () => {
  const jobsBearer = "jobs-bearer-0123456789";
  const store = createFakeStore();
  const { deps } = makeDeps({ JOBS_BEARER: jobsBearer }, store);
  const req = () => post({ job: "outbox" }, { path: "/jobs/outbox", auth: `Bearer ${jobsBearer}` });
  const first = await handle(req(), deps);
  assertEquals(first.status, 200);
  assertEquals(await first.json(), {
    job: "outbox",
    period_key: "2026-10-12T15:00Z",
    skipped: false,
    result: { delivered: 0, retried: 0, dead: 0, errors: 0, skipped: "airtable not configured" },
  });
  const again = await handle(req(), deps);
  assertEquals(await again.json(), { job: "outbox", period_key: "2026-10-12T15:00Z", skipped: true });
  assertEquals(store.tables.job_runs.length, 1);
  assert(store.tables.job_runs[0].finished_at, "the run is recorded as finished");
});

// ---------------------------------------------------------------------------------------------
// End to end through the real tools.ts over the in-memory store
// ---------------------------------------------------------------------------------------------
Deno.test("e2e: /chat turns with new chat ids share one session: needs_dob, then verified", async () => {
  const store = createFakeStore();
  const { deps } = makeDeps({}, store);
  const first = await handle(
    post({
      message: chatEnvelope("chat-1", "sess-e2e", {
        toolCallList: [fnCall("tc1", "lookup_customer", { phone: TOBIAS_PHONE })],
      }),
    }),
    deps,
  );
  assertEquals(first.status, 200);
  const [r1] = await results(first);
  assertEquals([r1.toolCallId, r1.json.code], ["tc1", "needs_dob"]);

  const second = await handle(
    post({
      message: chatEnvelope("chat-2", "sess-e2e", {
        toolCallList: [fnCall("tc2", "verify_identity", JSON.stringify({ dob_month: 3, dob_day: 14, dob_year: 1986 }))],
      }),
    }),
    deps,
  );
  const [r2] = await results(second);
  assertEquals([r2.toolCallId, r2.json.code], ["tc2", "verified"]);
  assertStringIncludes(r2.json.message, "Tobias");
  assertEquals(r2.message?.content, r2.json.message);

  const sessions = store.tables.call_sessions.filter((s) => s.call_key === "sess-e2e");
  assertEquals(sessions.length, 1);
  assertEquals(sessions[0].level, "verified");
  assertEquals(sessions[0].channel, "chat");
  assertEquals(store.tables.call_sessions.length, 1, "no session was keyed on a per-turn chat id");
});

Deno.test("e2e: malformed arguments -> bad_args at HTTP 200, nothing counted", async () => {
  const store = createFakeStore();
  const { deps } = makeDeps({}, store);
  const res = await handle(
    post({ message: callEnvelope({ toolCallList: [fnCall("tc1", "verify_identity", "{dob_month: 3,")] }) }),
    deps,
  );
  assertEquals(res.status, 200);
  const [r] = await results(res);
  assertEquals(r.toolCallId, "tc1");
  assertEquals(r.json.code, "bad_args");
  assertEquals(r.json.message, sentenceFor("bad_args"));
  assertEquals(r.message, { type: "request-complete", content: sentenceFor("bad_args") });
  assertEquals(store.tables.attempts.filter((a) => a.tool_name === "verify_identity").length, 0);
});

Deno.test("e2e: one delivery with lookup then verify walks the ladder in order", async () => {
  const store = createFakeStore();
  const { deps, logs } = makeDeps({}, store);
  const message = callEnvelope({
    toolCalls: [
      fnCall("tc1", "lookup_customer", { phone: TOBIAS_PHONE }),
      fnCall("tc2", "verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 }),
      fnCall("tc3", "get_claim_status", {}),
    ],
  });
  const out = await results(await handle(post({ message }), deps));
  assertEquals(out.map((r) => [r.toolCallId, r.json.code]), [["tc1", "needs_dob"], ["tc2", "verified"], ["tc3", "ok"]]);
  for (const r of out) {
    assertEquals(r.message?.content, nativeContent(r.json.message));
    assertEquals(r.json.spoken, speaksNatively(r.json.message, true) ? undefined : false);
  }
  const text = JSON.stringify(logs);
  for (const leak of ["0101", "1986", "Tobias"]) assertFalse(text.includes(leak), leak);
});

Deno.test("e2e: claim status before verification is refused; unknown tools are unknown_tool", async () => {
  const { deps } = makeDeps({}, createFakeStore());
  const message = callEnvelope({
    toolCallList: [fnCall("tc1", "get_claim_status", {}), fnCall("tc2", "delete_everything", {})],
  });
  const out = await results(await handle(post({ message }), deps));
  assertEquals(out.map((r) => [r.toolCallId, r.name, r.json.code]), [
    ["tc1", "get_claim_status", "not_verified"],
    ["tc2", "delete_everything", "unknown_tool"],
  ]);
  assertEquals(out[1].json.message, sentenceFor("unknown_tool"));
});

Deno.test("e2e: status-update in-progress writes the session and the live stub row; a report without call.id is 400", async () => {
  const store = createFakeStore();
  const { deps } = makeDeps({}, store);
  const status = await handle(
    post({
      message: {
        type: "status-update",
        status: "in-progress",
        call: { id: CALL_ID, orgId: ORG, type: "inboundPhoneCall", customer: { number: "+16025550188" } },
      },
    }),
    deps,
  );
  assertEquals(status.status, 200);
  assertEquals(await status.json(), {});
  const [row] = store.tables.call_interactions.filter((r) => r.vapi_call_id === CALL_ID);
  assertEquals([row.outcome, row.channel, row.caller_phone], ["in_progress", "inboundPhoneCall", "+16025550188"]);
  assertEquals(store.tables.call_sessions.map((s) => [s.call_key, s.channel]), [[CALL_ID, "inboundPhoneCall"]]);

  const report = await handle(post({ message: { type: "end-of-call-report", chat: { orgId: ORG } } }), deps);
  assertEquals(report.status, 400);
  assertEquals(await report.json(), { error: "missing_call_id" });
  assertEquals(store.tables.call_interactions.length, 1, "nothing written for a report without a key");
});
