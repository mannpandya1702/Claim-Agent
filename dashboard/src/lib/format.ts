import { formatDistanceStrict } from "date-fns";
import type {
  AlertStatus,
  CallbackSource,
  CallerType,
  CallReason,
  CallReasonSource,
  ClaimIntakeKind,
  ClaimType,
  ContactKind,
  EmailKind,
  EmailStatus,
  EscalationReason,
  EscalationStatus,
  Flag,
  Level,
  Outcome,
  Sentiment,
} from "./types";

/** Every displayed date and day boundary is Eastern, matching calls_by_day and the digest. */
export const TIME_ZONE = "America/New_York";

/** Placeholder for a value that does not exist yet (in-progress call, unset column). */
export const DASH = "—";
/** Placeholder for a measured value the backend could not get (cost, latency); never shown as 0. */
export const NA = "n/a";

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function toNum(n: unknown): number | null {
  if (isNum(n)) return n;
  if (typeof n === "string" && n.trim() !== "" && Number.isFinite(Number(n))) return Number(n);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** 75 -> "1:15", 3725 -> "1:02:05"; null -> "—". Negative and fractional input is clamped/rounded. */
export function formatDuration(seconds: number | null | undefined): string {
  const n = toNum(seconds);
  if (n === null) return DASH;
  const total = Math.max(0, Math.round(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Transcript stamp: seconds from call start -> "mm:ss" (minutes keep growing past 59). */
export function formatStamp(seconds: number | null | undefined): string {
  const n = toNum(seconds);
  const total = n === null ? 0 : Math.max(0, Math.floor(n));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * USD. Voice calls cost cents, so sub-dollar values keep three decimals ($0.142); a missing
 * cost is "n/a", never "$0.00", because zero would claim the call was free.
 */
export function formatMoney(value: number | string | null | undefined, opts: { digits?: number } = {}): string {
  const n = toNum(value);
  if (n === null) return NA;
  const digits = opts.digits ?? (Math.abs(n) < 1 && n !== 0 ? 3 : 2);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** 0.724 -> "72%"; null -> "n/a". */
export function formatPercent(rate: number | string | null | undefined, digits = 0): string {
  const n = toNum(rate);
  if (n === null) return NA;
  return `${(n * 100).toFixed(digits)}%`;
}

/** Milliseconds -> "820 ms" or "1.4 s"; null -> "n/a". */
export function formatLatency(ms: number | string | null | undefined): string {
  const n = toNum(ms);
  if (n === null) return NA;
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

/** 1284 -> "1,284"; 12900 -> "12.9K"; null -> "—". */
export function formatCount(value: number | string | null | undefined): string {
  const n = toNum(value);
  if (n === null) return DASH;
  if (Math.abs(n) < 10_000) return new Intl.NumberFormat("en-US").format(Math.round(n));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

// ---------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------

// A callback number is stored as given (0011_intl_callbacks.sql): "+16025550101" (North American),
// "+442079460958" (international, E.164) or "9601550123" (noted as the caller said it, no country code).
// Only a "+1" number is North American: bare digits are a number noted as said, whatever their shape
// ("6025550177" from a caller abroad), so they are never shown with "+1" or dialled as written (the same
// rule as the generated *_masked columns).

/** The ten digits of a North American number stored with its "+1", or null. */
function northAmerican(phone: string): string | null {
  const text = phone.trim();
  const digits = text.replace(/\D/g, "");
  return text.startsWith("+") && /^1[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? digits.slice(1) : null;
}

/** A number written by hand with its punctuation ("(602) 555-0100", such as an env value): its ten digits
 *  when they could be North American, else null. Bare digits are never one (noted as said). */
function handWritten(phone: string): string | null {
  const text = phone.trim();
  if (text.startsWith("+") || /^\d+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  return ten && /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null;
}

/** Whether a stored number can be dialled as written: E.164, "+" and 8 to 15 digits. A number noted as said
 *  has no country code, so a tel: link would dial it as a local number wherever the phone happens to be. */
export function isDialable(phone: string | null | undefined): boolean {
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

/** Whether a stored number was noted as the caller said it, with no country code (7 to 15 bare digits). */
export function isAsSaid(phone: string | null | undefined): boolean {
  return typeof phone === "string" && /^\d{7,15}$/.test(phone.trim());
}

/** "+16025550101" -> "+1 602 ... 0101"; any other number -> "... 0958". Lists mask; only the call detail page
 *  shows the full number. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return DASH;
  const nanp = northAmerican(phone);
  if (nanp) return `+1 ${nanp.slice(0, 3)} ... ${nanp.slice(-4)}`;
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 4) return `... ${digits.slice(-4)}`;
  return "...";
}

/** The full number (detail page only): "+16025550101" -> "+1 602 555 0101"; an international number as
 *  stored ("+442079460958"); one noted as said in groups of three, the last group up to four ("960 155 0123"),
 *  never with "+1". A number written by hand ("(602) 555-0100") reads as North American when it could be;
 *  anything else is returned as given. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return DASH;
  const nanp = northAmerican(phone) ?? handWritten(phone);
  if (nanp) return `+1 ${nanp.slice(0, 3)} ${nanp.slice(3, 6)} ${nanp.slice(6)}`;
  if (!isAsSaid(phone)) return phone;
  const digits = phone.trim();
  const groups: string[] = [];
  let i = 0;
  for (; digits.length - i > 4; i += 3) groups.push(digits.slice(i, i + 3));
  groups.push(digits.slice(i));
  return groups.join(" ");
}

// ---------------------------------------------------------------------------------------------
// Dates (always Eastern)
// ---------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, ...options });
    formatters.set(key, f);
  }
  return f;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 12, 3:04 PM" */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return DASH;
  return fmt("dt", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

/** "Oct 12, 2026, 3:04:09 PM ET" for headers and tooltips where precision matters. */
export function formatDateTimeLong(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return DASH;
  const s = fmt("dtl", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
  return `${s} ET`;
}

/** "Oct 12" */
export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return DASH;
  return fmt("d", { month: "short", day: "numeric" }).format(d);
}

/** "3:04 PM" */
export function formatTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return DASH;
  return fmt("t", { hour: "numeric", minute: "2-digit" }).format(d);
}

/** "2026-10-12" style day key in Eastern time, the same bucket calls_by_day uses. */
export function etDayKey(value: string | number | Date): string {
  const d = toDate(value);
  if (!d) return "";
  const parts = fmt("key", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A calls_by_day `day` ("2026-10-12", already Eastern) -> "Oct 12" without a timezone shift. */
export function formatDayKey(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
}

/**
 * A calendar date column ("2026-10-10", a loss date) -> "Sat, Oct 10, 2026". It names a day, not
 * an instant, so it is formatted as written with no timezone shift. Anything else is returned as given.
 */
export function formatCalendarDate(day: string | null | undefined): string {
  if (!day) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.slice(0, 10));
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** "5 minutes ago". `now` is injectable so tests and SLA badges share one clock. */
export function formatRelative(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return DASH;
  if (Math.abs(now.getTime() - d.getTime()) < 45_000) return "just now";
  return formatDistanceStrict(d, now, { addSuffix: true });
}

/** Whole minutes between two instants, for age columns and the 30-minute SLA rule. */
export function minutesBetween(from: string | Date, now: Date = new Date()): number {
  const d = toDate(from);
  if (!d) return 0;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
}

// ---------------------------------------------------------------------------------------------
// Badge and label maps
// ---------------------------------------------------------------------------------------------

export interface OutcomeMeta {
  label: string;
  description: string;
  /** Categorical slot (CSS color). Fixed per outcome so filters never repaint survivors. */
  color: string;
}

/**
 * Outcome identity colors. Stacks and the donut skip outcomes a range does not have, so any two
 * outcomes can end up side by side; the colors are therefore validated all-pairs
 * (validate_palette.js --pairs all, both modes), which holds for three hues only. The three
 * outcomes a supervisor reads first take them; every other outcome folds into the gray "Other"
 * (in_progress is a state, not an outcome, and folds too). Tooltips and the table views still
 * name each outcome. Light-mode aqua sits under 3:1 on the card, so outcome charts keep their
 * labels and table view.
 */
export const HUED_OUTCOMES = ["resolved", "escalated", "auth_failed"] as const;

/** Stack, legend and table order: the hued outcomes first, then the ones that fold into Other. */
export const OUTCOME_ORDER = [
  ...HUED_OUTCOMES,
  "not_found",
  "unsupported",
  "abandoned",
  "emergency",
  "in_progress",
  "unknown",
] as const;

const FOLD = "var(--series-other)";

export const OUTCOME_META: Record<Outcome | "unknown", OutcomeMeta> = {
  resolved: { label: "Resolved", description: "Handled without a person", color: "var(--series-1)" },
  escalated: { label: "Escalated", description: "Handed to a representative", color: "var(--series-2)" },
  auth_failed: { label: "Auth failed", description: "Date of birth did not match", color: "var(--series-3)" },
  not_found: { label: "Not found", description: "No customer for that phone number", color: FOLD },
  unsupported: { label: "Unsupported", description: "Question outside what Ava handles", color: FOLD },
  abandoned: { label: "Abandoned", description: "Caller left before an outcome", color: FOLD },
  in_progress: { label: "In progress", description: "Call has not ended", color: FOLD },
  emergency: { label: "Emergency", description: "Caller reported present danger", color: FOLD },
  unknown: { label: "Unknown", description: "No outcome recorded", color: FOLD },
};

export function outcomeMeta(outcome: string | null | undefined): OutcomeMeta {
  if (outcome && outcome in OUTCOME_META) return OUTCOME_META[outcome as Outcome];
  return OUTCOME_META.unknown;
}

export interface SentimentMeta {
  label: string;
  color: string;
}

/** Sentiment is polarity, so it uses the diverging pair around a neutral gray, not categorical slots. */
export const SENTIMENT_META: Record<Sentiment | "unknown", SentimentMeta> = {
  positive: { label: "Positive", color: "var(--diverging-pos)" },
  neutral: { label: "Neutral", color: "var(--diverging-mid)" },
  negative: { label: "Negative", color: "var(--diverging-neg)" },
  unknown: { label: NA, color: "var(--series-other)" },
};

export function sentimentMeta(sentiment: string | null | undefined): SentimentMeta {
  if (sentiment && sentiment in SENTIMENT_META) return SENTIMENT_META[sentiment as Sentiment];
  return SENTIMENT_META.unknown;
}

export interface FlagMeta {
  label: string;
  explanation: string;
}

/** Evidence-first post-call flags, in words a supervisor can act on. */
export const FLAG_META: Record<Flag, FlagMeta> = {
  promised_callback_without_escalation: {
    label: "Callback promised, none queued",
    explanation: "Ava told the caller someone would call back, but no escalation row was written for this call.",
  },
  status_read_without_verified_identity: {
    label: "Status read before verification",
    explanation: "Claim details were spoken while the caller's identity was not verified.",
  },
  tool_markup_spoken: {
    label: "Tool markup spoken",
    explanation: "Ava read raw tool output or markup aloud instead of a sentence.",
  },
  email_promised_without_send: {
    label: "Email promised, not sent",
    explanation: "Ava said an email was on its way, but no email was sent for this call.",
  },
  claim_promised_without_filing: {
    label: "Claim promised, not filed",
    explanation: "Ava said a claim was filed or submitted, but the caller never confirmed a claim on this call.",
  },
};

export function flagMeta(flag: string): FlagMeta {
  if (flag in FLAG_META) return FLAG_META[flag as Flag];
  const words = flag.replace(/_/g, " ");
  return { label: words.charAt(0).toUpperCase() + words.slice(1), explanation: "Raised by the post-call checks." };
}

export const CHANNEL_LABELS: Record<string, string> = {
  webCall: "Web",
  inboundPhoneCall: "Phone",
  outboundPhoneCall: "Phone (outbound)",
  chat: "Chat",
  unknown: "Unknown",
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "Unknown";
  return CHANNEL_LABELS[channel] ?? channel;
}

export const LEVEL_META: Record<Level, { label: string; description: string }> = {
  none: { label: "Not identified", description: "No phone lookup has matched yet" },
  phone_found: { label: "Phone found", description: "Phone matched a customer; date of birth pending" },
  verified: { label: "Verified", description: "Phone and date of birth matched" },
  locked: { label: "Locked", description: "Two date-of-birth misses; nothing is disclosed" },
};

export interface CallerTypeMeta {
  label: string;
  description: string;
}

/** Caller type words. Missing (a row from before 0006_contacts.sql) reads as unknown, never a guess. */
export const CALLER_TYPE_META: Record<CallerType, CallerTypeMeta> = {
  existing: { label: "Existing", description: "Existing customer: the phone number matched an account" },
  new: { label: "New", description: "New caller: no account, gave their name and details" },
  unknown: { label: "Unknown", description: "Never matched an account or gave their details" },
};

export function callerTypeMeta(type: string | null | undefined): CallerTypeMeta & { type: CallerType } {
  const t: CallerType = type === "existing" || type === "new" ? type : "unknown";
  return { type: t, ...CALLER_TYPE_META[t] };
}

export interface CallReasonMeta {
  label: string;
  description: string;
}

/** Why the caller called, in staff words (the analysis schema's one-line meaning in the tooltip). */
export const CALL_REASON_META: Record<CallReason, CallReasonMeta> = {
  claim_status: { label: "Claim status", description: "Checking on an existing claim" },
  file_claim: { label: "File a claim", description: "Reporting a new loss or starting a claim" },
  documents: { label: "Documents", description: "Which documents are needed, or how to send them" },
  general_question: { label: "General question", description: "Claims process or policy questions answered from the FAQ" },
  speak_to_agent: { label: "Speak to an agent", description: "Wanted a person" },
  update_details: { label: "Update details", description: "Changing contact details or the email on file" },
  emergency: { label: "Emergency", description: "Danger happening at the time of the call" },
  other: { label: "Other", description: "None of the reasons above" },
};

/**
 * The reason's words, or null when the call has none yet (it is never guessed). A value the
 * server adds later shows as its own words rather than disappearing.
 */
export function callReasonMeta(reason: string | null | undefined): (CallReasonMeta & { reason: string }) | null {
  if (!reason) return null;
  if (reason in CALL_REASON_META) return { reason, ...CALL_REASON_META[reason as CallReason] };
  const words = reason.replace(/_/g, " ");
  return { reason, label: words.charAt(0).toUpperCase() + words.slice(1), description: "Why the caller called" };
}

/** Where a call reason came from, strongest first (a later, weaker source never replaces it). */
export const CALL_REASON_SOURCE_LABELS: Record<CallReasonSource, string> = {
  server: "Server facts",
  structured_output: "Call analysis",
  derived: "Tool results",
};

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  auto: "Auto",
  home: "Home",
  property: "Property",
};

export const CLAIM_INTAKE_KIND_LABELS: Record<ClaimIntakeKind, string> = {
  claim: "Claim by a verified customer",
  lead_intake: "Claim details from a new caller",
};

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  new_customer: "New customer",
  email_update: "Email update request",
};

export const ESCALATION_REASON_LABELS: Record<EscalationReason, string> = {
  representative_requested: "Asked for a representative",
  emergency: "Emergency",
  auth_locked: "Verification locked",
  not_found: "Customer not found",
  unsupported_question: "Unsupported question",
  transfer_failed: "Transfer failed",
};

export const ESCALATION_STATUS_LABELS: Record<EscalationStatus, string> = {
  open: "Open",
  claimed: "Claimed",
  done: "Done",
};

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
};

export const CALLBACK_SOURCE_LABELS: Record<CallbackSource, string> = {
  argument: "Given by caller",
  account: "Number on account",
  caller_id: "Caller ID",
  none: "No number",
};

export const EMAIL_KIND_LABELS: Record<EmailKind, string> = {
  callback_request: "Callback request",
  emergency_alert: "Emergency alert",
  sla_realert: "SLA re-alert",
  document_checklist: "Document checklist",
  claim_summary: "Claim summary",
  how_to_start_claim: "How to start a claim",
  claim_received: "Claim confirmation",
  claim_intake: "New claim notice (team)",
};

export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  pending: "Pending",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
};

/** "Unknown caller" when the agent never learned a name (unverified or not found). */
export function callerLabel(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n.length > 0 ? n : "Unknown caller";
}

/** True while a call is live. Always derived from ended_at, never from the generated status column. */
export function isInProgress(row: { ended_at: string | null | undefined }): boolean {
  return row.ended_at === null || row.ended_at === undefined;
}
