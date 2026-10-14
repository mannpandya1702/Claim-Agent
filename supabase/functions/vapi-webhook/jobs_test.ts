// The scheduled jobs over the in-memory store with a recording fetch and a controllable clock that
// the store shares: one run per period, the sla re-page at most once per row (one email per call),
// one sent digest per Eastern date, the reaper backfilling from VAPI before it abandons, never
// notifying anyone and queueing what the call log is missing, and the outbox's at-least-once
// delivery to Airtable with its lease, attempt cap and deadline. No network.

import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes } from "@std/assert";
import { createFakeStore, type FakeStore } from "./fake_store.ts";
import { isJobName, periodKey, runJob } from "./jobs.ts";
import { deliverOutbox, deliverSoon } from "./outbox.ts";
import { OUTBOX_LEASE_MS } from "./store_rules.ts";
import type { Deps, Env, EscalationRow } from "./types.ts";

const NOW = new Date("2026-10-12T15:04:30Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CALL_A = "5a0c1d2e-0000-4000-8000-0000000000a1";
const CALL_B = "5a0c1d2e-0000-4000-8000-0000000000b2";
const CALL_C = "5a0c1d2e-0000-4000-8000-0000000000c3";
const CALL_D = "5a0c1d2e-0000-4000-8000-0000000000d4";
const CALL_E = "5a0c1d2e-0000-4000-8000-0000000000e5";
const CHAT_F = "5a0c1d2e-0000-4000-8000-0000000000f6";
const TEAM = "claims-team@example.com";
const PRIVATE_KEY = "vapi-private-jobs-test";

const FULL_ENV: Partial<Env> = {
  TELEGRAM_BOT_TOKEN: "123456:jobs-test",
  TELEGRAM_CHAT_ID: "-100200300",
  RESEND_API_KEY: "re_jobs_test",
  CLAIMS_TEAM_EMAIL: TEAM,
  DASHBOARD_URL: "https://staff.example.com/",
  AIRTABLE_TOKEN: "pat_jobs_test",
  AIRTABLE_BASE_ID: "appJOBS",
};

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function harness(opts: {
  env?: Partial<Env>;
  store?: FakeStore;
  at?: Date;
  vapi?: Responder;
  telegram?: Responder;
  resend?: Responder;
  airtable?: Responder;
} = {}) {
  let t = (opts.at ?? NOW).getTime();
  // The store takes now() from the same clock, as Postgres and the function share one.
  const store = opts.store ?? createFakeStore(undefined, { now: () => new Date(t) });
  const calls: { url: string; host: string; init: RequestInit }[] = [];
  const logs: Record<string, unknown>[] = [];
  let resendSeq = 0;
  let recordSeq = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    calls.push({ url, host, init: init ?? {} });
    const i = init ?? {};
    if (host === "api.telegram.org") {
      return await (opts.telegram ?? (() => json({ ok: true, result: { message_id: 1 } })))(url, i);
    }
    if (host === "api.resend.com") return await (opts.resend ?? (() => json({ id: `re_${++resendSeq}` })))(url, i);
    if (host === "api.airtable.com") {
      return await (opts.airtable ?? (() => json({ records: [{ id: `rec_${++recordSeq}` }], createdRecords: [] })))(
        url,
        i,
      );
    }
    if (host === "api.vapi.ai") return await (opts.vapi ?? (() => json({ message: "Not Found" }, 404)))(url, i);
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    store,
    fetch: fetchFn,
    env: { VAPI_ORG_ID: "org", VAPI_WEBHOOK_SECRET: "s", ...(opts.env ?? FULL_ENV) },
    now: () => new Date(t),
    waitUntil: () => {},
    log: (e) => logs.push(e),
  };
  return {
    store,
    deps,
    calls,
    logs,
    advance: (ms: number) => {
      t += ms;
    },
    setTime: (d: Date) => {
      t = d.getTime();
    },
    hosts: () => [...new Set(calls.map((c) => c.host))].sort(),
  };
}

const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms).toISOString();

async function escalation(
  store: FakeStore,
  callKey: string,
  p: {
    kind?: EscalationRow["kind"];
    minutesAgo: number;
    status?: EscalationRow["status"];
    realerted?: boolean;
    channel?: string;
  },
): Promise<Record<string, any>> {
  const kind = p.kind ?? "representative";
  const channel = p.channel ?? "inboundPhoneCall";
  await store.upsertEscalation({
    callKey,
    kind,
    reason: kind === "emergency" ? "emergency" : "representative_requested",
    details: null,
    callbackPhone: "+16025550101",
    callbackSource: "caller_id",
    channel,
    verified: false,
  });
  const row = store.tables.escalations.find((e) => e.call_key === callKey && e.kind === kind)!;
  row.created_at = ago(p.minutesAgo * MINUTE);
  row.status = p.status ?? "open";
  row.realerted_at = p.realerted ? ago(5 * MINUTE) : null;
  row.alert_status = channel === "chat" ? "skipped" : "sent";
  return row;
}

async function interaction(
  store: FakeStore,
  callKey: string,
  p: { createdAgo: number; ended?: boolean; extra?: Record<string, unknown> },
): Promise<Record<string, any>> {
  if (p.ended) {
    await store.upsertInteraction({
      vapi_call_id: callKey,
      channel: "inboundPhoneCall",
      caller_name: "Tobias Halvorsen",
      caller_phone: "+16025550101",
      summary: "Asked about a claim.",
      sentiment: "positive",
      sentiment_source: "vapi",
      outcome: "resolved",
      started_at: ago(p.createdAgo),
      ended_at: ago(p.createdAgo - 2 * MINUTE),
      duration_seconds: 120,
      cost: 0.1234,
      analysis_status: "ok",
    });
  } else {
    await store.ensureInteraction({
      vapi_call_id: callKey,
      channel: "webCall",
      started_at: ago(p.createdAgo),
      outcome: "in_progress",
    });
  }
  const row = store.tables.call_interactions.find((r) => r.vapi_call_id === callKey)!;
  row.created_at = ago(p.createdAgo);
  Object.assign(row, p.extra ?? {});
  return row;
}

function outbox(store: FakeStore, refId: string) {
  return store.tables.outbox_events.find((o) => o.ref_id === refId);
}

// ---------------------------------------------------------------------------------------------
// Period keys
// ---------------------------------------------------------------------------------------------
Deno.test("periodKey: sla floors to the UTC 10-minute slot, reaper to the hour, outbox to the minute", () => {
  const at = (iso: string) => new Date(iso);
  assertEquals(periodKey("sla", at("2026-10-12T15:04:30Z")), "2026-10-12T15:00Z");
  assertEquals(periodKey("sla", at("2026-10-12T15:09:59.999Z")), "2026-10-12T15:00Z");
  assertEquals(periodKey("sla", at("2026-10-12T15:10:00Z")), "2026-10-12T15:10Z");
  assertEquals(periodKey("sla", at("2026-10-12T23:59:59Z")), "2026-10-12T23:50Z");
  assertEquals(periodKey("reaper", at("2026-10-12T15:07:00Z")), "2026-10-12T15:00Z");
  assertEquals(periodKey("reaper", at("2026-10-12T15:59:59Z")), "2026-10-12T15:00Z");
  assertEquals(periodKey("outbox", at("2026-10-12T15:04:30Z")), "2026-10-12T15:04Z");
  assertEquals(periodKey("outbox", at("2026-12-31T23:59:59.999Z")), "2026-12-31T23:59Z");
});

Deno.test("periodKey: digest is the America/New_York date, across both DST changes", () => {
  const cases: [string, string][] = [
    // the cron time, 12:00 UTC: 08:00 EDT in summer, 07:00 EST in winter, one Eastern day either way
    ["2026-10-12T12:00:00Z", "2026-10-12"],
    ["2026-11-02T12:00:00Z", "2026-11-02"],
    ["2026-03-08T12:00:00Z", "2026-03-08"],
    ["2026-11-01T12:00:00Z", "2026-11-01"],
    // Eastern midnight is 04:00 UTC under EDT and 05:00 UTC under EST
    ["2026-10-12T03:59:59Z", "2026-10-11"],
    ["2026-10-12T04:00:00Z", "2026-10-12"],
    ["2026-12-01T04:59:59Z", "2026-11-30"],
    ["2026-12-01T05:00:00Z", "2026-12-01"],
    // DST starts 2026-03-08 at 07:00 UTC (02:00 EST -> 03:00 EDT)
    ["2026-03-08T04:59:59Z", "2026-03-07"],
    ["2026-03-08T05:00:00Z", "2026-03-08"],
    ["2026-03-08T07:30:00Z", "2026-03-08"],
    // DST ends 2026-11-01 at 06:00 UTC (02:00 EDT -> 01:00 EST)
    ["2026-11-01T03:59:59Z", "2026-10-31"],
    ["2026-11-01T04:00:00Z", "2026-11-01"],
    ["2026-11-01T06:30:00Z", "2026-11-01"],
    ["2026-11-02T04:59:59Z", "2026-11-01"],
  ];
  for (const [iso, date] of cases) assertEquals(periodKey("digest", new Date(iso)), date, iso);
});

Deno.test("isJobName: exactly the four scheduled jobs", () => {
  for (const name of ["sla", "digest", "reaper", "outbox"]) assert(isJobName(name), name);
  for (const name of ["", "SLA", "drop_tables", "jobs", undefined, 1]) assertFalse(isJobName(name), String(name));
});

// ---------------------------------------------------------------------------------------------
// One run per period
// ---------------------------------------------------------------------------------------------
Deno.test("runJob: a second run in the same period is skipped with no side effects; the next period runs", async () => {
  const h = harness();
  await escalation(h.store, CALL_A, { minutesAgo: 45 });
  await interaction(h.store, CALL_B, { createdAgo: 3 * HOUR });
  await interaction(h.store, CALL_C, { createdAgo: 3 * HOUR, ended: true });
  await h.store.enqueueOutbox("interaction.completed", CALL_C);

  for (const job of ["sla", "digest", "reaper", "outbox"] as const) {
    const first = await runJob(job, h.deps);
    assertFalse(first.skipped, job);
  }
  const fetches = h.calls.length;
  assert(fetches >= 4, "the first runs did their work");
  const before = JSON.stringify(h.store.tables);

  h.advance(20_000); // same minute, same slot, same hour, same Eastern date
  for (const job of ["sla", "digest", "reaper", "outbox"] as const) {
    const again = await runJob(job, h.deps);
    assertEquals(again, { job, period_key: periodKey(job, NOW), skipped: true });
  }
  assertEquals(h.calls.length, fetches, "a skipped run makes no request");
  assertEquals(JSON.stringify(h.store.tables), before, "a skipped run writes nothing");

  h.advance(10 * MINUTE);
  const next = await runJob("sla", h.deps);
  assertEquals([next.skipped, next.period_key], [false, "2026-10-12T15:10Z"]);
  assertEquals(h.store.tables.job_runs.length, 5);
  for (const run of h.store.tables.job_runs) assert(run.finished_at && run.result, `${run.job} finished`);
});

// ---------------------------------------------------------------------------------------------
// sla
// ---------------------------------------------------------------------------------------------
Deno.test("sla: only open, stale, never re-alerted, non-chat rows; one alert per row, one email per call", async () => {
  const h = harness();
  const a1 = await escalation(h.store, CALL_A, { minutesAgo: 45 });
  const a2 = await escalation(h.store, CALL_A, { kind: "emergency", minutesAgo: 40 });
  const fresh = await escalation(h.store, CALL_B, { minutesAgo: 10 });
  const claimed = await escalation(h.store, CALL_C, { minutesAgo: 50, status: "claimed" });
  const done = await escalation(h.store, CALL_D, { minutesAgo: 50, status: "done" });
  const already = await escalation(h.store, CALL_E, { minutesAgo: 50, realerted: true });
  const alreadyAt = already.realerted_at;
  const chat = await escalation(h.store, CHAT_F, { minutesAgo: 50, channel: "chat" });

  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, {
    stale: 2,
    realerted: 2,
    superseded: 0,
    telegram_sent: 2,
    telegram_failed: 0,
    telegram_skipped: 0,
    email_sent: 1,
    email_failed: 0,
    email_skipped: 1,
    deferred: 0,
    errors: 0,
  });

  const telegram = h.calls.filter((c) => c.host === "api.telegram.org");
  assertEquals(telegram.length, 2);
  const texts = telegram.map((c) => JSON.parse(String(c.init.body)).text as string);
  for (const text of texts) {
    assertStringIncludes(text, "RE-ALERT: still unclaimed");
    assertStringIncludes(text, `call ${CALL_A.slice(0, 8)}`);
    assertFalse(/555|0101/.test(text), "no phone number on the card");
  }
  assertStringIncludes(texts[1], "POSSIBLE EMERGENCY REPORTED");

  const resend = h.calls.filter((c) => c.host === "api.resend.com");
  assertEquals(resend.length, 1);
  assertEquals((resend[0].init.headers as Record<string, string>)["Idempotency-Key"], `${CALL_A}:sla_realert`);
  const email = JSON.parse(String(resend[0].init.body));
  assertEquals(email.to, [TEAM]);
  assertStringIncludes(email.subject, "Still unclaimed after 45 minutes");
  assertEquals(
    h.store.tables.emails.map((m) => [m.call_key, m.kind, m.status, m.resend_id]),
    [[CALL_A, "sla_realert", "sent", "re_1"]],
  );

  assert(a1.realerted_at && a2.realerted_at, "both stale rows of the call are marked");
  for (const row of [fresh, claimed, done, chat]) assertEquals(row.realerted_at, null, row.call_key);
  assertEquals(already.realerted_at, alreadyAt, "an earlier mark is never moved");
  assertEquals(h.hosts(), ["api.resend.com", "api.telegram.org"]);

  // ten minutes later nothing is owed: a row is re-alerted once
  h.advance(10 * MINUTE);
  const again = await runJob("sla", h.deps);
  assert(!again.skipped);
  assertEquals([again.result.stale, again.result.realerted], [0, 0]);
  assertEquals(h.calls.length, 3);
});

Deno.test("sla: failed channels still mark the row, and the failures are counted", async () => {
  const h = harness({
    telegram: () => json({ ok: false, description: "Forbidden: bot was kicked" }, 403),
    resend: () => json({ message: "domain not verified" }, 403),
  });
  const row = await escalation(h.store, CALL_A, { minutesAgo: 31 });
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals(
    [out.result.realerted, out.result.telegram_failed, out.result.email_failed, out.result.errors],
    [1, 1, 1, 0],
  );
  assert(row.realerted_at, "marked after the attempt whatever the channels said");
  assertEquals(h.store.tables.emails[0].status, "failed");
  assertStringIncludes(h.store.tables.emails[0].error, "resend 403");

  h.advance(10 * MINUTE);
  await runJob("sla", h.deps);
  assertEquals(h.calls.length, 2, "never re-alerted a second time");
});

Deno.test("sla: the re-alert email names the caller and the callback number; the Telegram card does not", async () => {
  const h = harness();
  await h.store.ensureSession(CALL_A, "inboundPhoneCall", null);
  await escalation(h.store, CALL_A, { minutesAgo: 31 });
  await h.store.upsertContact({
    callKey: CALL_A,
    kind: "new_customer",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@gmail.com",
    callbackPhone: "+16025550177",
    callbackSource: "argument",
    customerId: null,
  });
  await h.store.setContactConfirmed(CALL_A, true);
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.telegram_sent, out.result.email_sent], [1, 1]);

  const email = JSON.parse(String(h.calls.find((c) => c.host === "api.resend.com")!.init.body));
  assertStringIncludes(email.html, "Jane Doe (caller-provided, unverified)");
  assertStringIncludes(email.html, "Email (caller-provided, unverified)");
  assertStringIncludes(email.html, "jane.doe@gmail.com");
  // the escalation row's own number, the one staff are asked to call
  assertStringIncludes(email.html, "(602) 555-0101 (+16025550101)");

  const card = JSON.parse(String(h.calls.find((c) => c.host === "api.telegram.org")!.init.body)).text as string;
  assertFalse(/Jane|Doe|jane\.doe|555|0101|0177/.test(card), "no name, address or number on the card");
});

Deno.test("sla: a failed contact read still sends the re-alert, without the caller rows", async () => {
  const h = harness();
  await escalation(h.store, CALL_A, { minutesAgo: 31 });
  h.store.failNext("listEscalations");
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.realerted, out.result.email_sent, out.result.errors], [1, 1, 0]);
  const email = JSON.parse(String(h.calls.find((c) => c.host === "api.resend.com")!.init.body));
  assertStringIncludes(email.subject, "Still unclaimed after 31 minutes");
  assertStringIncludes(email.html, "Unknown caller");
  assertStringIncludes(email.html, "None known (check the dashboard)");
});

Deno.test("sla: channels switched off or not configured are skipped without a request or a ledger row", async () => {
  const h = harness({ env: { ALERT_SINKS: "telegram" } });
  const row = await escalation(h.store, CALL_A, { minutesAgo: 31 });
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.telegram_sent, out.result.email_skipped, out.result.realerted], [0, 1, 1]);
  assertEquals(out.result.telegram_skipped, 1, "no bot token configured");
  assertEquals(h.calls.length, 0);
  assertEquals(h.store.tables.emails.length, 0);
  assert(row.realerted_at);
});

Deno.test("sla: a failed mark pages nobody; the next run re-pages that row, so every row is re-paged exactly once", async () => {
  const h = harness();
  const a = await escalation(h.store, CALL_A, { minutesAgo: 35 });
  const b = await escalation(h.store, CALL_B, { minutesAgo: 33 });
  h.store.failNext("markRealerted");
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals(
    [out.result.realerted, out.result.errors, out.result.telegram_sent, out.result.email_sent],
    [1, 1, 1, 1],
  );
  assertEquals(a.realerted_at, null);
  assert(b.realerted_at, "one bad row does not stop the others");
  assert(h.logs.some((l) => l.event === "job_error" && l.step === "markRealerted"));
  const emailKeys = () =>
    h.calls.filter((c) => c.host === "api.resend.com").map((c) =>
      (c.init.headers as Record<string, string>)["Idempotency-Key"]
    );
  assertEquals(emailKeys(), [`${CALL_B}:sla_realert`], "the row that could not be marked was not paged");

  h.advance(10 * MINUTE);
  const again = await runJob("sla", h.deps);
  assert(!again.skipped);
  assertEquals([again.result.stale, again.result.realerted, again.result.telegram_sent, again.result.email_sent], [
    1,
    1,
    1,
    1,
  ]);
  assert(a.realerted_at);
  assertEquals(h.calls.filter((c) => c.host === "api.telegram.org").length, 2, "one Telegram re-page per row, ever");
  assertEquals(emailKeys(), [`${CALL_B}:sla_realert`, `${CALL_A}:sla_realert`], "one email per call, ever");

  h.advance(10 * MINUTE);
  await runJob("sla", h.deps);
  assertEquals(h.calls.length, 4, "nothing is owed after that");
});

Deno.test("sla: a row staff claim after the list, or another run marked first, is never paged", async () => {
  const h = harness();
  const a = await escalation(h.store, CALL_A, { minutesAgo: 45 });
  const b = await escalation(h.store, CALL_B, { minutesAgo: 40 });
  const list = h.store.listStaleEscalations;
  h.store.listStaleEscalations = async (cutoff) => {
    const rows = await list(cutoff);
    // between the list and each row's turn: staff claim one row, an overlapping run marks the other
    a.status = "claimed";
    b.realerted_at = ago(MINUTE);
    return rows;
  };
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.stale, out.result.realerted, out.result.superseded, out.result.errors], [2, 0, 2, 0]);
  assertEquals(h.calls.length, 0, "no RE-ALERT for a claimed row, and no second page for a marked one");
  assertEquals(h.store.tables.emails.length, 0);
  assertEquals(a.realerted_at, null, "a claimed row is left as staff left it");
});

Deno.test("sla: rows that would run past the 8 s deadline wait for the next run", async () => {
  const h = harness({
    telegram: () => {
      h.advance(3000);
      return json({ ok: true });
    },
    env: { ...FULL_ENV, ALERT_SINKS: "telegram" },
  });
  for (const [i, key] of [CALL_A, CALL_B, CALL_C, CALL_D].entries()) {
    await escalation(h.store, key, { minutesAgo: 60 - i });
  }
  const out = await runJob("sla", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.realerted, out.result.deferred], [2, 2]);
  h.setTime(new Date(NOW.getTime() + 10 * MINUTE));
  const next = await runJob("sla", h.deps);
  assert(!next.skipped);
  assertEquals([next.result.stale, next.result.realerted, next.result.deferred], [2, 2, 0]);
  assert(h.store.tables.escalations.every((e) => e.realerted_at), "every row re-alerted exactly once");
});

// ---------------------------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------------------------
const CRON = new Date("2026-10-12T12:00:00Z"); // 08:00 EDT

async function digestFixture(store: FakeStore) {
  await interaction(store, CALL_A, { createdAgo: 2 * HOUR, ended: true });
  await interaction(store, CALL_B, {
    createdAgo: 5 * HOUR,
    ended: true,
    extra: { outcome: "escalated", sentiment: "negative", cost: 0.5, flags: ["promised_callback_without_escalation"] },
  });
  await interaction(store, CALL_C, { createdAgo: 30 * MINUTE });
  await interaction(store, CALL_D, { createdAgo: 25 * HOUR, ended: true, extra: { outcome: "abandoned" } });
  for (const r of store.tables.call_interactions) r.created_at = ago(NOW.getTime() - Date.parse(r.created_at), CRON);
  await escalation(store, CALL_B, { minutesAgo: 0 });
  store.tables.escalations[0].created_at = ago(5 * HOUR, CRON);
  store.tables.emails.push(
    { call_key: CALL_A, kind: "claim_summary", status: "sent", created_at: ago(HOUR, CRON) },
    { call_key: CALL_B, kind: "callback_request", status: "failed", created_at: ago(HOUR, CRON) },
    { call_key: CALL_D, kind: "claim_summary", status: "sent", created_at: ago(30 * HOUR, CRON) },
  );
}

Deno.test("digest: one email per Eastern day to the team, keyed digest:<date>, from the last 24 hours", async () => {
  const h = harness({ at: CRON });
  await digestFixture(h.store);
  const out = await runJob("digest", h.deps);
  assertEquals(out, {
    job: "digest",
    period_key: "2026-10-12",
    skipped: false,
    result: { calls: 3, completed: 2, flagged: 1, emails_sent: 1, digest_email: "sent" },
  });
  assertEquals(h.hosts(), ["api.resend.com"]);
  const [call] = h.calls;
  assertEquals((call.init.headers as Record<string, string>)["Idempotency-Key"], "digest:2026-10-12");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.to, [TEAM]);
  assertEquals(body.subject, "Observe Claims daily digest: 2026-10-12");
  assertStringIncludes(body.html, "October 11, 2026 at 08:00 to October 12, 2026 at 08:00 Eastern");
  assertStringIncludes(body.html, "Escalations by status");
  assertStringIncludes(body.html, "Total cost usd");
  assertStringIncludes(body.html, "0.6234");
  assertFalse(/5550101|Tobias|Halvorsen/.test(body.html), "counts only: no name or number");
  assertFalse(/[^\t\n\r\x20-\x7e]/.test(body.html), "printable ASCII only");

  // the same Eastern date an hour later (a manual run) is skipped
  h.setTime(new Date("2026-10-12T13:00:00Z"));
  assertEquals((await runJob("digest", h.deps)).skipped, true);
  // the next day sends again, under its own key
  h.setTime(new Date("2026-10-13T12:00:00Z"));
  const next = await runJob("digest", h.deps);
  assertEquals([next.skipped, next.period_key], [false, "2026-10-13"]);
  assertEquals(h.calls.length, 2);
  assertEquals((h.calls[1].init.headers as Record<string, string>)["Idempotency-Key"], "digest:2026-10-13");
});

Deno.test("digest: in winter the 12:00 UTC run is 07:00 EST and keys that Eastern date", async () => {
  const h = harness({ at: new Date("2026-11-02T12:00:00Z") });
  const out = await runJob("digest", h.deps);
  assertEquals([out.skipped, out.period_key], [false, "2026-11-02"]);
  const body = JSON.parse(String(h.calls[0].init.body));
  assertStringIncludes(body.html, "November 1, 2026 at 07:00 to November 2, 2026 at 07:00 Eastern");
  assertStringIncludes(body.html, "Calls");
});

Deno.test("digest: without Resend or a team address nothing is sent and the result says so", async () => {
  for (const env of [{ ...FULL_ENV, RESEND_API_KEY: undefined }, { ...FULL_ENV, CLAIMS_TEAM_EMAIL: undefined }]) {
    const h = harness({ at: CRON, env });
    await digestFixture(h.store);
    const out = await runJob("digest", h.deps);
    assert(!out.skipped);
    assertEquals(out.result, { calls: 3, completed: 2, flagged: 1, emails_sent: 1, digest_email: "skipped" });
    assertEquals(h.calls.length, 0);
    assert(h.store.tables.job_runs[0].finished_at);
  }
});

Deno.test("digest: a Resend failure gives the date back; a later run that day sends it under the same key", async () => {
  let down = true;
  const h = harness({
    at: CRON,
    resend: () => down ? json({ message: "rate limited" }, 429) : json({ id: "re_digest" }),
  });
  await digestFixture(h.store);
  const out = await runJob("digest", h.deps);
  assert(!out.skipped);
  assertEquals(out.result.digest_email, "failed");
  assertEquals(out.released, true, "the operator is told the date can be run again");
  assert(h.logs.some((l) => l.event === "job_error" && l.step === "sendEmail"));
  assertEquals(h.store.tables.job_runs, [], "the Eastern date is not held by a run that sent nothing");

  // deno task jobs digest later the same morning
  down = false;
  h.setTime(new Date("2026-10-12T12:30:00Z"));
  const retry = await runJob("digest", h.deps);
  assert(!retry.skipped);
  assertEquals([retry.period_key, retry.result.digest_email, retry.released], ["2026-10-12", "sent", undefined]);
  assertEquals(
    h.calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]),
    ["digest:2026-10-12", "digest:2026-10-12"],
    "the same key, so a first send Resend had in fact accepted is not delivered twice",
  );
  assertEquals(h.store.tables.job_runs.map((r) => [r.period_key, r.result?.digest_email]), [["2026-10-12", "sent"]]);

  // once sent, the date is done
  h.setTime(new Date("2026-10-12T13:00:00Z"));
  assertEquals((await runJob("digest", h.deps)).skipped, true);
  assertEquals(h.calls.length, 2);
});

Deno.test("digest: a failed read throws and gives the date back, so a manual run the same day still sends", async () => {
  const h = harness({ at: CRON });
  await digestFixture(h.store);
  h.store.failNext("digestStats");
  await assertRejects(() => runJob("digest", h.deps));
  assertEquals(h.store.tables.job_runs, []);
  assertEquals(h.calls.length, 0);

  h.setTime(new Date("2026-10-12T12:20:00Z"));
  const retry = await runJob("digest", h.deps);
  assert(!retry.skipped);
  assertEquals(retry.result, { calls: 3, completed: 2, flagged: 1, emails_sent: 1, digest_email: "sent" });
  assertEquals(h.store.tables.job_runs.map((r) => [r.period_key, typeof r.finished_at]), [["2026-10-12", "string"]]);
});

Deno.test("digest: a date whose run could not be given back stays claimed, and the failure is logged", async () => {
  const h = harness({ at: CRON, resend: () => json({ message: "down" }, 503) });
  h.store.failNext("releaseJobRun");
  const out = await runJob("digest", h.deps);
  assert(!out.skipped);
  assertEquals(out.result.digest_email, "failed");
  assert(h.logs.some((l) => l.event === "job_error" && l.step === "releaseJobRun"));
  assertEquals(h.store.tables.job_runs.map((r) => [r.period_key, r.finished_at]), [["2026-10-12", null]]);
});

// ---------------------------------------------------------------------------------------------
// reaper
// ---------------------------------------------------------------------------------------------
function endedCall(callKey: string) {
  return {
    id: callKey,
    orgId: "org",
    type: "webCall",
    status: "ended",
    startedAt: ago(3 * HOUR),
    endedAt: ago(3 * HOUR - 3 * MINUTE),
    endedReason: "customer-ended-call",
    cost: 0.21,
    analysis: {
      summary: "The caller asked for a representative and a callback was queued.",
      structuredData: { sentiment: "neutral", outcome: "escalated" },
    },
    artifact: {
      transcript: "AI: Hi, this is Ava.\nUser: I need a person, my number is 602 555 0101.",
      messages: [
        { role: "bot", message: "Hi, this is Ava.", secondsFromStart: 0 },
        { role: "user", message: "I need a person, my number is 602 555 0101.", secondsFromStart: 3 },
      ],
    },
  };
}

Deno.test("reaper: a stuck call is rebuilt from GET /call before anything is abandoned, and nobody is notified", async () => {
  const h = harness({
    env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: (url) => json(endedCall(decodeURIComponent(url.split("/call/")[1]))),
  });
  await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  await escalation(h.store, CALL_A, { minutesAgo: 170 });
  h.store.tables.escalations[0].alert_status = "pending";
  await h.store.insertTranscriptLine({ call_key: CALL_A, role: "assistant", text: "Hi, this is Ava.", ts_ms: 1 });

  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, {
    stuck: 1,
    backfilled: 1,
    reaped: 0,
    waiting: 0,
    superseded: 0,
    deferred: 0,
    errors: 0,
    requeued: 0,
    lines_deleted: 0,
    captures_deleted: 0,
    runs_deleted: 0,
  });
  assertEquals(h.hosts(), ["api.vapi.ai"], "only VAPI is called: no Telegram, no Resend");
  assertEquals(h.calls.length, 1);
  assertEquals(h.calls[0].url, `https://api.vapi.ai/call/${CALL_A}`);
  assertEquals((h.calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${PRIVATE_KEY}`);

  const row = h.store.tables.call_interactions[0];
  assertEquals(row.ended_at, endedCall(CALL_A).endedAt);
  assertEquals(row.outcome, "escalated", "server facts first: the escalation row decides");
  assertEquals(row.analysis_status, "backfilled");
  assertEquals([row.sentiment, row.sentiment_source], ["neutral", "backfill"]);
  assertEquals(row.ended_reason, "customer-ended-call");
  assertFalse(JSON.stringify(row.messages).includes("555 0101"), "built through the redacting row builder");
  assertEquals(h.store.tables.escalations[0].alert_status, "pending", "no alert was sent");
  assertEquals(h.store.tables.transcript_lines.length, 0, "the live lines give way to the record");
  assertEquals([outbox(h.store, CALL_A)?.attempts, outbox(h.store, CALL_A)?.delivered_at], [0, null]);
});

Deno.test("reaper: VAPI's 404 closes the call as abandoned; completed and recent rows are untouched", async () => {
  const h = harness({
    env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: (url) =>
      url.endsWith(CALL_C)
        ? json({ id: CALL_C, status: "in-progress", startedAt: ago(3 * HOUR) })
        : json({ message: "Not Found" }, 404),
  });
  await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  await interaction(h.store, CALL_B, { createdAgo: 4 * HOUR, extra: { ended_reason: "pipeline-error" } });
  const stillOn = await interaction(h.store, CALL_C, { createdAgo: 5 * HOUR });
  const completed = await interaction(h.store, CALL_D, { createdAgo: 6 * HOUR, ended: true });
  await h.store.enqueueOutbox("interaction.completed", CALL_D); // as its report did
  const completedBefore = structuredClone(completed);
  const queuedBefore = structuredClone(outbox(h.store, CALL_D));
  const recent = await interaction(h.store, CALL_E, { createdAgo: HOUR });

  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals(
    [out.result.stuck, out.result.backfilled, out.result.reaped, out.result.waiting, out.result.errors],
    [3, 0, 2, 1, 0],
  );
  assertEquals(h.hosts(), ["api.vapi.ai"]);
  assertEquals(h.calls.length, 3);

  for (const key of [CALL_A, CALL_B]) {
    const row = h.store.tables.call_interactions.find((r) => r.vapi_call_id === key)!;
    assertEquals([row.outcome, row.analysis_status], ["abandoned", "missing"], key);
    assert(row.ended_at, key);
    assert(outbox(h.store, key), `${key} is queued for the call log`);
  }
  const reason = (key: string) => h.store.tables.call_interactions.find((r) => r.vapi_call_id === key)!.ended_reason;
  assertEquals([reason(CALL_A), reason(CALL_B)], ["reaped", "pipeline-error"]);
  // VAPI says it is still on: asked again next hour rather than closed under a live call
  assertEquals([stillOn.ended_at, stillOn.outcome, outbox(h.store, CALL_C)], [null, "in_progress", undefined]);
  assertEquals(completed, completedBefore, "a completed row is never touched");
  assertEquals(outbox(h.store, CALL_D), queuedBefore, "nor its outbox row");
  assertEquals([recent.ended_at, recent.outcome], [null, "in_progress"]);
});

Deno.test("reaper: a VAPI outage, rate limit or timeout leaves the call open; the next pass rebuilds it", async () => {
  let vapi: Responder = (url) => {
    if (url.endsWith(CALL_A)) return json({ message: "Service Unavailable" }, 503);
    if (url.endsWith(CALL_B)) return json({ message: "Too Many Requests" }, 429);
    throw new DOMException("The signal has been aborted", "TimeoutError");
  };
  const h = harness({ env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY }, vapi: (url, init) => vapi(url, init) });
  for (const [i, key] of [CALL_A, CALL_B, CALL_C].entries()) {
    await interaction(h.store, key, { createdAgo: (3 + i) * HOUR });
    await h.store.insertTranscriptLine({ call_key: key, role: "assistant", text: "Hi, this is Ava.", ts_ms: 1 });
  }
  const before = structuredClone(h.store.tables.call_interactions);

  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.stuck, out.result.waiting, out.result.reaped, out.result.errors], [3, 3, 0, 0]);
  assertEquals(h.store.tables.call_interactions, before, "nothing is closed while VAPI cannot answer");
  assertEquals(h.store.tables.outbox_events.length, 0);
  assertEquals(h.store.tables.transcript_lines.length, 3);

  vapi = (url) => json(endedCall(decodeURIComponent(url.split("/call/")[1])));
  h.advance(HOUR);
  const next = await runJob("reaper", h.deps);
  assert(!next.skipped);
  assertEquals([next.result.stuck, next.result.backfilled, next.result.waiting, next.result.reaped], [3, 3, 0, 0]);
  for (const row of h.store.tables.call_interactions) {
    assertEquals([row.analysis_status, row.ended_reason], ["backfilled", "customer-ended-call"], row.vapi_call_id);
  }
});

Deno.test("reaper: a call VAPI still cannot answer for once its row is a day old is closed as abandoned", async () => {
  const h = harness({
    env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: (url) =>
      url.endsWith(CALL_A)
        ? json({ message: "Bad Gateway" }, 502)
        : json({ id: CALL_B, status: "in-progress", startedAt: ago(30 * HOUR) }),
  });
  await interaction(h.store, CALL_A, { createdAgo: 25 * HOUR });
  await interaction(h.store, CALL_B, { createdAgo: 30 * HOUR });
  await interaction(h.store, CALL_C, { createdAgo: 23 * HOUR }); // not a day old yet: 502 too, waits
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.reaped, out.result.waiting], [2, 1]);
  const row = (key: string) => h.store.tables.call_interactions.find((r) => r.vapi_call_id === key)!;
  assertEquals([row(CALL_A).outcome, row(CALL_B).outcome, row(CALL_C).outcome], [
    "abandoned",
    "abandoned",
    "in_progress",
  ]);
});

Deno.test("reaper: a row starts only with room for the whole GET /call; the rest wait for the next pass", async () => {
  const h = harness({
    env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: () => {
      h.advance(2500);
      return json({ message: "Not Found" }, 404);
    },
  });
  for (const [i, key] of [CALL_A, CALL_B, CALL_C].entries()) {
    await interaction(h.store, key, { createdAgo: (5 - i) * HOUR });
  }
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.reaped, out.result.deferred], [1, 2]);
  assertEquals(h.calls.length, 1, "no fetch is started with less than its full timeout left");
});

Deno.test("reaper: a reaped call keeps its live lines, its only transcript, until the 7-day sweep", async () => {
  const h = harness({ env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY } }); // VAPI answers 404
  const row = await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  await h.store.insertTranscriptLine({ call_key: CALL_A, role: "assistant", text: "Hi, this is Ava.", ts_ms: 1 });
  await h.store.insertTranscriptLine({ call_key: CALL_A, role: "user", text: "I need help with a claim.", ts_ms: 2 });
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals(out.result.reaped, 1);
  assertEquals([row.outcome, row.messages], ["abandoned", null]);
  assertEquals(h.store.tables.transcript_lines.map((l) => l.ts_ms), [1, 2], "the dashboard's fallback transcript");

  h.advance(8 * DAY);
  const later = await runJob("reaper", h.deps);
  assert(!later.skipped);
  assertEquals([later.result.lines_deleted, h.store.tables.transcript_lines.length], [2, 0]);
});

Deno.test("reaper: a call rebuilt without messages keeps its live lines; one rebuilt with them clears them", async () => {
  const bare = (key: string) => {
    const call: Record<string, unknown> = endedCall(key);
    call.artifact = { transcript: "" };
    return call;
  };
  const h = harness({
    env: { ...FULL_ENV, VAPI_PRIVATE_KEY: PRIVATE_KEY },
    vapi: (url) => {
      const key = decodeURIComponent(url.split("/call/")[1]);
      return json(key === CALL_A ? bare(key) : endedCall(key));
    },
  });
  for (const key of [CALL_A, CALL_B]) {
    await interaction(h.store, key, { createdAgo: 3 * HOUR });
    await h.store.insertTranscriptLine({ call_key: key, role: "assistant", text: "Hi, this is Ava.", ts_ms: 1 });
  }
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals(out.result.backfilled, 2);
  assertEquals(h.store.tables.transcript_lines.map((l) => l.call_key), [CALL_A]);
});

Deno.test("reaper: without VAPI_PRIVATE_KEY it abandons with no request at all", async () => {
  const h = harness();
  await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.reaped, out.result.backfilled], [1, 0]);
  assertEquals(h.calls.length, 0);
});

Deno.test("reaper: a report that lands between the list and the close is left alone (superseded)", async () => {
  const h = harness();
  const row = await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  const list = h.store.listStuckInteractions;
  h.store.listStuckInteractions = async (cutoff) => {
    const stuck = await list(cutoff);
    // the report path: the row, then its own outbox row
    await h.store.upsertInteraction({ vapi_call_id: CALL_A, ended_at: ago(2 * HOUR), outcome: "resolved" });
    await h.store.enqueueOutbox("interaction.completed", CALL_A);
    return stuck;
  };
  const queuedBefore = structuredClone(h.store.tables.outbox_events);
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.stuck, out.result.reaped, out.result.superseded, out.result.requeued], [1, 0, 1, 0]);
  assertEquals([row.outcome, row.ended_reason], ["resolved", null]);
  assertEquals(queuedBefore, [], "nothing was queued before the report");
  assertEquals(
    h.store.tables.outbox_events.map((o) => [o.ref_id, o.attempts, o.delivered_at]),
    [[CALL_A, 0, null]],
    "only the report's own row: the reaper neither closes nor re-queues the call",
  );
});

Deno.test("reaper: one failing row is counted and the others are still closed", async () => {
  const h = harness();
  await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  await interaction(h.store, CALL_B, { createdAgo: 3 * HOUR });
  h.store.failNext("reapInteraction");
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.reaped, out.result.errors], [1, 1]);
  assert(h.logs.some((l) => l.event === "job_error" && l.job === "reaper"));
});

Deno.test("reaper: prunes every live line after 7 days, whatever became of its call, old captures and old frequent runs", async () => {
  const h = harness();
  const ended = await interaction(h.store, CALL_D, { createdAgo: 9 * DAY, ended: true });
  assert(ended.ended_at);
  const line = (call_key: string, daysAgo: number, ts_ms: number) =>
    h.store.tables.transcript_lines.push({
      id: ts_ms,
      call_key,
      role: "user",
      text: "[answer withheld]",
      ts_ms,
      created_at: ago(daysAgo * DAY),
    });
  line(CALL_A, 8, 1); // no row: deleted
  line(CALL_A, 8, 2);
  line(CALL_D, 8, 3); // the call ended (a line delivered after its report, or a failed clear): deleted
  line(CALL_B, 1, 4); // recent: kept
  h.store.tables.webhook_captures.push(
    { id: 1, message_type: "status-update", call_key: CALL_A, body: {}, received_at: ago(8 * DAY) },
    { id: 2, message_type: "status-update", call_key: CALL_B, body: {}, received_at: ago(6 * DAY) },
  );
  const run = (job: string, period_key: string, daysAgo: number) =>
    h.store.tables.job_runs.push({ job, period_key, started_at: ago(daysAgo * DAY), finished_at: null, result: null });
  run("outbox", "old-outbox", 8);
  run("sla", "old-sla", 8);
  run("outbox", "recent-outbox", 6);
  run("digest", "old-digest", 30);
  run("reaper", "old-reaper", 30);
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.lines_deleted, out.result.captures_deleted, out.result.runs_deleted], [3, 1, 2]);
  assertEquals(h.store.tables.transcript_lines.map((t) => t.ts_ms), [4]);
  assertEquals(h.store.tables.webhook_captures.map((c) => c.id), [2]);
  assertEquals(h.store.tables.job_runs.map((r) => r.period_key), [
    "recent-outbox",
    "old-digest",
    "old-reaper",
    periodKey("reaper", NOW),
  ]);
});

Deno.test("reaper: ended calls missing from the call log are queued again; recent, old, pending and current rows are not", async () => {
  const h = harness();
  const ended = async (key: string, endedAgo: number, updatedAgo = endedAgo) => {
    const row = await interaction(h.store, key, { createdAgo: endedAgo + 2 * MINUTE, ended: true });
    Object.assign(row, { ended_at: ago(endedAgo), updated_at: ago(updatedAgo) });
    return row;
  };
  await ended(CALL_A, 3 * HOUR); // its enqueue failed: no outbox row at all
  await ended(CALL_B, 3 * HOUR, HOUR); // delivered, then a backfill improved it and the re-arm failed
  await ended(CALL_C, 3 * HOUR, 2 * HOUR); // delivered after its last change: current
  await ended(CALL_D, 5 * MINUTE); // just ended: still in the report's own path
  await ended(CALL_E, 3 * DAY); // outside the 48-hour window
  await ended(CHAT_F, 3 * HOUR); // queued and still pending
  for (const key of [CALL_B, CALL_C, CHAT_F]) await h.store.enqueueOutbox("interaction.completed", key);
  Object.assign(outbox(h.store, CALL_B)!, {
    delivered_at: ago(2 * HOUR + 50 * MINUTE),
    attempts: 1,
    external_id: "recB",
  });
  Object.assign(outbox(h.store, CALL_C)!, { delivered_at: ago(30 * MINUTE), attempts: 1, external_id: "recC" });
  Object.assign(outbox(h.store, CHAT_F)!, { attempts: 2, last_error: "airtable 503: x" });
  const untouched = structuredClone([outbox(h.store, CALL_C), outbox(h.store, CHAT_F)]);

  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.requeued, out.result.errors], [2, 0]);
  assertEquals([outbox(h.store, CALL_A)?.attempts, outbox(h.store, CALL_A)?.delivered_at], [0, null]);
  const b = outbox(h.store, CALL_B)!;
  assertEquals([b.attempts, b.delivered_at, b.external_id], [0, null, "recB"], "re-armed, record id kept");
  assertEquals([outbox(h.store, CALL_C), outbox(h.store, CHAT_F)], untouched);
  assertEquals([outbox(h.store, CALL_D), outbox(h.store, CALL_E)], [undefined, undefined]);
  assertEquals(h.calls.length, 0, "the reaper only queues; the outbox job delivers");

  // the next outbox runs deliver both (the re-armed one once its lease has passed)
  h.advance(MINUTE);
  const delivered = await runJob("outbox", h.deps);
  assert(!delivered.skipped);
  const sent = h.calls.map((c) => JSON.parse(String(c.init.body)).records[0].fields["Call ID"]);
  assert(sent.includes(CALL_A) && sent.includes(CALL_B), sent.join(","));
});

Deno.test("reaper: a call GoHighLevel has no row for is queued for it alone, 90 s out; only when it is configured", async () => {
  for (const configured of [true, false]) {
    const env = configured ? { ...FULL_ENV, GHL_TOKEN: "pit-jobs", GHL_LOCATION_ID: "locJobs" } : FULL_ENV;
    const h = harness({ env });
    for (const key of [CALL_A, CALL_B]) {
      const row = await interaction(h.store, key, { createdAgo: 3 * HOUR, ended: true });
      Object.assign(row, { ended_at: ago(3 * HOUR), updated_at: ago(3 * HOUR) });
      // the call log has both, delivered after the last change
      await h.store.enqueueOutbox("interaction.completed", key, "airtable");
    }
    for (const o of h.store.tables.outbox_events) Object.assign(o, { delivered_at: ago(2 * HOUR), attempts: 1 });
    // CALL_A's GoHighLevel enqueue failed; CALL_B's row was delivered long ago (never posted again)
    await h.store.enqueueOutbox("interaction.completed", CALL_B, "ghl", 90);
    const b = h.store.tables.outbox_events.find((o) => o.ref_id === CALL_B && o.destination === "ghl")!;
    Object.assign(b, { delivered_at: ago(2 * HOUR), attempts: 1 });
    const out = await runJob("reaper", h.deps);
    assert(!out.skipped);
    const ghl = h.store.tables.outbox_events.filter((o) => o.destination === "ghl");
    if (!configured) {
      assertEquals([out.result.requeued, ghl.length], [0, 1], "unconfigured: no GoHighLevel sweep");
      continue;
    }
    assertEquals([out.result.requeued, out.result.errors], [1, 0]);
    const a = ghl.find((o) => o.ref_id === CALL_A);
    assert(a, "CALL_A queued for GoHighLevel");
    assertEquals(Date.parse(a.next_attempt_at) - NOW.getTime(), 90_000, "with GoHighLevel's delay");
    // the call log rows were left alone, and the delivered GoHighLevel row too
    for (const o of h.store.tables.outbox_events.filter((o) => o.destination === "airtable")) {
      assertEquals(o.delivered_at, ago(2 * HOUR));
    }
    assertEquals(b.delivered_at, ago(2 * HOUR));
  }
});

Deno.test("reaper: a failed call-log sweep or enqueue is counted and the pruning still runs", async () => {
  const h = harness();
  const row = await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR, ended: true });
  row.ended_at = ago(2 * HOUR);
  h.store.failNext("listOutboxGaps");
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.requeued, out.result.errors], [0, 1]);
  assert(h.logs.some((l) => l.event === "job_error" && l.step === "listOutboxGaps"));
  assert(h.store.tables.job_runs[0].finished_at);

  h.advance(HOUR);
  h.store.failNext("enqueueOutbox");
  const next = await runJob("reaper", h.deps);
  assert(!next.skipped);
  assertEquals([next.result.requeued, next.result.errors], [0, 1]);
  assert(h.logs.some((l) => l.event === "outbox_enqueue_failed" && l.source === "sweep"));

  h.advance(HOUR);
  const third = await runJob("reaper", h.deps);
  assert(!third.skipped);
  assertEquals([third.result.requeued, third.result.errors], [1, 0]);
  assert(outbox(h.store, CALL_A));
});

Deno.test("reaper: a pruning failure is counted and the run still finishes with its counts", async () => {
  const h = harness();
  await interaction(h.store, CALL_A, { createdAgo: 3 * HOUR });
  h.store.failNext("deleteOldTranscriptLines");
  const out = await runJob("reaper", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.reaped, out.result.errors], [1, 1]);
  assert(h.store.tables.job_runs[0].finished_at);
});

// ---------------------------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------------------------
async function queued(store: FakeStore, ...keys: string[]) {
  for (const key of keys) {
    await interaction(store, key, { createdAgo: HOUR, ended: true });
    await store.enqueueOutbox("interaction.completed", key);
  }
}

Deno.test("outbox: a delivery upserts the slim record on Call ID and marks the row delivered with the record id", async () => {
  const h = harness();
  await queued(h.store, CALL_A);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(h.hosts(), ["api.airtable.com"]);
  const [call] = h.calls;
  assertEquals(call.url, "https://api.airtable.com/v0/appJOBS/Call%20Log");
  assertEquals(call.init.method, "PATCH");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.performUpsert, { fieldsToMergeOn: ["Call ID"] });
  const fields = body.records[0].fields;
  assertEquals(fields["Call ID"], CALL_A);
  assertEquals(fields["Caller Phone"], "ending 0101");
  assertEquals(fields["Dashboard"], `https://staff.example.com/#/calls/${CALL_A}`);
  assertFalse(JSON.stringify(body).includes("6025550101"));
  const row = outbox(h.store, CALL_A)!;
  assertEquals([row.attempts, row.external_id, row.last_error], [1, "rec_1", null]);
  assert(row.delivered_at);

  // delivered rows are never claimed again
  h.advance(MINUTE);
  await runJob("outbox", h.deps);
  assertEquals(h.calls.length, 1);
});

Deno.test("outbox: 429 keeps the row pending with a masked error; the next run delivers it", async () => {
  let limited = true;
  const h = harness({
    airtable: () =>
      limited
        ? json({ error: { type: "RATE_LIMIT", message: "Too many requests for account 9876543210987654" } }, 429)
        : json({ records: [{ id: "recOK" }] }),
  });
  await queued(h.store, CALL_A);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 1, dead: 0, errors: 0 });
  const row = outbox(h.store, CALL_A)!;
  assertEquals([row.attempts, row.delivered_at], [1, null]);
  assertStringIncludes(row.last_error, "airtable 429");
  assertStringIncludes(row.last_error, "[digits]");
  assertFalse(row.last_error.includes("9876543210987654"));

  limited = false;
  h.advance(MINUTE);
  const next = await runJob("outbox", h.deps);
  assert(!next.skipped);
  assertEquals(next.result.delivered, 1);
  assertEquals([row.attempts, row.external_id, row.last_error], [2, "recOK", null]);
});

Deno.test("outbox: 422 (a value this record holds) is not retryable: the row is dead at once and never claimed again", async () => {
  const h = harness({
    airtable: () => json({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: "Cannot parse value" } }, 422),
  });
  await queued(h.store, CALL_A);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 1, errors: 0 });
  const row = outbox(h.store, CALL_A)!;
  assertEquals([row.attempts, row.delivered_at], [5, null]);
  assertStringIncludes(row.last_error, "airtable 422");
  h.advance(MINUTE);
  await runJob("outbox", h.deps);
  assertEquals(h.calls.length, 1);
});

Deno.test("outbox: 401/403/404 pause delivery: nothing is spent, the run stops, and the rows go out once it is fixed", async () => {
  for (const status of [401, 403, 404]) {
    let refused = true;
    const h = harness({
      airtable: () =>
        refused
          ? json(
            { error: { type: "AUTHENTICATION_REQUIRED", message: "Invalid token for account 9876543210987654" } },
            status,
          )
          : json({ records: [{ id: "recOK" }] }),
    });
    await queued(h.store, CALL_A, CALL_B);
    const [a, b] = [outbox(h.store, CALL_A)!, outbox(h.store, CALL_B)!];
    const out = await runJob("outbox", h.deps);
    assert(!out.skipped);
    assertEquals(out.result, {
      delivered: 0,
      retried: 0,
      dead: 0,
      errors: 0,
      config_error: `airtable ${status}: Invalid token for account [digits]`,
    });
    assertEquals([a.attempts, a.delivered_at, b.attempts], [0, null, 0], `${status}: the attempt is given back`);
    assertStringIncludes(a.last_error, `airtable ${status}`);
    assertEquals(h.calls.length, 1, `${status}: the run stops at the first refusal`);
    assert(h.logs.some((l) => l.event === "outbox_paused"));

    // an hour of a revoked token costs no row anything
    for (let i = 0; i < 60; i++) {
      h.advance(MINUTE);
      await runJob("outbox", h.deps);
    }
    assertEquals([a.attempts, b.attempts, a.delivered_at, b.delivered_at], [0, 0, null, null], String(status));
    assertEquals(h.calls.length, 61, `${status}: one request a minute while paused`);

    refused = false;
    h.advance(MINUTE);
    const fixed = await runJob("outbox", h.deps);
    assert(!fixed.skipped);
    assertEquals(fixed.result, { delivered: 2, retried: 0, dead: 0, errors: 0 }, String(status));
    assertEquals([a.attempts, b.attempts], [1, 1]);
  }
});

Deno.test("outbox: a row whose record is gone is dead without a request", async () => {
  const h = harness();
  await h.store.enqueueOutbox("interaction.completed", "call-that-was-deleted");
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 1, errors: 0 });
  assertEquals(h.calls.length, 0);
  const row = outbox(h.store, "call-that-was-deleted")!;
  assertEquals([row.attempts, row.last_error], [5, "record missing"]);
});

Deno.test("outbox: the deadline stops claiming; unclaimed rows keep every attempt for the next run", async () => {
  const h = harness({
    airtable: () => {
      h.advance(5000);
      return json({ records: [{ id: "rec" }] });
    },
  });
  await queued(h.store, CALL_A, CALL_B, CALL_C);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result.delivered, 2);
  assertEquals(h.calls.length, 2);
  assertEquals(h.store.tables.outbox_events.map((o) => o.attempts), [1, 1, 0]);
});

Deno.test("outbox: the run stops after a failed delivery so one outage does not spend every row's attempt", async () => {
  const h = harness({ airtable: () => json({ error: "SERVER_ERROR" }, 503) });
  await queued(h.store, CALL_A, CALL_B);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 1, dead: 0, errors: 0 });
  assertEquals(h.store.tables.outbox_events.map((o) => o.attempts), [1, 0]);
});

Deno.test("outbox: a retryable failure on the last attempt counts as dead and the row is never claimed again", async () => {
  const h = harness({ airtable: () => json({ error: "SERVER_ERROR" }, 503) });
  await queued(h.store, CALL_A);
  outbox(h.store, CALL_A)!.attempts = 4;
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 1, errors: 0 });
  assertEquals(outbox(h.store, CALL_A)!.attempts, 5);
  h.advance(MINUTE);
  await runJob("outbox", h.deps);
  assertEquals(h.calls.length, 1);
});

Deno.test("outbox: a re-arm during a delivery is not marked done by it; the newer record goes out after the lease", async () => {
  const sent: string[] = [];
  const h = harness({
    airtable: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)).records[0].fields["Summary"]);
      if (sent.length === 1) {
        // the backfill improves the record and re-arms the row while the first request is in flight
        h.store.tables.call_interactions[0].summary = "Improved summary.";
        await h.store.enqueueOutbox("interaction.completed", CALL_A);
      }
      return json({ records: [{ id: "recA" }] });
    },
  });
  await queued(h.store, CALL_A);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 0, errors: 0 }, "the stale delivery counts for nothing");
  assertEquals(sent, ["Asked about a claim."]);
  const row = outbox(h.store, CALL_A)!;
  assertEquals([row.delivered_at, row.attempts], [null, 0], "the stale delivery did not mark the re-armed row done");
  assert(h.logs.some((l) => l.event === "outbox_superseded"));

  // Inside the lease nobody takes the re-armed row, so the stale request has finished before the
  // newer version is read: it can never land at Airtable after it.
  h.advance(OUTBOX_LEASE_MS - 1000);
  assertEquals(await deliverOutbox(h.deps, { deadlineMs: 8000 }), { delivered: 0, retried: 0, dead: 0, errors: 0 });
  assertEquals(sent.length, 1);

  h.advance(MINUTE);
  const next = await runJob("outbox", h.deps);
  assert(!next.skipped);
  assertEquals(next.result.delivered, 1);
  assertEquals(sent, ["Asked about a claim.", "Improved summary."]);
  assert(row.delivered_at);
  assertEquals(row.attempts, 1, "the re-armed row's own attempt");
});

Deno.test("outbox: two overlapping runners never take the same row; each row goes out once", async () => {
  const sent: string[] = [];
  const h = harness({
    airtable: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)).records[0].fields["Call ID"]);
      await new Promise((resolve) => setTimeout(resolve, 5)); // both runners are in flight together
      return json({ records: [{ id: `rec${sent.length}` }] });
    },
  });
  await queued(h.store, CALL_A, CALL_B);
  const [one, two] = await Promise.all([
    deliverOutbox(h.deps, { deadlineMs: 8000 }),
    deliverOutbox(h.deps, { deadlineMs: 8000 }),
  ]);
  assertEquals(one.delivered + two.delivered, 2);
  assertEquals([...sent].sort(), [CALL_A, CALL_B].sort(), "no row was claimed while another runner held it");
  assertEquals(h.store.tables.outbox_events.map((o) => [o.attempts, typeof o.delivered_at]), [
    [1, "string"],
    [1, "string"],
  ]);
  assertFalse(h.logs.some((l) => l.event === "outbox_superseded"));
});

Deno.test("outbox: a row in flight past the lease is re-claimed; the first runner's late finish is refused and it stops", async () => {
  let claimsBefore = 0;
  const h = harness({
    airtable: async () => {
      if (++claimsBefore === 1) {
        // the first delivery hangs past the lease; another runner takes the row meanwhile
        h.advance(OUTBOX_LEASE_MS + 1000);
        await deliverOutbox(h.deps, { deadlineMs: 8000 });
      }
      return json({ records: [{ id: `rec${claimsBefore}` }] });
    },
  });
  await queued(h.store, CALL_A, CALL_B);
  const first = await deliverOutbox(h.deps, { deadlineMs: 60_000 });
  assertEquals(first, { delivered: 0, retried: 0, dead: 0, errors: 0 }, "superseded: not counted, and no next claim");
  const [a, b] = [outbox(h.store, CALL_A)!, outbox(h.store, CALL_B)!];
  assertEquals([a.attempts, a.external_id, b.attempts, b.external_id], [2, "rec2", 1, "rec3"]);
  assertEquals(h.logs.filter((l) => l.event === "outbox_superseded").length, 1);
});

Deno.test("outbox: the fast path takes only its own call's row and leaves the backlog to the job", async () => {
  const h = harness({ airtable: () => json({ error: "SERVER_ERROR" }, 503) });
  await queued(h.store, CALL_A, CALL_B, CALL_C); // A and B wait from an outage; C just ended
  for (let i = 0; i < 6; i++) await deliverSoon(h.deps, CALL_C);
  const ids = h.calls.map((c) => JSON.parse(String(c.init.body)).records[0].fields["Call ID"]);
  assertEquals(ids, [CALL_C], "the backlog head is never spent by a call that ends; C itself waits out its lease");
  assertEquals(h.store.tables.outbox_events.map((o) => o.attempts), [0, 0, 1]);
  assert(h.logs.some((l) => l.event === "outbox_fast_path" && l.call_key === CALL_C && l.retried === 1));
});

Deno.test("outbox: without the Airtable token and base nothing is claimed and the result says why", async () => {
  const h = harness({ env: { ...FULL_ENV, AIRTABLE_TOKEN: undefined } });
  await queued(h.store, CALL_A);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 0, errors: 0, skipped: "airtable not configured" });
  assertEquals(outbox(h.store, CALL_A)!.attempts, 0);
  assertEquals(h.calls.length, 0);
});

Deno.test("outbox: a store failure mid-delivery is counted; the row keeps its spent attempt and stays pending", async () => {
  const h = harness();
  await queued(h.store, CALL_A, CALL_B);
  h.store.failNext("getInteractionForMirror");
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 0, errors: 1 });
  assertEquals(h.store.tables.outbox_events.map((o) => [o.attempts, o.delivered_at]), [[1, null], [0, null]]);
  assert(h.logs.some((l) => l.event === "outbox_error"));
});

Deno.test("outbox: a claim that fails after a delivery keeps that delivery's count; a first claim failure fails the run", async () => {
  const h = harness();
  await queued(h.store, CALL_A, CALL_B);
  const claim = h.store.claimOutbox;
  let claims = 0;
  h.store.claimOutbox = (limit, ref, destination) =>
    ++claims === 2 ? Promise.reject(new Error("store.claimOutbox: 57014")) : claim(limit, ref, destination);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 1, retried: 0, dead: 0, errors: 1 });
  assert(h.store.tables.job_runs[0].finished_at);

  h.store.claimOutbox = () => Promise.reject(new Error("store.claimOutbox: 57014"));
  h.advance(MINUTE);
  let failed = false;
  try {
    await runJob("outbox", h.deps);
  } catch {
    failed = true;
  }
  assert(failed, "nothing was done, so the run itself failed");
  assertEquals(h.store.tables.job_runs[1].finished_at, null);
});

Deno.test("runJob: a failing first read throws and leaves the run unfinished for the dashboard", async () => {
  const h = harness();
  h.store.failNext("listStaleEscalations");
  let failed = false;
  try {
    await runJob("sla", h.deps);
  } catch {
    failed = true;
  }
  assert(failed);
  assertEquals(h.store.tables.job_runs.map((r) => [r.job, r.finished_at]), [["sla", null]]);
});
