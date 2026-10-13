// First notice of loss by voice: verify_identity's intent shortcut (the chained status read and the
// straight-into-the-claim opening), start_claim's gate, validation and read-back, and confirm_claim's
// filing with the customer's confirmation, the team's notice and the honest "emailed" clause. Every
// path is replayed with the same toolCallId to show nothing is written, sent or paged twice.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { type Channel, CLAIM_DOCUMENTS } from "./enums.ts";
import { createFakeStore, type FakeStore } from "./fake_store.ts";
import {
  assertSpeakable,
  claimDetailSentence,
  claimsSentence,
  documentsSentence,
  MAX_SPOKEN_CHARS,
  MAX_TURN_WORDS,
  sentenceFor,
  spokenWords,
} from "./speak.ts";
import { claimEndingKey, claimMatchesKey, runTool, runToolWithin } from "./tools.ts";
import type { Claim, Deps, Env, ToolCtx, ToolResult } from "./types.ts";

const CALL_KEY = "8d2e3f40-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const TOKEN = "135790:CLAIM-test-token";
const OUR_LINE = "+15205210277";
const TOBIAS = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
const TEAGUE = "6b0d6f0e-1c11-4c7a-9a01-000000000104";
const INES = "6b0d6f0e-1c11-4c7a-9a01-000000000105";
// Tuesday, October 13, 2026, 11:00 in New York.
const NOW = new Date("2026-10-13T15:00:00Z");
const TODAY = "2026-10-13";
// file_claim_intake's draw, pinned so the number is known: CLM-482472, spoken "four seven two".
const DRAW = () => 0.4824725;

const VERIFIED_TOBIAS = "Thanks, Tobias. You're all verified. What can I help you with today?";
const READBACK_AUTO =
  "Let me make sure I have this right. An auto claim, for backed into in a parking lot, from Saturday, October tenth. Is that correct?";
const FILED_EMAILED =
  "You're all set. Your claim number ends in four seven two, and I've emailed the details to the email on file. An adjuster will reach out within one business day. Is there anything else I can help with?";
const FILED_PLAIN =
  "You're all set. Your claim number ends in four seven two. An adjuster will reach out within one business day. Is there anything else I can help with?";
const ALREADY_FILED =
  "Your claim is already filed, with a number ending in four seven two. Is there anything else I can help with?";
const SAVED_JANE =
  "Thanks, Jane. I've passed your claim details to our claims team, and sent a confirmation to your email. A specialist will call you within one business day to finish setting it up. Is there anything else I can help with?";

const AUTO_ARGS = {
  claim_type: "auto",
  loss_date: "Saturday",
  description: "Someone backed into my car in the grocery store parking lot.",
  summary: "backed into in a parking lot",
};

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Recorded {
  url: string;
  init: RequestInit;
}

function harness(opts: {
  env?: Partial<Env>;
  resend?: Responder;
  telegram?: Responder;
  channel?: Channel;
  callerNumber?: string | null;
  isChat?: boolean;
} = {}) {
  const store: FakeStore = createFakeStore(undefined, { now: () => NOW, random: DRAW });
  const calls: Recorded[] = [];
  const pending: Promise<unknown>[] = [];
  let resendIds = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://api.telegram.org/")) {
      return await (opts.telegram ?? (() => json({ ok: true, result: { message_id: 9 } })))(url, init ?? {});
    }
    if (url === "https://api.resend.com/emails") {
      return await (opts.resend ?? (() => json({ id: `re_${++resendIds}` })))(url, init ?? {});
    }
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
    log: () => {},
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
    assert(result.sentence.length <= MAX_SPOKEN_CHARS, "within VAPI's spoken limit");
    while (pending.length > 0) await pending.shift();
    return result;
  }
  const telegramCalls = () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
  const resendCalls = () => calls.filter((c) => c.url === "https://api.resend.com/emails");
  const intake = () => store.tables.claim_intakes.find((r) => r.call_key === CALL_KEY);
  const phoneClaims = () => store.claims.filter((c) => (c as Claim & { reported_call_key?: string }).reported_call_key);
  const attempts = () => store.tables.attempts.filter((a) => a.call_key === CALL_KEY);
  return { store, deps, ctx, calls, run, telegramCalls, resendCalls, intake, phoneClaims, attempts };
}

type Harness = ReturnType<typeof harness>;

const body = (c: Recorded): Record<string, any> => JSON.parse(String(c.init.body));
const header = (c: Recorded, name: string) => new Headers(c.init.headers).get(name);

async function lookup(h: Harness, phone: string, code = "needs_dob"): Promise<void> {
  assertEquals((await h.run("lookup_customer", { phone })).code, code);
}

async function verifyAs(
  h: Harness,
  phone: string,
  dob: [number, number, number],
  extra: Record<string, unknown> = {},
  toolCallId?: string,
): Promise<ToolResult> {
  await lookup(h, phone);
  const r = await h.run(
    "verify_identity",
    { dob_month: dob[0], dob_day: dob[1], dob_year: dob[2], ...extra },
    toolCallId,
  );
  assertEquals(r.code, "verified");
  return r;
}

const verifyTobias = (h: Harness, extra: Record<string, unknown> = {}, toolCallId?: string) =>
  verifyAs(h, "6025550101", [3, 14, 1986], extra, toolCallId);

async function notFoundTwice(h: Harness): Promise<void> {
  await lookup(h, "6025550199", "not_found");
  await lookup(h, "6025550199", "not_found_final");
}

/** A new caller who gave their details and said yes to the read-back. */
async function confirmedNewCaller(h: Harness, extra: Record<string, unknown> = {}): Promise<void> {
  await notFoundTwice(h);
  const read = await h.run("capture_contact", {
    first_name: "jane",
    last_name: "doe",
    email: "jane.doe42@gmail.com",
    callback_phone: "602-555-0177",
    ...extra,
  });
  assertEquals(read.code, "contact_readback");
  assertEquals((await h.run("confirm_contact", { correct: true })).code, "contact_saved_new");
}

function tobiasClaims(h: Harness): Claim[] {
  return h.store.claims.filter((c) => c.customer_id === TOBIAS);
}

// ---------------------------------------------------------------------------------------------
// verify_identity {intent}
// ---------------------------------------------------------------------------------------------
Deno.test("verify intent file_claim: the verified opening leads straight into the loss", async () => {
  const h = harness();
  const r = await verifyTobias(h, { intent: "file_claim" });
  assertEquals(r, {
    code: "verified",
    sentence:
      "Thanks, Tobias. You're all verified. I'm sorry you're dealing with this. Let's get your claim started. Can you tell me a little more about what happened?",
    data: { first_name: "Tobias" },
  });
  // nothing else is read or recorded for it
  assertEquals(h.attempts().map((a) => a.tool_name), ["lookup_customer", "verify_identity"]);
});

Deno.test("verify intent file_claim after start_claim asked for verification: take that claim down now", async () => {
  const h = harness();
  await lookup(h, "6025550101");
  // the caller told the loss before the date of birth; start_claim sent them to verify first
  assertEquals((await h.run("start_claim", AUTO_ARGS)).code, "claim_needs_verification");
  const resume = "Thanks, Tobias. You're all verified. Shall I go ahead and take down that claim now?";
  const args = { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "file_claim" };
  assertEquals((await h.run("verify_identity", args, "tc_v")).sentence, resume);
  // a replay of the same delivery says the same
  assertEquals((await h.run("verify_identity", args, "tc_v")).sentence, resume);
  // on a yes the model files it from what it already has
  assertEquals((await h.run("start_claim", AUTO_ARGS)).sentence, READBACK_AUTO);
});

Deno.test("verify intent file_claim keeps the welcome-back clause and replaces only its question", async () => {
  const h = harness({ env: { PRIOR_CONTACTS_ENABLED: "true" } });
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
  assertEquals(
    (await verifyTobias(h, { intent: "file_claim" })).sentence,
    "Thanks, Tobias. You're all verified. Welcome back. I see you called on October tenth. I'm sorry you're dealing with this. Let's get your claim started. Can you tell me a little more about what happened?",
  );
});

Deno.test("verify intent claim_status: the claims are read in the same call and recorded as a status read", async () => {
  const h = harness();
  const r = await verifyTobias(h, { intent: "claim_status" }, "tc_verify");
  const status = claimsSentence(tobiasClaims(h), TODAY);
  assertEquals(r, {
    code: "verified",
    sentence: `Thanks, Tobias. You're all verified. ${status}`,
    data: {
      first_name: "Tobias",
      status_read: true,
      claims: [
        { claim_number_last3: "115", status: "payment_issued" },
        { claim_number_last3: "198", status: "awaiting_documents" },
      ],
    },
  });
  assertStringIncludes(r.sentence, "You have two claims.");
  assert(spokenWords(r.sentence) <= MAX_TURN_WORDS, `${spokenWords(r.sentence)} words`);
  // a get_claim_status of its own in the ledger, under the verify's toolCallId
  assertEquals(
    h.attempts().map((a) => `${a.tool_call_id}:${a.tool_name}:${a.code}`).slice(-2),
    ["tc_verify:verify_identity:verified", "tc_verify:status:get_claim_status:ok"],
  );

  // a replay of the same toolCallId answers the same and records nothing more
  const again = await h.run(
    "verify_identity",
    { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "claim_status" },
    "tc_verify",
  );
  assertEquals(again, r);
  assertEquals(h.attempts().length, 3);
});

Deno.test("verify intent claim_status for a returning caller: welcome back, without the date, then the summary", async () => {
  const h = harness({ env: { PRIOR_CONTACTS_ENABLED: "true" } });
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
  const opening = "Thanks, Tobias. You're all verified. Welcome back.";
  const r = await verifyTobias(h, { intent: "claim_status" });
  assertEquals(
    r.sentence,
    `${opening} ${claimsSentence(tobiasClaims(h), TODAY, MAX_TURN_WORDS - spokenWords(opening))}`,
  );
  assert(!r.sentence.includes("I see you called"), r.sentence);
  // both claims still fit the turn after the longer opening
  assertStringIncludes(r.sentence, "one nine eight");
  assertStringIncludes(r.sentence, "one one five");
  assert(spokenWords(r.sentence) <= MAX_TURN_WORDS, `${spokenWords(r.sentence)} words`);
});

Deno.test("verify intent claim_status: no claims gives the no_claims sentence after the opening", async () => {
  const h = harness();
  const r = await verifyAs(h, "6025550105", [5, 9, 1990], { intent: "claim_status" }, "tc_v");
  assertEquals(
    r.sentence,
    "Thanks, Ines. You're all verified. I'm not seeing any claims on file for your account. Would you like me to explain how to start one?",
  );
  assertEquals(r.data, { first_name: "Ines", status_read: true, claims: [] });
  assertEquals(h.attempts().at(-1)?.code, "no_claims");
});

Deno.test("verify intent claim_status: a failed claims read gives the plain verified answer, and no status read", async () => {
  const h = harness();
  await lookup(h, "6025550101");
  h.store.failNext("getClaims");
  const r = await h.run(
    "verify_identity",
    { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "claim_status" },
    "tc_v",
  );
  assertEquals(r, { code: "verified", sentence: VERIFIED_TOBIAS, data: { first_name: "Tobias" } });
  // the ledger says what happened: the read failed, so post-call never counts it as a status read
  assertEquals(h.attempts().at(-1)?.tool_call_id, "tc_v:status");
  assertEquals(h.attempts().at(-1)?.code, "system_error");
});

Deno.test("verify intent claim_status: a failed ledger claim still answers with the read", async () => {
  const h = harness();
  await lookup(h, "6025550101");
  h.store.failNext("claimAttempt");
  const r = await h.run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "claim_status" });
  assertEquals(r.data?.status_read, true);
  assertFalse(h.attempts().some((a) => a.tool_name === "get_claim_status"));
});

Deno.test("verify intent claim_status: a busy account still fits one turn after the opening", async () => {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    h.store.claims.push({
      id: crypto.randomUUID(),
      customer_id: TOBIAS,
      claim_number: `CLM-25${String(i).padStart(4, "0")}`,
      claim_type: "home",
      status: "awaiting_documents",
      status_detail: null,
      documents_required: ["photos of the damage", "a contractor estimate"],
      documents_due: "2026-10-30",
      adjuster_name: "Leona Fairbanks",
      filed_on: `2026-08-${String(i + 10).padStart(2, "0")}`,
      updated_on: "2026-09-01",
      amount_approved: null,
    });
  }
  const r = await verifyTobias(h, { intent: "claim_status" });
  assert(r.sentence.startsWith("Thanks, Tobias. You're all verified. You have fourteen claims."), r.sentence);
  assert(spokenWords(r.sentence) <= MAX_TURN_WORDS, `${spokenWords(r.sentence)} words`);
  assertStringIncludes(r.sentence, "more claims on file");
});

Deno.test("verify intent: other, absent or unknown changes nothing; a failed verify ignores it", async () => {
  for (const intent of ["other", undefined, "banana", 7]) {
    const h = harness();
    const r = await verifyTobias(h, intent === undefined ? {} : { intent });
    assertEquals(r, { code: "verified", sentence: VERIFIED_TOBIAS, data: { first_name: "Tobias" } }, String(intent));
  }
  const h = harness();
  await lookup(h, "6025550101");
  const wrong = await h.run("verify_identity", { dob_month: 3, dob_day: 15, dob_year: 1986, intent: "claim_status" });
  assertEquals(wrong.code, "auth_failed");
  assertFalse(h.attempts().some((a) => a.tool_name === "get_claim_status"));
});

// ---------------------------------------------------------------------------------------------
// get_claim_status {detail, claim_ending}: the details the summary leaves out, on request
// ---------------------------------------------------------------------------------------------
const claimNumbered = (h: Harness, number: string) => h.store.claims.find((c) => c.claim_number === number)!;

Deno.test("get_claim_status detail documents: the list, the due date and how to send it", async () => {
  const h = harness();
  await verifyTobias(h);
  const r = await h.run("get_claim_status", { detail: "documents" }, "tc_docs");
  assertEquals(r, {
    code: "claim_documents",
    sentence: documentsSentence(tobiasClaims(h), TODAY),
    data: { claims: [{ claim_number_last3: "198", status: "awaiting_documents" }] },
  });
  assertStringIncludes(r.sentence, "photos of the damage, a contractor estimate, and proof of ownership");
  assert(spokenWords(r.sentence) <= MAX_TURN_WORDS);
  assertEquals(h.attempts().at(-1)?.code, "claim_documents");
  // read-only: a replay of the same toolCallId reads again and keeps one ledger row
  assertEquals(await h.run("get_claim_status", { detail: "documents" }, "tc_docs"), r);
  assertEquals(h.attempts().filter((a) => a.tool_call_id === "tc_docs").length, 1);
});

Deno.test("get_claim_status detail documents: a named claim narrows the list only to a claim awaiting documents", async () => {
  const h = harness();
  h.store.claims.push({
    ...claimNumbered(h, "CLM-240198"),
    id: crypto.randomUUID(),
    claim_number: "CLM-240305",
    claim_type: "auto",
    documents_required: ["a police report"],
    documents_due: "2026-10-30",
    filed_on: "2026-10-02",
  });
  await verifyTobias(h);
  const awaiting = tobiasClaims(h).filter((c) => c.status === "awaiting_documents");
  const one = await h.run("get_claim_status", { detail: "documents", claim_ending: "305" });
  assertEquals(one.sentence, documentsSentence([claimNumbered(h, "CLM-240305")], TODAY));
  // the paid auto claim needs nothing, so naming it reads every claim that does
  for (const claim_ending of ["115", "nope"]) {
    const all = await h.run("get_claim_status", { detail: "documents", claim_ending });
    assertEquals(all.sentence, documentsSentence(awaiting, TODAY), claim_ending);
    assertEquals(all.data?.claims, [
      { claim_number_last3: "198", status: "awaiting_documents" },
      { claim_number_last3: "305", status: "awaiting_documents" },
    ]);
  }
});

Deno.test("get_claim_status detail documents: nothing to send", async () => {
  const h = harness();
  await verifyAs(h, "6025550102", [11, 2, 1979]); // Ronan: one claim, under review
  assertEquals(await h.run("get_claim_status", { detail: "documents" }), {
    code: "no_documents_needed",
    sentence: "None of your claims needs documents right now. Is there anything else I can help with?",
  });
});

Deno.test("get_claim_status detail claim: one claim by its ending, its type or as the only claim", async () => {
  const h = harness();
  await verifyTobias(h);
  const paid = claimDetailSentence(claimNumbered(h, "CLM-240115"), TODAY);
  for (
    const claim_ending of [
      "115",
      "5",
      "one one five",
      "CLM-240115",
      "ending in 115",
      "ending in one one five",
      "auto",
      "the car one",
      "auto 115",
      "the paid one",
      "the one paid October 8",
      "the one they paid on 10/8",
      115,
    ]
  ) {
    const r = await h.run("get_claim_status", { detail: "claim", claim_ending });
    assertEquals(r.code, "claim_detail", String(claim_ending));
    assertEquals(r.sentence, paid, String(claim_ending));
    assertEquals(r.data, { claims: [{ claim_number_last3: "115", status: "payment_issued" }] });
  }
  assertStringIncludes(paid, "was issued by direct deposit on October eighth. Your adjuster is Leona Fairbanks.");
  // a claim awaiting documents: its documents, its due date and its adjuster
  const home = await h.run("get_claim_status", { detail: "claim", claim_ending: "home" });
  assertEquals(home.sentence, claimDetailSentence(claimNumbered(h, "CLM-240198"), TODAY));
  assertStringIncludes(home.sentence, "by October twenty-fourth. Your adjuster is Leona Fairbanks.");
  // a named claim with no detail given means that claim; an explicit summary stays the summary
  assertEquals((await h.run("get_claim_status", { claim_ending: "198" })).code, "claim_detail");
  assertEquals((await h.run("get_claim_status", { detail: "summary", claim_ending: "198" })).code, "ok");
  assertEquals((await h.run("get_claim_status", { detail: "everything" })).code, "ok");

  // Sloane's only claim needs no ending: the reason, the adjuster and how to appeal
  const s = harness();
  await verifyAs(s, "6025550103", [7, 21, 1992]);
  const denied = await s.run("get_claim_status", { detail: "claim" });
  assertEquals(denied.code, "claim_detail");
  assertStringIncludes(denied.sentence, "was denied because the item class is not covered by the policy.");
  assertStringIncludes(denied.sentence, "Your adjuster is Leona Fairbanks.");
  assertStringIncludes(denied.sentence, "To appeal, send us a short letter within thirty days");
  // an account's only claim is the one meant, whatever words came with it: a misheard ending or the
  // wrong type gets that claim's details (which say its type and ending), never a question for digits
  for (const claim_ending of ["117", "auto", "the home one", "the other one"]) {
    assertEquals(await s.run("get_claim_status", { detail: "claim", claim_ending }), denied, claim_ending);
  }
  const r = harness();
  await verifyAs(r, "6025550102", [11, 2, 1979]); // Ronan: one auto claim
  const ronan = await r.run("get_claim_status", { detail: "claim", claim_ending: "home" });
  assertEquals(ronan.code, "claim_detail");
  assert(ronan.sentence.startsWith("Your auto claim ending in two one one is under review"), ronan.sentence);
});

Deno.test("get_claim_status detail claim: words that name no single claim are asked about", async () => {
  const h = harness();
  await verifyTobias(h);
  const which =
    "Which claim do you mean, your home claim ending in one nine eight or your auto claim ending in one one five?";
  for (
    const claim_ending of [undefined, "777", "boat", "198 or 115", "the 8th", "the $4,820 one", "home 115"]
  ) {
    const args = claim_ending === undefined ? { detail: "claim" } : { detail: "claim", claim_ending };
    const r = await h.run("get_claim_status", args);
    assertEquals(r.code, "claim_not_identified", JSON.stringify(args));
    assertEquals(r.sentence, which, JSON.stringify(args));
    assertEquals(r.data, {
      claims: [
        { claim_number_last3: "198", claim_type: "home", status: "awaiting_documents" },
        { claim_number_last3: "115", claim_type: "auto", status: "payment_issued" },
      ],
    });
  }
  // two claims of the type named: only those two are offered
  h.store.claims.push({ ...claimNumbered(h, "CLM-240115"), id: crypto.randomUUID(), claim_number: "CLM-240777" });
  const autos = await h.run("get_claim_status", { detail: "claim", claim_ending: "auto" });
  assertEquals(autos.sentence, "Which auto claim do you mean, the one ending in seven seven seven or one one five?");
  // the ledger never counts the question as a status read
  assertEquals(h.attempts().at(-1)?.code, "claim_not_identified");
});

Deno.test("get_claim_status detail claim: the claims the summary only counted are offered first", async () => {
  const h = harness();
  // a claim filed on an earlier call: the summary reads the documents and the payment, and counts it
  h.store.claims.push({
    ...claimNumbered(h, "CLM-240115"),
    id: crypto.randomUUID(),
    claim_number: "CLM-260472",
    status: "received",
    status_detail: null,
    adjuster_name: null,
    amount_approved: null,
    filed_on: "2026-10-12",
    updated_on: "2026-10-12",
  });
  await verifyTobias(h);
  const summary = await h.run("get_claim_status", {});
  assertStringIncludes(summary.sentence, "There's one more claim on file.");
  assert(!summary.sentence.includes("four seven two"), summary.sentence);
  const other = await h.run("get_claim_status", { detail: "claim" });
  assertEquals(
    other.sentence,
    "Which claim do you mean, your auto claim ending in four seven two, your home claim ending in one nine eight, or your auto claim ending in one one five?",
  );
  // and the caller can name it now that they have heard its ending
  const named = await h.run("get_claim_status", { detail: "claim", claim_ending: "472" });
  assertEquals(named.code, "claim_detail");
  assertStringIncludes(named.sentence, "ending in four seven two was received on October twelfth");

  // five claims or more: four are offered by ending, never a question for digits the caller never heard
  for (const n of ["301", "302"]) {
    h.store.claims.push({
      ...claimNumbered(h, "CLM-240115"),
      id: crypto.randomUUID(),
      claim_number: `CLM-260${n}`,
      claim_type: "property",
      status: "closed",
      filed_on: "2026-01-01",
    });
  }
  const five = await h.run("get_claim_status", { detail: "claim" });
  assertEquals(five.code, "claim_not_identified");
  assertEquals((five.data?.claims as unknown[]).length, 4);
  assert(!/digits/.test(five.sentence), five.sentence);
  assertStringIncludes(five.sentence, "your auto claim ending in four seven two");
  assertStringIncludes(five.sentence, "your property claim ending in three zero two");
});

Deno.test("get_claim_status detail claim: two claims with the same ending are told apart by type", async () => {
  const h = harness();
  h.store.claims.push({
    ...claimNumbered(h, "CLM-240115"),
    id: crypto.randomUUID(),
    claim_number: "CLM-250198",
    claim_type: "property",
    status: "denied",
    status_detail: "The item class is not covered by the policy",
    amount_approved: null,
  });
  await verifyTobias(h);
  const r = await h.run("get_claim_status", { detail: "claim", claim_ending: "198" });
  assertEquals(r.code, "claim_not_identified");
  assertEquals(
    r.sentence,
    "Which claim do you mean, your home claim ending in one nine eight or your property claim ending in one nine eight?",
  );
  // the answer names the type: that claim, not the same question again
  for (const claim_ending of ["property 198", "the property one ending in 198", "property"]) {
    const one = await h.run("get_claim_status", { detail: "claim", claim_ending });
    assertEquals(one.code, "claim_detail", claim_ending);
    assertStringIncludes(one.sentence, "Your property claim ending in one nine eight was denied because", claim_ending);
  }
  assertEquals(
    (await h.run("get_claim_status", { detail: "claim", claim_ending: "home 198" })).sentence,
    claimDetailSentence(claimNumbered(h, "CLM-240198"), TODAY),
  );
  // the same type and ending as well: told apart by where they stand, and named by it
  claimNumbered(h, "CLM-250198").claim_type = "home";
  const twin = await h.run("get_claim_status", { detail: "claim", claim_ending: "home 198" });
  assertEquals(
    twin.sentence,
    "Which home claim do you mean, the one ending in one nine eight that needs documents or the one ending in one nine eight that was denied?",
  );
  const byStatus = await h.run("get_claim_status", { detail: "claim", claim_ending: "the denied one" });
  assertEquals(byStatus.code, "claim_detail");
  assertStringIncludes(byStatus.sentence, "was denied because");
});

Deno.test("get_claim_status details: not verified is refused as before, and no claims is no_claims", async () => {
  const h = harness();
  const r = await h.run("get_claim_status", { detail: "claim", claim_ending: "115" });
  assertEquals([r.code, r.data], ["not_verified", { level: "none" }]);
  const ines = harness();
  await verifyAs(ines, "6025550105", [5, 9, 1990]);
  for (const detail of ["summary", "documents", "claim"]) {
    assertEquals((await ines.run("get_claim_status", { detail })).code, "no_claims", detail);
  }
  // a placeholder in the arguments is refused before anything is read
  assertEquals((await h.run("get_claim_status", { detail: "claim", claim_ending: "{{claim}}" })).code, "bad_args");
});

Deno.test("claimEndingKey reads digits, digit words, claim types and statuses, and nothing else", () => {
  assertEquals(claimEndingKey("198"), "198");
  assertEquals(claimEndingKey(198), "198");
  assertEquals(claimEndingKey("ending in 1 9 8"), "198");
  assertEquals(claimEndingKey("one nine eight"), "198");
  assertEquals(claimEndingKey("ending in one nine eight"), "198");
  assertEquals(claimEndingKey("the one one five"), "115");
  assertEquals(claimEndingKey("ending in five"), "5");
  assertEquals(claimEndingKey("Oh nine oh"), "090");
  assertEquals(claimEndingKey("CLM-240198"), "240198");
  assertEquals(claimEndingKey("CLM-240198, ending 198"), "240198");
  assertEquals(claimEndingKey("Home"), "home");
  assertEquals(claimEndingKey("the house claim"), "home");
  assertEquals(claimEndingKey("my car"), "auto");
  // a type and an ending together narrow each other
  assertEquals(claimEndingKey("home 198"), "home 198");
  assertEquals(claimEndingKey("the home one ending in one nine eight"), "home 198");
  // where a claim stands names it too
  assertEquals(claimEndingKey("the denied one"), "denied");
  assertEquals(claimEndingKey("the one that needs documents"), "awaiting_documents");
  assertEquals(claimEndingKey("the approved one"), "approved");
  // "one" next to other words is a word, not a digit
  assertEquals(claimEndingKey("the home one"), "home");
  // dates and amounts are not endings; two endings, or two types, name neither
  assertEquals(claimEndingKey("the one paid October 8"), "payment_issued");
  assertEquals(claimEndingKey("the one from Oct. 8th, 2026"), "");
  assertEquals(claimEndingKey("the one from 10/8"), "");
  assertEquals(claimEndingKey("the 8th"), "");
  assertEquals(claimEndingKey("the $4,820 one"), "");
  assertEquals(claimEndingKey("the 4820 dollars one"), "");
  assertEquals(claimEndingKey("198 or 115"), "");
  assertEquals(claimEndingKey("one nine eight or one one five"), "");
  assertEquals(claimEndingKey("auto or home"), "");
  assertEquals(claimEndingKey("home, 198 or 199"), "home");
  for (const v of ["", "the other one", "two claims", null, undefined, {}, true]) {
    assertEquals(claimEndingKey(v), "", String(v));
  }
});

Deno.test("claimMatchesKey: every part of the key must fit the claim", () => {
  assert(claimMatchesKey("240198", "home", "awaiting_documents", "198"));
  assert(claimMatchesKey("240198", "home", "awaiting_documents", "home 198"));
  assertFalse(claimMatchesKey("240198", "home", "awaiting_documents", "auto 198"));
  assertFalse(claimMatchesKey("240198", "home", "awaiting_documents", "115"));
  assert(claimMatchesKey("240115", "auto", "payment_issued", "approved"));
  assert(claimMatchesKey("240115", "auto", "payment_issued", "payment_issued"));
  assertFalse(claimMatchesKey("240115", "auto", "approved", "payment_issued"));
  assertFalse(claimMatchesKey("240115", "auto", "payment_issued", ""));
});

// ---------------------------------------------------------------------------------------------
// start_claim: who may report a loss
// ---------------------------------------------------------------------------------------------
Deno.test("start_claim: nobody looked up yet is asked for the number on the account", async () => {
  const h = harness();
  assertEquals(await h.run("start_claim", AUTO_ARGS), {
    code: "claim_needs_lookup",
    sentence: "I'm sorry to hear that. I can help you start a claim. First, what's the phone number on your account?",
  });
  // an unreadable number was never a lookup
  assertEquals((await h.run("lookup_customer", { phone: "12345" })).code, "invalid_phone");
  assertEquals((await h.run("start_claim", AUTO_ARGS)).code, "claim_needs_lookup");
  assertEquals(h.intake(), undefined);
});

Deno.test("start_claim: after a lookup miss the new caller's details come first", async () => {
  const h = harness();
  await lookup(h, "6025550199", "not_found");
  assertEquals(await h.run("start_claim", AUTO_ARGS), {
    code: "claim_needs_contact",
    sentence:
      "I'm sorry to hear that. I can take down the details for our claims team. First, can I get your first and last name?",
  });
  await lookup(h, "6025550199", "not_found_final");
  assertEquals((await h.run("start_claim", AUTO_ARGS)).code, "claim_needs_contact");
  // details given but not yet confirmed are not enough either
  await h.run("capture_contact", { first_name: "Jane", last_name: "Doe" });
  assertEquals((await h.run("start_claim", AUTO_ARGS)).code, "claim_needs_contact");
  assertEquals(h.intake(), undefined);
});

Deno.test("start_claim: a matched number verifies first; a locked caller cannot file", async () => {
  const found = harness();
  await lookup(found, "6025550101");
  assertEquals(await found.run("start_claim", AUTO_ARGS), {
    code: "claim_needs_verification",
    sentence: "I'm sorry to hear that. I'll just need to verify you first. What's the date of birth on the account?",
  });

  const locked = harness();
  await lookup(locked, "6025550101");
  await locked.run("verify_identity", { dob_month: 1, dob_day: 1, dob_year: 1980 });
  assertEquals((await locked.run("verify_identity", { dob_month: 1, dob_day: 2, dob_year: 1980 })).code, "locked");
  assertEquals(await locked.run("start_claim", AUTO_ARGS), {
    code: "claim_locked",
    sentence:
      "Since I wasn't able to verify your identity, I can't file a claim on this call. I can have a claims specialist call you back to help. Would you like that?",
  });
  assertEquals(found.intake(), undefined);
  assertEquals(locked.intake(), undefined);
});

// ---------------------------------------------------------------------------------------------
// start_claim: validation and the read-back
// ---------------------------------------------------------------------------------------------
Deno.test("start_claim: a verified customer's loss is stored unconfirmed and read back with the weekday", async () => {
  const h = harness();
  await verifyTobias(h);
  const r = await h.run("start_claim", AUTO_ARGS);
  assertEquals(r, {
    code: "claim_readback",
    sentence: READBACK_AUTO,
    data: { claim_type: "auto", loss_date: "2026-10-10" },
  });
  assertEquals(h.intake(), {
    call_key: CALL_KEY,
    kind: "claim",
    claim_type: "auto",
    loss_date: "2026-10-10",
    summary: "backed into in a parking lot",
    description: "Someone backed into my car in the grocery store parking lot.",
    customer_id: TOBIAS,
    claim_id: null,
    claim_number: null,
    confirmed: false,
    confirmed_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  // reading back files nothing and tells nobody
  assertEquals(h.phoneClaims(), []);
  assertEquals(h.calls.length, 0);
});

Deno.test("start_claim: the customer is the session's, never one named in the arguments", async () => {
  const h = harness();
  await verifyTobias(h);
  await h.run("start_claim", { ...AUTO_ARGS, customer_id: TEAGUE, customerId: INES, verified: true });
  assertEquals(h.intake()?.customer_id, TOBIAS);
});

Deno.test("start_claim: what happened needs three words or more", async () => {
  const h = harness();
  await verifyTobias(h);
  for (const description of [undefined, "", "   ", "car", "my car", 42, "123 456 789"]) {
    const args: Record<string, unknown> = { ...AUTO_ARGS, description };
    if (description === undefined) delete args.description;
    assertEquals(await h.run("start_claim", args), {
      code: "claim_needs_description",
      sentence: "Can you tell me briefly what happened?",
    }, String(description));
  }
  assertEquals(h.intake(), undefined);
  assertEquals(
    (await h.run("start_claim", { ...AUTO_ARGS, description: "hail cracked windshield" })).code,
    "claim_readback",
  );
});

Deno.test("start_claim: an unreadable or future date asks again; one past a year goes to a specialist", async () => {
  for (const loss_date of ["a while ago", "", "tomorrow", "2026-10-14", "October 10, 2027", undefined]) {
    const h = harness();
    await verifyTobias(h);
    const args: Record<string, unknown> = { ...AUTO_ARGS, loss_date };
    if (loss_date === undefined) delete args.loss_date;
    assertEquals(await h.run("start_claim", args), {
      code: "claim_bad_date",
      sentence: "Sorry, I didn't catch the date. What day did it happen?",
    }, String(loss_date));
    assertEquals(h.intake(), undefined);
  }
  const h = harness();
  await verifyTobias(h);
  assertEquals(await h.run("start_claim", { ...AUTO_ARGS, loss_date: "March 3rd, 2025" }), {
    code: "claim_too_old",
    sentence:
      "Since that was more than a year ago, a claims specialist will need to help with this one. Would you like a callback?",
  });
  assertEquals(h.intake(), undefined);
});

Deno.test("start_claim: a second date it cannot read offers a specialist instead of a third try", async () => {
  const h = harness();
  await verifyTobias(h);
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, loss_date: "the other day" })).code, "claim_bad_date");
  const help = {
    code: "claim_date_help",
    sentence: "No problem. A claims specialist can help pin down the date. Would you like a callback?",
  };
  assertEquals(await h.run("start_claim", { ...AUTO_ARGS, loss_date: "sometime last week" }, "tc_help"), help);
  // a replay answers the same; a later readable day still reads back
  assertEquals(await h.run("start_claim", { ...AUTO_ARGS, loss_date: "sometime last week" }, "tc_help"), help);
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, loss_date: "a few days ago" })).code, "claim_date_help");
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, loss_date: "Saturday, I think" })).sentence, READBACK_AUTO);
});

Deno.test("start_claim: the claim type must be one of auto, home, property", async () => {
  const h = harness();
  await verifyTobias(h);
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, claim_type: "boat" })).code, "bad_args");
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, claim_type: undefined })).code, "bad_args");
  assertEquals(h.intake(), undefined);
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, claim_type: " Home " })).code, "claim_readback");
  assertEquals(h.intake()?.claim_type, "home");
});

Deno.test("start_claim: a missing or unusable summary is left out of the read-back", async () => {
  const h = harness();
  await verifyTobias(h);
  const plain = "Let me make sure I have this right. A home claim from Friday, October ninth. Is that correct?";
  const home = { claim_type: "home", loss_date: "Friday", description: "A pipe burst under the kitchen sink." };
  for (
    const summary of [
      undefined,
      "",
      "   ",
      42,
      "a pipe burst under the kitchen sink and flooded the floor", // more than eight words
      "call 602 555 0177", // a number is redacted, and what is left cannot be said
      "!!!",
    ]
  ) {
    const r = await h.run("start_claim", summary === undefined ? home : { ...home, summary });
    assertEquals(r.sentence, plain, String(summary));
    // the column holds the type's own label, which the read-back never repeats
    assertEquals(h.intake()?.summary, "Home claim");
  }
  // accents are folded and anything but letters, digits, spaces and ' - , is dropped
  const r = await h.run("start_claim", { ...home, summary: "Burst pipe in the café's kitchen!" });
  assertEquals(
    r.sentence,
    "Let me make sure I have this right. A home claim, for burst pipe in the cafe's kitchen, from Friday, October ninth. Is that correct?",
  );
  assertEquals(h.intake()?.summary, "Burst pipe in the cafe's kitchen");
});

Deno.test("start_claim: the read-back never repeats the caller's first person as Ava's own", async () => {
  const h = harness();
  await verifyTobias(h);
  const home = { claim_type: "home", loss_date: "Friday", description: "A tree branch came down on the roof." };
  const said = (summary: string) => h.run("start_claim", { ...home, summary }).then((r) => r.sentence);
  // "my" and "our" are said as "your"
  assertEquals(
    await said("a tree branch on my roof"),
    "Let me make sure I have this right. A home claim, for a tree branch on your roof, from Friday, October ninth. Is that correct?",
  );
  assertEquals(h.intake()?.summary, "a tree branch on your roof");
  assertStringIncludes(await said("Our basement flooded"), "for your basement flooded,");
  // anything else in the first person is left out rather than spoken as Ava's
  for (const summary of ["I hit a deer", "someone hit me", "we lost power", "a tree fell on us", "I'm locked out"]) {
    assertEquals(
      await said(summary),
      "Let me make sure I have this right. A home claim from Friday, October ninth. Is that correct?",
      summary,
    );
    assertEquals(h.intake()?.summary, "Home claim", summary);
  }
  // a road named with a letter is not a pronoun
  assertStringIncludes(await said("a crash on I-95"), "for a crash on I-ninety five,");
});

Deno.test("start_claim: the caller's words are stored redacted, one line, at most 500 characters", async () => {
  const h = harness();
  await verifyTobias(h);
  await h.run("start_claim", {
    ...AUTO_ARGS,
    description: "Someone hit my car.\nCall me at 602 555 0177 or jane.doe@example.com. " + "More details. ".repeat(60),
  });
  const description = h.intake()?.description as string;
  assertStringIncludes(description, "Someone hit my car. Call me at [phone ending 0177] or [email].");
  assertFalse(description.includes("\n"));
  assert(description.length <= 500);
});

Deno.test("start_claim: a correction replaces the unconfirmed intake; a replay reads back the stored one", async () => {
  const h = harness();
  await verifyTobias(h);
  assertEquals((await h.run("start_claim", AUTO_ARGS, "tc_first")).sentence, READBACK_AUTO);
  const corrected = await h.run("start_claim", { ...AUTO_ARGS, loss_date: "yesterday", summary: "" }, "tc_second");
  assertEquals(
    corrected.sentence,
    "Let me make sure I have this right. An auto claim from Monday, October twelfth. Is that correct?",
  );
  assertEquals(h.store.tables.claim_intakes.length, 1);
  assertEquals(h.intake()?.loss_date, "2026-10-12");
  // the first toolCallId again: the read-back of what confirm_claim would file now, and no write
  const before = structuredClone(h.intake());
  assertEquals((await h.run("start_claim", AUTO_ARGS, "tc_first")).sentence, corrected.sentence);
  assertEquals(h.intake(), before);
});

Deno.test("start_claim: a year other than this one is said in the read-back", async () => {
  const h = harness();
  await verifyTobias(h);
  const r = await h.run("start_claim", { ...AUTO_ARGS, loss_date: "December 24", summary: "" });
  assertEquals(
    r.sentence,
    "Let me make sure I have this right. An auto claim from Wednesday, December twenty-fourth, twenty twenty five. Is that correct?",
  );
});

// ---------------------------------------------------------------------------------------------
// confirm_claim: a verified customer's claim
// ---------------------------------------------------------------------------------------------
Deno.test("confirm_claim yes: files the claim, emails the customer on file, tells the team, says the number", async () => {
  const h = harness();
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  const r = await h.run("confirm_claim", { correct: true }, "tc_confirm");
  assertEquals(r, {
    code: "claim_filed",
    sentence: FILED_EMAILED,
    data: { claim_last3: "472", emailed: true },
  });

  // the claims row, exactly as file_claim_intake writes it
  const [claim] = h.phoneClaims() as (Claim & { reported_call_key: string })[];
  assertEquals({ ...claim, id: "x" }, {
    id: "x",
    customer_id: TOBIAS,
    claim_number: "CLM-482472",
    claim_type: "auto",
    status: "received",
    status_detail: "Reported by phone. An adjuster will be assigned within one business day.",
    documents_required: [...CLAIM_DOCUMENTS.auto],
    documents_due: null,
    adjuster_name: null,
    filed_on: TODAY,
    updated_on: TODAY,
    amount_approved: null,
    reported_call_key: CALL_KEY,
  });
  const intake = h.intake();
  assertEquals([intake?.confirmed, intake?.claim_number, intake?.claim_id], [true, "CLM-482472", claim.id]);

  // the customer's confirmation: on-file address, DB facts only, never the caller's words
  const [customer, team] = [...h.resendCalls()].sort((a, b) => body(a).to[0].localeCompare(body(b).to[0]));
  assertEquals(body(customer).to, ["owner@example.com"]);
  assertEquals(header(customer, "Idempotency-Key"), `${CALL_KEY}:claim_received`);
  assertStringIncludes(body(customer).subject, "CLM-482472");
  assertStringIncludes(body(customer).html, "October 10, 2026");
  assertStringIncludes(body(customer).html, "The police report, if one was filed");
  assertFalse(body(customer).html.includes("grocery store"));
  // the team's notice: who, how to reach them, what happened, the number
  assertEquals(body(team).to, ["team@example.com"]);
  assertEquals(header(team, "Idempotency-Key"), `${CALL_KEY}:claim_intake`);
  for (const part of ["Tobias Halvorsen", "(602) 555-0101", "grocery store parking lot", "CLM-482472", "#/calls/"]) {
    assertStringIncludes(body(team).html, part);
  }
  // the card: ids, enums and the last three digits only
  const [telegram] = h.telegramCalls();
  const card = body(telegram).text as string;
  assertStringIncludes(card, "claim_intake | claim | auto | normal | call 8d2e3f40 | webCall | claim ending 472");
  for (const leak of ["482472", "Tobias", "0101", "grocery", "parking"]) assertFalse(card.includes(leak), leak);

  // the ledger keeps both emails, once each
  assertEquals(
    h.store.tables.emails.map((e) => `${e.kind}:${e.status}:${e.to_masked}`).sort(),
    ["claim_intake:sent:t***@example.com", "claim_received:sent:o***@example.com"],
  );
});

Deno.test("confirm_claim yes: a replay of the same toolCallId repeats the answer and sends nothing again", async () => {
  const h = harness();
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  const first = await h.run("confirm_claim", { correct: true }, "tc_confirm");
  const sent = h.calls.length;
  const again = await h.run("confirm_claim", { correct: true }, "tc_confirm");
  assertEquals(again, first);
  assertEquals(h.calls.length, sent);
  assertEquals(h.phoneClaims().length, 1);

  // a new confirm (another toolCallId) finds it filed: nothing is filed, sent or paged again
  assertEquals(await h.run("confirm_claim", { correct: true }), {
    code: "claim_already_filed",
    sentence: ALREADY_FILED,
    data: { claim_last3: "472" },
  });
  // and so does a new start_claim, or a "no" after the fact
  assertEquals((await h.run("start_claim", { ...AUTO_ARGS, loss_date: "yesterday" })).sentence, ALREADY_FILED);
  assertEquals((await h.run("confirm_claim", { correct: false })).sentence, ALREADY_FILED);
  assertEquals(h.calls.length, sent);
  assertEquals([h.intake()?.confirmed, h.intake()?.loss_date], [true, "2026-10-10"]);
});

Deno.test("confirm_claim no: the intake stays unconfirmed and the caller is asked what to change", async () => {
  const h = harness();
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  assertEquals(await h.run("confirm_claim", { correct: false }), {
    code: "claim_retry",
    sentence: "No problem. What should I change?",
  });
  assertEquals([h.intake()?.confirmed, h.phoneClaims().length, h.calls.length], [false, 0, 0]);
  // the corrected details are read back and can then be filed
  await h.run("start_claim", { ...AUTO_ARGS, loss_date: "Sunday" });
  assertEquals((await h.run("confirm_claim", { correct: "yes" })).code, "claim_filed");
  assertEquals(h.intake()?.loss_date, "2026-10-11");
});

Deno.test("confirm_claim: nothing to confirm without an intake; a non-boolean is bad_args", async () => {
  const h = harness();
  await verifyTobias(h);
  for (const correct of [true, false]) {
    assertEquals(await h.run("confirm_claim", { correct }), {
      code: "claim_not_pending",
      sentence: "I don't have the claim details yet. Can you tell me what happened?",
    });
  }
  for (const args of [{}, { correct: "maybe" }, { correct: 1 }, null]) {
    assertEquals((await h.run("confirm_claim", args)).code, "bad_args", JSON.stringify(args));
  }
});

Deno.test("confirm_claim: a failed confirmation email is never said to have been sent", async () => {
  const resend: Responder = (_url, init) =>
    String(init.body).includes("owner@example.com")
      ? json({ message: "Domain not verified" }, 403)
      : json({ id: "re_team" });
  const h = harness({ resend });
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  const r = await h.run("confirm_claim", { correct: true }, "tc_confirm");
  assertEquals(r, { code: "claim_filed", sentence: FILED_PLAIN, data: { claim_last3: "472", emailed: false } });
  assertEquals(h.store.tables.emails.find((e) => e.kind === "claim_received")?.status, "failed");
  // the replay rebuilds the same honest answer from the ledger
  assertEquals((await h.run("confirm_claim", { correct: true }, "tc_confirm")).sentence, FILED_PLAIN);
});

Deno.test("confirm_claim: the team's channels failing never change what the caller hears", async () => {
  const resend: Responder = (_url, init) =>
    String(init.body).includes("team@example.com") ? json({ message: "boom" }, 500) : json({ id: "re_customer" });
  const h = harness({ resend, telegram: () => json({ ok: false, description: "Bad Request" }, 400) });
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  assertEquals((await h.run("confirm_claim", { correct: true })).sentence, FILED_EMAILED);
});

Deno.test("confirm_claim: no email on file means no confirmation and no promise of one", async () => {
  const h = harness();
  await verifyAs(h, "6025550104", [1, 30, 1965]);
  // an address Teague spelled for staff is a pending update, never a recipient
  await h.run("capture_contact", { email: "teague.a@example.com" });
  await h.run("confirm_contact", { correct: true });
  await h.run("start_claim", {
    claim_type: "home",
    loss_date: "the 5th",
    description: "A tree fell on the garage roof.",
  });
  const r = await h.run("confirm_claim", { correct: true });
  assertEquals(r.code, "claim_filed");
  assertFalse(r.sentence.includes("emailed"));
  const recipients = h.resendCalls().map((c) => body(c).to[0]);
  assertEquals(recipients, ["team@example.com"]);
});

Deno.test("confirm_claim: a Resend that never answers is cut at the channel budget, and not promised", async () => {
  const h = harness({
    resend: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      }),
  });
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  const started = Date.now();
  const r = await h.run("confirm_claim", { correct: true });
  assert(Date.now() - started < 4000, "answered within the tool budget");
  assertEquals(r, { code: "claim_filed", sentence: FILED_PLAIN, data: { claim_last3: "472", emailed: false } });
});

Deno.test("confirm_claim on a chat: the customer is emailed; the team alerts are skipped, as escalate does", async () => {
  const h = harness({ isChat: true, channel: "chat" });
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  assertEquals((await h.run("confirm_claim", { correct: true })).sentence, FILED_EMAILED);
  assertEquals(h.telegramCalls().length, 0);
  assertEquals(h.resendCalls().map((c) => body(c).to[0]), ["owner@example.com"]);
});

Deno.test("confirm_claim: two overlapping deliveries file once and page the team once", async () => {
  for (const ids of [["tc_dup", "tc_dup"], ["tc_a", "tc_b"]]) {
    const h = harness();
    await verifyTobias(h);
    await h.run("start_claim", AUTO_ARGS);
    // both read the intake unfiled before either files it; the store says which one filed
    const [a, b] = await Promise.all(
      ids.map((id) => runTool({ id, name: "confirm_claim", args: { correct: true } }, h.ctx)),
    );
    assertEquals([a.code, b.code], ["claim_filed", "claim_filed"], ids.join());
    assertEquals(h.telegramCalls().length, 1, `${ids.join()}: paged once`);
    assertEquals(h.resendCalls().length, 2, `${ids.join()}: the confirmation and the team email, once each`);
    assertEquals(h.phoneClaims().length, 1);
    // the delivery that filed it says "emailed"; the other answers from the ledger, never more
    assertEquals(a.sentence, FILED_EMAILED);
    assert([FILED_EMAILED, FILED_PLAIN].includes(b.sentence), b.sentence);
  }
});

Deno.test("confirm_claim: overrunning the tool budget answers system_error, and the ledger replays that", async () => {
  const h = harness();
  await verifyTobias(h);
  await h.run("start_claim", AUTO_ARGS);
  const file = h.store.fileClaimIntake;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.store.fileClaimIntake = async (callKey) => {
    await gate;
    return await file(callKey);
  };
  const r = await runToolWithin({ id: "tc_slow", name: "confirm_claim", args: { correct: true } }, h.ctx, 50);
  assertEquals(r, { code: "system_error", sentence: sentenceFor("system_error") });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // the ledger holds what the caller heard, so a retry of the same toolCallId hears it again
  assertEquals(h.attempts().find((a) => a.tool_call_id === "tc_slow")?.code, "system_error");
  assertEquals((await h.run("confirm_claim", { correct: true }, "tc_slow")).code, "system_error");
  // the filing itself completed; a new confirm says so, and post-call sees a filed intake
  assertEquals((await h.run("confirm_claim", { correct: true })).code, "claim_already_filed");
});

// ---------------------------------------------------------------------------------------------
// confirm_claim: a new caller's lead intake
// ---------------------------------------------------------------------------------------------
Deno.test("lead intake: a confirmed new caller's loss is taken for a specialist, with no claims row", async () => {
  const h = harness();
  await confirmedNewCaller(h);
  const read = await h.run("start_claim", {
    claim_type: "property",
    loss_date: "October 10th",
    description: "My rental property had a break-in and the TV was stolen.",
    summary: "break-in at my rental",
  });
  assertEquals(
    read.sentence,
    "Let me make sure I have this right. A property claim, for break-in at your rental, from Saturday, October tenth. Is that correct?",
  );
  assertEquals([h.intake()?.kind, h.intake()?.customer_id], ["lead_intake", null]);

  const r = await h.run("confirm_claim", { correct: true }, "tc_confirm");
  assertEquals(r, { code: "claim_intake_saved", sentence: SAVED_JANE, data: { first_name: "Jane", emailed: true } });
  assertEquals(h.phoneClaims(), []);
  assertEquals([h.intake()?.confirmed, h.intake()?.claim_number], [true, null]);

  // the confirmation goes to the address the caller spelled and confirmed, without a claim number
  const customer = h.resendCalls().find((c) => body(c).to[0] === "jane.doe42@gmail.com");
  assert(customer, "the caller's confirmed address got the confirmation");
  assertFalse(body(customer).html.includes("CLM-"));
  assertStringIncludes(body(customer).html, "call you within one business day");
  // the team: the caller's name (unverified) and the number they gave
  const team = h.resendCalls().find((c) => body(c).to[0] === "team@example.com");
  assert(team);
  for (const part of ["Jane Doe (caller-provided, unverified)", "(602) 555-0177", "TV was stolen", "NEW CALLER"]) {
    assertStringIncludes(body(team).html, part);
  }
  const card = body(h.telegramCalls()[0]).text as string;
  assertStringIncludes(card, "NEW CALLER: call back to set up the claim");
  assertStringIncludes(card, "claim_intake | lead_intake | property | normal");
  assertFalse(card.includes("claim ending"));
  for (const leak of ["Jane", "0177", "rental"]) assertFalse(card.includes(leak), leak);

  // replay: same answer, nothing sent again
  const sent = h.calls.length;
  assertEquals(await h.run("confirm_claim", { correct: true }, "tc_confirm"), r);
  assertEquals(h.calls.length, sent);
  assertEquals((await h.run("confirm_claim", { correct: true })).code, "claim_already_filed");
  assertEquals(
    (await h.run("confirm_claim", { correct: true })).sentence,
    "Your claim is already filed. Is there anything else I can help with?",
  );
});

Deno.test("lead intake without an email: saved, and no confirmation is promised", async () => {
  const h = harness();
  await notFoundTwice(h);
  await h.run("capture_contact", { first_name: "Jane", last_name: "Doe", callback_phone: "6025550177" });
  await h.run("confirm_contact", { correct: true });
  await h.run("start_claim", {
    claim_type: "auto",
    loss_date: "yesterday",
    description: "I hit a deer on the highway.",
  });
  const r = await h.run("confirm_claim", { correct: true });
  assertEquals(
    r.sentence,
    "Thanks, Jane. I've passed your claim details to our claims team. A specialist will call you within one business day to finish setting it up. Is there anything else I can help with?",
  );
  assertEquals(h.resendCalls().map((c) => body(c).to[0]), ["team@example.com"]);
});

Deno.test("new caller who came to report a loss: once their details are saved, the claim is offered first", async () => {
  // the usual path: two misses, then the details; the offer starts with taking the loss down now
  const h = harness();
  await confirmedNewCaller(h);
  const plain = h.attempts().find((a) => a.tool_name === "confirm_contact");
  assertEquals(plain?.code, "contact_saved_new");
  // the loss told before the details: start_claim asked for them first, so the yes asks to take it down
  const t = harness();
  await notFoundTwice(t);
  const loss = { claim_type: "home", loss_date: "Saturday", description: "Storm damage to the roof of my house." };
  assertEquals((await t.run("start_claim", loss)).code, "claim_needs_contact");
  await t.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe42@gmail.com",
    callback_phone: "6025550177",
  });
  const resume: ToolResult = {
    code: "contact_saved_new",
    sentence: "Perfect, I've saved your details. Shall I go ahead and take down that claim now?",
    data: { first_name: "Jane", resume_claim: true },
  };
  assertEquals(await t.run("confirm_contact", { correct: true }, "tc_yes"), resume);
  assertEquals(await t.run("confirm_contact", { correct: true }, "tc_yes"), resume, "a replay");
  assertEquals((await t.run("start_claim", loss)).code, "claim_readback");
});

Deno.test("lead intake: no number to call back on asks for one before the claim is taken", async () => {
  const h = harness();
  await notFoundTwice(h);
  // a web call has no caller id; the caller gave no number with their details
  await h.run("capture_contact", { first_name: "Jane", last_name: "Doe", email: "jane.doe42@gmail.com" });
  await h.run("confirm_contact", { correct: true });
  const loss = { claim_type: "auto", loss_date: "yesterday", description: "I hit a deer on the highway." };
  assertEquals(await h.run("start_claim", loss, "tc_phone"), {
    code: "claim_needs_phone",
    sentence: "Before I take this down, what's the best number for our claims team to reach you?",
  });
  assertEquals((await h.run("start_claim", loss, "tc_phone")).code, "claim_needs_phone", "a replay");
  assertEquals(h.intake(), undefined);
  // the number is captured with a read-back of its own; the yes then asks to take the claim down
  const read = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe42@gmail.com",
    callback_phone: "6025550177",
  });
  assertStringIncludes(read.sentence, "six zero two... five five five... zero one seven seven");
  assertEquals(
    (await h.run("confirm_contact", { correct: true })).sentence,
    "Perfect, I've saved your details. Shall I go ahead and take down that claim now?",
  );
  assertEquals((await h.run("start_claim", loss)).code, "claim_readback");
  // a phone call's caller id is a number to call: no question
  const p = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550177" });
  await notFoundTwice(p);
  await p.run("capture_contact", { first_name: "Jane", last_name: "Doe" });
  await p.run("confirm_contact", { correct: true });
  assertEquals((await p.run("start_claim", loss)).code, "claim_readback");
});

Deno.test("the claim sentences: speakable, one question, at most sixty words, no 'oh' for zero", () => {
  const variants: [Parameters<typeof sentenceFor>[0], Record<string, unknown> | undefined][] = [
    ["claim_readback", { claim_type: "auto", loss_date: "2026-10-10", summary: "a cracked windshield", today: TODAY }],
    ["claim_filed", { claim_last3: "070", emailed: true }],
    ["claim_intake_saved", { first_name: "Jane", emailed: true }],
    ["claim_already_filed", { claim_last3: "070" }],
  ];
  for (const [code, data] of variants) {
    const s = sentenceFor(code, data);
    assertSpeakable(s);
    assertEquals(s.split("?").length - 1, 1, s);
    assert(s.split(/\s+/).length <= 60, s);
    assertFalse(/\boh\b/i.test(s), s);
  }
  assertStringIncludes(sentenceFor("claim_filed", { claim_last3: "070" }), "ends in zero seven zero");
});
