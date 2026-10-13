// Single source for every value list. The SQL CHECK constraints, the tool JSON enums and the
// analysis schema must match these; enums_test.ts (parity) and conformance_test.ts enforce it.

export const LEVELS = ["none", "phone_found", "verified", "locked"] as const;
export type Level = typeof LEVELS[number];

export const ATTEMPT_KINDS = ["lookup_hit", "lookup_miss", "dob_ok", "dob_wrong", "unreadable", "other"] as const;
export type AttemptKind = typeof ATTEMPT_KINDS[number];

export const CLAIM_TYPES = ["auto", "home", "property"] as const;
export type ClaimType = typeof CLAIM_TYPES[number];

// What a claim filed by phone asks the customer for, by type (file_claim_intake in
// 0007_fnol_reasons.sql writes the same lists into claims.documents_required; enums_test.ts checks
// the two agree). Worded like the seeded claims and data/faq.json.
export const CLAIM_DOCUMENTS: Readonly<Record<ClaimType, readonly string[]>> = {
  auto: ["photos of the damage", "the police report, if one was filed", "a repair estimate"],
  home: ["photos of the damage", "a contractor estimate", "proof of ownership for the damaged items"],
  property: ["photos of the damage", "a contractor estimate", "proof of ownership for the damaged items"],
};

// claim_intakes.kind (0007_fnol_reasons.sql). claim: a verified customer's intake, filed as a claims
// row; lead_intake: a new caller's confirmed details plus the loss, for a specialist to set up.
export const CLAIM_INTAKE_KINDS = ["claim", "lead_intake"] as const;
export type ClaimIntakeKind = typeof CLAIM_INTAKE_KINDS[number];

// verify_identity's optional intent: what the caller said they want, so a verified answer can lead
// straight into it (claim_status reads the claims in the same call; file_claim asks what happened).
export const VERIFY_INTENTS = ["claim_status", "file_claim", "other"] as const;
export type VerifyIntent = typeof VERIFY_INTENTS[number];

// get_claim_status's optional detail: summary (the default) says where each claim stands in a few
// words; documents reads what the claims awaiting documents need and how to send them; claim tells
// the whole story of the one claim claim_ending names.
export const CLAIM_STATUS_DETAILS = ["summary", "documents", "claim"] as const;
export type ClaimStatusDetail = typeof CLAIM_STATUS_DETAILS[number];

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
export const MODEL_ESCALATION_REASONS = [
  "representative_requested",
  "unsupported_question",
  "transfer_failed",
] as const;
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

// caller_contacts (0006_contacts.sql). new_customer: a caller with no account gave their details;
// email_update: a verified customer spelled an email for staff to add (never used to send to).
export const CONTACT_KINDS = ["new_customer", "email_update"] as const;
export type ContactKind = typeof CONTACT_KINDS[number];

// Where a captured callback number came from: said by the caller, or the call's caller id.
export const CONTACT_CALLBACK_SOURCES = ["argument", "caller_id", "none"] as const;
export type ContactCallbackSource = typeof CONTACT_CALLBACK_SOURCES[number];

// call_interactions.caller_type: existing (the session matched an account), new (a new_customer
// contact was captured), else unknown.
export const CALLER_TYPES = ["existing", "new", "unknown"] as const;
export type CallerType = typeof CALLER_TYPES[number];

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
  "claim_received", // the customer's confirmation of a claim taken by phone
  "claim_intake", // the team's notice of a claim taken by phone
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

// call_interactions.call_reason (0007_fnol_reasons.sql): the primary reason for the call, also offered
// to the analysis schema (render.ts). call_reason_source ranks who set it: server facts beat the
// structured output, which beats a reason derived from what the tools did.
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
export type CallReason = typeof CALL_REASONS[number];

export const CALL_REASON_SOURCES = ["server", "structured_output", "derived"] as const;
export type CallReasonSource = typeof CALL_REASON_SOURCES[number];

export const ANALYSIS_STATUSES = ["pending", "ok", "backfilled", "missing"] as const;
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];

export const FLAGS = [
  "promised_callback_without_escalation",
  "status_read_without_verified_identity",
  "tool_markup_spoken",
  "email_promised_without_send",
  "claim_promised_without_filing",
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
  "capture_contact",
  "confirm_contact",
  "start_claim",
  "confirm_claim",
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
  "claim_documents",
  "no_documents_needed",
  "claim_detail",
  "claim_not_identified",
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
  // capture_contact
  "contact_readback",
  "contact_invalid_email",
  "contact_needs_name",
  "contact_needs_phone",
  "email_on_file",
  // confirm_contact
  "not_pending",
  "contact_retry",
  "contact_saved_new",
  "contact_saved_existing",
  // start_claim
  "claim_readback",
  "claim_needs_lookup",
  "claim_needs_contact",
  "claim_needs_verification",
  "claim_locked",
  "claim_needs_description",
  "claim_bad_date",
  "claim_date_help",
  "claim_too_old",
  "claim_needs_phone",
  "claim_already_filed",
  // confirm_claim
  "claim_not_pending",
  "claim_retry",
  "claim_filed",
  "claim_intake_saved",
] as const;
export type Code = typeof CODES[number];

// get_claim_status answers that read the verified caller's claims (verify_identity's chained read is
// recorded as one of these too): the post-call outcome and call reason count any of them as a status
// read. claim_not_identified asked which claim and read nothing.
export const STATUS_READ_CODES = ["ok", "no_claims", "claim_documents", "no_documents_needed", "claim_detail"] as const;

export const CHANNELS = ["webCall", "inboundPhoneCall", "outboundPhoneCall", "chat", "unknown"] as const;
export type Channel = typeof CHANNELS[number];

export const ALERT_SINKS = ["telegram", "email"] as const;
export type AlertSink = typeof ALERT_SINKS[number];

// Scheduled jobs: invoke_job in 0004_automation.sql POSTs <fn>/jobs/<name> for exactly these.
export const JOB_NAMES = ["sla", "digest", "reaper", "outbox"] as const;
export type JobName = typeof JOB_NAMES[number];

// outbox_events CHECK lists (kind: 0005_outbox.sql; destination: 0008_ghl.sql puts it back widened).
export const OUTBOX_KINDS = ["interaction.completed"] as const;
export type OutboxKind = typeof OUTBOX_KINDS[number];

export const OUTBOX_DESTINATIONS = ["airtable", "ghl"] as const;
export type OutboxDestination = typeof OUTBOX_DESTINATIONS[number];

// Every tag the GoHighLevel adapter (ghl.ts) can add to a contact: lowercase, one "oi-" prefix, an
// outcome tag per outcome and a reason tag per call reason. Tags are only ever added (never put or
// deleted), so a contact collects one outcome tag per call it made.
export const GHL_TAGS = [
  "oi-voice",
  "oi-caller-existing",
  "oi-caller-new",
  "oi-verified",
  "oi-unverified",
  "oi-verify-locked",
  "oi-lead-new", // only on a contact the adapter created, and not when it is do-not-contact
  "oi-phone-matched", // a new caller whose confirmed number matched an existing contact
  "oi-channel-phone",
  "oi-channel-web",
  ...OUTCOMES.map((o) => `oi-outcome-${o}` as const),
  ...CALL_REASONS.map((r) => `oi-reason-${r}` as const),
  "oi-callback",
  "oi-emergency",
  "oi-claim-filed", // a verified customer's claim filed on the call
  "oi-claim-intake", // a new caller's claim details taken for a specialist
] as const;
export type GhlTag = typeof GHL_TAGS[number];

export const MAIN_LINE_SPOKEN = "1-800-555-0142";
export const CLAIMS_URL_SPOKEN = "observeinsurance dot com slash claims";
export const TIMEZONE = "America/New_York";
