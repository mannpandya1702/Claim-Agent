// The fake must behave like 0001_init.sql, or every test built on it proves the wrong thing. These
// cases walk the same sequences scripts/db_test.ts runs against the live database.

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { createFakeStore, demoSeed } from "./fake_store.ts";
import type { InteractionRow } from "./types.ts";

const TOBIAS = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
const TOBIAS_PHONE = "+16025550101";
const NOBODY_PHONE = "+16025550199";

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

Deno.test("two misses end the lookups for the call; a later hit is still not_found_final", async () => {
  const store = createFakeStore();
  assertEquals(await lookup(store, "c1", "t1", NOBODY_PHONE), { code: "not_found", misses: 1 });
  assertEquals(await lookup(store, "c1", "t2", null), { code: "invalid_phone", misses: 1 });
  assertEquals(await lookup(store, "c1", "t3", "+16025550198"), { code: "not_found_final", misses: 2 });
  assertEquals(await lookup(store, "c1", "t4", TOBIAS_PHONE), { code: "not_found_final", misses: 2 });
  const s = await store.getSession("c1");
  assertEquals(s?.level, "none");
  assertEquals(s?.candidate_customer_id, null);
  assertEquals(kinds(store, "c1"), [
    "lookup_miss:not_found",
    "unreadable:invalid_phone",
    "lookup_miss:not_found_final",
    "other:not_found_final",
  ]);
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
    for (const d of k.documents_required) assert(sql.includes(`"${d}"`), `claim ${k.claim_number}: ${d}`);
    if (k.amount_approved !== null) assert(sql.includes(k.amount_approved.toFixed(2)));
  }
  // Ines has no claims (no_claims branch) and nobody owns the not-found number
  assertFalse(seed.claims.some((k) => k.customer_id.endsWith("105")));
  assertFalse(seed.customers.some((c) => c.phone_e164 === NOBODY_PHONE));
});
