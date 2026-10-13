// Integration #2, second destination: the post-call record mirrored to an Airtable call log.
//
// Supabase stays the system of record; Airtable is the external system a claims team would
// actually work in. Delivery goes through outbox_events and is at-least-once, so the write must
// be idempotent: Airtable's upsert (performUpsert, merged on "Call ID") updates the existing
// record instead of creating a duplicate when the same call is delivered twice or re-delivered
// after a backfill improved the row.
//
// Only already-redacted, slim fields cross the boundary: no transcript, no messages, no DOB, and
// the caller's number as its last four digits only. The one address that crosses is the email a new
// caller spelled and confirmed (caller_email), which the claims team needs to follow up; the
// account's own email is never in the record. Why the caller called (call_reason) and the claim a
// phone claim filed (claim_number) cross as they are stored; a call without them leaves the cells.

import { dashboardLink } from "./alert.ts";
import type { Deps } from "./types.ts";

export const DEFAULT_TABLE = "Call Log";
export const MERGE_FIELD = "Call ID";

// The call_interactions columns the mirror reads (selected fresh at delivery time).
export interface InteractionForMirror {
  vapi_call_id: string;
  channel: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  summary: string | null;
  sentiment: string | null;
  outcome: string | null;
  escalated: boolean;
  emergency: boolean;
  flags: string[] | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  cost: number | string | null;
  analysis_status: string | null;
  caller_type: string | null;
  caller_email: string | null;
  // 0007_fnol_reasons.sql. Optional so a record built without them (a test fixture, a caller older
  // than the columns) still maps; store.ts always selects them.
  call_reason?: string | null;
  claim_number?: string | null;
}

/** Exactly the InteractionForMirror columns, in the select list store.ts sends. */
export const MIRROR_COLUMNS = [
  "vapi_call_id",
  "channel",
  "caller_name",
  "caller_phone",
  "summary",
  "sentiment",
  "outcome",
  "escalated",
  "emergency",
  "flags",
  "started_at",
  "ended_at",
  "duration_seconds",
  "cost",
  "analysis_status",
  "caller_type",
  "caller_email",
  "call_reason",
  "claim_number",
] as const satisfies readonly (keyof InteractionForMirror)[];
// A column added to the interface but not to the list fails the type check here.
const _everyMirrorColumn: Exclude<keyof InteractionForMirror, typeof MIRROR_COLUMNS[number]> extends never ? true
  : never = true;
void _everyMirrorColumn;

/** Both values the upsert needs; without them the mirror is off, not failing. */
export function airtableConfigured(env: { AIRTABLE_TOKEN?: string; AIRTABLE_BASE_ID?: string }): boolean {
  return !!env?.AIRTABLE_TOKEN?.trim() && !!env?.AIRTABLE_BASE_ID?.trim();
}

// config: the destination refused the request whatever the record held (token, scope, base or table),
// so no row is to blame and every row would fail the same way until the setting is fixed.
export type AirtableResult =
  | { ok: true; recordId: string; created: boolean }
  | { ok: false; status?: number; error: string; retryable: boolean; config?: boolean };

function phoneEnding(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `ending ${digits.slice(-4)}` : null;
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

/** Pure mapping from the stored record to Airtable fields (field names are the table's schema). */
export function interactionToFields(
  row: InteractionForMirror,
  syncedAt: Date,
  dashboardUrl?: string,
): Record<string, unknown> {
  const cost = row.cost === null || row.cost === undefined ? null : Number(row.cost);
  const fields: Record<string, unknown> = {
    [MERGE_FIELD]: row.vapi_call_id,
    "Caller Name": row.caller_name ?? "Unknown caller",
    "Caller Phone": phoneEnding(row.caller_phone),
    "Caller Type": row.caller_type ?? "unknown",
    "Email": typeof row.caller_email === "string" && row.caller_email.trim() ? row.caller_email.trim() : null,
    "Channel": row.channel,
    "Outcome": row.outcome,
    "Sentiment": row.sentiment,
    "Summary": truncate(row.summary, 2000),
    "Escalated": !!row.escalated,
    "Emergency": !!row.emergency,
    "Flags": row.flags ?? [],
    "Started At": row.started_at,
    "Ended At": row.ended_at,
    "Duration (s)": row.duration_seconds,
    "Cost (USD)": Number.isFinite(cost) ? cost : null,
    "Analysis Status": row.analysis_status,
    "Call Reason": row.call_reason,
    "Claim Number": typeof row.claim_number === "string" && row.claim_number.trim() ? row.claim_number.trim() : null,
    "Synced At": syncedAt.toISOString(),
  };
  // The alerts' link builder: a URL with credentials, another scheme or a malformed id gives no link.
  const link = dashboardLink(dashboardUrl, row.vapi_call_id);
  if (link) fields["Dashboard"] = link;
  // Airtable rejects explicit nulls on some field types; an absent key leaves the cell as is.
  for (const k of Object.keys(fields)) if (fields[k] === null || fields[k] === undefined) delete fields[k];
  return fields;
}

/** Upsert one record, merged on "Call ID". Never throws; classifies each failure as retryable, a
 *  configuration error, or neither. */
export async function upsertCallRecord(
  deps: Deps,
  fields: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<AirtableResult> {
  const { AIRTABLE_TOKEN: token, AIRTABLE_BASE_ID: baseId } = deps.env;
  if (!token || !baseId) return { ok: false, error: "airtable not configured", retryable: false, config: true };
  const table = deps.env.AIRTABLE_TABLE || DEFAULT_TABLE;
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // typecast lets a new outcome or flag value become a select option instead of a 422
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: [MERGE_FIELD] },
        records: [{ fields }],
        typecast: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timedOut ? "timeout" : `network: ${(e as Error).message}`, retryable: true };
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch { /* non-JSON error page */ }
  if (res.ok) {
    const rec = body?.records?.[0];
    if (!rec?.id) return { ok: false, status: res.status, error: "airtable: no record in response", retryable: true };
    return {
      ok: true,
      recordId: rec.id,
      created: Array.isArray(body?.createdRecords) && body.createdRecords.includes(rec.id),
    };
  }
  const message = body?.error?.message ?? body?.error?.type ?? body?.error ?? res.statusText;
  const error = `airtable ${res.status}: ${String(message).slice(0, 200)}`;
  // 401/403/404 are the token, its scopes, or the base or table: a setting, not this record, so the
  // outbox pauses with the row's attempt given back. 429 (5 req/s per base) and 5xx are transient.
  // Anything else (422: a value this record holds) a retry cannot fix, so that row stops.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { ok: false, status: res.status, error, retryable: false, config: true };
  }
  // A field the table does not have yet (the code shipped before `deno task airtable:setup` added
  // it) is the table's schema, not this record: every row would fail the same way until it is fixed.
  if (res.status === 422 && body?.error?.type === "UNKNOWN_FIELD_NAME") {
    return { ok: false, status: res.status, error, retryable: false, config: true };
  }
  return { ok: false, status: res.status, error, retryable: res.status === 429 || res.status >= 500 };
}
