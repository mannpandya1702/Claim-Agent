import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import type { Channel } from "./enums.ts";
import { createFakeStore, type FakeStore } from "./fake_store.ts";
import { assertSpeakable, sentenceFor } from "./speak.ts";
import { runTool, runToolWithin } from "./tools.ts";
import type { Deps, Env, Store, ToolCtx, ToolResult } from "./types.ts";

const CALL_KEY = "5f0c2a9e-7b1d-4c3e-9a8f-1b2c3d4e5f60";
const TOKEN = "123456:TEST-token-value";
const TOBIAS = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
const RONAN = "6b0d6f0e-1c11-4c7a-9a01-000000000102";
const NOW = new Date("2026-10-12T15:00:00Z");

const SYSTEM_ERROR =
  "Sorry, I'm having trouble on our end right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?";
const LOCKED =
  "I'm sorry, but I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?";
// This call key hears the second phrasing of needs_dob (speak.ts variantIndex); sentenceFor without a key
// is the first.
const NEEDS_DOB = "To keep your account safe, what's the date of birth on the account?";

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Recorded {
  url: string;
  init: RequestInit;
}

// One call's worth of fakes: the in-memory store, a fetch that answers Telegram and Resend and
// records every request, a fixed clock, and a waitUntil that collects the background writes.
function harness(opts: {
  env?: Partial<Env>;
  telegram?: Responder;
  resend?: Responder;
  channel?: Channel;
  callerNumber?: string | null;
  isChat?: boolean;
  callKey?: string;
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
    callKey: opts.callKey ?? CALL_KEY,
    channel: opts.channel ?? "webCall",
    callerNumber: opts.callerNumber ?? null,
    isChat: opts.isChat ?? false,
    deps,
  };
  let seq = 0;
  async function run(name: string, args: Record<string, unknown> | null, toolCallId?: string): Promise<ToolResult> {
    const result = await runTool({ id: toolCallId ?? `tc_${++seq}`, name, args }, ctx);
    // Every answer is spoken as is, so every answer must pass the speakability guard.
    assertSpeakable(result.sentence);
    await Promise.all(pending);
    return result;
  }
  const telegramCalls = () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
  const resendCalls = () => calls.filter((c) => c.url === "https://api.resend.com/emails");
  return { store, deps, ctx, calls, logs, run, telegramCalls, resendCalls };
}

type Harness = ReturnType<typeof harness>;

async function verifyAs(h: Harness, phone: string, dob: [number, number, number]): Promise<ToolResult> {
  assertEquals((await h.run("lookup_customer", { phone })).code, "needs_dob");
  return await h.run("verify_identity", { dob_month: dob[0], dob_day: dob[1], dob_year: dob[2] });
}

const verifyTobias = (h: Harness) => verifyAs(h, "602-555-0101", [3, 14, 1986]);

function body(c: Recorded): Record<string, any> {
  return JSON.parse(String(c.init.body));
}

function header(c: Recorded, name: string): string | null {
  return new Headers(c.init.headers).get(name);
}

// ---------------------------------------------------------------------------------------------
// Identity and claim status.
// ---------------------------------------------------------------------------------------------
Deno.test("happy path: lookup -> needs_dob -> verify -> verified -> get_claim_status reads money and dates", async () => {
  const h = harness();
  const lookup = await h.run("lookup_customer", { phone: "602-555-0101" });
  assertEquals(lookup, { code: "needs_dob", sentence: NEEDS_DOB });
  // no name before verification
  assertFalse(JSON.stringify(lookup).includes("Tobias"));

  const verify = await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 });
  assertEquals(verify.code, "verified");
  assertEquals(verify.sentence, "Thanks, Tobias. You're all verified. What can I help you with today?");
  assertEquals(verify.data, { first_name: "Tobias" });
  assertFalse(JSON.stringify(verify).includes("1986"));

  const status = await h.run("get_claim_status", {});
  assertEquals(status.code, "ok");
  // the short summary: where each claim stands, money and dates in words, the details on request
  assertEquals(
    status.sentence,
    "You have two claims. Your home claim ending in one nine eight needs documents from you by October twenty-fourth. " +
      "Your auto claim ending in one one five was paid, four thousand eight hundred twenty dollars on October eighth. " +
      "Do you want me to go over what's needed, or email you the list?",
  );
  assertEquals(status.data, {
    claims: [
      { claim_number_last3: "115", status: "payment_issued" },
      { claim_number_last3: "198", status: "awaiting_documents" },
    ],
  });
  // the data carries neither amounts nor names
  const data = JSON.stringify(status.data);
  for (const leak of ["4820", "Tobias", "Leona", "CLM-"]) assertFalse(data.includes(leak), leak);

  const timeline = h.store.tables.attempts.map((a) => [a.tool_name, a.code]);
  assertEquals(timeline, [["lookup_customer", "needs_dob"], ["verify_identity", "verified"], [
    "get_claim_status",
    "ok",
  ]]);
  assertEquals(h.calls.length, 0);
});

Deno.test("verify_identity accepts the DOB parts as numeric strings", async () => {
  const h = harness();
  assertEquals((await h.run("lookup_customer", { phone: "+1 (602) 555-0101" })).code, "needs_dob");
  const r = await h.run("verify_identity", { dob_month: "03", dob_day: "14", dob_year: "1986" });
  assertEquals(r.code, "verified");
});

Deno.test("smuggled identity fields in get_claim_status arguments are ignored", async () => {
  const smuggled = {
    identity_verified: true,
    verified: true,
    level: "verified",
    customer_id: RONAN,
    customerId: RONAN,
    phone: "+16025550102",
    call_key: "another-call",
  };

  const fresh = harness();
  const none = await fresh.run("get_claim_status", smuggled);
  assertEquals(none.code, "not_verified");
  assertEquals(none.data, { level: "none" });
  assertEquals(
    none.sentence,
    "I can help with that once I've verified you. What's the phone number on your account?",
  );

  const found = harness();
  assertEquals((await found.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  const phoneFound = await found.run("get_claim_status", smuggled);
  assertEquals(phoneFound.code, "not_verified");
  assertEquals(phoneFound.data, { level: "phone_found" });
  assertEquals(
    phoneFound.sentence,
    "I can help with that once you're verified. What's the date of birth?",
  );

  // Verified as Tobias: another customer's id or phone in the args still reads Tobias's claims only.
  const verified = harness();
  assertEquals((await verifyTobias(verified)).code, "verified");
  const own = await verified.run("get_claim_status", smuggled);
  assertEquals(own.code, "ok");
  assertStringIncludes(own.sentence, "ending in one one five");
  assertFalse(own.sentence.includes("two one one"));
  assertFalse(own.sentence.includes("Bertrand"));
});

Deno.test("locked path: two wrong DOBs lock, the lock is sticky and every claim tool refuses", async () => {
  const h = harness();
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  const first = await h.run("verify_identity", { dob_month: 1, dob_day: 1, dob_year: 1980 });
  assertEquals(first, {
    code: "auth_failed",
    sentence: "That doesn't quite match what we have on file. Could you give me your date of birth one more time?",
  });
  assertEquals(await h.run("verify_identity", { dob_month: 2, dob_day: 2, dob_year: 1980 }), {
    code: "locked",
    sentence: LOCKED,
  });
  // a correct DOB after the lock is still locked
  assertEquals((await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 })).code, "locked");
  const status = await h.run("get_claim_status", {});
  assertEquals(status.code, "not_verified");
  assertEquals(status.data, { level: "locked" });
  assertEquals(status.sentence, LOCKED);
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "locked");
  assertEquals((await h.run("send_info_email", { topic: "claim_summary" })).code, "not_verified");
  assertEquals(h.calls.length, 0);
});

Deno.test("not_found reads the number back; the same number again is not_found_final", async () => {
  const h = harness();
  const miss = await h.run("lookup_customer", { phone: "602 555 0199" });
  assertEquals(miss.code, "not_found");
  assertEquals(miss.data, { digits: "6025550199" });
  assertEquals(
    miss.sentence,
    "I couldn't find an account under six zero two, five five five, zero one nine nine. Is that the right number?",
  );
  // the caller said yes: the confirmed number is looked up again, written another way
  const final = await h.run("lookup_customer", { phone: "(602) 555-0199" });
  assertEquals(final.code, "not_found_final");
  assertEquals(
    final.sentence,
    "I'm sorry, there's still no account under that number. If you're new with us, I can help you get started. Could I get your first and last name?",
  );
  // final for that number only: a different number is still looked up
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
});

Deno.test("the call key picks each sentence's phrasing, and a retry of the same toolCallId keeps it", async () => {
  // two calls whose keys pick different phrasings of needs_dob, the verified opening and the summary
  const keys = [CALL_KEY, "8d2e3f40-5b6c-4d7e-8f90-a1b2c3d4e5f6"];
  const heard: string[][] = [];
  for (const callKey of keys) {
    const h = harness({ callKey });
    const lookup = await h.run("lookup_customer", { phone: "6025550101" });
    assertEquals(lookup.sentence, sentenceFor("needs_dob", undefined, callKey));
    const verify = await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 });
    assertEquals(verify.sentence, sentenceFor("verified", { first_name: "Tobias" }, callKey));
    const status = await h.run("get_claim_status", {}, "tc_status");
    // a VAPI retry of the toolCallId is answered from the ledger with the very same words
    assertEquals(await h.run("get_claim_status", {}, "tc_status"), status);
    heard.push([lookup.sentence, verify.sentence, status.sentence]);
  }
  for (let i = 0; i < 3; i++) assert(heard[0][i] !== heard[1][i], `the two calls sound alike: ${heard[0][i]}`);
  // the words differ, the facts do not
  assertStringIncludes(heard[1][1], "Tobias");
  for (const summary of [heard[0][2], heard[1][2]]) {
    assertStringIncludes(summary, "ending in one nine eight needs documents from you by October twenty-fourth");
    assertStringIncludes(summary, "go over what's needed, or email you the list?");
  }
});

Deno.test("up to three different numbers: a misheard second miss still lets the right third one through", async () => {
  const h = harness();
  assertEquals((await h.run("lookup_customer", { phone: "6025550199" })).code, "not_found");
  const second = await h.run("lookup_customer", { phone: "6025550198" });
  assertEquals(second.code, "not_found");
  assertEquals(second.data, { digits: "6025550198" });
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");

  const capped = harness();
  assertEquals((await capped.run("lookup_customer", { phone: "6025550199" })).code, "not_found");
  assertEquals((await capped.run("lookup_customer", { phone: "6025550198" })).code, "not_found");
  assertEquals((await capped.run("lookup_customer", { phone: "6025550197" })).code, "not_found_final");
  // sticky after three: even a real customer's number is not looked up any more on this call
  assertEquals((await capped.run("lookup_customer", { phone: "6025550101" })).code, "not_found_final");
});

Deno.test("an unreadable phone number is never counted as a miss", async () => {
  const h = harness();
  assertEquals(await h.run("lookup_customer", { phone: "555-0101" }), {
    code: "invalid_phone",
    sentence: "Sorry, I'll need the full ten-digit number on the account. Could you say it again?",
  });
  assertEquals((await h.run("lookup_customer", { phone: "6025550199" })).code, "not_found");
  assertEquals((await h.run("lookup_customer", {})).code, "invalid_phone");
  assertEquals((await h.run("lookup_customer", { phone: "1111111111" })).code, "invalid_phone");
  assertEquals((await h.run("lookup_customer", { phone: "6025550198" })).code, "not_found");
  assertEquals((await h.run("lookup_customer", { phone: "6025550197" })).code, "not_found_final");
});

Deno.test("verify_identity before a lookup, and three unreadable DOBs give dob_give_up", async () => {
  const h = harness();
  assertEquals(await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 }), {
    code: "no_lookup_yet",
    sentence: "I can check that. First, I'll just need the phone number on the account. What's the number?",
  });
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  assertEquals(await h.run("verify_identity", { dob_month: 13, dob_day: 14, dob_year: 1986 }), {
    code: "dob_unreadable",
    sentence: "Just to be sure, could you give me the month, day and year?",
  });
  assertEquals((await h.run("verify_identity", { dob_month: 2, dob_day: 30, dob_year: 1986 })).code, "dob_unreadable");
  assertEquals(await h.run("verify_identity", { dob_month: 3, dob_day: 14 }), {
    code: "dob_give_up",
    sentence: LOCKED,
  });
  // unreadable answers never locked the caller
  assertEquals(h.store.tables.call_sessions[0].level, "phone_found");
});

Deno.test("verified with prior contacts enabled adds the welcome-back clause; disabled or failing gives the plain one", async () => {
  const plain = "Thanks, Tobias. You're all verified. What can I help you with today?";
  const prior = async (h: Harness) => {
    await h.store.upsertInteraction({
      vapi_call_id: "prior-call-1",
      customer_id: TOBIAS,
      caller_name: "Tobias Halvorsen",
      summary: "Asked about the home claim documents.",
      sentiment: "neutral",
      outcome: "resolved",
      started_at: "2026-10-11T02:30:00Z",
      ended_at: "2026-10-11T02:36:00Z",
      analysis_status: "ok",
    });
  };

  const on = harness({ env: { PRIOR_CONTACTS_ENABLED: "true" } });
  await prior(on);
  const welcome = await verifyTobias(on);
  assertEquals(
    welcome.sentence,
    "Thanks, Tobias. You're all verified. Welcome back. I see you called on October tenth. Is this about the same claim as last time, or something else?",
  );
  assertFalse(welcome.sentence.includes("home claim"));

  const off = harness();
  await prior(off);
  assertEquals((await verifyTobias(off)).sentence, plain);

  const failing = harness({ env: { PRIOR_CONTACTS_ENABLED: "true" } });
  await prior(failing);
  failing.store.failNext("priorInteractions");
  const r = await verifyTobias(failing);
  assertEquals(r.code, "verified");
  assertEquals(r.sentence, plain);
});

Deno.test("get_claim_status: no_claims for a verified customer without claims", async () => {
  const h = harness();
  assertEquals((await verifyAs(h, "6025550105", [5, 9, 1990])).code, "verified");
  assertEquals(await h.run("get_claim_status", {}), {
    code: "no_claims",
    sentence: "I'm not seeing any claims on file for your account. Would you like me to explain how to start one?",
  });
});

Deno.test("get_claim_status replay of the same toolCallId reads again and keeps one timeline row", async () => {
  const h = harness();
  await verifyTobias(h);
  const first = await h.run("get_claim_status", {}, "tc-status");
  const again = await h.run("get_claim_status", {}, "tc-status");
  assertEquals(again, first);
  const rows = h.store.tables.attempts.filter((a) => a.tool_call_id === "tc-status");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].code, "ok");
});

// ---------------------------------------------------------------------------------------------
// send_info_email.
// ---------------------------------------------------------------------------------------------
Deno.test("send_info_email when not verified: not_verified and no fetch", async () => {
  const h = harness();
  assertEquals((await h.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  const r = await h.run("send_info_email", { topic: "claim_summary" });
  assertEquals(r.code, "not_verified");
  assertEquals(r.data, { level: "phone_found" });
  assertEquals(h.calls.length, 0);
  assertEquals(h.store.tables.emails.length, 0);
});

Deno.test("send_info_email: no_email_on_file for Teague, with no fetch and no ledger row", async () => {
  const h = harness();
  assertEquals((await verifyAs(h, "6025550104", [1, 30, 1965])).code, "verified");
  assertEquals(await h.run("send_info_email", { topic: "document_checklist" }), {
    code: "no_email_on_file",
    sentence:
      "I don't see an email address on your account. If you'd like, you can spell one for me, and I'll pass it to our team to add. Or you can find the same information at observeinsurance dot com slash claims. Which would you prefer?",
  });
  assertEquals(h.calls.length, 0);
  assertEquals(h.store.tables.emails.length, 0);
});

Deno.test("send_info_email sends once per topic: a repeat is email_already_sent with no second fetch", async () => {
  const h = harness();
  await verifyTobias(h);
  const sent = await h.run("send_info_email", { topic: "document_checklist" });
  assertEquals(sent, {
    code: "email_sent",
    sentence:
      "There you go, I've emailed that to the address on your account. It should arrive within a few minutes. Anything else I can help with?",
  });
  assertEquals(h.resendCalls().length, 1);
  const req = h.resendCalls()[0];
  assertEquals(header(req, "Idempotency-Key"), `${CALL_KEY}:document_checklist`);
  assertEquals(header(req, "Authorization"), "Bearer re_test_key");
  const payload = body(req);
  assertEquals(payload.to, ["owner@example.com"]);
  assertStringIncludes(payload.html, "A contractor estimate");
  assertStringIncludes(payload.html, "CLM-240198");
  assertStringIncludes(payload.html, "October 24, 2026");
  assertEquals(h.store.tables.emails.map((m) => [m.kind, m.status, m.resend_id, m.to_masked]), [
    ["document_checklist", "sent", "re_1", "o***@example.com"],
  ]);

  assertEquals(await h.run("send_info_email", { topic: "document_checklist" }), {
    code: "email_already_sent",
    sentence: "No worries, I've already sent that to your email on this call. Anything else I can help with?",
  });
  assertEquals(h.resendCalls().length, 1);

  // another topic is its own send
  assertEquals((await h.run("send_info_email", { topic: "how_to_start_claim" })).code, "email_sent");
  assertEquals(h.resendCalls().length, 2);
  assertEquals(header(h.resendCalls()[1], "Idempotency-Key"), `${CALL_KEY}:how_to_start_claim`);
});

Deno.test("send_info_email: Resend 500 gives email_failed and a failed row, and the call does not retry", async () => {
  const h = harness({ resend: () => json({ name: "internal_server_error", message: "internal" }, 500) });
  await verifyTobias(h);
  const r = await h.run("send_info_email", { topic: "claim_summary" });
  assertEquals(r, {
    code: "email_failed",
    sentence:
      "Sorry, that email didn't go through just now. You can find the same information at observeinsurance dot com slash claims, or I can have a representative send it. Which would you prefer?",
  });
  assertEquals(h.store.tables.emails.map((m) => [m.kind, m.status, m.resend_id, m.error]), [
    ["claim_summary", "failed", null, "resend 500: internal"],
  ]);
  assertEquals((await h.run("send_info_email", { topic: "claim_summary" })).code, "email_failed");
  assertEquals(h.resendCalls().length, 1);
});

Deno.test("send_info_email with an off-list or missing topic is bad_args before anything is written", async () => {
  const h = harness();
  await verifyTobias(h);
  const attemptsBefore = h.store.tables.attempts.length;
  for (const args of [{ topic: "policy_documents" }, {}, { topic: 3 }]) {
    assertEquals(await h.run("send_info_email", args), {
      code: "bad_args",
      sentence: "Sorry, I didn't quite catch that. Could you say it again?",
    });
  }
  assertEquals(h.store.tables.attempts.length, attemptsBefore);
  assertEquals(h.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Replay, emergency, failures.
// ---------------------------------------------------------------------------------------------
Deno.test("escalate replay of the same toolCallId returns the same answer with no second Telegram fetch", async () => {
  const h = harness();
  const first = await h.run("escalate", { reason: "representative_requested", callback_phone: "6025550177" }, "tc-esc");
  assertEquals(first.code, "rep_queued");
  assertStringIncludes(first.sentence, "the number you gave me, ending in zero one seven seven");
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 1);

  const replay = await h.run(
    "escalate",
    { reason: "representative_requested", callback_phone: "6025550177" },
    "tc-esc",
  );
  assertEquals(replay, first);
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 1);
  assertEquals(h.store.tables.attempts.filter((a) => a.tool_call_id === "tc-esc").length, 1);
  assertEquals(h.store.tables.escalations.length, 1);
});

Deno.test("report_emergency writes the row, alerts both channels, and answers emergency_logged", async () => {
  const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550188" });
  const r = await h.run("report_emergency", { note: "Caller says there is smoke in the kitchen" });
  assertEquals(r, { code: "emergency_logged", sentence: "I've told our team. Are you safe right now?" });
  const [row] = h.store.tables.escalations;
  assertEquals([row.kind, row.reason, row.alert_status, row.delivery_error], ["emergency", "emergency", "sent", null]);
  assertEquals([row.callback_phone, row.callback_source], ["+16025550188", "caller_id"]);
  assertStringIncludes(body(h.telegramCalls()[0]).text, "POSSIBLE EMERGENCY REPORTED");
  assertEquals(header(h.resendCalls()[0], "Idempotency-Key"), `${CALL_KEY}:emergency_alert`);
  // the team email carries how to reach the caller, and that they are not verified
  const html = String(body(h.resendCalls()[0]).html);
  assertStringIncludes(html, "(602) 555-0188 (+16025550188)");
  assertMatch(html, /Identity verified<\/th><td[^>]*>No</);

  // a second report on the same call is the same row and pages nobody again
  assertEquals((await h.run("report_emergency", {})).code, "emergency_logged");
  assertEquals(h.store.tables.escalations.length, 1);
  assertEquals(h.telegramCalls().length, 1);
  assertEquals(h.resendCalls().length, 1);
});

Deno.test("report_emergency DB failure still returns emergency_logged with the db_failed sentence", async () => {
  const h = harness();
  h.store.failNext("upsertEscalation");
  const r = await h.run("report_emergency", { note: "Someone is hurt" });
  assertEquals(r, {
    code: "emergency_logged",
    sentence: "Please stay on the line. Are you safe right now?",
    data: { db_failed: true },
  });
  assertEquals(h.store.tables.escalations.length, 0);
  // without a row the team is still paged; the email waits for its ledger
  assertEquals(h.telegramCalls().length, 1);
  assertStringIncludes(body(h.telegramCalls()[0]).text, "POSSIBLE EMERGENCY REPORTED");
  assertEquals(h.resendCalls().length, 0);
});

Deno.test("report_emergency never refuses: placeholder or unparseable arguments still log the emergency", async () => {
  const h = harness();
  const r = await h.run("report_emergency", { note: "{{note}}" });
  assertEquals(r.code, "emergency_logged");
  assertEquals(h.store.tables.escalations[0].details, null);

  const h2 = harness();
  assertEquals((await h2.run("report_emergency", null)).code, "emergency_logged");
  assertEquals(h2.store.tables.escalations.length, 1);
});

Deno.test("bad arguments are bad_args before any database work", async () => {
  const h = harness();
  const bad = { code: "bad_args", sentence: "Sorry, I didn't quite catch that. Could you say it again?" };
  assertEquals(await h.run("lookup_customer", null), bad);
  assertEquals(await h.run("lookup_customer", { phone: "{{customer.number}}" }), bad);
  assertEquals(await h.run("verify_identity", { dob_month: "unknown", dob_day: 14, dob_year: 1986 }), bad);
  assertEquals(await h.run("escalate", { reason: "representative_requested", details: "null" }), bad);
  assertEquals(h.store.tables.attempts.length, 0);
  assertEquals(h.store.tables.call_sessions.length, 0);
  assertEquals(h.calls.length, 0);
});

Deno.test("an unknown tool name answers unknown_tool with the trouble sentence", async () => {
  const h = harness();
  for (const name of ["transferCall", "constructor", "__proto__", ""]) {
    const r = await h.run(name, {});
    assertEquals(r, { code: "unknown_tool", sentence: SYSTEM_ERROR });
  }
  assertEquals(sentenceFor("unknown_tool"), SYSTEM_ERROR);
});

Deno.test("a store failure is system_error, never a business answer, and is not counted", async () => {
  const h = harness();
  h.store.failNext("lookupCustomerAttempt");
  assertEquals(await h.run("lookup_customer", { phone: "6025550199" }), {
    code: "system_error",
    sentence: SYSTEM_ERROR,
  });
  // the failed call burned nothing: the first real lookup of the number is still a plain miss
  assertEquals((await h.run("lookup_customer", { phone: "6025550199" })).code, "not_found");

  const v = harness();
  assertEquals((await v.run("lookup_customer", { phone: "6025550101" })).code, "needs_dob");
  v.store.failNext("verifyDobAttempt");
  assertEquals((await v.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 })).code, "system_error");
  assertEquals((await v.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 })).code, "verified");
  v.store.failNext("getClaims");
  assertEquals((await v.run("get_claim_status", {})).code, "system_error");
  v.store.failNext("getSession");
  assertEquals((await v.run("send_info_email", { topic: "claim_summary" })).code, "system_error");
  assertEquals(v.calls.length, 0);
  assert(v.logs.some((l) => l.event === "tool_error" && l.tool === "get_claim_status"));
});

Deno.test("the budget turns a hung store into each tool's honest fallback", async () => {
  const hang = () => new Promise<never>(() => {});
  const cases: [string, Record<string, unknown>, keyof Store, ToolResult][] = [
    ["get_claim_status", {}, "getSession", { code: "system_error", sentence: SYSTEM_ERROR }],
    ["lookup_customer", { phone: "6025550101" }, "lookupCustomerAttempt", {
      code: "system_error",
      sentence: SYSTEM_ERROR,
    }],
    ["escalate", {}, "upsertEscalation", { code: "rep_unavailable", sentence: sentenceFor("rep_unavailable") }],
    [
      "report_emergency",
      {},
      "upsertEscalation",
      {
        code: "emergency_logged",
        sentence: "Please stay on the line. Are you safe right now?",
        data: { db_failed: true },
      },
    ],
  ];
  for (const [name, args, method, expected] of cases) {
    const h = harness({ env: { TELEGRAM_BOT_TOKEN: undefined } });
    (h.store as unknown as Record<string, unknown>)[method] = hang;
    const started = Date.now();
    const r = await runToolWithin({ id: "tc-hung", name, args }, h.ctx, 50);
    assertEquals(r, expected, name);
    assert(Date.now() - started < 1000, `${name} waited past its budget`);
    assert(h.logs.some((l) => l.event === "tool_timeout"), name);
  }
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("after a budget timeout the ledger keeps the fallback the caller heard, not the late real code", async () => {
  // get_claim_status: the late read would have said ok, which the post-call outcome reads as resolved
  const h = harness();
  await verifyTobias(h);
  const getClaims = h.store.getClaims;
  const slow = gate();
  h.store.getClaims = async (id) => {
    await slow.opened;
    return await getClaims(id);
  };
  const r = await runToolWithin({ id: "tc-slow-status", name: "get_claim_status", args: {} }, h.ctx, 30);
  assertEquals(r, { code: "system_error", sentence: SYSTEM_ERROR });
  slow.open();
  await tick();
  assertEquals(h.store.tables.attempts.find((a) => a.tool_call_id === "tc-slow-status")?.code, "system_error");

  // escalate: the caller heard the main-line apology, so a retry of the same toolCallId says it again
  const e = harness({ env: { TELEGRAM_BOT_TOKEN: undefined } });
  const upsert = e.store.upsertEscalation;
  const held = gate();
  e.store.upsertEscalation = async (p) => {
    await held.opened;
    return await upsert(p);
  };
  const first = await runToolWithin({ id: "tc-slow-escalate", name: "escalate", args: {} }, e.ctx, 30);
  assertEquals(first.code, "rep_unavailable");
  held.open();
  await tick();
  assertEquals(e.store.tables.escalations.length, 1, "the late run still wrote its row");
  assertEquals(
    e.store.tables.attempts.find((a) => a.tool_call_id === "tc-slow-escalate")?.code,
    "rep_unavailable",
  );
  e.store.upsertEscalation = upsert;
  assertEquals(await e.run("escalate", {}, "tc-slow-escalate"), first);
});

// Deno's test sanitizer does not report a pending timer, so the timers are counted by hand: a
// budget timer left running would keep a worker alive for five seconds after every tool call.
async function pendingTimersAfter(body: () => Promise<unknown>): Promise<number> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  type TimerId = ReturnType<typeof setTimeout>;
  const live = new Set<TimerId>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id: TimerId = realSet(() => {
      live.delete(id);
      fn(...rest);
    }, ms);
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: TimerId) => {
    if (id !== undefined) live.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  try {
    await body();
    return live.size;
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of live) realClear(id);
  }
}

Deno.test("every budget timer is cleared or has fired by the time the tool answers", async () => {
  const h = harness();
  assertEquals(await pendingTimersAfter(() => h.run("lookup_customer", { phone: "6025550101" })), 0);
  assertEquals(
    await pendingTimersAfter(() => h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 })),
    0,
  );
  assertEquals(await pendingTimersAfter(() => h.run("get_claim_status", {})), 0);
  assertEquals(await pendingTimersAfter(() => h.run("send_info_email", { topic: "claim_summary" })), 0);
  // escalate and report_emergency also run one budget per channel
  assertEquals(await pendingTimersAfter(() => h.run("escalate", { callback_phone: "6025550177" })), 0);
  assertEquals(await pendingTimersAfter(() => h.run("report_emergency", { note: "smoke" })), 0);
  assertEquals(h.telegramCalls().length, 2);

  const hung = harness();
  hung.store.getSession = () => new Promise<never>(() => {});
  assertEquals(
    await pendingTimersAfter(() => runToolWithin({ id: "tc-hung", name: "get_claim_status", args: {} }, hung.ctx, 20)),
    0,
  );
});

Deno.test("runTool never throws, even with a store that is not a store and a logger that throws", async () => {
  for (const name of ["lookup_customer", "verify_identity", "get_claim_status", "escalate", "send_info_email"]) {
    const h = harness({ env: { TELEGRAM_BOT_TOKEN: undefined } });
    h.deps.store = {} as Store;
    h.deps.log = () => {
      throw new Error("log sink down");
    };
    const args = name === "send_info_email" ? { topic: "claim_summary" } : { phone: "6025550101" };
    const r = await runTool({ id: "tc-broken", name, args }, h.ctx);
    assertSpeakable(r.sentence);
    assertEquals(r.code, name === "escalate" ? "rep_unavailable" : "system_error", name);
  }
  const h = harness({ env: { TELEGRAM_BOT_TOKEN: undefined } });
  h.deps.store = {} as Store;
  const r = await runTool({ id: "tc-broken", name: "report_emergency", args: {} }, h.ctx);
  assertEquals(r.code, "emergency_logged");
  assertEquals(r.data, { db_failed: true });
  // a missing call object is still an answer
  assertEquals((await runTool(null as never, h.ctx)).code, "unknown_tool");
});

Deno.test("logs carry no phone number, DOB or raw arguments", async () => {
  const h = harness();
  h.store.failNext("lookupCustomerAttempt");
  await h.run("lookup_customer", { phone: "6025550101" });
  await h.run("lookup_customer", { phone: "{{phone}}" });
  await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: "null" });
  const text = JSON.stringify(h.logs);
  assert(h.logs.length >= 3);
  for (const leak of ["6025550101", "555-0101", "1986", "{{phone}}"]) assertFalse(text.includes(leak), leak);
});
