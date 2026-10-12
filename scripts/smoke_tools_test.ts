// Runs every smoke case in-process against the real handler and the in-memory store, so the codes
// and sentences the smoke run expects are pinned to what the webhook actually answers. No network:
// the fetch handed to the cases routes straight into handle(), and the webhook's own fetch rejects.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { createFakeStore, type FakeStore } from "../supabase/functions/vapi-webhook/fake_store.ts";
import { handle } from "../supabase/functions/vapi-webhook/handler.ts";
import type { Deps } from "../supabase/functions/vapi-webhook/types.ts";
import { cleanupSql, loadEocrFixture, runSmoke, SMOKE_PREFIX, smokeCases, type SmokeDb } from "./smoke_tools.ts";

const SECRET = "smoke-test-secret-0123456789";
const ORG = "4f1c2d3e-0000-4000-8000-00000000a0a0";
const URL_BASE = "https://example.supabase.co/functions/v1/vapi-webhook";
const NOW = new Date("2026-10-12T15:00:00Z");

const noNetwork = (() => Promise.reject(new Error("network disabled in unit tests"))) as typeof fetch;

function harness(env: Partial<Deps["env"]> = {}) {
  const store = createFakeStore();
  const background: Promise<unknown>[] = [];
  const deps: Deps = {
    store,
    fetch: noNetwork,
    env: { VAPI_ORG_ID: ORG, VAPI_WEBHOOK_SECRET: SECRET, ...env },
    now: () => NOW,
    waitUntil: (p) => {
      background.push(p);
    },
    log: () => {},
  };
  const inProcess =
    ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), deps)) as typeof fetch;
  return { store, deps, background, inProcess };
}

function fakeDb(store: FakeStore): SmokeDb {
  const t = store.tables;
  return {
    attempts: (k) => Promise.resolve(t.attempts.filter((r) => r.call_key === k)),
    escalations: (k) => Promise.resolve(t.escalations.filter((r) => r.call_key === k)),
    interaction: (k) => Promise.resolve(t.call_interactions.find((r) => r.vapi_call_id === k) ?? null),
    transcriptLines: (k) =>
      Promise.resolve(t.transcript_lines.filter((r) => r.call_key === k).sort((a, b) => a.ts_ms - b.ts_ms)),
  };
}

Deno.test("every smoke case passes against the in-process webhook", async () => {
  const { store, background, inProcess } = harness();
  const results = await runSmoke({
    target: { url: URL_BASE, secret: SECRET, fetch: inProcess },
    orgId: ORG,
    runId: "20261012150000",
    db: fakeDb(store),
    now: () => NOW,
    rowWaitMs: 0,
  });
  await Promise.allSettled(background);
  const failures = results.filter((r) => !r.pass).map((r) => `${r.name}: ${r.problems.join(" | ")}`);
  assertEquals(failures, []);
  assertEquals(results.map((r) => r.name), smokeCases().map((c) => c.name));
  assert(results.every((r) => r.requests > 0));
});

Deno.test("smoke cases still pass when native tool messages are off", async () => {
  const { store, background, inProcess } = harness({ NATIVE_TOOL_MESSAGES: "false" });
  const results = await runSmoke({
    target: { url: URL_BASE, secret: SECRET, fetch: inProcess },
    orgId: ORG,
    runId: "20261012150001",
    db: fakeDb(store),
    now: () => NOW,
    rowWaitMs: 0,
  }, ["happy-path", "chat-escalate"]);
  await Promise.allSettled(background);
  assertEquals(results.filter((r) => !r.pass).map((r) => r.problems), []);
});

Deno.test("every call key a smoke run writes starts with the cleanup prefix", async () => {
  const { store, background, inProcess } = harness();
  await runSmoke({
    target: { url: URL_BASE, secret: SECRET, fetch: inProcess },
    orgId: ORG,
    runId: "20261012150002",
    db: fakeDb(store),
    now: () => NOW,
    rowWaitMs: 0,
  });
  await Promise.allSettled(background);
  const keys = [
    ...store.tables.attempts.map((r) => r.call_key),
    ...store.tables.call_sessions.map((r) => r.call_key),
    ...store.tables.escalations.map((r) => r.call_key),
    ...store.tables.emails.map((r) => r.call_key),
    ...store.tables.transcript_lines.map((r) => r.call_key),
    ...store.tables.call_interactions.map((r) => r.vapi_call_id),
  ];
  assert(keys.length > 0);
  for (const k of keys) assert(k.startsWith(SMOKE_PREFIX), k);
  // no email row and no delivered alert: a smoke run never pages anyone
  assertEquals(store.tables.emails.length, 0);
  assert(store.tables.escalations.every((e) => e.alert_status === "skipped"));
});

Deno.test("a wrong expectation is reported as a failure, not thrown", async () => {
  const { inProcess } = harness({ VAPI_WEBHOOK_SECRET: "a-different-secret" });
  const results = await runSmoke({
    target: { url: URL_BASE, secret: SECRET, fetch: inProcess },
    orgId: ORG,
    runId: "20261012150003",
    now: () => NOW,
    rowWaitMs: 0,
  }, ["happy-path", "invalid-phone"]);
  assertEquals(results.length, 2);
  for (const r of results) {
    assertEquals(r.pass, false);
    assertStringIncludes(r.problems[0], "HTTP 401");
  }
});

Deno.test("cleanup SQL covers every call table and only the smoke prefix", () => {
  const sql = cleanupSql();
  for (
    const table of [
      "attempts",
      "call_sessions",
      "escalations",
      "emails",
      "transcript_lines",
      "call_interactions",
      "webhook_captures",
    ]
  ) {
    assertStringIncludes(sql, `delete from ${table} where`);
  }
  assertEquals(sql.match(/like 'smoke-%'/g)?.length, 7);
  assert(!/delete from \w+ returning/.test(sql), "an unfiltered delete");
  assertThrows(() => cleanupSql("%"));
  assertThrows(() => cleanupSql("smoke"));
});

Deno.test("the post-call cases pass with the captured end-of-call-report fixture, when present", async () => {
  const fixture = loadEocrFixture();
  if (fixture === undefined) return; // no capture in the repo: the inline report is covered above
  const { store, background, inProcess } = harness();
  const results = await runSmoke({
    target: { url: URL_BASE, secret: SECRET, fetch: inProcess },
    orgId: ORG,
    runId: "20261012150004",
    db: fakeDb(store),
    eocrFixture: fixture,
    now: () => NOW,
    rowWaitMs: 0,
  }, ["status-update", "transcript", "end-of-call-report"]);
  await Promise.allSettled(background);
  assertEquals(results.filter((r) => !r.pass).map((r) => r.problems), []);
  // the fixture's own call id never reaches the database: every row is keyed by the smoke run
  assertEquals(store.tables.call_interactions.map((r) => r.vapi_call_id), [`${SMOKE_PREFIX}20261012150004-lifecycle`]);
});
