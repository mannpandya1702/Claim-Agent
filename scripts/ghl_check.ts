// deno task ghl:check --call <vapi_call_id> [--wait] [--enqueue]
//
// Runs the GoHighLevel delivery of one call against live GHL, through the same outbox path the
// every-minute job takes (the claim with its lease, deliverGhl step by step, the guarded finish),
// and prints the call's ghl outbox row before and after: attempts, due time, last error, the
// contact id and the progress (tags, note id, task ids, or the reason it was skipped). For the live
// test after a deploy: the deployed post-call writer queues the row 90 s after the call ends.
//   --wait     a row not yet claimable (its 90 s delay, a retry-after, a lease) is waited for, up
//              to 150 s, instead of only printed
//   --enqueue  a call without a ghl row (one that ended before GHL was configured) is queued, due
//              at once; an existing row is re-armed (attempts reset, progress kept, so a delivered
//              row replays with zero requests and a half-done one adds only the missing steps)
// A delivered row is printed and left alone. Exit code 0 when the row ends delivered, 1 when not,
// 2 for bad arguments or missing configuration, 3 when the row is not claimable yet (no --wait).
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GHL_TOKEN and GHL_LOCATION_ID in .env (optional:
// GHL_ASSIGNEE_USER_ID, GHL_EMERGENCY_USER_ID, DASHBOARD_URL, OWN_NUMBERS). No token is printed.

import { createClient } from "@supabase/supabase-js";
import { ghlConfigured } from "../supabase/functions/vapi-webhook/ghl.ts";
import { deliverOutbox, type OutboxCounts } from "../supabase/functions/vapi-webhook/outbox.ts";
import { createStore } from "../supabase/functions/vapi-webhook/store.ts";
import { OUTBOX_LEASE_MS, OUTBOX_MAX_ATTEMPTS, outboxDue } from "../supabase/functions/vapi-webhook/store_rules.ts";
import type { Deps, Env, OutboxRef } from "../supabase/functions/vapi-webhook/types.ts";
import { loadEnv, need } from "./lib/env.ts";

const USAGE = "usage: deno task ghl:check --call <vapi_call_id> [--wait] [--enqueue]";
/** The job's own run deadline (jobs.ts), so a run here does what one job run would. */
const DEADLINE_MS = 8000;
const MAX_WAIT_MS = 150_000;
const ROW_COLUMNS = "id, attempts, delivered_at, next_attempt_at, last_error, external_id, progress, created_at, " +
  "updated_at";
// The function environment the delivery reads; the rest of Env plays no part in it.
const ENV_KEYS = [
  "GHL_TOKEN",
  "GHL_LOCATION_ID",
  "GHL_ASSIGNEE_USER_ID",
  "GHL_EMERGENCY_USER_ID",
  "DASHBOARD_URL",
  "OWN_NUMBERS",
] as const satisfies readonly (keyof Env)[];

export interface CheckArgs {
  call: string;
  wait: boolean;
  enqueue: boolean;
}

export function parseArgs(args: string[]): CheckArgs | null {
  const out: CheckArgs = { call: "", wait: false, enqueue: false };
  const rest = args.filter((a) => a !== "--");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--wait") out.wait = true;
    else if (a === "--enqueue") out.enqueue = true;
    else if (a === "--call" && i + 1 < rest.length) out.call = rest[++i].trim();
    else if (a.startsWith("--call=")) out.call = a.slice("--call=".length).trim();
    else return null;
  }
  return out.call ? out : null;
}

/** The function environment for the delivery, from .env: only the keys it reads, never blank. */
export function functionEnv(env: Record<string, string>): Env {
  const out: Env = { VAPI_ORG_ID: "", VAPI_WEBHOOK_SECRET: "" };
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

export interface GhlRow {
  id: string;
  attempts: number;
  delivered_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  external_id: string | null;
  progress: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Where the row stands at `nowMs`, and when a claim could take it (epoch ms) when it is waiting.
 *  The same rules as store_rules.ts outboxClaimable: due, and either never written since its
 *  insert or not written for the whole lease. */
export function rowState(
  row: GhlRow,
  nowMs: number,
): { state: "delivered" | "dead" | "claimable" | "waiting"; at?: number } {
  if (row.delivered_at !== null) return { state: "delivered" };
  if (row.attempts >= OUTBOX_MAX_ATTEMPTS) return { state: "dead" };
  const leaseEnds = row.updated_at === row.created_at ? 0 : Date.parse(row.updated_at) + OUTBOX_LEASE_MS;
  const dueAt = outboxDue(row, nowMs) ? 0 : Date.parse(row.next_attempt_at ?? "");
  const at = Math.max(leaseEnds, Number.isFinite(dueAt) ? dueAt : 0);
  return at <= nowMs ? { state: "claimable" } : { state: "waiting", at };
}

/** The row as printed: ids, counts, times, the masked last error and the progress (GHL ids, tags
 *  and skip reasons only; progress never holds a name, a number or an address). */
export function describeRow(row: GhlRow, nowMs: number): string {
  const s = rowState(row, nowMs);
  const lines = [
    `state: ${s.state}${s.at ? ` (claimable at ${new Date(s.at).toISOString()})` : ""}`,
    `attempts: ${row.attempts}/${OUTBOX_MAX_ATTEMPTS}`,
    `delivered_at: ${row.delivered_at ?? "-"}`,
    `next_attempt_at: ${row.next_attempt_at ?? "-"}`,
    `last_error: ${row.last_error ?? "-"}`,
    `contact id (external_id): ${row.external_id ?? "-"}`,
    `progress: ${JSON.stringify(row.progress ?? {})}`,
  ];
  return lines.map((l) => `  ${l}`).join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const env = loadEnv();
  const [supabaseUrl, serviceRoleKey] = need(
    env,
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GHL_TOKEN",
    "GHL_LOCATION_ID",
  );
  const fnEnv = functionEnv(env);
  if (!ghlConfigured(fnEnv)) {
    console.error("GHL_TOKEN and GHL_LOCATION_ID must be non-blank");
    return 2;
  }
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const deps: Deps = {
    store: createStore(supabaseUrl, serviceRoleKey),
    fetch: globalThis.fetch.bind(globalThis),
    env: fnEnv,
    now: () => new Date(),
    waitUntil: () => {},
    log: (event) => console.error(JSON.stringify(event)),
  };
  const ref: OutboxRef = { kind: "interaction.completed", refId: args.call, destination: "ghl" };
  const readRow = async (): Promise<GhlRow | null> => {
    const { data, error } = await db.from("outbox_events").select(ROW_COLUMNS).eq("kind", ref.kind)
      .eq("ref_id", ref.refId).eq("destination", ref.destination).maybeSingle();
    if (error) throw new Error(`outbox_events read failed: ${error.message}`);
    return (data as GhlRow | null) ?? null;
  };

  if (!fnEnv.DASHBOARD_URL) console.error("note: DASHBOARD_URL is not in .env, so the note carries no dashboard link");
  let row = await readRow();
  console.log(`call ${args.call}, ghl outbox row before:`);
  console.log(row ? describeRow(row, Date.now()) : "  none");
  if (row?.delivered_at && !args.enqueue) return 0;

  if (args.enqueue) {
    if (!(await deps.store.getInteractionForGhl(args.call))) {
      console.error("no call_interactions row for that call id");
      return 1;
    }
    await deps.store.enqueueOutbox("interaction.completed", args.call, "ghl", 0);
    row = await readRow();
    console.log(row && row.created_at === row.updated_at ? "queued, due now" : "re-armed (progress kept)");
  }
  if (!row) {
    console.error("no ghl row for this call: it ended before GHL was configured, or the deploy is older (--enqueue)");
    return 1;
  }

  let state = rowState(row, Date.now());
  if (state.state === "waiting") {
    const waitMs = (state.at ?? 0) - Date.now() + 1000;
    if (!args.wait || waitMs > MAX_WAIT_MS) {
      console.log(
        `not claimable yet (in ${Math.ceil(waitMs / 1000)} s)${
          args.wait ? ", more than the wait allows" : "; --wait waits"
        }`,
      );
      return 3;
    }
    console.log(`waiting ${Math.ceil(waitMs / 1000)} s for the row to be claimable`);
    await new Promise((r) => setTimeout(r, waitMs));
    state = rowState(row, Date.now());
  }
  if (state.state !== "claimable") {
    console.log(`not delivered: the row is ${state.state}${state.state === "dead" ? " (--enqueue re-arms it)" : ""}`);
    return 1;
  }

  const counts: OutboxCounts = await deliverOutbox(deps, { deadlineMs: DEADLINE_MS, ref });
  console.log(`delivery: ${JSON.stringify(counts)}`);
  row = await readRow();
  console.log("ghl outbox row after:");
  console.log(row ? describeRow(row, Date.now()) : "  none");
  return row?.delivered_at ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
