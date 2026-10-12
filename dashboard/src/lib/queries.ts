import type { DateRange } from "./dates";
import { supabase } from "./supabase";
import type {
  Attempt,
  CallInteraction,
  CallListRow,
  CallsByDayRow,
  CallSession,
  DashboardMetrics,
  DeliveryGapRow,
  EmailRow,
  Escalation,
  EscalationStatus,
  JobRun,
  OpsHealth,
  SearchCallsParams,
  TranscriptLineRow,
} from "./types";

/*
 * Query keys and fetchers shared by every page, so a Realtime hook on one page invalidates the
 * same keys another page reads. Keys are prefix-friendly: invalidating ["call", id] refreshes
 * everything about one call; ["calls"] refreshes every list. Only what 0003_dashboard.sql grants
 * is read here; customers and claims are never queried.
 */

export const qk = {
  calls: () => ["calls"] as const,
  callList: (params: SearchCallsParams) => ["calls", "list", params] as const,
  liveCalls: () => ["calls", "live"] as const,

  call: (id: string) => ["call", id] as const,
  callRow: (id: string) => ["call", id, "row"] as const,
  callSession: (id: string) => ["call", id, "session"] as const,
  callAttempts: (id: string) => ["call", id, "attempts"] as const,
  callTranscript: (id: string) => ["call", id, "transcript"] as const,
  callEscalations: (id: string) => ["call", id, "escalations"] as const,
  callEmails: (id: string) => ["call", id, "emails"] as const,

  metrics: (range: DateRange) => ["metrics", range.from, range.to] as const,
  callsByDay: (range: DateRange) => ["calls-by-day", range.from, range.to] as const,

  escalations: () => ["escalations"] as const,
  escalationList: (status: EscalationStatus | "all") => ["escalations", status] as const,

  ops: () => ["ops"] as const,
  opsHealth: () => ["ops", "health"] as const,
  jobRuns: () => ["ops", "jobs"] as const,
  deliveryGap: (hours: number) => ["ops", "gap", hours] as const,
};

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

// The detail page reads the full row except the search vector; lists use search_calls, which
// never returns transcript or messages.
export const CALL_DETAIL_COLUMNS = [
  "id",
  "vapi_call_id",
  "channel",
  "customer_id",
  "caller_name",
  "caller_phone",
  "summary",
  "sentiment",
  "sentiment_source",
  "outcome",
  "escalated",
  "emergency",
  "flags",
  "started_at",
  "ended_at",
  "duration_seconds",
  "ended_reason",
  "transcript",
  "recording_url",
  "cost",
  "success_evaluation",
  "analysis_raw",
  "messages",
  "latency_avg_ms",
  "cost_breakdown",
  "staff_notes",
  "assistant_name",
  "analysis_status",
  "created_at",
  "updated_at",
].join(",");

/** Columns for live cards and other non-detail views (no transcript, messages or raw analysis). */
export const CALL_SUMMARY_COLUMNS =
  "id,vapi_call_id,channel,caller_name,caller_phone,outcome,sentiment,escalated,emergency,flags,started_at,ended_at,duration_seconds,assistant_name,created_at,updated_at";

export type CallSummary = Pick<
  CallInteraction,
  | "id"
  | "vapi_call_id"
  | "channel"
  | "caller_name"
  | "caller_phone"
  | "outcome"
  | "sentiment"
  | "escalated"
  | "emergency"
  | "flags"
  | "started_at"
  | "ended_at"
  | "duration_seconds"
  | "assistant_name"
  | "created_at"
  | "updated_at"
>;

// ---------------------------------------------------------------------------------------------
// Lists and aggregates (RPCs; all aggregation happens in SQL)
// ---------------------------------------------------------------------------------------------

export interface CallPage {
  rows: CallListRow[];
  /** null when the page came back empty: an out-of-range page carries no total, so clamp to page 0. */
  total: number | null;
}

export async function searchCalls(params: SearchCallsParams): Promise<CallPage> {
  const { data, error } = await supabase.rpc("search_calls", params);
  fail(error);
  const rows = (data ?? []) as CallListRow[];
  return { rows, total: rows.length > 0 ? Number(rows[0]!.total) : null };
}

export async function fetchMetrics(range: DateRange): Promise<DashboardMetrics> {
  const { data, error } = await supabase.rpc("dashboard_metrics", { p_from: range.from, p_to: range.to });
  fail(error);
  return data as DashboardMetrics;
}

export async function fetchCallsByDay(range: DateRange): Promise<CallsByDayRow[]> {
  const { data, error } = await supabase.rpc("calls_by_day", { p_from: range.from, p_to: range.to });
  fail(error);
  return ((data ?? []) as CallsByDayRow[]).map((r) => ({ ...r, n: Number(r.n) }));
}

export async function fetchLiveCalls(): Promise<CallSummary[]> {
  // Live is ended_at is null, never the generated status column (Realtime does not carry it).
  const { data, error } = await supabase
    .from("call_interactions")
    .select(CALL_SUMMARY_COLUMNS)
    .is("ended_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  fail(error);
  return (data ?? []) as unknown as CallSummary[];
}

// ---------------------------------------------------------------------------------------------
// One call (everything keyed by the VAPI call id = call_key)
// ---------------------------------------------------------------------------------------------

export async function fetchCall(id: string): Promise<CallInteraction | null> {
  const { data, error } = await supabase.from("call_interactions").select(CALL_DETAIL_COLUMNS).eq("vapi_call_id", id).maybeSingle();
  fail(error);
  return (data ?? null) as unknown as CallInteraction | null;
}

export async function fetchCallSession(id: string): Promise<CallSession | null> {
  const { data, error } = await supabase.from("call_sessions").select("*").eq("call_key", id).maybeSingle();
  fail(error);
  return (data ?? null) as CallSession | null;
}

export async function fetchCallAttempts(id: string): Promise<Attempt[]> {
  const { data, error } = await supabase
    .from("attempts")
    .select("call_key,tool_call_id,tool_name,kind,code,created_at")
    .eq("call_key", id)
    .order("created_at", { ascending: true });
  fail(error);
  return (data ?? []) as Attempt[];
}

export async function fetchTranscriptLines(id: string): Promise<TranscriptLineRow[]> {
  const { data, error } = await supabase
    .from("transcript_lines")
    .select("id,call_key,role,text,ts_ms,created_at")
    .eq("call_key", id)
    .order("ts_ms", { ascending: true })
    .order("id", { ascending: true });
  fail(error);
  return (data ?? []) as TranscriptLineRow[];
}

export async function fetchCallEscalations(id: string): Promise<Escalation[]> {
  const { data, error } = await supabase.from("escalations").select("*").eq("call_key", id).order("created_at");
  fail(error);
  return (data ?? []) as Escalation[];
}

export async function fetchCallEmails(id: string): Promise<EmailRow[]> {
  const { data, error } = await supabase.from("emails").select("*").eq("call_key", id).order("created_at");
  fail(error);
  return (data ?? []) as EmailRow[];
}

/**
 * Saves staff notes, the one browser-writable column. A policy denial updates zero rows and
 * PostgREST still answers 2xx, so the row is selected back and a missing row is an error.
 */
export async function saveStaffNotes(id: string, notes: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("call_interactions")
    .update({ staff_notes: notes.trim() === "" ? null : notes })
    .eq("vapi_call_id", id)
    .select("vapi_call_id,staff_notes")
    .maybeSingle();
  fail(error);
  if (!data) throw new Error("Notes were not saved (no permission to update this call).");
  return (data as { staff_notes: string | null }).staff_notes;
}

// ---------------------------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------------------------

export async function fetchEscalations(status: EscalationStatus | "all" = "all"): Promise<Escalation[]> {
  let q = supabase.from("escalations").select("*");
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q.order("created_at", { ascending: status === "open" }).limit(200);
  fail(error);
  return (data ?? []) as Escalation[];
}

/** Claims an open escalation. A second claim returns the row with the first claimer, not an error. */
export async function claimEscalation(id: string): Promise<Escalation> {
  const { data, error } = await supabase.rpc("claim_escalation", { p_id: id });
  fail(error);
  return data as Escalation;
}

export async function closeEscalation(id: string, note?: string): Promise<Escalation> {
  const { data, error } = await supabase.rpc("close_escalation", { p_id: id, p_note: note?.trim() || null });
  fail(error);
  return data as Escalation;
}

// ---------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------

export async function fetchOpsHealth(): Promise<OpsHealth | null> {
  const { data, error } = await supabase.from("ops_health").select("*").maybeSingle();
  fail(error);
  return (data ?? null) as OpsHealth | null;
}

export async function fetchJobRuns(limit = 50): Promise<JobRun[]> {
  const { data, error } = await supabase
    .from("job_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  fail(error);
  return (data ?? []) as JobRun[];
}

export async function fetchDeliveryGap(hours = 24): Promise<DeliveryGapRow[]> {
  const { data, error } = await supabase.rpc("escalation_delivery_gap", { p_hours: hours });
  fail(error);
  return ((data ?? []) as DeliveryGapRow[]).map((r) => ({
    ...r,
    owed: Number(r.owed),
    delivered: Number(r.delivered),
    failed: Number(r.failed),
  }));
}
