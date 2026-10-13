// The fake must behave like 0001_init.sql (and 0010_lookup_retries.sql for lookups), or every test
// built on it proves the wrong thing. These cases walk the same sequences scripts/db_suite.ts runs
// against the live database.

import { assert, assertEquals, assertFalse, assertMatch, assertRejects } from "@std/assert";
import { createFakeStore, demoSeed, numberHash } from "./fake_store.ts";
import { OUTBOX_LEASE_MS, outboxClaimable, outboxDue } from "./store_rules.ts";
import type { InteractionRow, OutboxRef } from "./types.ts";

const TOBIAS = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
const TOBIAS_PHONE = "+16025550101";
const NOBODY_PHONE = "+16025550199";
// match no seeded customer either
const OTHER_PHONES = ["+16025550198", "+16025550197"];

function lookup(store: ReturnType<typeof createFakeStore>, callKey: string, toolCallId: string, phone: string | null) {
  return store.lookupCustomerAttempt({ callKey, channel: "webCall", phoneE164: phone, toolCallId, callerNumber: null });
}

function verify(
  store: ReturnType<typeof createFakeStore>,
  callKey: string,
  toolCallId: string,
  dob: [number | null, number | null, number | null],
) {
  const [year, month, day] = dob;
  return store.verifyDobAttempt({ callKey, year, month, day, toolCallId });
}

function kinds(store: ReturnType<typeof createFakeStore>, callKey: string): string[] {
  return store.tables.attempts.filter((a) => a.call_key === callKey).map((a) => `${a.kind}:${a.code}`);
}

Deno.test("lookup hit asks for the DOB and records a lookup_hit without naming anyone", async () => {
  const store = createFakeStore();
  const r = await lookup(store, "c1", "t1", TOBIAS_PHONE);
  assertEquals(r, { code: "needs_dob", misses: 0 });
  const s = await store.getSession("c1");
  assertEquals(s?.level, "phone_found");
  assertEquals(s?.candidate_customer_id, TOBIAS);
  assertEquals(s?.verified_customer_id, null);
  assertEquals(s?.channel, "webCall");
  assertEquals(kinds(store, "c1"), ["lookup_hit:needs_dob"]);
});

Deno.test("right DOB verifies; later lookups say already_verified and later verifies stay verified", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", TOBIAS_PHONE);
  assertEquals(await verify(store, "c1", "t2", [1986, 3, 14]), {
    code: "verified",
    firstName: "Tobias",
    attempts: 0,
    customerId: TOBIAS,
  });
  const s = await store.getSession("c1");
  assertEquals(s?.level, "verified");
  assertEquals(s?.verified_customer_id, TOBIAS);
  assertEquals((await lookup(store, "c1", "t3", NOBODY_PHONE)).code, "already_verified");
  assertEquals(await verify(store, "c1", "t4", [1990, 1, 1]), {
    code: "verified",
    firstName: "Tobias",
    attempts: 0,
    customerId: TOBIAS,
  });
  assertEquals(kinds(store, "c1"), [
    "lookup_hit:needs_dob",
    "dob_ok:verified",
    "other:already_verified",
    "other:verified",
  ]);
});

Deno.test("wrong DOB twice locks; the lock is sticky against a later correct DOB and new lookups", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", TOBIAS_PHONE);
  assertEquals(await verify(store, "c1", "t2", [1986, 3, 15]), {
    code: "auth_failed",
    firstName: null,
    attempts: 1,
    customerId: null,
  });
  assertEquals((await store.getSession("c1"))?.level, "phone_found");
  assertEquals(await verify(store, "c1", "t3", [1987, 3, 14]), {
    code: "locked",
    firstName: null,
    attempts: 2,
    customerId: null,
  });
  assertEquals((await store.getSession("c1"))?.level, "locked");
  assertEquals(await verify(store, "c1", "t4", [1986, 3, 14]), {
    code: "locked",
    firstName: null,
    attempts: 2,
    customerId: null,
  });
  assertEquals((await lookup(store, "c1", "t5", TOBIAS_PHONE)).code, "locked");
  const s = await store.getSession("c1");
  assertEquals(s?.level, "locked");
  assertEquals(s?.verified_customer_id, null);
  assertEquals(kinds(store, "c1"), [
    "lookup_hit:needs_dob",
    "dob_wrong:auth_failed",
    "dob_wrong:locked",
    "other:locked",
    "other:locked",
  ]);
});

Deno.test("one wrong DOB then the right one verifies", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", TOBIAS_PHONE);
  assertEquals((await verify(store, "c1", "t2", [1986, 4, 14])).code, "auth_failed");
  const ok = await verify(store, "c1", "t3", [1986, 3, 14]);
  assertEquals(ok.code, "verified");
  assertEquals(ok.attempts, 1);
});

Deno.test("unreadable DOBs are never counted as wrong; the third one gives up without locking", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", TOBIAS_PHONE);
  assertEquals((await verify(store, "c1", "t2", [null, null, null])).code, "dob_unreadable");
  assertEquals((await verify(store, "c1", "t3", [1986, 2, 30])).code, "dob_unreadable"); // impossible date
  const third = await verify(store, "c1", "t4", [1899, 3, 14]); // before 1900
  assertEquals(third, { code: "dob_give_up", firstName: null, attempts: 0, customerId: null });
  const s = await store.getSession("c1");
  assertEquals(s?.level, "phone_found");
  assertEquals(store.tables.attempts.filter((a) => a.kind === "dob_wrong").length, 0);
  assertEquals(kinds(store, "c1").slice(1), [
    "unreadable:dob_unreadable",
    "unreadable:dob_unreadable",
    "unreadable:dob_give_up",
  ]);
});

Deno.test("a year after this year and month 13 are unreadable, not wrong", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", TOBIAS_PHONE);
  const nextYear = new Date().getUTCFullYear() + 1;
  assertEquals((await verify(store, "c1", "t2", [nextYear, 3, 14])).code, "dob_unreadable");
  assertEquals((await verify(store, "c1", "t3", [1986, 13, 14])).code, "dob_unreadable");
  assertEquals((await verify(store, "c1", "t4", [1986, 3, 15])).code, "auth_failed");
});

Deno.test("an unreadable phone does not move the caller toward dob_give_up", async () => {
  const store = createFakeStore();
  assertEquals(await lookup(store, "c1", "t1", null), { code: "invalid_phone", misses: 0 });
  assertEquals(await lookup(store, "c1", "t2", null), { code: "invalid_phone", misses: 0 });
  await lookup(store, "c1", "t3", TOBIAS_PHONE);
  assertEquals((await verify(store, "c1", "t4", [null, 3, 14])).code, "dob_unreadable");
  assertEquals((await verify(store, "c1", "t5", [1986, null, 14])).code, "dob_unreadable");
  assertEquals((await verify(store, "c1", "t6", [1986, 3, 14])).code, "verified");
  assertEquals(kinds(store, "c1").slice(0, 2), ["unreadable:invalid_phone", "unreadable:invalid_phone"]);
});

Deno.test("verify before any lookup is no_lookup_yet and creates the session", async () => {
  const store = createFakeStore();
  assertEquals(await verify(store, "c1", "t1", [1986, 3, 14]), {
    code: "no_lookup_yet",
    firstName: null,
    attempts: 0,
    customerId: null,
  });
  const s = await store.getSession("c1");
  assertEquals(s?.level, "none");
  assertEquals(s?.channel, "unknown");
  assertEquals(kinds(store, "c1"), ["other:no_lookup_yet"]);
});

Deno.test("the same number again is final for that number: recorded as other, never counted twice", async () => {
  const store = createFakeStore();
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(await lookup(store, "c1", "t2", NOBODY_PHONE), { code: "not_found_final", misses: 1 });
  assertEquals(await lookup(store, "c1", "t3", NOBODY_PHONE), { code: "not_found_final", misses: 1 });
  assertEquals(kinds(store, "c1"), ["lookup_miss:not_found", "other:not_found_final", "other:not_found_final"]);
  // the miss row carries the number's hash, as 0010 writes it; no row carries the number itself
  assertEquals(store.tables.attempts.map((a) => a.number_hash), [numberHash(NOBODY_PHONE), null, null]);
  assertMatch(numberHash(NOBODY_PHONE), /^[0-9a-f]{64}$/);
  assertFalse(JSON.stringify(store.tables.attempts).includes("5550199"));
  // listAttempts reads the columns store.ts selects, without the hash
  assertFalse("number_hash" in (await store.listAttempts("c1"))[0]);
});

Deno.test("a final reached by a repeat is not sticky: a different number is still looked up", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", NOBODY_PHONE);
  assertEquals((await lookup(store, "c1", "t2", NOBODY_PHONE)).code, "not_found_final");
  assertEquals(await lookup(store, "c1", "t3", TOBIAS_PHONE), { code: "needs_dob", misses: 1 });
  assertEquals((await store.getSession("c1"))?.candidate_customer_id, TOBIAS);
});

Deno.test("two different numbers miss and the third hits", async () => {
  const store = createFakeStore();
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(await lookup(store, "c1", "t2", null), { code: "invalid_phone", misses: 1 });
  assertEquals(await lookup(store, "c1", "t3", OTHER_PHONES[0]), { code: "not_found", misses: 2 });
  assertEquals(await lookup(store, "c1", "t4", TOBIAS_PHONE), { code: "needs_dob", misses: 2 });
  assertEquals((await store.getSession("c1"))?.level, "phone_found");
  assertEquals(kinds(store, "c1"), [
    "lookup_miss:not_found",
    "unreadable:invalid_phone",
    "lookup_miss:not_found",
    "lookup_hit:needs_dob",
  ]);
});

Deno.test("three different numbers miss: the third is final, and so is every lookup after it", async () => {
  const store = createFakeStore();
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(await lookup(store, "c1", "t2", OTHER_PHONES[0]), { code: "not_found", misses: 2 });
  assertEquals(await lookup(store, "c1", "t3", OTHER_PHONES[1]), { code: "not_found_final", misses: 3 });
  // sticky: even a seeded number is not looked up any more
  assertEquals(await lookup(store, "c1", "t4", TOBIAS_PHONE), { code: "not_found_final", misses: 3 });
  assertEquals(await lookup(store, "c1", "t5", NOBODY_PHONE), { code: "not_found_final", misses: 3 });
  const s = await store.getSession("c1");
  assertEquals([s?.level, s?.candidate_customer_id], ["none", null]);
  assertEquals(kinds(store, "c1"), [
    "lookup_miss:not_found",
    "lookup_miss:not_found",
    "lookup_miss:not_found_final",
    "other:not_found_final",
    "other:not_found_final",
  ]);
  // a retry of a toolCallId replays its own answer with today's count
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 3 });
  assertEquals(await lookup(store, "c1", "t3", TOBIAS_PHONE), { code: "not_found_final", misses: 3 });
  assertEquals(store.tables.attempts.length, 5);
});

Deno.test("miss rows from before 0010 (no number_hash) still count, each as a different number", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t0", null); // the session row, as any first lookup writes it
  const legacy = (id: string) => ({
    call_key: "c1",
    tool_call_id: id,
    tool_name: "lookup_customer",
    kind: "lookup_miss",
    code: "not_found",
    number_hash: null,
    created_at: new Date().toISOString(),
  });
  store.tables.attempts.push(legacy("old1"));
  // one old miss: a second different number still gets the read-back, and its repeat is known
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 2 });
  assertEquals(await lookup(store, "c1", "t2", NOBODY_PHONE), { code: "not_found_final", misses: 2 });
  store.tables.attempts.push(legacy("old2"));
  // two old misses and one new one: the cap is reached, whatever number comes next
  assertEquals(await lookup(store, "c1", "t3", TOBIAS_PHONE), { code: "not_found_final", misses: 3 });
});

Deno.test("a miss then a hit still reaches the DOB step", async () => {
  const store = createFakeStore();
  await lookup(store, "c1", "t1", NOBODY_PHONE);
  assertEquals(await lookup(store, "c1", "t2", TOBIAS_PHONE), { code: "needs_dob", misses: 1 });
});

Deno.test("replaying a toolCallId returns the stored code and never burns a counter", async () => {
  const store = createFakeStore();
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(await lookup(store, "c1", "t1", TOBIAS_PHONE), { code: "not_found", misses: 1 });
  await lookup(store, "c1", "t2", TOBIAS_PHONE);
  assertEquals((await verify(store, "c1", "t3", [1986, 3, 15])).code, "auth_failed");
  // a VAPI retry of the wrong answer must not lock the caller
  assertEquals(await verify(store, "c1", "t3", [1986, 3, 15]), {
    code: "auth_failed",
    firstName: null,
    attempts: 1,
    customerId: null,
  });
  assertEquals((await store.getSession("c1"))?.level, "phone_found");
  assertEquals((await verify(store, "c1", "t4", [1986, 3, 14])).code, "verified");
  assertEquals(await verify(store, "c1", "t4", [1986, 3, 14]), {
    code: "verified",
    firstName: "Tobias",
    attempts: 1,
    customerId: TOBIAS,
  });
  // the first lookup's answer survives later state changes
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(store.tables.attempts.length, 4);
});

Deno.test("claimAttempt inserts once and returns the stored code to a replay", async () => {
  const store = createFakeStore();
  assertEquals(await store.claimAttempt("c1", "t9", "escalate"), null);
  // the first delivery has not finished: nothing to replay yet
  assertEquals(await store.claimAttempt("c1", "t9", "escalate"), null);
  await store.setAttemptCode("c1", "t9", "rep_queued");
  assertEquals(await store.claimAttempt("c1", "t9", "escalate"), "rep_queued");
  const rows = await store.listAttempts("c1");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].tool_name, "escalate");
  assertEquals(rows[0].kind, "other");
  assertEquals(rows[0].code, "rep_queued");
  // the ledger is shared with the counted tools: the same primary key
  assertEquals(await store.claimAttempt("c2", "t9", "escalate"), null);
  assertEquals((await store.listAttempts("c2")).length, 1);
});

Deno.test("upsert_escalation: one row per (call, kind); a repeat merges only a new number", async () => {
  const store = createFakeStore();
  const base = {
    callKey: "c1",
    kind: "representative" as const,
    reason: "representative_requested" as const,
    details: null,
    callbackPhone: null,
    callbackSource: "none" as const,
    channel: "webCall",
    verified: false,
  };
  const first = await store.upsertEscalation(base);
  assertEquals(first.inserted, true);
  assertEquals(first.callbackPhone, null);
  assertEquals(first.alertStatus, "pending");

  const second = await store.upsertEscalation({
    ...base,
    reason: "auth_locked",
    callbackPhone: "+16025550111",
    callbackSource: "argument",
    details: "wants a call",
  });
  assertEquals(second, { id: first.id, inserted: false, callbackPhone: "+16025550111", alertStatus: "pending" });

  await store.setEscalationDelivery(first.id, "sent", null);
  const third = await store.upsertEscalation({
    ...base,
    callbackSource: "caller_id",
    verified: true,
  });
  assertEquals(third, { id: first.id, inserted: false, callbackPhone: "+16025550111", alertStatus: "sent" });
  await store.upsertEscalation({ ...base, verified: false });

  const rows = await store.listEscalations("c1");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].reason, "representative_requested"); // first reason stands
  assertEquals(rows[0].callback_source, "argument"); // no new number, source kept
  assertEquals(rows[0].details, "wants a call");
  assertEquals(rows[0].verified, true); // OR-ed, never cleared
  assertEquals(rows[0].alert_status, "sent");
  assertEquals(rows[0].status, "open");

  const emergency = await store.upsertEscalation({ ...base, kind: "emergency", reason: "emergency" });
  assertEquals(emergency.inserted, true);
  assert(emergency.id !== first.id);
  assertEquals((await store.listEscalations("c1")).length, 2);
});

Deno.test("upsert_escalation and setEscalationDelivery reject values outside the CHECK lists", async () => {
  const store = createFakeStore();
  await assertRejects(() =>
    store.upsertEscalation({
      callKey: "c1",
      kind: "representative",
      reason: "made_up" as never,
      details: null,
      callbackPhone: null,
      callbackSource: "none",
      channel: "webCall",
      verified: false,
    })
  );
  const { id } = await store.upsertEscalation({
    callKey: "c1",
    kind: "representative",
    reason: "representative_requested",
    details: null,
    callbackPhone: null,
    callbackSource: "none",
    channel: "webCall",
    verified: false,
  });
  await assertRejects(() => store.setEscalationDelivery(id, "delivered" as never, null));
  await store.setEscalationDelivery(id, "failed", "telegram 502: bad gateway");
  assertEquals((await store.listEscalations("c1"))[0].delivery_error, "telegram 502: bad gateway");
});

Deno.test("email ledger: claimed exactly once per (call, kind); later claims see the outcome", async () => {
  const store = createFakeStore();
  assertEquals(await store.claimEmail("c1", "claim_summary", "o***@example.com"), { claimed: true });
  assertEquals(await store.claimEmail("c1", "claim_summary", "o***@example.com"), {
    claimed: false,
    status: "sending",
    resendId: null,
  });
  await store.finishEmail("c1", "claim_summary", "sent", "re_123", null);
  assertEquals(await store.claimEmail("c1", "claim_summary", "o***@example.com"), {
    claimed: false,
    status: "sent",
    resendId: "re_123",
  });
  assertEquals(await store.claimEmail("c1", "document_checklist", "o***@example.com"), { claimed: true });
  await store.finishEmail("c1", "document_checklist", "failed", null, "resend 422: invalid to");
  assertEquals(await store.claimEmail("c1", "document_checklist", "o***@example.com"), {
    claimed: false,
    status: "failed",
    resendId: null,
  });
  assertEquals(await store.claimEmail("c2", "claim_summary", "o***@example.com"), { claimed: true });
  const rows = await store.listEmails("c1");
  assertEquals(rows.map((r) => `${r.kind}:${r.status}`), ["claim_summary:sent", "document_checklist:failed"]);
  assertEquals(rows[1].error, "resend 422: invalid to");
  await assertRejects(() => store.claimEmail("c1", "newsletter" as never, "o***@example.com"));
});

const STUB: InteractionRow = {
  vapi_call_id: "call-1",
  channel: "webCall",
  caller_phone: null,
  started_at: "2026-10-12T14:00:00.000Z",
  outcome: "in_progress",
};

const FULL: InteractionRow = {
  vapi_call_id: "call-1",
  channel: "webCall",
  customer_id: TOBIAS,
  caller_name: "Tobias Halvorsen",
  caller_phone: TOBIAS_PHONE,
  summary: "Caller asked about two claims.",
  sentiment: "positive",
  sentiment_source: "vapi",
  outcome: "resolved",
  escalated: true,
  emergency: false,
  flags: ["tool_markup_spoken"],
  started_at: "2026-10-12T14:00:00.000Z",
  ended_at: "2026-10-12T14:03:30.000Z",
  duration_seconds: 210,
  ended_reason: "customer-ended-call",
  transcript: "AI: Hello\nUser: Hi",
  recording_url: "https://storage.example/rec.wav",
  cost: 0.1234,
  success_evaluation: "true",
  analysis_raw: { summary: "Caller asked about two claims." },
  messages: [{ role: "assistant", text: "Hello", t: "00:00" }],
  latency_avg_ms: 820,
  cost_breakdown: { total: 0.1234 },
  assistant_name: "solo-web",
  analysis_status: "ok",
};

Deno.test("upsert_interaction: a stub then the full report fills the row and completes it", async () => {
  const store = createFakeStore();
  await store.upsertInteraction(STUB);
  let row = store.tables.call_interactions[0];
  assertEquals(row.outcome, "in_progress");
  assertEquals(row.status, "in_progress");
  assertEquals(row.escalated, false);
  assertEquals(row.flags, []);
  assertEquals(row.analysis_status, "pending");

  await store.upsertInteraction(FULL);
  assertEquals(store.tables.call_interactions.length, 1);
  row = store.tables.call_interactions[0];
  assertEquals(row.outcome, "resolved");
  assertEquals(row.summary, FULL.summary);
  assertEquals(row.sentiment, "positive");
  assertEquals(row.flags, ["tool_markup_spoken"]);
  assertEquals(row.escalated, true);
  assertEquals(row.analysis_status, "ok");
  assertEquals(row.status, "completed");
});

Deno.test("upsert_interaction: a partial report after the full one keeps every filled field", async () => {
  const store = createFakeStore();
  await store.upsertInteraction(FULL);
  await store.upsertInteraction({
    vapi_call_id: "call-1",
    channel: "",
    summary: "",
    sentiment: null,
    outcome: "in_progress",
    escalated: false,
    flags: [],
    ended_at: "2026-10-12T14:03:31.000Z",
    transcript: "AI: Hello",
    analysis_status: "pending",
  });
  const row = store.tables.call_interactions[0];
  assertEquals(row.channel, "webCall");
  assertEquals(row.summary, FULL.summary);
  assertEquals(row.sentiment, "positive");
  assertEquals(row.outcome, "resolved");
  assertEquals(row.escalated, true);
  assertEquals(row.flags, ["tool_markup_spoken"]);
  assertEquals(row.analysis_status, "ok");
  assertEquals(row.customer_id, TOBIAS);
  assertEquals(row.ended_at, "2026-10-12T14:03:31.000Z"); // a non-null timestamp replaces
  assertEquals(row.transcript, "AI: Hello"); // non-empty text replaces
  assertEquals(row.status, "completed");
});

Deno.test("upsert_interaction: a stub after the completed row is ignored entirely", async () => {
  const store = createFakeStore();
  await store.upsertInteraction(FULL);
  const before = structuredClone(store.tables.call_interactions[0]);
  await store.upsertInteraction({
    vapi_call_id: "call-1",
    channel: "inboundPhoneCall",
    caller_name: "Someone Else",
    started_at: "2026-10-12T15:00:00.000Z",
    outcome: "abandoned",
    escalated: true,
    emergency: true,
    analysis_status: "missing",
  });
  assertEquals(store.tables.call_interactions[0], before);
});

Deno.test("upsert_interaction: a definite outcome and a non-pending analysis status replace", async () => {
  const store = createFakeStore();
  await store.upsertInteraction(FULL);
  await store.upsertInteraction({
    vapi_call_id: "call-1",
    ended_at: FULL.ended_at,
    outcome: "escalated",
    emergency: true,
    sentiment: "negative",
    sentiment_source: "backfill",
    analysis_status: "backfilled",
  });
  const row = store.tables.call_interactions[0];
  assertEquals(row.outcome, "escalated");
  assertEquals(row.emergency, true);
  assertEquals(row.sentiment, "negative");
  assertEquals(row.sentiment_source, "backfill");
  assertEquals(row.analysis_status, "backfilled");
});

Deno.test("upsert_interaction rejects what Postgres would reject", async () => {
  const store = createFakeStore();
  await assertRejects(() => store.upsertInteraction({ ...FULL, duration_seconds: 210.5 }));
  await assertRejects(() => store.upsertInteraction({ ...FULL, sentiment: "ecstatic" }));
  await assertRejects(() => store.upsertInteraction({ ...FULL, outcome: "done" }));
  await assertRejects(() => store.upsertInteraction({ ...FULL, customer_id: "not-a-uuid" }));
  await assertRejects(() => store.upsertInteraction({ ...FULL, customer_id: "00000000-0000-4000-8000-000000000000" }));
  await assertRejects(() => store.upsertInteraction({ ...FULL, started_at: "yesterday" }));
  assertEquals(store.tables.call_interactions.length, 0);
});

Deno.test("ensureInteraction inserts a stub once and never touches an existing row", async () => {
  const store = createFakeStore();
  await store.ensureInteraction(STUB);
  await store.ensureInteraction({ ...STUB, channel: "inboundPhoneCall" });
  assertEquals(store.tables.call_interactions.length, 1);
  assertEquals(store.tables.call_interactions[0].channel, "webCall");
  assertEquals(store.tables.call_interactions[0].escalated, false);
  await store.upsertInteraction(FULL);
  await store.ensureInteraction(STUB);
  assertEquals(store.tables.call_interactions[0].status, "completed");
  await assertRejects(() => store.ensureInteraction({ vapi_call_id: "call-2", escalated: null as never }));
  await assertRejects(() => store.ensureInteraction({ vapi_call_id: "call-3", nope: 1 } as never));
});

Deno.test("transcript lines: retried deliveries are no-ops; the newest assistant line wins by ts_ms", async () => {
  const store = createFakeStore();
  await store.insertTranscriptLine({
    call_key: "c1",
    role: "assistant",
    text: "What's the date of birth?",
    ts_ms: 2000,
  });
  await store.insertTranscriptLine({ call_key: "c1", role: "assistant", text: "Hello", ts_ms: 1000 }); // arrives late
  await store.insertTranscriptLine({ call_key: "c1", role: "user", text: "[answer withheld]", ts_ms: 3000 });
  await store.insertTranscriptLine({ call_key: "c1", role: "assistant", text: "duplicate", ts_ms: 2000 });
  await store.insertTranscriptLine({ call_key: "c2", role: "assistant", text: "other call", ts_ms: 9000 });
  assertEquals(store.tables.transcript_lines.filter((t) => t.call_key === "c1").length, 3);
  assertEquals(await store.lastAssistantLine("c1"), "What's the date of birth?");
  assertEquals(await store.lastAssistantLine("nobody"), null);
  await store.deleteTranscriptLines("c1");
  assertEquals(await store.lastAssistantLine("c1"), null);
  assertEquals(await store.lastAssistantLine("c2"), "other call");
  await assertRejects(() =>
    store.insertTranscriptLine({ call_key: "c1", role: "system" as never, text: "x", ts_ms: 1 })
  );
  await assertRejects(() => store.insertTranscriptLine({ call_key: "c1", role: "user", text: "x", ts_ms: 1.5 }));
});

Deno.test("priorInteractions: completed rows with a summary, this call excluded, newest first, capped", async () => {
  const store = createFakeStore();
  const done = (id: string, startedAt: string | null, extra: Partial<InteractionRow> = {}) =>
    store.upsertInteraction({
      vapi_call_id: id,
      customer_id: TOBIAS,
      started_at: startedAt,
      ended_at: "2026-10-12T00:00:00.000Z",
      summary: `summary ${id}`,
      ...extra,
    });
  await done("a", "2026-10-01T15:00:00.000Z");
  await done("b", "2026-10-05T15:00:00.000Z");
  await done("c", "2026-10-03T15:00:00.000Z");
  await done("d", "2026-10-04T15:00:00.000Z");
  await done("no-start", null);
  await done("no-summary", "2026-10-09T15:00:00.000Z", { summary: null });
  await store.upsertInteraction({ vapi_call_id: "open", customer_id: TOBIAS, started_at: "2026-10-10T15:00:00.000Z" });
  await done("current", "2026-10-11T15:00:00.000Z");
  await done("someone-else", "2026-10-11T15:00:00.000Z", { customer_id: "6b0d6f0e-1c11-4c7a-9a01-000000000102" });

  const rows = await store.priorInteractions(TOBIAS, "current", 3);
  assertEquals(rows.map((r) => r.vapi_call_id), ["b", "d", "c"]);
  assertEquals(rows[0], { vapi_call_id: "b", started_at: "2026-10-05T15:00:00.000Z", summary: "summary b" });
  const all = await store.priorInteractions(TOBIAS, "current", 10);
  assertEquals(all.map((r) => r.vapi_call_id), ["b", "d", "c", "a", "no-start"]);
});

Deno.test("getCustomer never returns the date of birth; getClaims orders by filed_on then claim_number", async () => {
  const store = createFakeStore();
  const c = await store.getCustomer(TOBIAS);
  assert(c);
  assertFalse("date_of_birth" in c);
  assertEquals(c.first_name, "Tobias");
  assertEquals(c.email, "owner@example.com");
  assertEquals(await store.getCustomer("6b0d6f0e-1c11-4c7a-9a01-000000000999"), null);
  await assertRejects(() => store.getCustomer("not-a-uuid"));

  const claims = await store.getClaims(TOBIAS);
  assertEquals(claims.map((x) => x.claim_number), ["CLM-240115", "CLM-240198"]);
  claims[0].status = "denied"; // callers get copies
  assertEquals((await store.getClaims(TOBIAS))[0].status, "payment_issued");
  assertEquals(await store.getClaims("6b0d6f0e-1c11-4c7a-9a01-000000000105"), []);
});

Deno.test("an explicit seed replaces the demo data", async () => {
  const store = createFakeStore({ customers: [] });
  assertEquals(store.customers.length, 0);
  assertEquals(store.claims.length, 0);
  assertEquals((await lookup(store, "c1", "t1", TOBIAS_PHONE)).code, "not_found");
});

Deno.test("failNext makes exactly the next call of that method reject", async () => {
  const store = createFakeStore();
  store.failNext("getSession");
  store.failNext("lookupCustomerAttempt");
  await assertRejects(() => store.getSession("c1"), Error, "getSession");
  assertEquals(await store.getSession("c1"), null);
  await assertRejects(() => lookup(store, "c1", "t1", TOBIAS_PHONE));
  // the failed call wrote nothing
  assertEquals(store.tables.attempts.length, 0);
  assertEquals((await lookup(store, "c1", "t1", TOBIAS_PHONE)).code, "needs_dob");
});

Deno.test("captureWebhook stores a copy of the body", async () => {
  const store = createFakeStore();
  const body = { message: { type: "status-update", status: "in-progress" } };
  await store.captureWebhook("status-update", "c1", body);
  body.message.status = "ended";
  assertEquals(store.tables.webhook_captures[0].body.message.status, "in-progress");
  assertEquals(store.tables.webhook_captures[0].message_type, "status-update");
});

Deno.test("captureWebhook keeps seven days of captures, whether or not a job runs", async () => {
  const store = createFakeStore();
  const day = 24 * 60 * 60 * 1000;
  store.tables.webhook_captures.push(
    {
      id: 101,
      message_type: "status-update",
      call_key: "old",
      body: {},
      received_at: new Date(Date.now() - 8 * day).toISOString(),
    },
    {
      id: 102,
      message_type: "status-update",
      call_key: "recent",
      body: {},
      received_at: new Date(Date.now() - 6 * day).toISOString(),
    },
  );
  await store.captureWebhook("status-update", "c1", { message: { type: "status-update" } });
  assertEquals(store.tables.webhook_captures.map((c) => c.call_key), ["recent", "c1"]);
});

Deno.test("demoSeed mirrors 0002_seed.sql row for row", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/0002_seed.sql", import.meta.url));
  const seed = demoSeed();
  assertEquals(seed.customers.length, (sql.match(/'\+1602555\d{4}'/g) ?? []).length);
  for (const c of seed.customers) {
    const tuple =
      `('${c.id}', '${c.phone_e164}', '${c.first_name}', '${c.last_name}', '${c.date_of_birth}', '${c.policy_number}')`;
    assert(sql.includes(tuple), `customer ${c.first_name} differs from the SQL seed`);
    assertEquals(c.email, c.first_name === "Teague" ? null : "owner@example.com");
  }
  assertEquals(seed.claims.length, (sql.match(/'CLM-\d{6}'/g) ?? []).length);
  for (const k of seed.claims) {
    assert(
      sql.includes(`('${k.customer_id}', '${k.claim_number}', '${k.claim_type}', '${k.status}',`),
      `claim ${k.claim_number} differs from the SQL seed`,
    );
    for (const s of [k.status_detail, k.adjuster_name, k.filed_on, k.updated_on, k.documents_due]) {
      if (s !== null) assert(sql.includes(`'${s}'`), `claim ${k.claim_number}: ${s} not in the SQL seed`);
    }
    for (const d of k.documents_required) {
      assert(sql.includes(`"${d}"`), `claim ${k.claim_number}: ${d}`);
    }
    if (k.amount_approved !== null) assert(sql.includes(k.amount_approved.toFixed(2)));
  }
  // Ines has no claims (no_claims branch) and nobody owns the not-found number
  assertFalse(seed.claims.some((k) => k.customer_id.endsWith("105")));
  assertFalse(seed.customers.some((c) => c.phone_e164 === NOBODY_PHONE));
});

// ---------------------------------------------------------------------------------------------
// Outbox (0005_outbox.sql), job runs and the scheduled jobs' reads (0001, 0004). The same
// sequences run against the live database in scripts/db_suite.ts.
// ---------------------------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A fake store on a clock the test moves, as the outbox lease is measured in time. */
function clockedStore(start = "2026-10-12T15:00:00.000Z") {
  let t = Date.parse(start);
  const store = createFakeStore(undefined, { now: () => new Date(t) });
  return {
    store,
    advance: (ms: number) => {
      t += ms;
    },
    at: (iso: string) => {
      t = Date.parse(iso);
    },
  };
}

Deno.test("outbox: one row per (kind, ref_id, destination); enqueue again re-arms it with a fresh budget", async () => {
  const { store, advance } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1");
  await store.enqueueOutbox("interaction.completed", "c1", "airtable");
  assertEquals(store.tables.outbox_events.length, 1);
  const row = store.tables.outbox_events[0];
  assertEquals(
    [row.kind, row.destination, row.attempts, row.delivered_at, row.last_error, row.external_id],
    ["interaction.completed", "airtable", 0, null, null, null],
  );
  advance(OUTBOX_LEASE_MS + 1000); // the second enqueue was a write: the row sits out the lease first
  const [claimed] = await store.claimOutbox(1);
  assert(await store.finishOutbox(claimed.id, { delivered: true, externalId: "rec1" }));
  const createdAt = row.created_at;
  await store.enqueueOutbox("interaction.completed", "c1");
  assertEquals([row.delivered_at, row.attempts, row.last_error], [null, 0, null]);
  assertEquals([row.external_id, row.created_at], ["rec1", createdAt], "the record id and queue position stay");
  await assertRejects(() => store.enqueueOutbox("escalation.created" as never, "c1"), Error, "23514");
  await assertRejects(() => store.enqueueOutbox("interaction.completed", "c1", "sheets" as never), Error, "23514");
});

Deno.test("outbox: a claim takes the oldest due rows, bumps attempts, and never a delivered or spent row", async () => {
  const { store, advance } = clockedStore();
  // inserted in reverse, a second apart, so the queue order is created_at and not insertion order
  for (const k of ["c4", "c3", "c2", "c1"]) {
    await store.enqueueOutbox("interaction.completed", k);
    advance(-1000);
  }
  advance(4000);
  const [c4, c3, c2, c1] = store.tables.outbox_events;
  assert(c1.created_at < c2.created_at && c2.created_at < c3.created_at && c3.created_at < c4.created_at);
  c1.delivered_at = isoAgo(500);
  c2.attempts = 5;
  const first = await store.claimOutbox(1);
  assertEquals(first.map((r) => [r.ref_id, r.attempts]), [["c3", 1]]);
  assertEquals(
    (await store.claimOutbox(0)).map((r) => [r.ref_id, r.attempts]),
    [["c4", 1]],
    "limit is at least one, and the row just claimed is passed over",
  );
  assertEquals(await store.claimOutbox(20), [], "every due row is inside its lease");
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals((await store.claimOutbox(20)).map((r) => [r.ref_id, r.attempts]), [["c3", 2], ["c4", 2]]);
  c3.attempts = 4;
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals((await store.claimOutbox(20)).map((r) => [r.ref_id, r.attempts]), [["c3", 5], ["c4", 3]]);
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals((await store.claimOutbox(20)).map((r) => r.ref_id), ["c4"], "a row at five attempts is never claimed");
  await assertRejects(() => store.claimOutbox(1.5), Error, "22P02");
});

Deno.test("outbox lease: a fresh row is claimable at once; any write (claim, failure, re-arm) holds it for the lease", async () => {
  const { store, advance, at } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1");
  const row = store.tables.outbox_events[0];
  assertEquals(row.created_at, row.updated_at, "never written since its insert");

  const [claimed] = await store.claimOutbox(1);
  assertEquals([claimed.attempts, claimed.updated_at], [1, row.updated_at], "the claim returns its own write time");
  assert(claimed.updated_at > claimed.created_at);
  at(new Date(Date.parse(claimed.updated_at) + OUTBOX_LEASE_MS).toISOString());
  assertEquals(await store.claimOutbox(1), [], "in flight for the whole lease: nobody else may take it");
  advance(1);
  const [again] = await store.claimOutbox(1);
  assertEquals(again.attempts, 2, "a delivery that never finished is retried once the lease is over");

  // a failed delivery backs off for the lease
  assert(
    await store.finishOutbox(again.id, {
      delivered: false,
      error: "airtable 503",
      attempt: 2,
      claimedAt: again.updated_at,
    }),
  );
  assertEquals(await store.claimOutbox(1), []);
  advance(OUTBOX_LEASE_MS + 1000);
  const [third] = await store.claimOutbox(1);
  assertEquals(third.attempts, 3);

  // a re-arm while that delivery is in flight holds the row too: the stale request finishes first
  await store.enqueueOutbox("interaction.completed", "c1");
  assertEquals(row.attempts, 0);
  assertEquals(await store.claimOutbox(1), []);
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals((await store.claimOutbox(1)).map((r) => r.attempts), [1]);
});

Deno.test("outbox: a claim for one call's row takes only that row", async () => {
  const { store, advance } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "backlog");
  advance(1000);
  await store.enqueueOutbox("interaction.completed", "c2");
  const ref: OutboxRef = { kind: "interaction.completed", refId: "c2", destination: "airtable" };
  assertEquals((await store.claimOutbox(5, ref)).map((r) => [r.ref_id, r.attempts]), [["c2", 1]]);
  assertEquals(await store.claimOutbox(5, ref), [], "its own row inside the lease is not taken again");
  assertEquals(await store.claimOutbox(5, { ...ref, refId: "no-such-call" }), []);
  assertEquals(store.tables.outbox_events.map((o) => [o.ref_id, o.attempts]), [["backlog", 0], ["c2", 1]]);
});

Deno.test("outbox: finishing records delivery, or a masked capped error; dead spends the budget; the attempt guards", async () => {
  const { store, advance } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1");
  const row = store.tables.outbox_events[0];
  let [claimed] = await store.claimOutbox(1);

  const long = `airtable 422: Cannot parse value for account 98765432101 near +1 602 555 0101 ${"x".repeat(400)}`;
  assert(await store.finishOutbox(claimed.id, { delivered: false, error: long }));
  assertEquals([row.attempts, row.delivered_at], [1, null]);
  assertEquals(row.last_error.length, 300);
  assert(row.last_error.startsWith("airtable 422: Cannot parse value for account [digits] near [phone ending 0101]"));
  await store.finishOutbox(claimed.id, { delivered: false });
  assertEquals(row.last_error, "delivery failed");

  // a delivery that started before a re-arm cannot mark the newer version done
  await store.enqueueOutbox("interaction.completed", "c1");
  assertFalse(await store.finishOutbox(claimed.id, { delivered: true, externalId: "rec1", attempt: claimed.attempts }));
  assertEquals([row.delivered_at, row.attempts], [null, 0]);
  // not even once a new claim has brought attempts back to the value it saw: the write time differs
  const stale = claimed;
  advance(OUTBOX_LEASE_MS + 1000);
  [claimed] = await store.claimOutbox(1);
  assertEquals(claimed.attempts, stale.attempts, "attempts repeat after a re-arm");
  const staleFinish = { delivered: true, externalId: "rec0", attempt: stale.attempts, claimedAt: stale.updated_at };
  assertFalse(await store.finishOutbox(stale.id, staleFinish));
  assertEquals([row.delivered_at, row.external_id], [null, null]);
  assert(
    await store.finishOutbox(claimed.id, {
      delivered: true,
      externalId: "rec1",
      attempt: claimed.attempts,
      claimedAt: claimed.updated_at,
    }),
  );
  assertEquals([row.external_id, row.last_error], ["rec1", null]);
  assert(row.delivered_at);
  await store.finishOutbox(claimed.id, { delivered: true });
  assertEquals(row.external_id, "rec1", "a delivery without a record id keeps the stored one");

  // a refund (the destination refused every request) gives the claim's attempt back
  await store.enqueueOutbox("interaction.completed", "c1");
  advance(OUTBOX_LEASE_MS + 1000);
  [claimed] = await store.claimOutbox(1);
  assertEquals(row.attempts, 1);
  const refund = { delivered: false, error: "airtable 401: bad token", refund: true, attempt: 1 };
  assert(await store.finishOutbox(claimed.id, { ...refund, claimedAt: claimed.updated_at }));
  assertEquals([row.attempts, row.last_error, row.delivered_at], [0, "airtable 401: bad token", null]);
  assertFalse(await store.finishOutbox(claimed.id, { ...refund, claimedAt: claimed.updated_at }), "once per claim");
  assertEquals(row.attempts, 0);

  await store.enqueueOutbox("interaction.completed", "c1");
  advance(OUTBOX_LEASE_MS + 1000);
  [claimed] = await store.claimOutbox(1);
  await store.finishOutbox(claimed.id, { delivered: false, error: "airtable 401: bad token", dead: true });
  assertEquals([row.attempts, row.last_error, row.delivered_at], [5, "airtable 401: bad token", null]);
  assertEquals(await store.claimOutbox(1), []);

  assertFalse(await store.finishOutbox(crypto.randomUUID(), { delivered: true }));
  await assertRejects(() => store.finishOutbox("not-a-uuid", { delivered: true }), Error, "22P02");
});

Deno.test("outbox (0008): a delay sets next_attempt_at and a claim waits for it; a re-arm moves it and keeps progress", async () => {
  const { store, advance } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1", "ghl", 90);
  const row = store.tables.outbox_events[0];
  assertEquals([row.destination, row.progress, row.next_attempt_at], ["ghl", {}, "2026-10-12T15:01:30.000Z"]);
  assertEquals(await store.claimOutbox(5), [], "not before next_attempt_at");
  advance(89_000);
  assertEquals(await store.claimOutbox(5), []);
  advance(1000);
  const [claimed] = await store.claimOutbox(5);
  assertEquals(
    [claimed.ref_id, claimed.attempts, claimed.next_attempt_at, claimed.progress],
    ["c1", 1, "2026-10-12T15:01:30.000Z", {}],
  );
  // a step's result lands in progress, then the delivery finishes under the save's write time
  const guard = { attempt: 1, claimedAt: claimed.updated_at };
  const saved = await store.saveOutboxProgress(claimed.id, { contact_id: "ct1", note_id: "n1" }, guard);
  assert(saved?.held);
  assertFalse(await store.finishOutbox(claimed.id, { delivered: true, ...guard }), "the claim's own time is stale now");
  assert(
    await store.finishOutbox(claimed.id, { delivered: true, externalId: "ct1", attempt: 1, claimedAt: saved.savedAt }),
  );
  // a re-arm resets the delivery and moves the wait, and keeps what the steps did
  await store.enqueueOutbox("interaction.completed", "c1", "ghl", 90);
  assertEquals(
    [row.delivered_at, row.attempts, row.external_id, row.progress],
    [null, 0, "ct1", { contact_id: "ct1", note_id: "n1" }],
  );
  assertEquals(Date.parse(row.next_attempt_at) - Date.parse(row.updated_at), 90_000);
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals(await store.claimOutbox(5), [], "the lease is over but the wait is not");
  advance(60_000);
  assertEquals((await store.claimOutbox(5)).map((r) => r.progress), [{ contact_id: "ct1", note_id: "n1" }]);
  await assertRejects(() => store.enqueueOutbox("interaction.completed", "c2", "ghl", 1.5), Error, "22P02");
  await assertRejects(() => store.enqueueOutbox("interaction.completed", "c2", "sheets" as never), Error, "23514");
});

Deno.test("outbox (0008): a claim takes only its destination's rows (a ref names its own); without one, any", async () => {
  const { store, advance } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1", "airtable");
  advance(1000);
  await store.enqueueOutbox("interaction.completed", "c1", "ghl");
  advance(1000);
  await store.enqueueOutbox("interaction.completed", "c2", "ghl");
  assertEquals(
    (await store.claimOutbox(5, undefined, "ghl")).map((r) => [r.ref_id, r.destination]),
    [["c1", "ghl"], ["c2", "ghl"]],
  );
  assertEquals(await store.claimOutbox(5, undefined, "ghl"), []);
  const ref: OutboxRef = { kind: "interaction.completed", refId: "c1", destination: "airtable" };
  assertEquals((await store.claimOutbox(5, ref, "ghl")).map((r) => r.destination), ["airtable"], "the ref decides");
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals((await store.claimOutbox(5)).map((r) => r.destination), ["airtable", "ghl", "ghl"]);
});

Deno.test("outbox (0008): saveOutboxProgress always merges; held says whether the claim still holds", async () => {
  const { store } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1", "ghl");
  const row = store.tables.outbox_events[0];
  const [claimed] = await store.claimOutbox(1);
  const claim = { attempt: 1, claimedAt: claimed.updated_at };
  const first = await store.saveOutboxProgress(claimed.id, { contact_id: "ct1", tags_done: true }, claim);
  assert(first?.held);
  assert(first.savedAt > claimed.updated_at, "a save is a write: its time is the next guard");
  // the claim's own time no longer holds, yet what the step did is still recorded
  const stale = await store.saveOutboxProgress(claimed.id, { x: 1 }, claim);
  assertEquals([stale?.held, row.progress.x], [false, 1]);
  // a shallow merge: null clears a value, other keys stay
  const third = await store.saveOutboxProgress(claimed.id, { contact_id: null, note_id: "n1" }, {
    attempt: 1,
    claimedAt: stale!.savedAt,
  });
  assert(third?.held);
  assertEquals(row.progress, { contact_id: null, tags_done: true, x: 1, note_id: "n1" });
  // a re-arm mid-delivery: the merge lands (the note exists whoever holds the row), the claim is gone
  await store.enqueueOutbox("interaction.completed", "c1", "ghl");
  const after = await store.saveOutboxProgress(claimed.id, {
    task_claim_id: "t1",
  }, { attempt: 1, claimedAt: third.savedAt });
  assertEquals([after?.held, row.progress.task_claim_id], [false, "t1"]);
  assertEquals(await store.saveOutboxProgress(crypto.randomUUID(), {}, claim), null);
  await assertRejects(() => store.saveOutboxProgress("not-a-uuid", {}, claim), Error, "22P02");
  await assertRejects(() => store.saveOutboxProgress(claimed.id, [] as never, claim), Error, "23514");
  await assertRejects(
    () => store.saveOutboxProgress(claimed.id, {}, { attempt: 1, claimedAt: "soon" }),
    Error,
    "22007",
  );
});

Deno.test("outbox (0008): retryAfterS keeps a failed row unclaimed until then; a dead row ignores it", async () => {
  const { store, advance } = clockedStore();
  await store.enqueueOutbox("interaction.completed", "c1", "ghl");
  const row = store.tables.outbox_events[0];
  let [claimed] = await store.claimOutbox(1);
  assert(
    await store.finishOutbox(claimed.id, {
      delivered: false,
      error: "ghl 429 POST /contacts/search: Too many requests",
      retryAfterS: 120,
      attempt: 1,
      claimedAt: claimed.updated_at,
    }),
  );
  assertEquals(row.next_attempt_at, "2026-10-12T15:02:00.000Z");
  advance(OUTBOX_LEASE_MS + 1000);
  assertEquals(await store.claimOutbox(1), [], "past the lease, before the retry-after");
  advance(120_000);
  [claimed] = await store.claimOutbox(1);
  assertEquals(claimed.attempts, 2);
  const before = row.next_attempt_at;
  await store.finishOutbox(claimed.id, { delivered: false, error: "ghl 422", dead: true, retryAfterS: 60 });
  assertEquals([row.next_attempt_at, row.attempts], [before, 5]);
});

Deno.test("outboxDue: a row inserted with no delay is due whatever the clock; otherwise next_attempt_at decides", () => {
  const at = "2026-10-12T15:00:00.000Z";
  const base = { delivered_at: null, attempts: 0, created_at: at, updated_at: at };
  const t = Date.parse(at);
  assert(outboxDue({ ...base, next_attempt_at: at }, t - 5000), "the caller's clock behind the database's");
  assertFalse(outboxDue({ ...base, next_attempt_at: "2026-10-12T15:01:30.000Z" }, t + 89_999));
  assert(outboxDue({ ...base, next_attempt_at: "2026-10-12T15:01:30.000Z" }, t + 90_000));
  assert(outboxDue(base, t), "a row read without the column (before 0008) is due");
  assertFalse(outboxClaimable({ ...base, next_attempt_at: "2026-10-12T15:01:30.000Z" }, t), "fresh, but not due");
  assert(outboxClaimable({ ...base, next_attempt_at: at }, t));
});

Deno.test("getInteractionForMirror: exactly the mirror columns, or null", async () => {
  const store = createFakeStore();
  assertEquals(await store.getInteractionForMirror("c1"), null);
  await store.upsertInteraction({
    vapi_call_id: "c1",
    caller_phone: "+16025550101",
    summary: "s",
    ended_at: "2026-10-12T15:02:00Z",
    transcript: "AI: hi",
    flags: ["tool_markup_spoken"],
    cost: 0.25,
  });
  const row = await store.getInteractionForMirror("c1");
  assert(row);
  assertEquals(Object.keys(row).sort(), [
    "analysis_status",
    "call_reason",
    "caller_email",
    "caller_name",
    "caller_phone",
    "caller_type",
    "channel",
    "claim_number",
    "cost",
    "duration_seconds",
    "emergency",
    "ended_at",
    "escalated",
    "flags",
    "outcome",
    "sentiment",
    "started_at",
    "summary",
    "vapi_call_id",
  ]);
  assertEquals([row.flags, row.cost, row.ended_at], [["tool_markup_spoken"], 0.25, "2026-10-12T15:02:00Z"]);
  row.flags!.push("x");
  assertEquals(store.tables.call_interactions[0].flags, ["tool_markup_spoken"], "a copy, not the stored array");
});

Deno.test("listOutboxGaps: ended in [from, to), with no outbox row or one delivered before the record changed", async () => {
  const store = createFakeStore();
  const call = async (key: string, endedAt: string | null, updatedAt: string) => {
    await store.ensureInteraction({ vapi_call_id: key, outcome: "in_progress" });
    Object.assign(store.tables.call_interactions.at(-1)!, { ended_at: endedAt, updated_at: updatedAt });
  };
  const from = "2026-10-10T12:00:00.000Z";
  const to = "2026-10-12T12:00:00.000Z";
  await call("never-queued", "2026-10-11T10:00:00.000Z", "2026-10-11T10:01:00.000Z");
  await call("changed-after", "2026-10-11T09:00:00.000Z", "2026-10-11T11:00:00.000Z");
  await call("current", "2026-10-11T08:00:00.000Z", "2026-10-11T08:01:00.000Z");
  await call("pending", "2026-10-11T07:00:00.000Z", "2026-10-11T07:01:00.000Z");
  await call("open", null, "2026-10-11T07:00:00.000Z");
  await call("early", "2026-10-10T11:59:59.000Z", "2026-10-10T11:59:59.000Z");
  await call("late", to, to); // to is exclusive
  for (const k of ["changed-after", "current", "pending", "early", "late"]) {
    await store.enqueueOutbox("interaction.completed", k);
  }
  const queued = (k: string) => store.tables.outbox_events.find((o) => o.ref_id === k)!;
  queued("changed-after").delivered_at = "2026-10-11T10:30:00.000Z";
  queued("current").delivered_at = "2026-10-11T08:30:00.000Z";
  assertEquals(await store.listOutboxGaps(from, to), ["changed-after", "never-queued"], "oldest end first");
  await assertRejects(() => store.listOutboxGaps("yesterday", to), Error, "22007");
  // GoHighLevel: only a call with no ghl row at all (a delivered one is never posted again)
  for (const k of ["changed-after", "current"]) await store.enqueueOutbox("interaction.completed", k, "ghl", 90);
  const ghl = (k: string) => store.tables.outbox_events.find((o) => o.ref_id === k && o.destination === "ghl")!;
  ghl("changed-after").delivered_at = "2026-10-11T10:30:00.000Z";
  assertEquals(await store.listOutboxGaps(from, to, "ghl"), ["pending", "never-queued"]);
});

Deno.test("interactionEnded: true only for a row with ended_at", async () => {
  const store = createFakeStore();
  await store.ensureInteraction({ vapi_call_id: "open", outcome: "in_progress" });
  await store.upsertInteraction({ vapi_call_id: "ended", ended_at: "2026-10-12T15:02:00Z", outcome: "resolved" });
  assertEquals(
    [await store.interactionEnded("open"), await store.interactionEnded("ended"), await store.interactionEnded("none")],
    [false, true, false],
  );
});

Deno.test("job runs: claimed once per (job, period); finishing records the result", async () => {
  const store = createFakeStore();
  assert(await store.claimJobRun("digest", "2026-10-12"));
  assertFalse(await store.claimJobRun("digest", "2026-10-12"));
  assert(await store.claimJobRun("digest", "2026-10-13"));
  assert(await store.claimJobRun("sla", "2026-10-12"));
  const result = { calls: 3 };
  await store.finishJobRun("digest", "2026-10-12", result);
  result.calls = 4;
  const run = store.tables.job_runs[0];
  assertEquals([run.result, typeof run.finished_at], [{ calls: 3 }, "string"]);
  assertEquals(store.tables.job_runs[1].finished_at, null);

  // a release gives back only an unfinished run of that period
  await store.releaseJobRun("digest", "2026-10-12");
  await store.releaseJobRun("digest", "2026-10-13");
  assertEquals(store.tables.job_runs.map((r) => [r.job, r.period_key]), [["digest", "2026-10-12"], [
    "sla",
    "2026-10-12",
  ]]);
  assert(await store.claimJobRun("digest", "2026-10-13"), "a released period can be claimed again");
  assertFalse(await store.claimJobRun("digest", "2026-10-12"), "a finished one cannot");
});

Deno.test("stale escalations: open, before the cutoff, never re-alerted, not chat; oldest first; marked once", async () => {
  const store = createFakeStore();
  const add = async (callKey: string, minutesAgo: number, extra: Record<string, unknown> = {}) => {
    await store.upsertEscalation({
      callKey,
      kind: "representative",
      reason: "representative_requested",
      details: null,
      callbackPhone: null,
      callbackSource: "none",
      channel: (extra.channel as string) ?? "webCall",
      verified: false,
    });
    const row = store.tables.escalations.at(-1)!;
    Object.assign(row, { created_at: isoAgo(minutesAgo * 60_000), ...extra });
    return row;
  };
  await add("newer", 40);
  await add("older", 50);
  await add("fresh", 10);
  await add("claimed", 50, { status: "claimed" });
  await add("done", 50, { status: "done" });
  await add("chat", 50, { channel: "chat" });
  const marked = await add("marked", 50, { realerted_at: isoAgo(60_000) });
  const cutoff = isoAgo(30 * 60_000);
  const stale = await store.listStaleEscalations(cutoff);
  assertEquals(stale.map((s) => s.call_key), ["older", "newer"]);
  assertEquals(Object.keys(stale[0]).sort(), ["call_key", "channel", "created_at", "id", "kind", "reason", "verified"]);

  assert(await store.markRealerted(stale[0].id));
  const first = store.tables.escalations.find((e) => e.call_key === "older")!.realerted_at;
  assert(first);
  assertFalse(await store.markRealerted(stale[0].id));
  assertEquals(store.tables.escalations.find((e) => e.call_key === "older")!.realerted_at, first, "set once");
  const markedAt = marked.realerted_at;
  assertFalse(await store.markRealerted(marked.id));
  assertEquals(marked.realerted_at, markedAt);
  // a row staff claimed after the list is not marked, so it is never paged
  const claimedRow = store.tables.escalations.find((e) => e.call_key === "claimed")!;
  assertFalse(await store.markRealerted(claimedRow.id));
  assertEquals(claimedRow.realerted_at, null);
  assertEquals((await store.listStaleEscalations(cutoff)).map((s) => s.call_key), ["newer"]);
  await assertRejects(() => store.listStaleEscalations("yesterday"), Error, "22007");
  await assertRejects(() => store.markRealerted("not-a-uuid"), Error, "22P02");
});

Deno.test("stale escalations and stuck calls: one run takes at most 50, oldest first", async () => {
  const store = createFakeStore();
  for (let i = 0; i < 55; i++) {
    await store.upsertEscalation({
      callKey: `k${i}`,
      kind: "emergency",
      reason: "emergency",
      details: null,
      callbackPhone: null,
      callbackSource: "none",
      channel: "webCall",
      verified: false,
    });
    store.tables.escalations[i].created_at = isoAgo((100 + i) * 60_000);
    await store.ensureInteraction({ vapi_call_id: `k${i}`, outcome: "in_progress" });
    store.tables.call_interactions[i].created_at = isoAgo((200 + i) * 60_000);
  }
  const stale = await store.listStaleEscalations(isoAgo(30 * 60_000));
  assertEquals([stale.length, stale[0].call_key], [50, "k54"]);
  const stuck = await store.listStuckInteractions(isoAgo(2 * 60 * 60_000));
  assertEquals([stuck.length, stuck[0].vapi_call_id], [50, "k54"]);
});

Deno.test("digestStats: rows created in [from, to); outcomes and sentiments in enum order; every escalation status", async () => {
  const store = createFakeStore();
  const from = "2026-10-11T12:00:00.000Z";
  const to = "2026-10-12T12:00:00.000Z";
  const call = async (key: string, created: string, p: Record<string, unknown>) => {
    await store.ensureInteraction({ vapi_call_id: key, outcome: "in_progress" });
    Object.assign(store.tables.call_interactions.at(-1)!, { created_at: created, ...p });
  };
  await call("c1", from, { outcome: "resolved", sentiment: "positive", cost: 0.1234, ended_at: to });
  await call("c2", "2026-10-11T20:00:00Z", {
    outcome: "escalated",
    sentiment: "negative",
    cost: "0.5000",
    ended_at: to,
    flags: ["promised_callback_without_escalation"],
  });
  await call("c3", "2026-10-12T11:59:59Z", { outcome: "resolved", sentiment: null, cost: null });
  await call("c4", "2026-10-11T18:00:00Z", { outcome: null, sentiment: "neutral", cost: 0.0001, ended_at: to });
  await call("late", to, { outcome: "abandoned" }); // to is exclusive
  await call("early", "2026-10-11T11:59:59Z", { outcome: "abandoned" });
  await store.upsertEscalation({
    callKey: "c2",
    kind: "representative",
    reason: "representative_requested",
    details: null,
    callbackPhone: null,
    callbackSource: "none",
    channel: "webCall",
    verified: false,
  });
  Object.assign(store.tables.escalations[0], { created_at: "2026-10-11T20:01:00Z", status: "done" });
  store.tables.emails.push(
    { call_key: "c1", kind: "claim_summary", status: "sent", created_at: "2026-10-11T13:00:00Z" },
    { call_key: "c2", kind: "callback_request", status: "failed", created_at: "2026-10-11T20:01:00Z" },
    { call_key: "early", kind: "claim_summary", status: "sent", created_at: "2026-10-11T11:00:00Z" },
  );
  const stats = await store.digestStats(from, to);
  assertEquals(stats, {
    calls: 4,
    completed: 3,
    outcomes: { resolved: 2, escalated: 1, unknown: 1 },
    sentiments: { positive: 1, neutral: 1, negative: 1, unknown: 1 },
    flagged: 1,
    escalations: { open: 0, claimed: 0, done: 1 },
    emails_sent: 1,
    total_cost: 0.6235,
  });
  assertEquals(Object.keys(stats.outcomes), ["resolved", "escalated", "unknown"]);
  assertEquals(await store.digestStats("2001-01-01T00:00:00Z", "2001-01-02T00:00:00Z"), {
    calls: 0,
    completed: 0,
    outcomes: {},
    sentiments: {},
    flagged: 0,
    escalations: { open: 0, claimed: 0, done: 0 },
    emails_sent: 0,
    total_cost: 0,
  });
  await assertRejects(() => store.digestStats("not a time", to), Error, "22007");
});

Deno.test("reapInteraction: closes only a row that never ended; keeps an ended_reason already there", async () => {
  const store = createFakeStore();
  await store.ensureInteraction({ vapi_call_id: "stub", channel: "webCall", outcome: "in_progress" });
  await store.ensureInteraction({ vapi_call_id: "errored", outcome: "in_progress", ended_reason: "pipeline-error" });
  await store.upsertInteraction({
    vapi_call_id: "done",
    caller_name: "A",
    summary: "s",
    sentiment: "neutral",
    started_at: "2026-10-12T15:00:00Z",
    ended_at: "2026-10-12T15:02:00Z",
    outcome: "resolved",
    analysis_status: "ok",
  });
  for (const r of store.tables.call_interactions) {
    r.created_at = isoAgo(3 * 60 * 60_000);
  }
  assertEquals(
    (await store.listStuckInteractions(isoAgo(2 * 60 * 60_000))).map((r) => r.vapi_call_id),
    ["stub", "errored"],
  );
  const done = structuredClone(store.tables.call_interactions[2]);

  assert(await store.reapInteraction("stub"));
  assert(await store.reapInteraction("errored"));
  assertFalse(await store.reapInteraction("done"));
  assertFalse(await store.reapInteraction("stub"), "a second reap finds nothing to close");
  assertFalse(await store.reapInteraction("no-such-call"));

  const [stub, errored, after] = store.tables.call_interactions;
  assertEquals([stub.outcome, stub.analysis_status, stub.ended_reason, stub.status], [
    "abandoned",
    "missing",
    "reaped",
    "incomplete",
  ]);
  assert(stub.ended_at);
  assertEquals(errored.ended_reason, "pipeline-error");
  assertEquals(after, done, "a completed row is never touched");
  assertEquals(await store.listStuckInteractions(isoAgo(2 * 60 * 60_000)), []);
});

Deno.test("retention: every live line older than the cutoff, whatever became of its call, and old captures, are deleted", async () => {
  const store = createFakeStore();
  await store.ensureInteraction({ vapi_call_id: "open", outcome: "in_progress" });
  await store.upsertInteraction({ vapi_call_id: "ended", ended_at: "2026-10-01T15:02:00Z", outcome: "resolved" });
  let id = 0;
  const line = (call_key: string, ageMs: number) =>
    store.tables.transcript_lines.push({
      id: ++id,
      call_key,
      role: "assistant",
      text: "Hello.",
      ts_ms: id,
      created_at: isoAgo(ageMs),
    });
  line("orphan", 8 * DAY);
  line("open", 8 * DAY);
  line("ended", 8 * DAY); // a line VAPI delivered after the report, or one a failed clear left
  line("orphan", 6 * DAY);
  line("open", 1000);
  const cutoff = isoAgo(7 * DAY);
  assertEquals(await store.deleteOldTranscriptLines(cutoff), 3);
  assertEquals(store.tables.transcript_lines.map((t) => t.id), [4, 5]);
  assertEquals(await store.deleteOldTranscriptLines(cutoff), 0);

  store.tables.webhook_captures.push(
    { id: 1, message_type: null, call_key: null, body: {}, received_at: isoAgo(8 * DAY) },
    { id: 2, message_type: null, call_key: null, body: {}, received_at: isoAgo(6 * DAY) },
  );
  assertEquals(await store.pruneWebhookCaptures(cutoff), 1);
  assertEquals(store.tables.webhook_captures.map((c) => c.id), [2]);
  await assertRejects(() => store.pruneWebhookCaptures(""), Error, "22007");

  for (const [job, age] of [["outbox", 8], ["sla", 8], ["outbox", 6], ["digest", 30]] as const) {
    store.tables.job_runs.push({ job, period_key: `${job}-${age}`, started_at: isoAgo(age * DAY), result: null });
  }
  assertEquals(await store.pruneJobRuns(["sla", "outbox"], cutoff), 2);
  assertEquals(store.tables.job_runs.map((r) => r.period_key), ["outbox-6", "digest-30"]);
  assertEquals(await store.pruneJobRuns([], cutoff), 0);
});

// ---------------------------------------------------------------------------------------------
// caller_contacts and the post-call caller columns (0006_contacts.sql), the same sequences
// db_suite.ts runs against the live database.
// ---------------------------------------------------------------------------------------------
const CONTACT = {
  callKey: "cc1",
  kind: "new_customer" as const,
  firstName: "Jane",
  lastName: "Doe",
  email: "jane.doe@example.com",
  callbackPhone: "+16025550177",
  callbackSource: "argument" as const,
  customerId: null,
};

Deno.test("caller_contacts: inserted unconfirmed; confirm keeps its first time; an identical capture keeps it", async () => {
  let t = Date.parse("2026-10-12T15:00:00Z");
  const store = createFakeStore(undefined, { now: () => new Date(t) });
  assertEquals(await store.getContact("cc1"), null);
  assertEquals(await store.setContactConfirmed("cc1", true), null, "no row: nothing to confirm");

  const first = await store.upsertContact(CONTACT);
  assertEquals(first, {
    call_key: "cc1",
    kind: "new_customer",
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@example.com",
    callback_phone: "+16025550177",
    callback_source: "argument",
    customer_id: null,
    confirmed: false,
    confirmed_at: null,
  });
  const confirmed = await store.setContactConfirmed("cc1", true);
  assertEquals([confirmed?.confirmed, confirmed?.confirmed_at], [true, "2026-10-12T15:00:00.000Z"]);
  t += 60_000;
  assertEquals((await store.setContactConfirmed("cc1", true))?.confirmed_at, "2026-10-12T15:00:00.000Z");

  // the same read-back again (a retried delivery, or the model capturing it twice) stays confirmed
  const again = await store.upsertContact(CONTACT);
  assertEquals([again.confirmed, again.confirmed_at], [true, "2026-10-12T15:00:00.000Z"]);

  // anything read back that changed needs a new yes, the number said and where it came from included
  // (0009): GoHighLevel and the claim intake key on a confirmed row's number
  for (
    const change of [
      { email: "jane.doe2@example.com" },
      { lastName: "Dough" },
      { email: null },
      { callbackPhone: "+16025550222" },
      { callbackPhone: null, callbackSource: "none" as const },
      { callbackSource: "caller_id" as const },
    ]
  ) {
    await store.upsertContact(CONTACT);
    await store.setContactConfirmed("cc1", true);
    const changed = await store.upsertContact({ ...CONTACT, ...change });
    assertEquals([changed.confirmed, changed.confirmed_at], [false, null], JSON.stringify(change));
  }
  const no = await store.setContactConfirmed("cc1", false);
  assertEquals([no?.confirmed, no?.confirmed_at], [false, null]);
  assertEquals(store.tables.caller_contacts.length, 1, "one row per call");
});

Deno.test("caller_contacts rejects what Postgres would reject", async () => {
  const store = createFakeStore();
  const bad: [Partial<typeof CONTACT> & Record<string, unknown>, string][] = [
    [{ kind: "prospect" as never }, "23514"],
    [{ callbackSource: "account" as never }, "23514"],
    [{ firstName: "" }, "23514"],
    [{ lastName: "x".repeat(41) }, "23514"],
    [{ email: "Jane@Example.com" }, "23514"],
    [{ email: "jane@example" }, "23514"],
    [{ callbackPhone: "6025550177" }, "23514"],
    [{ customerId: "not-a-uuid" as never }, "22P02"],
    [{ customerId: "6b0d6f0e-1c11-4c7a-9a01-000000000999" as never }, "23503"],
  ];
  for (const [change, sqlstate] of bad) {
    await assertRejects(() => store.upsertContact({ ...CONTACT, ...change } as typeof CONTACT), Error, sqlstate);
  }
  assertEquals(store.tables.caller_contacts.length, 0);
  // an email_update carries the verified customer
  const update = await store.upsertContact({ ...CONTACT, kind: "email_update", customerId: TOBIAS as never });
  assertEquals([update.kind, update.customer_id], ["email_update", TOBIAS]);
});

Deno.test("upsert_interaction: caller_type replaces unknown and is never downgraded; caller_email is kept", async () => {
  const store = createFakeStore();
  const row = () => store.tables.call_interactions.find((r) => r.vapi_call_id === "ct1")!;
  await store.ensureInteraction({ vapi_call_id: "ct1", outcome: "in_progress" });
  assertEquals([row().caller_type, row().caller_email, row().caller_email_masked], ["unknown", null, null]);

  await store.upsertInteraction({ vapi_call_id: "ct1", caller_type: "new", caller_email: "jane.doe@example.com" });
  assertEquals([row().caller_type, row().caller_email, row().caller_email_masked], [
    "new",
    "jane.doe@example.com",
    "j***@example.com",
  ]);
  // a stub, a partial or an explicit unknown never takes it back
  await store.upsertInteraction({ vapi_call_id: "ct1", outcome: "in_progress" });
  await store.upsertInteraction({ vapi_call_id: "ct1", caller_type: "unknown", caller_email: "" });
  await store.upsertInteraction({ vapi_call_id: "ct1", caller_type: null, caller_email: null });
  assertEquals([row().caller_type, row().caller_email], ["new", "jane.doe@example.com"]);
  // a definite type replaces another
  await store.upsertInteraction({ vapi_call_id: "ct1", caller_type: "existing" });
  assertEquals(row().caller_type, "existing");
  await assertRejects(
    () => store.upsertInteraction({ vapi_call_id: "ct1", caller_type: "prospect" as never }),
    Error,
    "23514",
  );
  // a fresh row with no type is unknown, as the column default and the coalesce make it
  await store.upsertInteraction({ vapi_call_id: "ct2" });
  assertEquals(store.tables.call_interactions.find((r) => r.vapi_call_id === "ct2")?.caller_type, "unknown");
});

// ---------------------------------------------------------------------------------------------
// claim_intakes (0007_fnol_reasons.sql): the same sequences the DB suite runs live.
// ---------------------------------------------------------------------------------------------
const intakeArgs = (callKey: string, over: Record<string, unknown> = {}) => ({
  callKey,
  kind: "claim" as const,
  claimType: "auto" as const,
  lossDate: "2026-10-10",
  summary: "rear-ended",
  description: "Someone rear-ended me at a light.",
  customerId: TOBIAS,
  ...over,
});

Deno.test("claim_intakes: upserted unconfirmed and replaced until filed; filed once; never rewritten or un-filed", async () => {
  const now = new Date("2026-10-13T03:30:00Z"); // still October 12 in New York
  const store = createFakeStore(undefined, { now: () => now, random: () => 0.0700005 });
  assertEquals(await store.getClaimIntake("c1"), null);
  assertEquals(await store.fileClaimIntake("c1"), null);
  assertEquals(await store.rejectClaimIntake("c1"), null);

  const first = await store.upsertClaimIntake(intakeArgs("c1"));
  assertEquals([first.confirmed, first.claim_number, first.kind], [false, null, "claim"]);
  const replaced = await store.upsertClaimIntake(intakeArgs("c1", { claimType: "home", lossDate: "2026-10-09" }));
  assertEquals([replaced.claim_type, replaced.loss_date], ["home", "2026-10-09"]);
  assertEquals(store.tables.claim_intakes.length, 1);
  assertEquals((await store.rejectClaimIntake("c1"))?.confirmed, false);

  const once = await store.fileClaimIntake("c1");
  assertEquals(once?.filedNow, true, "this call filed it");
  const filed = once?.intake;
  assertEquals([filed?.confirmed, filed?.claim_number, filed?.confirmed_at], [true, "CLM-070000", now.toISOString()]);
  const claim = store.claims.find((c) => c.claim_number === "CLM-070000") as unknown as Record<string, unknown>;
  assertEquals(
    [claim.customer_id, claim.claim_type, claim.status, claim.filed_on, claim.updated_on, claim.reported_call_key],
    [TOBIAS, "home", "received", "2026-10-12", "2026-10-12", "c1"],
  );
  assertEquals(claim.documents_required, [
    "photos of the damage",
    "a contractor estimate",
    "proof of ownership for the damaged items",
  ]);
  assertEquals(filed?.claim_id, claim.id);

  // a second file, a new upsert and a reject all leave the filed intake exactly as it is; the second
  // file says it did not file (file_claim_intake_once's filed_now)
  assertEquals(await store.fileClaimIntake("c1"), { intake: filed!, filedNow: false });
  assertEquals(await store.upsertClaimIntake(intakeArgs("c1", { claimType: "auto" })), filed);
  assertEquals(await store.rejectClaimIntake("c1"), filed);
  assertEquals(store.claims.filter((c) => c.customer_id === TOBIAS).length, 3);
  // the customer's claims read like any other claim (reported_call_key stays behind)
  const read = (await store.getClaims(TOBIAS)).find((c) => c.claim_number === "CLM-070000");
  assertFalse(read !== undefined && "reported_call_key" in read);
});

Deno.test("claim_intakes: the claim number is drawn again when taken, and unique across calls", async () => {
  // the first draw repeats a seeded number's digits (CLM-240115 exists), the second is free
  const draws = [0.2401155, 0.2401155, 0.9999995, 0.5000005];
  const store = createFakeStore(undefined, { random: () => draws.shift() ?? 0.123 });
  store.claims.push({ ...store.claims[0], id: crypto.randomUUID(), claim_number: "CLM-240115" });
  await store.upsertClaimIntake(intakeArgs("c1"));
  await store.upsertClaimIntake(intakeArgs("c2"));
  assertEquals((await store.fileClaimIntake("c1"))?.intake.claim_number, "CLM-999999");
  assertEquals((await store.fileClaimIntake("c2"))?.intake.claim_number, "CLM-500000");

  // when every draw is taken it gives up with an error rather than reuse a number
  const stuck = createFakeStore(undefined, { random: () => 0.2401155 });
  await stuck.upsertClaimIntake(intakeArgs("c3"));
  await assertRejects(() => stuck.fileClaimIntake("c3"), Error, "no unused claim number");
  assertEquals((await stuck.getClaimIntake("c3"))?.confirmed, false);
});

Deno.test("claim_intakes: a lead intake is filed without a claims row; a claim needs its customer", async () => {
  const store = createFakeStore();
  const before = store.claims.length;
  await store.upsertClaimIntake(intakeArgs("lead", { kind: "lead_intake", customerId: null }));
  const lead = (await store.fileClaimIntake("lead"))?.intake;
  assertEquals([lead?.confirmed, lead?.claim_id, lead?.claim_number], [true, null, null]);
  assertEquals(store.claims.length, before);

  await store.upsertClaimIntake(intakeArgs("orphan", { customerId: null }));
  await assertRejects(() => store.fileClaimIntake("orphan"), Error, "23502");
  assertEquals((await store.getClaimIntake("orphan"))?.confirmed, false);
});

Deno.test("claim_intakes rejects what Postgres would reject", async () => {
  const store = createFakeStore();
  const bad: Record<string, unknown>[] = [
    { kind: "lead" },
    { claimType: "boat" },
    { lossDate: "10/10/2026" },
    { lossDate: null },
    { summary: "" },
    { summary: "x".repeat(81) },
    { description: "" },
    { description: "x".repeat(501) },
    { customerId: "not-a-uuid" },
    { customerId: "6b0d6f0e-1c11-4c7a-9a01-000000000999" },
  ];
  for (const over of bad) {
    await assertRejects(
      () => store.upsertClaimIntake(intakeArgs("bad", over) as never),
      Error,
      undefined,
      JSON.stringify(over),
    );
  }
  assertEquals(store.tables.claim_intakes.length, 0);
  // the limits themselves are accepted
  await store.upsertClaimIntake(intakeArgs("ok", { summary: "x".repeat(80), description: "y".repeat(500) }));
});

Deno.test("emails: the two claim kinds are accepted by the ledger", async () => {
  const store = createFakeStore();
  assertEquals(await store.claimEmail("c1", "claim_received", "o***@example.com"), { claimed: true });
  assertEquals(await store.claimEmail("c1", "claim_intake", "t***@example.com"), { claimed: true });
  await assertRejects(() => store.claimEmail("c1", "claim_update" as never, "x"), Error, "23514");
});
