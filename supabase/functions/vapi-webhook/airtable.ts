// Integration #2, second destination: the post-call record mirrored to an Airtable call log.
//
// Supabase stays the system of record; Airtable is the external system a claims team would
// actually work in. Delivery goes through outbox_events and is at-least-once, so the write must
// be idempotent: Airtable's upsert (performUpsert, merged on "Call ID") updates the existing
// record instead of creating a duplicate when the same call is delivered twice or re-delivered
// after a backfill improved the row.
//
// Only already-redacted, slim fields cross the boundary: no transcript, no messages, no DOB, and
// the caller's number as its last four digits only.

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
}

export type AirtableResult =
  | { ok: true; recordId: string; created: boolean }
  | { ok: false; status?: number; error: string; retryable: boolean };

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
export function interactionToFields(row: InteractionForMirror, syncedAt: Date, dashboardUrl?: string): Record<string, unknown> {
  const cost = row.cost === null || row.cost === undefined ? null : Number(row.cost);
  const fields: Record<string, unknown> = {
    [MERGE_FIELD]: row.vapi_call_id,
    "Caller Name": row.caller_name ?? "Unknown caller",
    "Caller Phone": phoneEnding(row.caller_phone),
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
    "Synced At": syncedAt.toISOString(),
  };
  if (dashboardUrl) fields["Dashboard"] = `${dashboardUrl.replace(/\/+$/, "")}/#/calls/${encodeURIComponent(row.vapi_call_id)}`;
  // Airtable rejects explicit nulls on some field types; an absent key leaves the cell as is.
  for (const k of Object.keys(fields)) if (fields[k] === null || fields[k] === undefined) delete fields[k];
  return fields;
}

/** Upsert one record, merged on "Call ID". Never throws; classifies failures as retryable or not. */
export async function upsertCallRecord(deps: Deps, fields: Record<string, unknown>, timeoutMs = 5000): Promise<AirtableResult> {
  const { AIRTABLE_TOKEN: token, AIRTABLE_BASE_ID: baseId } = deps.env;
  if (!token || !baseId) return { ok: false, error: "airtable not configured", retryable: false };
  const table = deps.env.AIRTABLE_TABLE || DEFAULT_TABLE;
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // typecast lets a new outcome or flag value become a select option instead of a 422
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [MERGE_FIELD] }, records: [{ fields }], typecast: true }),
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
    return { ok: true, recordId: rec.id, created: Array.isArray(body?.createdRecords) && body.createdRecords.includes(rec.id) };
  }
  const message = body?.error?.message ?? body?.error?.type ?? body?.error ?? res.statusText;
  // 429 (5 req/s per base) and 5xx are transient; 401/403/404/422 are configuration or schema
  // problems that a retry cannot fix, so they stop the outbox row instead of burning attempts.
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, status: res.status, error: `airtable ${res.status}: ${String(message).slice(0, 200)}`, retryable };
}
