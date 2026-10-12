// The honest escalation contract: the row exists before any transport is tried, a channel counts
// only when its transport confirmed delivery, the spoken sentence follows that result, and the
// callback number is the caller's own (argument, account, caller id), never our line.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { Channel } from "./enums.ts";
import { createFakeStore, type FakeStore } from "./fake_store.ts";
import { assertSpeakable } from "./speak.ts";
import { runTool } from "./tools.ts";
import type { Deps, Env, ToolCtx, ToolResult } from "./types.ts";

const CALL_KEY = "9d3e1f20-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
const TOKEN = "987654:ESCALATE-test-token";
const OUR_LINE = "+15205210277";
const NOW = new Date("2026-10-12T15:00:00Z");

const ANYTHING_ELSE = "Is there anything else I can help you with?";
const REP_QUEUED_NO_NUMBER =
  "I've sent your request to our claims team. What's the best number for a representative to reach you?";
const REP_RECORDED = `I've recorded your request. ${ANYTHING_ELSE}`;
const REP_ALREADY_QUEUED =
  `Your request is already with our claims team. A representative will call you back within one business day. ${ANYTHING_ELSE}`;
const queuedAt = (at: string) =>
  `I've sent your request and a summary to our claims team. A representative will call you back at ${at} within one business day. ${ANYTHING_ELSE}`;

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Recorded {
  url: string;
  init: RequestInit;
}

function harness(opts: {
  env?: Partial<Env>;
  telegram?: Responder;
  resend?: Responder;
  channel?: Channel;
  callerNumber?: string | null;
  isChat?: boolean;
} = {}) {
  const store: FakeStore = createFakeStore();
  const calls: Recorded[] = [];
  const pending: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  let resendIds = 0;
  const telegram: Responder = opts.telegram ?? (() => json({ ok: true, result: { message_id: 7 } }));
  const resend: Responder = opts.resend ?? (() => json({ id: `re_${++resendIds}` }));
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://api.telegram.org/")) return await telegram(url, init ?? {});
    if (url === "https://api.resend.com/emails") return await resend(url, init ?? {});
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    store,
    fetch: fetchFn,
    env: {
      VAPI_ORG_ID: "org_test",
      VAPI_WEBHOOK_SECRET: "secret",
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: "4242",
      RESEND_API_KEY: "re_test_key",
      CLAIMS_TEAM_EMAIL: "team@example.com",
      DASHBOARD_URL: "https://ops.example.test/",
      OWN_NUMBERS: OUR_LINE,
      ...opts.env,
    },
    now: () => NOW,
    waitUntil: (p) => {
      pending.push(p);
    },
    log: (event) => {
      logs.push(event);
    },
  };
  const ctx: Omit<ToolCtx, "toolCallId"> = {
    callKey: CALL_KEY,
    channel: opts.channel ?? "webCall",
    callerNumber: opts.callerNumber ?? null,
    isChat: opts.isChat ?? false,
    deps,
  };
  let seq = 0;
  async function run(name: string, args: Record<string, unknown> | null, toolCallId?: string): Promise<ToolResult> {
    const result = await runTool({ id: toolCallId ?? `tc_${++seq}`, name, args }, ctx);
    assertSpeakable(result.sentence);
    await Promise.all(pending);
    return result;
  }
  const telegramCalls = () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
  const resendCalls = () => calls.filter((c) => c.url === "https://api.resend.com/emails");
  const rows = () => store.tables.escalations.filter((e) => e.kind === "representative");
  return { store, deps, calls, logs, run, telegramCalls, resendCalls, rows };
}

type Harness = ReturnType<typeof harness>;

const body = (c: Recorded): Record<string, any> => JSON.parse(String(c.init.body));
const header = (c: Recorded, name: string) => new Headers(c.init.headers).get(name);

async function verifyTobias(h: Harness): Promise<void> {
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  assertEquals((await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 })).code, "verified");
}

Deno.test("first web call writes a row with no callback number; the second call adds the number to the same row", async () => {
  const h = harness();
  const first = await h.run("escalate", {
    reason: "representative_requested",
    details: "Wants to talk about the kitchen claim",
  });
  assertEquals(first, { code: "rep_queued_no_number", sentence: REP_QUEUED_NO_NUMBER });
  assertEquals(h.rows().length, 1);
  const row = h.rows()[0];
  assertEquals(
    [
      row.reason,
      row.callback_phone,
      row.callback_source,
      row.verified,
      row.channel,
      row.alert_status,
      row.delivery_error,
    ],
    ["representative_requested", null, "none", false, "webCall", "sent", null],
  );
  assertEquals(row.details, "Wants to talk about the kitchen claim");

  assertEquals(h.telegramCalls().length, 1);
  const card = body(h.telegramCalls()[0]).text as string;
  assertStringIncludes(card, "UNVERIFIED: do not disclose claim details");
  assertStringIncludes(card, "[Observe Claims] representative | representative_requested | normal | call 9d3e1f20");
  assertStringIncludes(card, `https://ops.example.test/#/calls/${CALL_KEY}`);
  assertEquals(h.resendCalls().length, 1);
  assertEquals(header(h.resendCalls()[0], "Idempotency-Key"), `${CALL_KEY}:callback_request`);
  assertEquals(body(h.resendCalls()[0]).to, ["team@example.com"]);
  assertEquals(h.store.tables.emails.map((m) => [m.kind, m.status, m.to_masked]), [
    ["callback_request", "sent", "t***@example.com"],
  ]);

  const second = await h.run("escalate", { reason: "representative_requested", callback_phone: "602-555-0177" });
  assertEquals(second, {
    code: "callback_updated",
    sentence: `Got it, six zero two... five five five... zero one seven seven. ${ANYTHING_ELSE}`,
    data: { digits: "6025550177" },
  });
  assertEquals(h.rows().length, 1);
  assertEquals([h.rows()[0].callback_phone, h.rows()[0].callback_source], ["+16025550177", "argument"]);
  // the number goes on the row; nobody is paged twice
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 1);

  assertEquals(await h.run("escalate", {}), { code: "rep_already_queued", sentence: REP_ALREADY_QUEUED });
  assertEquals(h.rows()[0].callback_phone, "+16025550177");
  assertEquals(h.telegramCalls().length, 1);
});

Deno.test("Telegram and email both down: alert_status failed and the honest rep_recorded", async () => {
  const h = harness({
    telegram: () => json({ ok: false, error_code: 500, description: `Internal error for bot${TOKEN}` }, 500),
    resend: () => json({ name: "application_error", message: "service down" }, 500),
  });
  const r = await h.run("escalate", { reason: "representative_requested" });
  assertEquals(r, { code: "rep_recorded", sentence: REP_RECORDED });
  const row = h.rows()[0];
  assertEquals(row.alert_status, "failed");
  assertStringIncludes(row.delivery_error, "telegram: telegram 500");
  assertStringIncludes(row.delivery_error, "email: resend 500: service down");
  assertFalse(row.delivery_error.includes(TOKEN));
  assertEquals(h.store.tables.emails.map((m) => [m.kind, m.status]), [["callback_request", "failed"]]);

  // a repeat does not pretend the team was told, and does not retry the channels
  assertEquals(await h.run("escalate", {}), { code: "rep_recorded", sentence: REP_RECORDED });
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 1);
});

Deno.test("Telegram down but the email sent: rep_queued, alert_status sent, the Telegram error kept", async () => {
  const h = harness({
    channel: "inboundPhoneCall",
    callerNumber: "+16025550188",
    telegram: () => json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
  });
  const r = await h.run("escalate", { reason: "representative_requested" });
  assertEquals(r, {
    code: "rep_queued",
    sentence: queuedAt("the number you're calling from"),
    data: { target: "caller_id" },
  });
  const row = h.rows()[0];
  assertEquals([row.alert_status, row.callback_phone, row.callback_source], ["sent", "+16025550188", "caller_id"]);
  assertEquals(row.delivery_error, "telegram: telegram 200: Bad Request: chat not found");
});

Deno.test("Telegram sent but the email down: rep_queued, and the email error is on the row", async () => {
  const h = harness({ resend: () => json({ message: "unavailable" }, 503) });
  const r = await h.run("escalate", { callback_phone: "(602) 555-0177" });
  assertEquals(r, {
    code: "rep_queued",
    sentence: queuedAt("the number you gave me, ending in zero one seven seven"),
    data: { target: "given", digits: "0177" },
  });
  assertEquals(h.rows()[0].alert_status, "sent");
  assertEquals(h.rows()[0].delivery_error, "email: resend 503: unavailable");
  assertEquals(h.store.tables.emails[0].status, "failed");
});

Deno.test("no channel configured: nothing is fetched and the answer is rep_recorded", async () => {
  const h = harness({ env: { TELEGRAM_BOT_TOKEN: undefined, CLAIMS_TEAM_EMAIL: undefined } });
  assertEquals(await h.run("escalate", {}), { code: "rep_recorded", sentence: REP_RECORDED });
  assertEquals(h.calls.length, 0);
  assertEquals(h.rows()[0].alert_status, "failed");
  assertStringIncludes(h.rows()[0].delivery_error, "telegram not configured");
  assertStringIncludes(h.rows()[0].delivery_error, "CLAIMS_TEAM_EMAIL not set");
  assertEquals(h.store.tables.emails.length, 0);
});

Deno.test("ALERT_SINKS=telegram leaves the team email out", async () => {
  const h = harness({ env: { ALERT_SINKS: "telegram" } });
  assertEquals((await h.run("escalate", {})).code, "rep_queued_no_number");
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 0);
  assertEquals(h.rows()[0].alert_status, "sent");
  assertEquals(h.rows()[0].delivery_error, "email: email disabled by ALERT_SINKS");
});

Deno.test("the same (call_key, kind) twice is one row; the first reason stays", async () => {
  const h = harness();
  await h.run("escalate", { reason: "unsupported_question" });
  await h.run("escalate", { reason: "transfer_failed" });
  assertEquals(h.store.tables.escalations.length, 1);
  assertEquals(h.rows()[0].reason, "unsupported_question");
  assertEquals(h.telegramCalls().length, 1);
});

Deno.test("an off-enum or missing reason coerces to representative_requested; listed reasons are kept", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ reason: "angry_customer" }, "representative_requested"],
    [{ reason: "auth_locked" }, "representative_requested"],
    [{ reason: "emergency" }, "representative_requested"],
    [{ reason: 7 }, "representative_requested"],
    [{}, "representative_requested"],
    [{ reason: "unsupported_question" }, "unsupported_question"],
    [{ reason: " transfer_failed " }, "transfer_failed"],
  ];
  for (const [args, expected] of cases) {
    const h = harness();
    const r = await h.run("escalate", args);
    assertEquals(r.code, "rep_queued_no_number", JSON.stringify(args));
    assertEquals(h.rows()[0].reason, expected, JSON.stringify(args));
  }
});

Deno.test("the server derives auth_locked from a locked session, whatever reason the model gave", async () => {
  const h = harness();
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  await h.run("verify_identity", { dob_month: 1, dob_day: 1, dob_year: 1980 });
  assertEquals((await h.run("verify_identity", { dob_month: 1, dob_day: 2, dob_year: 1980 })).code, "locked");
  await h.run("escalate", { reason: "unsupported_question" });
  const row = h.rows()[0];
  assertEquals([row.reason, row.verified, row.callback_phone], ["auth_locked", false, null]);
  assertStringIncludes(body(h.telegramCalls()[0]).text, "UNVERIFIED");
  assertStringIncludes(body(h.telegramCalls()[0]).text, "auth_locked");
});

Deno.test("the server derives not_found after a lookup miss, only for representative_requested", async () => {
  const missed = harness();
  assertEquals((await missed.run("lookup_customer", { phone: "6025550199" })).code, "not_found");
  await missed.run("escalate", { reason: "representative_requested" });
  assertEquals(missed.rows()[0].reason, "not_found");

  const offList = harness();
  await offList.run("lookup_customer", { phone: "6025550199" });
  await offList.run("escalate", { reason: "something_else" });
  assertEquals(offList.rows()[0].reason, "not_found");

  const question = harness();
  await question.run("lookup_customer", { phone: "6025550199" });
  await question.run("escalate", { reason: "unsupported_question" });
  assertEquals(question.rows()[0].reason, "unsupported_question");

  // an unreadable number is not a miss
  const unreadable = harness();
  assertEquals((await unreadable.run("lookup_customer", { phone: "555" })).code, "invalid_phone");
  await unreadable.run("escalate", {});
  assertEquals(unreadable.rows()[0].reason, "representative_requested");
});

Deno.test("callback number: the argument, else the verified account, else caller id", async () => {
  const account = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  await verifyTobias(account);
  const a = await account.run("escalate", { reason: "representative_requested" });
  assertEquals(a, {
    code: "rep_queued",
    sentence: queuedAt("the number on your account"),
    data: { target: "account" },
  });
  const aRow = account.rows()[0];
  assertEquals([aRow.callback_phone, aRow.callback_source, aRow.verified], ["+16025550101", "account", true]);
  assertFalse(body(account.telegramCalls()[0]).text.includes("UNVERIFIED"));

  const given = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  await verifyTobias(given);
  const g = await given.run("escalate", { callback_phone: "602 555 0177" });
  assertEquals(g.data, { target: "given", digits: "0177" });
  assertEquals([given.rows()[0].callback_phone, given.rows()[0].callback_source], ["+16025550177", "argument"]);

  const caller = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  const c = await caller.run("escalate", {});
  assertEquals(c.data, { target: "caller_id" });
  assertEquals([caller.rows()[0].callback_phone, caller.rows()[0].callback_source], ["+16025550188", "caller_id"]);

  // an unusable argument falls through to the next source instead of being stored
  for (const junk of ["anonymous", "555-0177", "0000000000", "1234567890"]) {
    const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
    await h.run("escalate", { callback_phone: junk });
    assertEquals([h.rows()[0].callback_phone, h.rows()[0].callback_source], ["+16025550188", "caller_id"], junk);
  }
});

Deno.test("the callback fallback never uses our own line, whichever way it arrives", async () => {
  // The handler never passes call.phoneNumber.number; even if our number reached the tool as the
  // caller id or as an argument, it is refused.
  const h = harness({ channel: "inboundPhoneCall", callerNumber: OUR_LINE });
  const r = await h.run("escalate", { callback_phone: "520-521-0277" });
  assertEquals(r, { code: "rep_queued_no_number", sentence: REP_QUEUED_NO_NUMBER });
  assertEquals([h.rows()[0].callback_phone, h.rows()[0].callback_source], [null, "none"]);

  const web = harness({ channel: "webCall", callerNumber: null });
  await web.run("escalate", {});
  assertEquals(web.rows()[0].callback_phone, null);
});

Deno.test("a later escalate without a number never overwrites the number the caller gave", async () => {
  const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  assertEquals((await h.run("escalate", { callback_phone: "6025550177" })).code, "rep_queued");
  await verifyTobias(h);
  assertEquals(await h.run("escalate", {}), { code: "rep_already_queued", sentence: REP_ALREADY_QUEUED });
  assertEquals([h.rows()[0].callback_phone, h.rows()[0].callback_source], ["+16025550177", "argument"]);
  // the same number again is not news
  assertEquals((await h.run("escalate", { callback_phone: "6025550177" })).code, "rep_already_queued");
  // a different number is
  assertEquals((await h.run("escalate", { callback_phone: "6025550166" })).code, "callback_updated");
  assertEquals(h.rows()[0].callback_phone, "+16025550166");
});

Deno.test("a chat envelope sends nothing and stores alert_status skipped", async () => {
  const h = harness({ channel: "chat", isChat: true });
  assertEquals(await h.run("escalate", { reason: "representative_requested" }), {
    code: "rep_queued_no_number",
    sentence: REP_QUEUED_NO_NUMBER,
  });
  assertEquals([h.rows()[0].alert_status, h.rows()[0].delivery_error, h.rows()[0].channel], ["skipped", null, "chat"]);
  assertEquals((await h.run("escalate", { callback_phone: "6025550177" })).code, "callback_updated");
  // a chat answered as if the team had been told, so the repeat says the same
  assertEquals((await h.run("escalate", {})).code, "rep_already_queued");
  assertEquals((await h.run("report_emergency", { note: "smoke" })).code, "emergency_logged");
  const emergency = h.store.tables.escalations.find((e) => e.kind === "emergency");
  assertEquals(emergency?.alert_status, "skipped");
  assertEquals(h.calls.length, 0);
  assertEquals(h.store.tables.emails.length, 0);
});

Deno.test("DOB-shaped and phone-shaped strings in details are stored redacted and never reach the alert", async () => {
  const h = harness();
  await h.run("escalate", {
    reason: "representative_requested",
    details: "Born March 14, 1986. Call me at 602-555-0177 or 6025550123 about CLM-240198, the $4,820 payment.",
  });
  const details = h.rows()[0].details as string;
  assertStringIncludes(details, "[date of birth]");
  assertStringIncludes(details, "[phone ending 0177]");
  assertStringIncludes(details, "[phone ending 0123]");
  assertStringIncludes(details, "CLM-240198");
  assertStringIncludes(details, "$4,820");
  for (const leak of ["1986", "March 14", "555-0177", "6025550123"]) assertFalse(details.includes(leak), leak);

  const card = body(h.telegramCalls()[0]).text as string;
  for (const leak of ["1986", "0177", "0123", "CLM", "4,820", "date of birth"]) assertFalse(card.includes(leak), leak);
  const html = body(h.resendCalls()[0]).html as string;
  for (const leak of ["1986", "March 14", "555-0177", "6025550123"]) assertFalse(html.includes(leak), leak);
  assertStringIncludes(html, "[phone ending 0177]");
});

Deno.test("details are capped at 500 characters, and blank details are null", async () => {
  const long = harness();
  await long.run("escalate", { details: `${"The caller wants a status update. ".repeat(30)}Call 602-555-0177.` });
  const details = long.rows()[0].details as string;
  assert(details.length <= 500, String(details.length));

  const blank = harness();
  await blank.run("escalate", { details: "   " });
  assertEquals(blank.rows()[0].details, null);
});

Deno.test("a database failure is rep_unavailable and sends nothing", async () => {
  const h = harness();
  h.store.failNext("upsertEscalation");
  assertEquals(await h.run("escalate", { reason: "representative_requested" }), {
    code: "rep_unavailable",
    sentence:
      `I'm sorry, I couldn't record your request just now. Please call our main line at 1-800-555-0142, and someone will help you. ${ANYTHING_ELSE}`,
  });
  assertEquals(h.calls.length, 0);
  assertEquals(h.store.tables.escalations.length, 0);
  assert(h.logs.some((l) => l.event === "tool_error" && l.step === "upsertEscalation"));
});

Deno.test("failed enrichment reads still record the escalation, as unverified", async () => {
  const h = harness();
  await verifyTobias(h);
  h.store.failNext("getSession");
  h.store.failNext("listEscalations");
  h.store.failNext("listAttempts");
  assertEquals((await h.run("escalate", {})).code, "rep_queued_no_number");
  // without the session the server cannot vouch for the caller, so the card warns
  assertEquals(h.rows()[0].verified, false);
  assertStringIncludes(body(h.telegramCalls()[0]).text, "UNVERIFIED");
});

Deno.test("a failed delivery write-back does not change an honest answer", async () => {
  const h = harness();
  h.store.failNext("setEscalationDelivery");
  assertEquals((await h.run("escalate", {})).code, "rep_queued_no_number");
  assertEquals(h.telegramCalls().length, 1);
  assert(h.logs.some((l) => l.event === "tool_error" && l.step === "setEscalationDelivery"));
});

Deno.test("replays keep each code and its number without paging again", async () => {
  const h = harness();
  const first = await h.run("escalate", {}, "tc-first");
  const second = await h.run("escalate", { callback_phone: "6025550177" }, "tc-second");
  assertEquals(second.code, "callback_updated");
  assertEquals(await h.run("escalate", { callback_phone: "6025550177" }, "tc-second"), second);
  assertEquals(await h.run("escalate", {}, "tc-first"), first);
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 1);
  assertEquals(
    h.store.tables.attempts.filter((a) => a.tool_name === "escalate").map((a) => [a.tool_call_id, a.code]),
    [["tc-first", "rep_queued_no_number"], ["tc-second", "callback_updated"]],
  );
});

Deno.test("a failed escalations read cannot let a fallback number or new details overwrite the caller's", async () => {
  const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  const first = await h.run("escalate", { callback_phone: "6025550177", details: "Needs help with the kitchen claim" });
  assertEquals(first.data, { target: "given", digits: "0177" });

  h.store.failNext("listEscalations");
  assertEquals(await h.run("escalate", { details: "Wants a call about the car" }), {
    code: "rep_already_queued",
    sentence: REP_ALREADY_QUEUED,
  });
  const row = h.rows()[0];
  assertEquals([row.callback_phone, row.callback_source, row.details], [
    "+16025550177",
    "argument",
    "Needs help with the kitchen claim",
  ]);
  assertEquals(h.telegramCalls().length, 1);
});

Deno.test("a repeat fills details only where the row has none, and never replaces them", async () => {
  const h = harness();
  assertEquals((await h.run("escalate", {})).code, "rep_queued_no_number");
  assertEquals(h.rows()[0].details, null);
  await h.run("escalate", { callback_phone: "6025550177", details: "Wants to talk about the kitchen claim" });
  assertEquals(h.rows()[0].details, "Wants to talk about the kitchen claim");
  await h.run("escalate", { details: "Something else entirely" });
  assertEquals(h.rows()[0].details, "Wants to talk about the kitchen claim");
});

Deno.test("a failed write of the fallback number is not promised: the sentence asks for a number", async () => {
  const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  const upsert = h.store.upsertEscalation;
  let writes = 0;
  h.store.upsertEscalation = (p) => (++writes === 2 ? Promise.reject(new Error("connection reset")) : upsert(p));
  assertEquals(await h.run("escalate", { details: "Kitchen claim" }), {
    code: "rep_queued_no_number",
    sentence: REP_QUEUED_NO_NUMBER,
  });
  assertEquals([h.rows()[0].callback_phone, h.rows()[0].alert_status], [null, "sent"]);
  assert(h.logs.some((l) => l.event === "tool_error" && l.step === "upsertEscalation"));
});

Deno.test("a replayed rep_queued speaks the first answer's target, never one a later request wrote", async () => {
  // fallback target, then the caller gives a number: the replay no longer knows the fallback, so it names none
  const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  const first = await h.run("escalate", {}, "tc1");
  assertEquals(first.sentence, queuedAt("the number you're calling from"));
  assertEquals(await h.run("escalate", {}, "tc1"), first, "a replay before anything changed is identical");
  assertEquals((await h.run("escalate", { callback_phone: "6025550177" }, "tc2")).code, "callback_updated");
  const replay = await h.run("escalate", {}, "tc1");
  assertEquals(replay, {
    code: "rep_queued",
    sentence:
      `I've sent your request and a summary to our claims team. A representative will call you back within one business day. ${ANYTHING_ELSE}`,
  });

  // a number given in the first request is rebuilt from the retry's own arguments
  const g = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  const given = await g.run("escalate", { callback_phone: "6025550177" }, "tc1");
  await g.run("escalate", { callback_phone: "6025550166" }, "tc2");
  assertEquals(await g.run("escalate", { callback_phone: "6025550177" }, "tc1"), given);
  // and a replayed callback_updated says the number of its own request
  const updated = await g.run("escalate", { callback_phone: "6025550155" }, "tc3");
  await g.run("escalate", { callback_phone: "6025550144" }, "tc4");
  assertEquals(await g.run("escalate", { callback_phone: "6025550155" }, "tc3"), updated);
  assertEquals(g.telegramCalls().length, 1);
});
