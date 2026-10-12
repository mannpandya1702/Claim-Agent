// Single source for every value list. The SQL CHECK constraints, the tool JSON enums and the
// analysis schema must match these; enums_test.ts (parity) and conformance_test.ts enforce it.

export const LEVELS = ["none", "phone_found", "verified", "locked"] as const;
export type Level = typeof LEVELS[number];

export const ATTEMPT_KINDS = ["lookup_hit", "lookup_miss", "dob_ok", "dob_wrong", "unreadable", "other"] as const;
export type AttemptKind = typeof ATTEMPT_KINDS[number];

export const CLAIM_TYPES = ["auto", "home", "property"] as const;
export type ClaimType = typeof CLAIM_TYPES[number];

export const CLAIM_STATUSES = [
  "received",
  "under_review",
  "awaiting_documents",
  "approved",
  "payment_issued",
  "denied",
  "closed",
] as const;
export type ClaimStatus = typeof CLAIM_STATUSES[number];

export const ESCALATION_KINDS = ["representative", "emergency"] as const;
export type EscalationKind = typeof ESCALATION_KINDS[number];

// Reasons the model may pass to escalate(). The server derives auth_locked / not_found from
// session state and coerces anything off this list to representative_requested.
export const MODEL_ESCALATION_REASONS = ["representative_requested", "unsupported_question", "transfer_failed"] as const;
export type ModelEscalationReason = typeof MODEL_ESCALATION_REASONS[number];

export const ESCALATION_REASONS = [
  "representative_requested",
  "emergency",
  "auth_locked",
  "not_found",
  "unsupported_question",
  "transfer_failed",
] as const;
export type EscalationReason = typeof ESCALATION_REASONS[number];

export const CALLBACK_SOURCES = ["argument", "account", "caller_id", "none"] as const;
export type CallbackSource = typeof CALLBACK_SOURCES[number];

export const ALERT_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type AlertStatus = typeof ALERT_STATUSES[number];

export const ESCALATION_STATUSES = ["open", "claimed", "done"] as const;
export type EscalationStatus = typeof ESCALATION_STATUSES[number];

export const EMAIL_KINDS = [
  "callback_request",
  "emergency_alert",
  "sla_realert",
  "document_checklist",
  "claim_summary",
  "how_to_start_claim",
] as const;
export type EmailKind = typeof EMAIL_KINDS[number];

export const EMAIL_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type EmailStatus = typeof EMAIL_STATUSES[number];

// Topics the model may pass to send_info_email (a subset of EMAIL_KINDS).
export const INFO_EMAIL_TOPICS = ["document_checklist", "claim_summary", "how_to_start_claim"] as const;
export type InfoEmailTopic = typeof INFO_EMAIL_TOPICS[number];

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = typeof SENTIMENTS[number];

export const SENTIMENT_SOURCES = ["vapi", "structured_output", "backfill"] as const;
export type SentimentSource = typeof SENTIMENT_SOURCES[number];

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
export type Outcome = typeof OUTCOMES[number];

// The analysis / structured-output schema offers every outcome except in_progress.
export const ANALYSIS_OUTCOMES = OUTCOMES.filter((o) => o !== "in_progress");

export const ANALYSIS_STATUSES = ["pending", "ok", "backfilled", "missing"] as const;
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];

export const FLAGS = [
  "promised_callback_without_escalation",
  "status_read_without_verified_identity",
  "tool_markup_spoken",
  "email_promised_without_send",
] as const;
export type Flag = typeof FLAGS[number];

// Tools served by this webhook. transferCall, endCall, handoff_* and faq_search are VAPI-native.
export const SERVER_TOOLS = [
  "lookup_customer",
  "verify_identity",
  "get_claim_status",
  "escalate",
  "report_emergency",
  "send_info_email",
] as const;
export type ServerTool = typeof SERVER_TOOLS[number];

// Every result code a server tool can return; each has a sentence in speak.ts (speak_test.ts).
export const CODES = [
  // shared
  "bad_args",
  "system_error",
  "unknown_tool",
  // lookup_customer
  "invalid_phone",
  "not_found",
  "not_found_final",
  "needs_dob",
  "already_verified",
  "locked",
  // verify_identity
  "verified",
  "auth_failed",
  "no_lookup_yet",
  "dob_unreadable",
  "dob_give_up",
  // get_claim_status
  "ok",
  "no_claims",
  "not_verified",
  // escalate
  "rep_queued",
  "rep_queued_no_number",
  "callback_updated",
  "rep_recorded",
  "rep_already_queued",
  "rep_unavailable",
  // report_emergency
  "emergency_logged",
  // send_info_email
  "email_sent",
  "email_already_sent",
  "no_email_on_file",
  "email_failed",
] as const;
export type Code = typeof CODES[number];

export const CHANNELS = ["webCall", "inboundPhoneCall", "outboundPhoneCall", "chat", "unknown"] as const;
export type Channel = typeof CHANNELS[number];

export const ALERT_SINKS = ["telegram", "email"] as const;
export type AlertSink = typeof ALERT_SINKS[number];

// Scheduled jobs: invoke_job in 0004_automation.sql POSTs <fn>/jobs/<name> for exactly these.
export const JOB_NAMES = ["sla", "digest", "reaper", "outbox"] as const;
export type JobName = typeof JOB_NAMES[number];

// outbox_events CHECK lists (0005_outbox.sql).
export const OUTBOX_KINDS = ["interaction.completed"] as const;
export type OutboxKind = typeof OUTBOX_KINDS[number];

export const OUTBOX_DESTINATIONS = ["airtable"] as const;
export type OutboxDestination = typeof OUTBOX_DESTINATIONS[number];

export const MAIN_LINE_SPOKEN = "1-800-555-0142";
export const CLAIMS_URL_SPOKEN = "observeinsurance dot com slash claims";
export const TIMEZONE = "America/New_York";
