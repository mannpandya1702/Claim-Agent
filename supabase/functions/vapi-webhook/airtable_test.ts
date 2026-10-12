import { assert, assertEquals, assertFalse } from "@std/assert";
import { interactionToFields, type InteractionForMirror, MERGE_FIELD, upsertCallRecord } from "./airtable.ts";
import type { Deps, Env } from "./types.ts";

const row: InteractionForMirror = {
  vapi_call_id: "call-abc-123",
  channel: "webCall",
  caller_name: "Tobias Halvorsen",
  caller_phone: "+16025550101",
  summary: "Tobias asked about two claims and was told the payment was issued.",
  sentiment: "positive",
  outcome: "resolved",
  escalated: false,
  emergency: false,
  flags: [],
  started_at: "2026-10-12T15:00:00.000Z",
  ended_at: "2026-10-12T15:02:10.000Z",
  duration_seconds: 130,
  cost: "0.1234",
  analysis_status: "ok",
};

function deps(env: Partial<Env>, fetchImpl: typeof fetch): Deps {
  return {
    store: {} as Deps["store"],
    fetch: fetchImpl,
    env: { VAPI_ORG_ID: "org", VAPI_WEBHOOK_SECRET: "s", ...env },
    now: () => new Date("2026-10-12T15:03:00Z"),
    waitUntil: () => {},
    log: () => {},
  };
}

const configured = { AIRTABLE_TOKEN: "pat123", AIRTABLE_BASE_ID: "appBASE" };

Deno.test("interactionToFields: slim, redacted mapping with the merge key and a dashboard link", () => {
  const f = interactionToFields(row, new Date("2026-10-12T15:03:00Z"), "https://example.github.io/Claim-Agent/");
  assertEquals(f[MERGE_FIELD], "call-abc-123");
  assertEquals(f["Caller Phone"], "ending 0101");
  assertEquals(f["Cost (USD)"], 0.1234);
  assertEquals(f["Dashboard"], "https://example.github.io/Claim-Agent/#/calls/call-abc-123");
  assertEquals(f["Synced At"], "2026-10-12T15:03:00.000Z");
  // the full number never crosses the boundary, and nothing transcript-shaped is mapped
  assertFalse(JSON.stringify(f).includes("6025550101"));
  assertFalse("Transcript" in f);
});

Deno.test("interactionToFields: nulls are omitted so Airtable keeps the cell instead of rejecting the type", () => {
  const f = interactionToFields(
    { ...row, caller_name: null, caller_phone: null, sentiment: null, cost: null, started_at: null },
    new Date(),
  );
  assertEquals(f["Caller Name"], "Unknown caller");
  for (const k of ["Caller Phone", "Sentiment", "Cost (USD)", "Started At", "Dashboard"]) assertFalse(k in f, k);
});

Deno.test("upsertCallRecord: PATCH with performUpsert on Call ID, typecast and Bearer auth", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(
      new Response(JSON.stringify({ records: [{ id: "rec1", fields: {} }], createdRecords: ["rec1"], updatedRecords: [] })),
    );
  }) as unknown as typeof fetch;
  const r = await upsertCallRecord(deps(configured, fetchImpl), { [MERGE_FIELD]: "call-abc-123" });
  assertEquals(r, { ok: true, recordId: "rec1", created: true });
  assert(seen);
  const s = seen as { url: string; init: RequestInit };
  assertEquals(s.url, "https://api.airtable.com/v0/appBASE/Call%20Log");
  assertEquals(s.init.method, "PATCH");
  assertEquals((s.init.headers as Record<string, string>).Authorization, "Bearer pat123");
  const body = JSON.parse(String(s.init.body));
  assertEquals(body.performUpsert, { fieldsToMergeOn: [MERGE_FIELD] });
  assertEquals(body.typecast, true);
  assertEquals(body.records.length, 1);
});

Deno.test("upsertCallRecord: a second delivery of the same call reports an update, not a create", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ records: [{ id: "rec1" }], createdRecords: [], updatedRecords: ["rec1"] })),
    )) as unknown as typeof fetch;
  const r = await upsertCallRecord(deps(configured, fetchImpl), { [MERGE_FIELD]: "x" });
  assertEquals(r, { ok: true, recordId: "rec1", created: false });
});

Deno.test("upsertCallRecord: failures are classified so the outbox retries only what a retry can fix", async () => {
  const respond = (status: number, body: unknown) =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
  const cases: [number, boolean][] = [[429, true], [503, true], [401, false], [403, false], [404, false], [422, false]];
  for (const [status, retryable] of cases) {
    const r = await upsertCallRecord(deps(configured, respond(status, { error: { type: "X", message: "m" } })), {});
    assert(!r.ok);
    assertEquals(r.retryable, retryable, `status ${status}`);
    assertEquals(r.status, status);
  }
  const throwing = (() => Promise.reject(new DOMException("t", "TimeoutError"))) as unknown as typeof fetch;
  const t = await upsertCallRecord(deps(configured, throwing), {});
  assert(!t.ok && t.retryable && t.error === "timeout");
});

Deno.test("upsertCallRecord: unconfigured is a non-retryable failure and never calls fetch", async () => {
  let called = false;
  const fetchImpl = (() => {
    called = true;
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
  const r = await upsertCallRecord(deps({}, fetchImpl), {});
  assert(!r.ok && !r.retryable);
  assertFalse(called);
});
