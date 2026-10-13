import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  airtableConfigured,
  interactionToFields,
  type InteractionForMirror,
  MERGE_FIELD,
  MIRROR_COLUMNS,
  upsertCallRecord,
} from "./airtable.ts";
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
  caller_type: "existing",
  caller_email: null,
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

Deno.test("interactionToFields: the dashboard link goes through the alerts' guard (no credentials, http(s) only)", () => {
  const at = new Date("2026-10-12T15:03:00Z");
  for (
    const bad of [
      "https://user:secret@preview.example.com/",
      "https://token@preview.example.com/",
      "javascript:alert(1)//",
      "ftp://files.example.com/",
      "not a url",
      "https://example.com/a b",
      "",
    ]
  ) {
    const f = interactionToFields(row, at, bad);
    assertFalse("Dashboard" in f, bad);
    assertFalse(JSON.stringify(f).includes("secret"), bad);
  }
  // a fragment already on the base is dropped, as in the alerts and emails
  assertEquals(
    interactionToFields(row, at, " https://staff.example.com/app/#/old ")["Dashboard"],
    "https://staff.example.com/app/#/calls/call-abc-123",
  );
  // a call id that is not id-shaped gives no link rather than a mangled one
  assertFalse("Dashboard" in interactionToFields({ ...row, vapi_call_id: "x y<z>" }, at, "https://staff.example.com/"));
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
  // [status, retryable, config]: config is a setting every row shares (token, scope, base, table)
  const cases: [number, boolean, boolean][] = [
    [429, true, false],
    [500, true, false],
    [503, true, false],
    [401, false, true],
    [403, false, true],
    [404, false, true],
    [422, false, false],
    [400, false, false],
  ];
  for (const [status, retryable, config] of cases) {
    const r = await upsertCallRecord(deps(configured, respond(status, { error: { type: "X", message: "m" } })), {});
    assert(!r.ok);
    assertEquals([r.retryable, r.config === true], [retryable, config], `status ${status}`);
    assertEquals(r.status, status);
    assertEquals(r.error, `airtable ${status}: m`);
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
  assert(!r.ok && !r.retryable && r.config === true);
  assertFalse(called);
});

Deno.test("MIRROR_COLUMNS is exactly the InteractionForMirror shape the mapping reads", () => {
  assertEquals([...MIRROR_COLUMNS].sort(), Object.keys(row).sort());
  assertEquals(new Set(MIRROR_COLUMNS).size, MIRROR_COLUMNS.length);
  // never the transcript, the messages or anything else the mirror must not carry
  for (const c of ["transcript", "messages", "analysis_raw", "recording_url", "customer_id"]) {
    assertFalse((MIRROR_COLUMNS as readonly string[]).includes(c), c);
  }
});

Deno.test("airtableConfigured: both the token and the base id, ignoring blanks", () => {
  assert(airtableConfigured(configured));
  assertFalse(airtableConfigured({ AIRTABLE_TOKEN: "pat123" }));
  assertFalse(airtableConfigured({ AIRTABLE_BASE_ID: "appBASE" }));
  assertFalse(airtableConfigured({ AIRTABLE_TOKEN: " ", AIRTABLE_BASE_ID: "appBASE" }));
});

Deno.test("interactionToFields: Caller Type always, and the confirmed caller-given Email when there is one", () => {
  const at = new Date("2026-10-12T15:03:00Z");
  const existing = interactionToFields(row, at);
  assertEquals(existing["Caller Type"], "existing");
  assertFalse("Email" in existing, "no address: the cell is left alone");
  const fresh = interactionToFields(
    { ...row, caller_name: "Jane Doe", caller_type: "new", caller_email: " jane.doe@gmail.com ", caller_phone: "+16025550177" },
    at,
  );
  assertEquals([fresh["Caller Name"], fresh["Caller Type"], fresh["Email"], fresh["Caller Phone"]], [
    "Jane Doe",
    "new",
    "jane.doe@gmail.com",
    "ending 0177",
  ]);
  // a row from before the column existed reads as unknown
  assertEquals(interactionToFields({ ...row, caller_type: null, caller_email: "" }, at)["Caller Type"], "unknown");
  assertFalse("Email" in interactionToFields({ ...row, caller_email: "" }, at));
});

Deno.test("upsertCallRecord: a field the table lacks pauses the outbox (config) instead of killing the row", async () => {
  const respond = (body: unknown) =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status: 422 }))) as unknown as typeof fetch;
  const unknownField = await upsertCallRecord(
    deps(configured, respond({ error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Caller Type"' } })),
    {},
  );
  assert(!unknownField.ok);
  assertEquals([unknownField.retryable, unknownField.config], [false, true]);
  // any other 422 is still this record's value, which a retry cannot fix
  const badValue = await upsertCallRecord(
    deps(configured, respond({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: "m" } })),
    {},
  );
  assert(!badValue.ok);
  assertEquals([badValue.retryable, badValue.config === true], [false, false]);
});
