// Pure rules both stores share, so the in-memory store and the supabase-js store cannot drift:
// what an outbox error looks like once stored, when an outbox row may be claimed (its lease and its
// next_attempt_at) and when a call is missing from the call log, how the digest counts its rows,
// and the caps on the scheduled jobs' work lists. No I/O and no supabase-js here (fake_store.ts
// imports it).

import { ESCALATION_STATUSES, type OutboxDestination, OUTCOMES, SENTIMENTS } from "./enums.ts";
import { redactPII } from "./redact.ts";
import type { DigestStats } from "./types.ts";

/** claim_outbox stops claiming a row at this many attempts (0005_outbox.sql). */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** Rows one sla or reaper run may take; the rest wait for the next run. */
export const JOB_LIST_LIMIT = 50;
/** How long any write to an outbox row (a claim, a failed delivery, a re-arm) keeps it from being
 *  claimed. Far above one delivery (a 5 s upsert between two 5 s store calls), so a row is never
 *  delivered twice at once, and a delivery that started before a re-arm has finished before the
 *  re-armed version is read. */
export const OUTBOX_LEASE_MS = 30_000;

/** How far past the caller's clock store.ts reads candidate rows by next_attempt_at. The Edge
 *  Function's clock and the database's can differ by a little; the exact check is outboxDue. */
export const OUTBOX_DUE_SLACK_MS = 5000;

/** The outbox_events columns the lease and the due time read. */
export interface OutboxLeaseRow {
  delivered_at: string | null;
  attempts: number;
  created_at: string;
  updated_at: string; // touch_updated_at: now() of the last write
  next_attempt_at?: string | null; // 0008_ghl.sql; absent reads as due
}

/** Whether the row's next_attempt_at has come at `nowMs`. A row inserted with no delay holds
 *  next_attempt_at = created_at (one now()), so it is due at once whatever the caller's clock says,
 *  like the fresh-insert rule of the lease. */
export function outboxDue(row: OutboxLeaseRow, nowMs: number): boolean {
  if (typeof row.next_attempt_at !== "string") return true;
  const next = Date.parse(row.next_attempt_at);
  if (!Number.isFinite(next)) return true;
  return next <= Date.parse(row.created_at) || next <= nowMs;
}

/** Whether a claim may take the row at `nowMs`: undelivered, attempts left, due (next_attempt_at),
 *  and either never written since its insert (both timestamps are the insert's now()) or not written
 *  for the whole lease. */
export function outboxClaimable(row: OutboxLeaseRow, nowMs: number): boolean {
  if (row.delivered_at !== null || row.attempts >= OUTBOX_MAX_ATTEMPTS) return false;
  if (!outboxDue(row, nowMs)) return false;
  if (row.updated_at === row.created_at) return true;
  const touched = Date.parse(row.updated_at);
  return Number.isFinite(touched) && touched < nowMs - OUTBOX_LEASE_MS;
}

/** Whether an ended call is missing from a destination: no outbox row at all (its enqueue failed),
 *  or, for the call log, a row delivered before the record last changed (the re-arm after a backfill
 *  failed). A staff note also moves updated_at; the upsert on Call ID makes that extra delivery a
 *  no-op. GoHighLevel never posts a delivered call again, so only its missing row is a gap. */
export function outboxGap(
  recordUpdatedAt: string,
  outbox: { delivered_at: string | null } | undefined,
  destination: OutboxDestination = "airtable",
): boolean {
  if (!outbox) return true;
  if (destination === "ghl") return false;
  if (outbox.delivered_at === null) return false;
  return Date.parse(recordUpdatedAt) > Date.parse(outbox.delivered_at);
}

const MAX_OUTBOX_ERROR = 300;
// A receiver can quote a value back in its error (a phone number, an account or record number);
// any run this long is masked whatever it is.
const LONG_DIGITS_RE = /\d{7,}/g;

/** outbox_events.last_error as stored: runs of 7+ digits masked whole, then redacted, one line, 300
 *  chars. The digit runs go first: redactPII reads a bare 7 to 15 digit run as a phone number and keeps
 *  its last four, and an account or record number quoted in an error keeps none. */
export function outboxErrorText(error: unknown): string {
  const text = typeof error === "string" && error.trim() ? error : "delivery failed";
  return redactPII(text.slice(0, 2000).replace(LONG_DIGITS_RE, "[digits]")).replace(/\s+/g, " ").trim()
    .slice(0, MAX_OUTBOX_ERROR);
}

/** The call_interactions columns digestFromRows reads; both stores select only these. */
export interface DigestCallRow {
  outcome: string | null;
  sentiment: string | null;
  flags: string[] | null;
  cost: number | string | null;
  ended_at: string | null;
}

// Keys in the enum order, then anything off the list, then "unknown", so the email reads the same
// every day whatever order the rows came back in.
function tally(values: (string | null)[], order: readonly string[], withZeros: boolean): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = typeof v === "string" && v ? v : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const key of order) {
    if (withZeros || counts.has(key)) out[key] = counts.get(key) ?? 0;
  }
  const rest = [...counts.keys()].filter((k) => !order.includes(k) && k !== "unknown").sort();
  for (const key of rest) out[key] = counts.get(key)!;
  if (counts.has("unknown")) out.unknown = counts.get("unknown")!;
  return out;
}

/** The digest numbers from the selected rows. Cost arrives as a number or a numeric string. */
export function digestFromRows(
  calls: DigestCallRow[],
  escalationStatuses: string[],
  emailsSent: number,
): DigestStats {
  let cost = 0;
  for (const c of calls) {
    const n = c.cost === null || c.cost === undefined || c.cost === "" ? Number.NaN : Number(c.cost);
    if (Number.isFinite(n)) cost += n;
  }
  return {
    calls: calls.length,
    completed: calls.filter((c) => c.ended_at !== null && c.ended_at !== undefined).length,
    outcomes: tally(calls.map((c) => c.outcome), OUTCOMES, false),
    sentiments: tally(calls.map((c) => c.sentiment), SENTIMENTS, false),
    flagged: calls.filter((c) => Array.isArray(c.flags) && c.flags.length > 0).length,
    escalations: tally(escalationStatuses, ESCALATION_STATUSES, true),
    emails_sent: emailsSent,
    // numeric(10,4) per row; the sum is rounded the same way so float noise never shows
    total_cost: Math.round(cost * 1e4) / 1e4,
  };
}
