// scripts/ghl_check.ts: argument parsing, the environment it hands the delivery, and how it reads
// a ghl outbox row (the claim rules of store_rules.ts). No network.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { OUTBOX_LEASE_MS } from "../supabase/functions/vapi-webhook/store_rules.ts";
import { describeRow, functionEnv, type GhlRow, parseArgs, rowState } from "./ghl_check.ts";

const T0 = Date.parse("2026-10-13T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const base = (over: Partial<GhlRow> = {}): GhlRow => ({
  id: "9b1d2c3e-0000-4000-8000-0000000000aa",
  attempts: 0,
  delivered_at: null,
  next_attempt_at: iso(T0),
  last_error: null,
  external_id: null,
  progress: {},
  created_at: iso(T0),
  updated_at: iso(T0),
  ...over,
});

Deno.test("ghl:check args: --call is required; --wait and --enqueue are flags; anything else is refused", () => {
  assertEquals(parseArgs(["--call", "abc"]), { call: "abc", wait: false, enqueue: false });
  assertEquals(parseArgs(["--", "--call=abc", "--wait", "--enqueue"]), { call: "abc", wait: true, enqueue: true });
  assertEquals(parseArgs([]), null);
  assertEquals(parseArgs(["--call"]), null);
  assertEquals(parseArgs(["--call", "abc", "--force"]), null);
  assertEquals(parseArgs(["abc"]), null);
});

Deno.test("ghl:check env: only the keys the delivery reads, blanks left out", () => {
  const env = functionEnv({
    GHL_TOKEN: " pit ",
    GHL_LOCATION_ID: "loc",
    GHL_ASSIGNEE_USER_ID: "",
    DASHBOARD_URL: "https://staff.example.com/",
    SUPABASE_SERVICE_ROLE_KEY: "never-copied",
    RESEND_API_KEY: "never-copied",
  });
  assertEquals(env, {
    VAPI_ORG_ID: "",
    VAPI_WEBHOOK_SECRET: "",
    GHL_TOKEN: "pit",
    GHL_LOCATION_ID: "loc",
    DASHBOARD_URL: "https://staff.example.com/",
  });
});

Deno.test("ghl:check row state: the claim's rules (due time, lease, delivered, dead)", () => {
  assertEquals(rowState(base(), T0), { state: "claimable" });
  // queued 90 s out: waiting until next_attempt_at
  assertEquals(rowState(base({ next_attempt_at: iso(T0 + 90_000) }), T0), { state: "waiting", at: T0 + 90_000 });
  // written since its insert (a claim, a progress save, a re-arm): the lease holds it
  const touched = base({ updated_at: iso(T0 + 1000), next_attempt_at: iso(T0) });
  assertEquals(rowState(touched, T0 + 2000), { state: "waiting", at: T0 + 1000 + OUTBOX_LEASE_MS });
  assertEquals(rowState(touched, T0 + 1000 + OUTBOX_LEASE_MS + 1), { state: "claimable" });
  assertEquals(rowState(base({ delivered_at: iso(T0) }), T0), { state: "delivered" });
  assertEquals(rowState(base({ attempts: 5 }), T0), { state: "dead" });
});

Deno.test("ghl:check prints the row's ids, counts and progress", () => {
  const text = describeRow(
    base({ attempts: 1, external_id: "cont123", progress: { contact_id: "cont123", tags_done: true } }),
    T0,
  );
  assertStringIncludes(text, "state: claimable");
  assertStringIncludes(text, "attempts: 1/5");
  assertStringIncludes(text, "contact id (external_id): cont123");
  assertStringIncludes(text, `progress: {"contact_id":"cont123","tags_done":true}`);
});
