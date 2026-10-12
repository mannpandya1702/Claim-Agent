// Row shapes the browser can read (0003_dashboard.sql grants). customers and claims are never
// granted, so they have no type here on purpose.

export const OUTCOMES = [
  "resolved",
  "auth_failed",
  "not_found",
  "escalated",
  "emergency",
  "unsupported",
  "abandoned",
  "in_progress",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const LEVELS = ["none", "phone_found", "verified", "locked"] as const;
export type Level = (typeof LEVELS)[number];

export const FLAGS = [
  "promised_callback_without_escalation",
  "status_read_without_verified_identity",
  "tool_markup_spoken",
  "email_promised_without_send",
] as const;
export type Flag = (typeof FLAGS)[number];

export const CHANNELS = ["webCall", "inboundPhoneCall", "outboundPhoneCall", "chat", "unknown"] as const;
export type Channel = (typeof CHANNELS)[number];

export type AttemptKind = "lookup_hit" | "lookup_miss" | "dob_ok" | "dob_wrong" | "unreadable" | "other";
export type EscalationKind = "representative" | "emergency";
export type EscalationReason =
  | "representative_requested"
  | "emergency"
  | "auth_locked"
  | "not_found"
  | "unsupported_question"
  | "transfer_failed";
export type CallbackSource = "argument" | "account" | "caller_id" | "none";
export type AlertStatus = "pending" | "sent" | "failed" | "skipped";
export type EscalationStatus = "open" | "claimed" | "done";
export type EmailKind =
  | "callback_request"
  | "emergency_alert"
  | "sla_realert"
  | "document_checklist"
  | "claim_summary"
  | "how_to_start_claim";
export type EmailStatus = "pending" | "sending" | "sent" | "failed";
export type AnalysisStatus = "pending" | "ok" | "backfilled" | "missing";

export interface CostBreakdown {
  stt?: number | null;
  llm?: number | null;
  tts?: number | null;
  vapi?: number | null;
  transport?: number | null;
  analysis?: number | null;
  total?: number | null;
}

/** call_interactions. `status` is a generated column: Realtime never carries it, so never rely on it. */
export interface CallInteraction {
  id: string;
  vapi_call_id: string;
  channel: string | null;
  customer_id: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  summary: string | null;
  sentiment: Sentiment | null;
  sentiment_source: string | null;
  outcome: Outcome | null;
  escalated: boolean;
  emergency: boolean;
  flags: string[];
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  ended_reason: string | null;
  transcript: string | null;
  recording_url: string | null;
  cost: number | null;
  success_evaluation: string | null;
  analysis_raw: unknown;
  messages: unknown;
  latency_avg_ms: number | null;
  cost_breakdown: CostBreakdown | null;
  staff_notes: string | null;
  assistant_name: string | null;
  analysis_status: AnalysisStatus;
  created_at: string;
  updated_at: string;
}

/** One row of the search_calls RPC (never includes transcript or messages). */
export interface CallListRow {
  vapi_call_id: string;
  channel: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  outcome: Outcome | null;
  sentiment: Sentiment | null;
  escalated: boolean;
  emergency: boolean;
  flags: string[];
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  cost: number | null;
  latency_avg_ms: number | null;
  summary: string | null;
  assistant_name: string | null;
  created_at: string;
  total: number;
}

export interface SearchCallsParams {
  p_q?: string | null;
  p_from?: string | null;
  p_to?: string | null;
  p_outcome?: Outcome | null;
  p_sentiment?: Sentiment | null;
  p_channel?: string | null;
  p_flagged?: boolean | null;
  p_escalated?: boolean | null;
  p_limit?: number;
  p_offset?: number;
}

export interface Attempt {
  call_key: string;
  tool_call_id: string;
  tool_name: string;
  kind: AttemptKind | null;
  code: string | null;
  created_at: string;
}

export interface CallSession {
  call_key: string;
  channel: string;
  caller_number: string | null;
  level: Level;
  candidate_customer_id: string | null;
  verified_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Escalation {
  id: string;
  call_key: string;
  kind: EscalationKind;
  reason: EscalationReason;
  details: string | null;
  callback_phone: string | null;
  channel: string;
  verified: boolean;
  callback_source: CallbackSource | null;
  alert_status: AlertStatus;
  delivery_error: string | null;
  status: EscalationStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  close_note: string | null;
  realerted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailRow {
  id: string;
  call_key: string;
  kind: EmailKind;
  to_masked: string;
  resend_id: string | null;
  status: EmailStatus;
  error: string | null;
  created_at: string;
}

export interface TranscriptLineRow {
  id: number;
  call_key: string;
  role: string;
  text: string;
  ts_ms: number;
  created_at: string;
}

export interface JobRun {
  job: string;
  period_key: string;
  started_at: string;
  finished_at: string | null;
  result: unknown;
}

export interface OpsHealth {
  last_sla_run: string | null;
  last_digest_run: string | null;
  last_reaper_run: string | null;
  open_escalations: number;
  sla_breaches: number;
  alerts_failed_24h: number;
  emails_failed_24h: number;
  emails_sent_24h: number;
  stuck_calls: number;
  analysis_missing_24h: number;
}

/** dashboard_metrics(p_from, p_to). Rates are 0..1 and null when nothing completed in range. */
export interface DashboardMetrics {
  calls: number;
  completed: number;
  in_progress: number;
  resolved: number;
  containment_rate: number | null;
  verification_attempted: number;
  verification_success: number;
  auth_failed: number;
  not_found: number;
  escalated: number;
  emergencies: number;
  escalation_rate: number | null;
  avg_handle_seconds: number | null;
  avg_cost: number | null;
  avg_latency_ms: number | null;
  flagged: number;
  outcomes: Record<string, number>;
  sentiments: Record<string, number>;
  emails_sent: number;
  open_escalations: number;
  sla_breaches: number;
  escalations_in_range: number;
}

export interface CallsByDayRow {
  day: string;
  outcome: string;
  n: number;
}

export interface DeliveryGapRow {
  channel: "telegram" | "email";
  owed: number;
  delivered: number;
  failed: number;
}

/** Tables published to supabase_realtime (0003_dashboard.sql). */
export type RealtimeTable =
  | "call_interactions"
  | "call_sessions"
  | "escalations"
  | "emails"
  | "transcript_lines"
  | "attempts";
