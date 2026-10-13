// Row shapes the browser can read (0003_dashboard.sql and later grants). customers and claims are
// never granted, so they have no type here on purpose.

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
  "claim_promised_without_filing",
] as const;
export type Flag = (typeof FLAGS)[number];

/**
 * Why the caller called, one primary reason per call (0007_fnol_reasons.sql). Set from server
 * facts first (an emergency, a filed claim), then the call analysis, then what the tools did;
 * null until one of them knows, never a guess.
 */
export const CALL_REASONS = [
  "claim_status",
  "file_claim",
  "documents",
  "general_question",
  "speak_to_agent",
  "update_details",
  "emergency",
  "other",
] as const;
export type CallReason = (typeof CALL_REASONS)[number];

/** Which evidence set call_reason: server facts outrank the analysis, which outranks tool results. */
export type CallReasonSource = "server" | "structured_output" | "derived";

/**
 * Who called, as the end-of-call writer records it (0006_contacts.sql): existing = the session
 * matched an account, new = a caller with no account gave their details, unknown = neither.
 */
export const CALLER_TYPES = ["existing", "new", "unknown"] as const;
export type CallerType = (typeof CALLER_TYPES)[number];

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
  | "how_to_start_claim"
  | "claim_received"
  | "claim_intake";
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
  /** Generated: recording_url is not null. The stored reference itself never reaches the browser. */
  has_recording: boolean;
  cost: number | null;
  success_evaluation: string | null;
  analysis_raw: unknown;
  messages: unknown;
  latency_avg_ms: number | null;
  cost_breakdown: CostBreakdown | null;
  staff_notes: string | null;
  assistant_name: string | null;
  analysis_status: AnalysisStatus;
  /** 0006_contacts.sql; absent before it is applied (fetchCall then reads the older columns). */
  caller_type?: CallerType;
  /** The address a caller confirmed on the read-back (never the account's own email). Detail page only. */
  caller_email?: string | null;
  /** 0007_fnol_reasons.sql; absent before it is applied. Null until a source knows why they called. */
  call_reason?: CallReason | null;
  call_reason_source?: CallReasonSource | null;
  /** The claim this call filed (a verified customer's phone claim). */
  claim_number?: string | null;
  created_at: string;
  updated_at: string;
}

/** One row of the search_calls RPC (never includes transcript, messages or a full phone number). */
export interface CallListRow {
  /** call_interactions.id, the replica identity a Realtime DELETE carries. */
  id: string;
  vapi_call_id: string;
  channel: string | null;
  caller_name: string | null;
  /** "+1 602 ... 0101", masked in SQL. */
  caller_phone_masked: string | null;
  /** 0006_contacts.sql; absent before it is applied. */
  caller_type?: CallerType | null;
  /** "j***@gmail.com", masked in SQL; the full address stays on the detail page. Absent before 0006. */
  caller_email_masked?: string | null;
  outcome: Outcome | null;
  /** 0007_fnol_reasons.sql; absent before it is applied. */
  call_reason?: CallReason | null;
  sentiment: Sentiment | null;
  escalated: boolean;
  emergency: boolean;
  /** At least one email for this call was sent. */
  emailed: boolean;
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
  /** Generated "+1 602 ... 0102"; the queue reads this instead of callback_phone. */
  callback_phone_masked: string | null;
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

/** An escalation as the queue reads it: the full callback number stays on the call page. */
export type EscalationListRow = Omit<Escalation, "callback_phone"> & { callback_phone?: string | null };

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

export type ContactKind = "new_customer" | "email_update";
/** Where a captured callback number came from (caller_contacts has no "account" source). */
export type ContactCallbackSource = Extract<CallbackSource, "argument" | "caller_id" | "none">;

/**
 * caller_contacts (0006_contacts.sql): the name, email and callback number a caller gave on this
 * call, one row per call. new_customer is a caller with no account; email_update is a verified
 * customer with no email on file asking staff to add one (never written to the account, never
 * used to send anything). Every address here was spoken by the caller and is unverified.
 */
export interface CallerContact {
  call_key: string;
  kind: ContactKind;
  first_name: string;
  last_name: string;
  email: string | null;
  /** E.164; the full number, detail page only. */
  callback_phone: string | null;
  callback_source: ContactCallbackSource;
  /** The caller said yes to the read-back. */
  confirmed: boolean;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ClaimType = "auto" | "home" | "property";
/** claim: a verified customer's claim, filed as a claims row; lead_intake: a new caller's loss for a specialist. */
export type ClaimIntakeKind = "claim" | "lead_intake";

/**
 * claim_intakes (0007_fnol_reasons.sql): the loss a caller reported on this call, one row per
 * call. Unconfirmed while Ava reads it back; confirmed once the caller said yes, which files it
 * (a claim gets a claim number; a lead intake waits for a specialist's callback). The description
 * is the caller's words with personal details redacted before storage.
 */
export interface ClaimIntake {
  call_key: string;
  kind: ClaimIntakeKind;
  claim_type: ClaimType;
  /** A calendar date ("2026-10-10"), not an instant. */
  loss_date: string;
  summary: string;
  description: string;
  claim_number: string | null;
  /** The caller said yes to the read-back, and the intake was filed. */
  confirmed: boolean;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptLineRow {
  id: number;
  call_key: string;
  role: string;
  text: string;
  ts_ms: number;
  created_at: string;
}

/** outbox_events (0005_outbox.sql): one post-call delivery to an external system, keyed by call id. */
export interface OutboxEvent {
  id: string;
  kind: string;
  /** call_interactions.vapi_call_id */
  ref_id: string;
  /** "airtable", or "ghl" from 0008_ghl.sql. */
  destination: string;
  delivered_at: string | null;
  attempts: number;
  last_error: string | null;
  /** The receiver's id once delivered: the Airtable record, or the GoHighLevel contact (null when skipped). */
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Delivery attempts per outbox row before the job gives up (claim_outbox in 0005_outbox.sql). */
export const OUTBOX_MAX_ATTEMPTS = 5;

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
  /** Outbox columns arrive with 0005_outbox.sql; absent before it is applied. */
  last_outbox_run?: string | null;
  outbox_pending?: number;
  outbox_dead?: number;
  outbox_delivered_24h?: number;
  /** GoHighLevel's outbox counts arrive with 0008_ghl.sql (the outbox_* ones are then Airtable's only). */
  ghl_pending?: number;
  ghl_dead?: number;
  ghl_delivered_24h?: number;
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

/** call_reason_counts(p_from, p_to): calls per reason in range, most first; untagged calls are left out. */
export interface CallReasonCount {
  call_reason: string;
  calls: number;
}

export interface DeliveryGapRow {
  channel: "telegram" | "email";
  owed: number;
  delivered: number;
  failed: number;
}

/** Alert channels from escalation_delivery_gap, plus the outbox destinations (Airtable, GoHighLevel). */
export type DeliveryChannel = "telegram" | "email" | "airtable" | "ghl";

/** Tables published to supabase_realtime (0003_dashboard.sql, 0005_outbox.sql, 0006_contacts.sql, 0007_fnol_reasons.sql). */
export type RealtimeTable =
  | "call_interactions"
  | "call_sessions"
  | "escalations"
  | "emails"
  | "transcript_lines"
  | "attempts"
  | "outbox_events"
  | "caller_contacts"
  | "claim_intakes";
