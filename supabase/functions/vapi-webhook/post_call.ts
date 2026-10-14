// Post-call write-back (integration #2) and the live call view. Three VAPI server messages feed
// call_interactions and transcript_lines:
//   status-update      in-progress -> stub row; forwarding (phone transfer) -> escalation + alert
//   transcript (final) -> one redacted, masked live line; the first line also writes the stub row,
//                         and a line arriving after the call was closed and cleared is dropped
//   end-of-call-report -> the full row, built from server facts first and VAPI's words second
// Every write is an idempotent upsert or an on-conflict-do-nothing insert, because VAPI redelivers
// on 5xx and partial reports can arrive before full ones. Stored text is redacted, the caller's
// answer to a date-of-birth or phone question is masked whole, and tool arguments never leave the
// envelope. A row that has ended is queued for the Airtable call log (outbox.ts) by whichever
// path wrote it: the report, the backfill that improves it, or the reaper.

import { airtableConfigured } from "./airtable.ts";
import { alertSinks, type EscalationAlert, sendAlert } from "./alert.ts";
import {
  callbackRequestEmail,
  maskEmail,
  sendEmail,
  type TeamCaller,
  teamCallerOf,
  UNKNOWN_TEAM_CALLER,
} from "./email.ts";
import {
  ANALYSIS_OUTCOMES,
  CALL_REASONS,
  type CallerType,
  type CallReason,
  type CallReasonSource,
  type Channel,
  CHANNELS,
  CODES,
  type EscalationReason,
  type Level,
  type Outcome,
  type Sentiment,
  SENTIMENTS,
  STATUS_READ_CODES,
} from "./enums.ts";
import { computeFlags } from "./flags.ts";
import { callerIdNumber, storedCallbackNumber } from "./identity.ts";
import { deliverSoon, enqueueInteraction } from "./outbox.ts";
import type { CallFacts } from "./post_call_facts.ts";
import { asksForSensitive, MASKED_ANSWER, REASK_RE, redactDeep, redactPII } from "./redact.ts";
import type { StoreExtras } from "./store.ts";
import type {
  AttemptRow,
  CallerContact,
  ClaimIntake,
  Customer,
  Deps,
  Env,
  InteractionRow,
  Session,
  Store,
  VapiMessage,
} from "./types.ts";

/** The server facts plus the call's captured contact (caller_contacts) and the loss it reported
 *  (claim_intakes), when there are any. */
export type PostCallFacts = CallFacts & { contact?: CallerContact | null; intake?: ClaimIntake | null };

/** Backfill schedule: GET /call/{id} this many ms apart until the analysis shows up. */
export const BACKFILL_DELAYS_MS: readonly number[] = [5000, 15000, 45000];

export interface EndOfCallOptions {
  /** Overrides BACKFILL_DELAYS_MS (tests pass zeros so the chain runs instantly). */
  backfillDelaysMs?: readonly number[];
}

export const UNKNOWN_CALLER = "Unknown caller";

const VAPI_API = "https://api.vapi.ai";
const BACKFILL_FETCH_TIMEOUT_MS = 10_000;
// Each notification channel of a phone transfer gets at most this much, as in escalate.
const CHANNEL_BUDGET_MS = 2500;
// Bound the redaction work on one live line; a spoken turn is far shorter.
const MAX_LINE_SCAN = 4000;
const MAX_CALLER_NAME = 80;
const MAX_LOG_ERROR = 300;
// Server words for the escalation row a phone transfer writes; nothing the caller or model said.
const FORWARDING_DETAILS = "Live phone transfer to a representative started by the assistant.";

// A report that ends this way with no server code behind the call is abandoned, whatever the
// analysis guessed: nobody was left on the line to be helped.
const IDLE_ENDED_REASONS: ReadonlySet<string> = new Set(["silence-timed-out", "exceeded-max-duration"]);
// Statuses of a row that already holds the full analysis; nothing later may write less over it.
const COMPLETE_ANALYSIS: ReadonlySet<string> = new Set(["ok", "backfilled"]);

const CODE_SET: ReadonlySet<string> = new Set(CODES);
const STATUS_READ_SET: ReadonlySet<string> = new Set(STATUS_READ_CODES);
const CHANNEL_SET: ReadonlySet<string> = new Set(CHANNELS);
const SENTIMENT_SET: ReadonlySet<string> = new Set(SENTIMENTS);
const OUTCOME_SET: ReadonlySet<string> = new Set(ANALYSIS_OUTCOMES);
const CALL_REASON_SET: ReadonlySet<string> = new Set(CALL_REASONS);

// ISO 8601 with a time and an explicit zone: anything else would be read in the database's zone,
// or reject the whole upsert with 22007.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// What a structured-output model writes when it has no name for the caller.
const NAME_PLACEHOLDER_RE =
  /^(unknown|unknown caller|caller|customer|anonymous|n\/?a|none|null|undefined|not provided|not given|no name|unspecified|not specified)$/i;
const TRANSCRIPT_SPEAKER_RE = /^(\s*)(AI|Assistant|Bot|User|Customer)(\s*:\s?)/i;

type Obj = Record<string, unknown>;
type Delivery = { ok: true } | { ok: false; error: string };

/** One stored bubble or tool chip in call_interactions.messages. Arguments never appear here. */
export type StoredMessage =
  | { role: "user" | "assistant"; text: string; t: number | null; name?: string }
  | { role: "tool"; tool: string; code: string | null; t: number | null };

// ---------------------------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------------------------
function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const obj = (v: unknown): Obj => (isObj(v) ? v : {});

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** The string itself (untrimmed) when it has any content. */
function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  return s && ISO_TIMESTAMP_RE.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown";
  return redactPII(text.slice(0, 1000)).slice(0, MAX_LOG_ERROR);
}

function safeLog(deps: Deps, event: Record<string, unknown>): void {
  try {
    deps.log(event);
  } catch {
    // a logging fault must never change what is written
  }
}

/** Background work that must outlive the response; the promise already handles its own failure. */
function keepAlive(deps: Deps, p: Promise<unknown>): void {
  const settled = p.then(() => undefined, () => undefined);
  try {
    deps.waitUntil(settled);
  } catch {
    // outside the Edge Runtime there is nothing to extend
  }
}

function ownNumbers(env: Env): string[] {
  return typeof env?.OWN_NUMBERS === "string" ? env.OWN_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** The VAPI call id: the only key for post-call rows (call is optional on transcript messages). */
function callIdOf(message: VapiMessage): string | null {
  return str(obj(message?.call).id);
}

function channelOf(message: VapiMessage): Channel {
  const type = obj(message.call).type;
  return typeof type === "string" && CHANNEL_SET.has(type) ? type as Channel : "unknown";
}

function callerNumberOf(message: VapiMessage, own: string[]): string | null {
  return callerIdNumber(obj(obj(message.call).customer).number ?? obj(message.customer).number, own);
}

/** The row status-update and the first live line write: enough for the dashboard to show a live call. */
function stubRow(message: VapiMessage, deps: Deps, callKey: string): InteractionRow {
  return {
    vapi_call_id: callKey,
    channel: channelOf(message),
    caller_phone: callerNumberOf(message, ownNumbers(deps.env)),
    started_at: deps.now().toISOString(),
    outcome: "in_progress",
  };
}

async function withinBudget<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Messages, transcript and masking. One rule for all three stored views (messages, transcript,
// transcript_lines): once an assistant turn asks for a date of birth or a phone number, every
// caller turn until the next assistant turn is replaced whole, because the ASR splits a spoken
// date or number into fragments that no pattern can be trusted to recognise.
// ---------------------------------------------------------------------------------------------
function textOf(m: Obj): string | null {
  return str(m.message) ?? str(m.content);
}

function secondsOf(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.round(n));
}

function toolNameOf(v: unknown): string {
  return typeof v === "string" && TOOL_NAME_RE.test(v) ? v : "unknown";
}

/** The code inside a server tool result: JSON.parse once, again if that yields a string. Only a
 *  known code is kept; a native tool's free-text result gives a chip without a code. */
function resultCode(result: unknown): string | null {
  let value = result;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const code = isObj(value) ? value.code : null;
  return typeof code === "string" && CODE_SET.has(code) ? code : null;
}

function rawMessages(message: VapiMessage): unknown[] | null {
  const fromArtifact = obj(message.artifact).messages;
  if (Array.isArray(fromArtifact)) return fromArtifact;
  // the legacy top-level mirror some reports still carry
  return Array.isArray(message.messages) ? message.messages : null;
}

/** artifact.messages -> slim redacted bubbles and tool chips; null when there is nothing to store. */
export function buildMessages(raw: unknown): StoredMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const answered = new Set<string>();
  for (const m of raw) {
    if (isObj(m) && m.role === "tool_call_result" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }
  const out: StoredMessage[] = [];
  let masking = false;
  for (const m of raw) {
    if (!isObj(m)) continue;
    const t = secondsOf(m.secondsFromStart);
    switch (m.role) {
      case "user": {
        const text = textOf(m);
        if (text) out.push({ role: "user", text: masking ? MASKED_ANSWER : redactPII(text), t });
        break;
      }
      case "bot":
      case "assistant": {
        const text = textOf(m);
        if (!text) break;
        const clean = redactPII(text);
        // a re-ask right after a sensitive question asks for the same answer, so masking carries on
        masking = asksForSensitive(clean) || (masking && REASK_RE.test(clean));
        const name = str(m.assistantName);
        out.push(name ? { role: "assistant", text: clean, t, name } : { role: "assistant", text: clean, t });
        break;
      }
      case "tool_call_result":
        out.push({ role: "tool", tool: toolNameOf(m.name), code: resultCode(m.result), t });
        break;
      case "tool_calls":
        // Only to surface a call that never got a result (a timeout); the arguments stay behind.
        for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
          if (!isObj(call) || (typeof call.id === "string" && answered.has(call.id))) continue;
          out.push({ role: "tool", tool: toolNameOf(obj(call.function).name ?? call.name), code: null, t });
        }
        break;
      default:
        // system (the prompt) and anything unknown are never stored
    }
  }
  return out.length > 0 ? out : null;
}

/** How many of the latest assistant lines the live path reads: the question, and the re-asks or line
 *  checks after it (VAPI can split one assistant turn into more than one final transcript). */
const MASK_CARRY_LINES = 6;

/** The masking rule over assistant lines given newest first, as buildMessages applies it in order: a
 *  sensitive question turns it on, and a re-ask or line check right after one keeps it on. */
function maskingAfter(assistantNewestFirst: string[]): boolean {
  let masking = false;
  for (let i = assistantNewestFirst.length - 1; i >= 0; i--) {
    const line = assistantNewestFirst[i];
    masking = asksForSensitive(line) || (masking && REASK_RE.test(line));
  }
  return masking;
}

/** "AI: ..." / "User: ..." transcript, redacted line by line with the masking rule applied. */
export function maskTranscript(text: string): string {
  let speaker: "assistant" | "user" | null = null;
  let masking = false;
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    const label = TRANSCRIPT_SPEAKER_RE.exec(line);
    if (label) speaker = /^(user|customer)$/i.test(label[2]) ? "user" : "assistant";
    if (speaker === "user" && masking) return label ? `${label[0]}${MASKED_ANSWER}` : MASKED_ANSWER;
    const clean = redactPII(line);
    // a wrapped continuation of the same assistant turn can still carry the question
    if (speaker === "assistant") {
      masking = label
        ? asksForSensitive(clean) || (masking && REASK_RE.test(clean))
        : masking || asksForSensitive(clean);
    }
    return clean;
  }).join("\n");
}

function hasUserTurn(raw: unknown[] | null, transcript: string | null): boolean {
  if (raw) return raw.some((m) => isObj(m) && m.role === "user" && textOf(m) !== null);
  return transcript !== null && /^\s*(User|Customer)\s*:\s*\S/im.test(transcript);
}

/** Anything VAPI could have analysed: a spoken turn or a transcript. */
function hadConversation(message: VapiMessage): boolean {
  const raw = rawMessages(message);
  if (raw?.some((m) => isObj(m) && (m.role === "user" || m.role === "bot" || m.role === "assistant") && textOf(m))) {
    return true;
  }
  return (str(obj(message.artifact).transcript) ?? str(message.transcript)) !== null;
}

// ---------------------------------------------------------------------------------------------
// Analysis fields. analysis.structuredData is VAPI's own analysis ('vapi'); artifact.structuredOutputs
// (keyed by id, {name, result}) is the structured output run ('structured_output').
// ---------------------------------------------------------------------------------------------
function structuredOutputs(message: VapiMessage): Obj[] {
  const outputs = obj(message.artifact).structuredOutputs;
  const list = Array.isArray(outputs) ? outputs : isObj(outputs) ? Object.values(outputs) : [];
  return list.filter(isObj);
}

/** A field from every structured output, in order. A scalar result counts when the output itself
 *  is named after the field (an output "sentiment" whose result is "neutral"). */
function outputValues(message: VapiMessage, field: string): unknown[] {
  const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  return structuredOutputs(message).map((o) => {
    if (isObj(o.result)) return o.result[field];
    return typeof o.name === "string" && letters(o.name).includes(letters(field)) ? o.result : undefined;
  });
}

function sentimentOf(v: unknown): Sentiment | null {
  const s = str(v)?.toLowerCase();
  return s && SENTIMENT_SET.has(s) ? s as Sentiment : null;
}

function analysisOutcomeOf(v: unknown): Outcome | null {
  const s = str(v)?.toLowerCase();
  return s && OUTCOME_SET.has(s) ? s as Outcome : null;
}

function callerNameOf(v: unknown): string | null {
  const s = str(v);
  if (!s || /[{}<>[\]]/.test(s) || NAME_PLACEHOLDER_RE.test(s)) return null;
  const clean = redactPII(s).replace(/\s+/g, " ").trim();
  // a "name" that carried a phone number or a date is not a name
  if (clean !== s.replace(/\s+/g, " ") || clean.length > MAX_CALLER_NAME) return null;
  return clean;
}

function sentimentWithSource(message: VapiMessage): { sentiment: Sentiment; source: string } | null {
  const fromVapi = sentimentOf(obj(obj(message.analysis).structuredData).sentiment);
  if (fromVapi) return { sentiment: fromVapi, source: "vapi" };
  for (const v of outputValues(message, "sentiment")) {
    const s = sentimentOf(v);
    if (s) return { sentiment: s, source: "structured_output" };
  }
  return null;
}

function firstOf<T>(values: unknown[], pick: (v: unknown) => T | null): T | null {
  for (const v of values) {
    const picked = pick(v);
    if (picked !== null) return picked;
  }
  return null;
}

function idleOutcome(message: VapiMessage): Outcome | null {
  return typeof message.endedReason === "string" && IDLE_ENDED_REASONS.has(message.endedReason) ? "abandoned" : null;
}

function llmOutcome(message: VapiMessage): Outcome | null {
  const values = [obj(obj(message.analysis).structuredData).outcome, ...outputValues(message, "outcome")];
  return firstOf(values, analysisOutcomeOf);
}

function callReasonValue(v: unknown): CallReason | null {
  const s = str(v)?.toLowerCase();
  return s && CALL_REASON_SET.has(s) ? s as CallReason : null;
}

function structuredCallReason(message: VapiMessage): CallReason | null {
  const values = [obj(obj(message.analysis).structuredData).call_reason, ...outputValues(message, "call_reason")];
  return firstOf(values, callReasonValue);
}

function structuredCallerName(message: VapiMessage): string | null {
  const values = [obj(obj(message.analysis).structuredData).caller_name, ...outputValues(message, "caller_name")];
  return firstOf(values, callerNameOf);
}

// ---------------------------------------------------------------------------------------------
// Numbers.
// ---------------------------------------------------------------------------------------------
// USD amounts are summed in floating point; eight places hides the noise and keeps every real digit.
const roundUsd = (n: number) => Math.round(n * 1e8) / 1e8;

/** Sum of the cost fields of analysisCostBreakdown. Token counts are counts, not dollars. */
function analysisCost(v: unknown): number | null {
  if (!isObj(v)) return null;
  let sum = 0;
  let any = false;
  for (const [key, value] of Object.entries(v)) {
    const n = num(value);
    if (n === null || /tokens/i.test(key)) continue;
    sum += n;
    any = true;
  }
  return any ? roundUsd(sum) : null;
}

/** {stt, llm, tts, vapi, transport, analysis, total} in USD; an absent part is null, never 0. */
export function costBreakdownOf(message: VapiMessage): Record<string, number | null> | null {
  const cb = isObj(message.costBreakdown) ? message.costBreakdown : obj(message.call).costBreakdown;
  if (!isObj(cb)) return null;
  return {
    stt: num(cb.stt),
    llm: num(cb.llm),
    tts: num(cb.tts),
    vapi: num(cb.vapi),
    transport: num(cb.transport),
    analysis: analysisCost(cb.analysisCostBreakdown),
    total: num(cb.total),
  };
}

// Every VAPI number bound for an integer column is rounded first: one fractional value makes
// Postgres reject the whole row (22P02).
function durationOf(message: VapiMessage, startedAt: string | null, endedAt: string | null): number | null {
  const seconds = num(message.durationSeconds);
  if (seconds !== null && seconds >= 0) return Math.round(seconds);
  const ms = num(message.durationMs);
  if (ms !== null && ms >= 0) return Math.round(ms / 1000);
  if (startedAt && endedAt) {
    const diff = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
    if (Number.isFinite(diff) && diff >= 0) return Math.round(diff);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The row.
// ---------------------------------------------------------------------------------------------
function transferred(message: VapiMessage, raw: unknown[] | null): boolean {
  const transfers = obj(message.artifact).transfers;
  if (Array.isArray(transfers) && transfers.length > 0) return true;
  if (message.endedReason === "assistant-forwarded-call") return true;
  return raw?.some((m) => isObj(m) && m.role === "tool_call_result" && m.name === "transferCall") ?? false;
}

/** A get_claim_status answer that read the caller's claims: the summary, the documents, one claim's
 *  details, or that there are none (verify_identity's chained read is recorded as one of these too). */
function readClaims(attempts: AttemptRow[]): boolean {
  return attempts.some((a) => a.tool_name === "get_claim_status" && a.code !== null && STATUS_READ_SET.has(a.code));
}

function serverOutcome(facts: PostCallFacts, escalatedByTransfer: boolean, everVerified: boolean): Outcome | null {
  const escalations = facts.escalations ?? [];
  const attempts = facts.attempts ?? [];
  if (escalations.some((e) => e.kind === "emergency")) return "emergency";
  if (escalatedByTransfer || escalations.some((e) => e.kind === "representative")) return "escalated";
  // A claim taken on the call (either kind) resolved it, a new caller's lead intake included: they
  // were not found, and that was handled.
  if (facts.intake?.confirmed === true) return "resolved";
  if (facts.session?.level === "locked") return "auth_failed";
  // Not found only when no lookup ever matched: a third different number that hit (0010) found an
  // account even if the caller never got through the date of birth. Same rule as the escalation reason.
  if (
    !everVerified && !attempts.some((a) => a.kind === "lookup_hit") && attempts.some((a) => a.kind === "lookup_miss")
  ) {
    return "not_found";
  }
  if (everVerified && readClaims(attempts)) return "resolved";
  return null;
}

/** existing: the session reached an account (a lookup hit, verified or locked after it); new: the
 *  caller gave their details as a new customer; otherwise unknown. */
function callerTypeOf(session: Session | null, attempts: AttemptRow[], contact: CallerContact | null): CallerType {
  if ((session?.level ?? "none") !== "none" || attempts.some((a) => a.kind === "lookup_hit")) return "existing";
  return contact?.kind === "new_customer" ? "new" : "unknown";
}

/** Pure: why the caller called, and who says so. Server facts first (an emergency row, then a claim
 *  filed on the call), then the structured output when it names a known reason, then a reason
 *  derived from what the tools did (a status read, a document checklist sent, a representative
 *  request, an email update, the steps to start a claim sent); otherwise null, left for the
 *  backfill. Never invented. */
export function callReasonOf(
  message: VapiMessage,
  facts: PostCallFacts,
): { reason: CallReason; source: CallReasonSource } | null {
  const escalations = facts.escalations ?? [];
  if (escalations.some((e) => e.kind === "emergency")) return { reason: "emergency", source: "server" };
  if (facts.intake?.confirmed === true) return { reason: "file_claim", source: "server" };
  const structured = structuredCallReason(message);
  if (structured) return { reason: structured, source: "structured_output" };
  const attempts = facts.attempts ?? [];
  const sent = (kind: string) => (facts.emails ?? []).some((e) => e.kind === kind && e.status === "sent");
  // verify_identity's chained read is recorded as a get_claim_status of its own, so it counts here
  if (readClaims(attempts)) return { reason: "claim_status", source: "derived" };
  if (sent("document_checklist")) return { reason: "documents", source: "derived" };
  if (escalations.some((e) => e.kind === "representative")) return { reason: "speak_to_agent", source: "derived" };
  if (facts.contact?.kind === "email_update") return { reason: "update_details", source: "derived" };
  if (sent("how_to_start_claim")) return { reason: "file_claim", source: "derived" };
  return null;
}

/** Pure: the interaction row from an end-of-call-report plus server facts. */
export function buildInteractionRow(
  message: VapiMessage,
  facts: PostCallFacts,
  ownNumberList: string[] = [],
): InteractionRow {
  const call = obj(message.call);
  const analysis = obj(message.analysis);
  const artifact = obj(message.artifact);
  const session: Session | null = facts.session ?? null;
  const attempts: AttemptRow[] = facts.attempts ?? [];

  // The account holder's name and number only for the customer this call verified: a caller who
  // failed DOB, or never gave one, is never labelled with the account they asked about.
  const customer = facts.verifiedCustomer && session?.level === "verified" &&
      session.verified_customer_id === facts.verifiedCustomer.id
    ? facts.verifiedCustomer
    : null;
  // A name the caller gave is a claim, not an identity; next to an unverified account match it
  // would most likely be that account holder's name.
  const candidateUnverified = !customer && session?.candidate_customer_id != null;
  const contact = facts.contact ?? null;
  // The name the caller gave and confirmed on the read-back comes before the analysis' guess, under
  // the same guard: never next to an account the caller did not verify.
  const confirmed = contact?.confirmed === true ? contact : null;
  const capturedName = confirmed && !candidateUnverified
    ? `${confirmed.first_name} ${confirmed.last_name}`.replace(/\s+/g, " ").trim() || null
    : null;
  const givenName = candidateUnverified ? null : structuredCallerName(message);
  const callerName = customer
    ? `${customer.first_name} ${customer.last_name}`.trim() || UNKNOWN_CALLER
    : capturedName ?? givenName ?? UNKNOWN_CALLER;
  const callerId = callerIdNumber(obj(call.customer).number ?? obj(message.customer).number, ownNumberList);

  const summaryText = str(analysis.summary) ?? str(message.summary);
  const summary = summaryText ? redactPII(summaryText) : null;
  const sentiment = sentimentWithSource(message);

  const raw = rawMessages(message);
  const transcriptText = textOrNull(artifact.transcript) ?? textOrNull(message.transcript);
  const byTransfer = transferred(message, raw);
  const everVerified = session?.level === "verified" ||
    attempts.some((a) => a.tool_name === "verify_identity" && a.code === "verified");
  const outcome = serverOutcome(facts, byTransfer, everVerified) ?? idleOutcome(message) ?? llmOutcome(message) ??
    (hasUserTurn(raw, transcriptText) ? "resolved" : "abandoned");
  const reason = callReasonOf(message, facts);
  const intake = facts.intake ?? null;

  const startedAt = isoOrNull(message.startedAt);
  const endedAt = isoOrNull(message.endedAt);
  const latency = num(obj(artifact.performanceMetrics).turnLatencyAverage);
  const success = analysis.successEvaluation;
  const assistantName = str(obj(message.assistant).name);

  return {
    vapi_call_id: callIdOf(message) ?? "",
    channel: str(call.type),
    customer_id: customer?.id ?? null,
    caller_name: callerName,
    // A new caller on the web has no caller id: the number they gave with their details stands in,
    // under the same guard as the name (never next to an account the caller did not verify).
    caller_phone: customer?.phone_e164 ?? callerId ??
      (contact?.kind === "new_customer" && !candidateUnverified ? contact.callback_phone ?? null : null),
    summary,
    sentiment: sentiment?.sentiment ?? null,
    sentiment_source: sentiment?.source ?? null,
    outcome,
    escalated: byTransfer || (facts.escalations ?? []).some((e) => e.kind === "representative"),
    emergency: (facts.escalations ?? []).some((e) => e.kind === "emergency"),
    flags: computeFlags({
      messages: raw ?? [],
      attempts,
      escalations: facts.escalations ?? [],
      emails: facts.emails ?? [],
      intake,
    }),
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationOf(message, startedAt, endedAt),
    ended_reason: str(message.endedReason),
    transcript: transcriptText ? maskTranscript(transcriptText) : null,
    recording_url: str(obj(obj(artifact.recording).mono).combinedUrl) ?? str(artifact.recordingUrl) ??
      str(message.recordingUrl),
    cost: num(message.cost),
    success_evaluation: success === null || success === undefined
      ? null
      : redactPII(typeof success === "string" ? success : JSON.stringify(success)),
    // An empty analysis carries nothing, and null lets the merge keep an earlier report's copy.
    analysis_raw: Object.keys(analysis).length > 0 ? redactDeep(analysis) : null,
    messages: buildMessages(raw),
    latency_avg_ms: latency === null ? null : Math.round(latency),
    cost_breakdown: costBreakdownOf(message),
    assistant_name: assistantName,
    analysis_status: summary && sentiment ? "ok" : "pending",
    caller_type: callerTypeOf(session, attempts, contact),
    // Only an address the caller confirmed, and never next to an account the caller did not verify
    // (the name's guard); the account's own email never lands in the call record.
    caller_email: confirmed && !candidateUnverified ? confirmed.email ?? null : null,
    call_reason: reason?.reason ?? null,
    call_reason_source: reason?.source ?? null,
    // The claim this call filed: a verified customer's intake only (a lead intake has no number).
    claim_number: intake?.confirmed === true && intake.kind === "claim" ? intake.claim_number ?? null : null,
  };
}

// ---------------------------------------------------------------------------------------------
// end-of-call-report.
// ---------------------------------------------------------------------------------------------
async function readCallFacts(store: Store, callKey: string): Promise<PostCallFacts> {
  const [session, attempts, escalations, emails, contact, intake] = await Promise.all([
    store.getSession(callKey),
    store.listAttempts(callKey),
    store.listEscalations(callKey),
    store.listEmails(callKey),
    store.getContact(callKey),
    store.getClaimIntake(callKey),
  ]);
  const verifiedCustomer = session?.level === "verified" && session.verified_customer_id
    ? await store.getCustomer(session.verified_customer_id)
    : null;
  return { session, verifiedCustomer, attempts, escalations, emails, contact, intake };
}

/** The report's analysis inputs with the fetched call's filling the gaps. The report stays the
 *  source for everything it already has; the call adds what the analysis finished later. */
function withFetchedCall(message: VapiMessage, fetched: Obj): VapiMessage {
  const analysis = { ...obj(message.analysis) };
  for (const [k, v] of Object.entries(obj(fetched.analysis))) {
    if (v !== null && v !== undefined && v !== "") analysis[k] = v;
  }
  const reported = obj(message.artifact);
  const later = obj(fetched.artifact);
  const outputs = isObj(reported.structuredOutputs) && Object.keys(reported.structuredOutputs).length > 0
    ? reported.structuredOutputs
    : later.structuredOutputs ?? reported.structuredOutputs;
  return {
    ...message,
    analysis,
    artifact: { ...later, ...reported, structuredOutputs: outputs },
    startedAt: message.startedAt ?? fetched.startedAt,
    endedAt: message.endedAt ?? fetched.endedAt,
    endedReason: message.endedReason ?? (fetched.endedReason as string | undefined),
    costBreakdown: message.costBreakdown ?? fetched.costBreakdown,
  };
}

/** GET /call/{id}: the call, or why not. gone is VAPI's 404 (it holds no call under this id); any
 *  other failure (429, 5xx, a timeout, the network, an unreadable body, a rejected key) may pass. */
type FetchedCall = { ok: true; call: Obj } | { ok: false; gone: boolean };

async function fetchCall(
  deps: Deps,
  callKey: string,
  privateKey: string,
  timeoutMs = BACKFILL_FETCH_TIMEOUT_MS,
): Promise<FetchedCall> {
  try {
    const res = await deps.fetch(`${VAPI_API}/call/${encodeURIComponent(callKey)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${privateKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      safeLog(deps, { event: "backfill_fetch_failed", call_key: callKey, status: res.status });
      return { ok: false, gone: res.status === 404 };
    }
    const body = await res.json();
    return isObj(body) ? { ok: true, call: body } : { ok: false, gone: false };
  } catch (e) {
    safeLog(deps, { event: "backfill_fetch_failed", call_key: callKey, error: errorText(e) });
    return { ok: false, gone: false };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The analysis_status already stored for the call, or null with no row (or a store that cannot
 *  say). A read error throws. */
async function storedAnalysisStatus(store: Store, callKey: string): Promise<string | null> {
  const read = (store as Store & Partial<StoreExtras>).storedAnalysisStatus;
  return typeof read === "function" ? await read.call(store, callKey) : null;
}

/** Whether the call's row has ended, or false for a store that cannot say. A read error throws. */
async function interactionEnded(store: Store, callKey: string): Promise<boolean> {
  const read = (store as Store & Partial<StoreExtras>).interactionEnded;
  return typeof read === "function" ? await read.call(store, callKey) : false;
}

/** Off the request path: re-read the call until the summary is there, then write it. Only reads
 *  VAPI and writes call_interactions; it never alerts anyone. Never throws. */
async function backfill(
  deps: Deps,
  message: VapiMessage,
  facts: PostCallFacts,
  own: string[],
  privateKey: string,
  delays: readonly number[],
): Promise<void> {
  const callKey = callIdOf(message) ?? "";
  const original = buildInteractionRow(message, facts, own);
  let best = original;
  let attempts = 0;
  // Sentiment found only now is the backfill's; one the report already had keeps its source.
  const sourced = (row: InteractionRow): InteractionRow =>
    row.sentiment && !original.sentiment ? { ...row, sentiment_source: "backfill" } : row;
  // A complete report can land while this waits; upsert_interaction takes any status but
  // 'pending', so writing after it would demote the row and relabel its sentiment.
  const write = async (row: InteractionRow, result: "backfilled" | "missing"): Promise<void> => {
    if (COMPLETE_ANALYSIS.has(await storedAnalysisStatus(deps.store, callKey) ?? "")) {
      safeLog(deps, { event: "backfill", call_key: callKey, result: "superseded", attempts });
      return;
    }
    await deps.store.upsertInteraction({ ...sourced(row), analysis_status: result });
    safeLog(deps, { event: "backfill", call_key: callKey, result, attempts });
    // Re-arms the outbox row, so the call log gets the improved record on the next delivery.
    if (row.ended_at) await enqueueInteraction(deps, callKey, "backfill");
  };
  try {
    for (const delay of delays) {
      await sleep(delay);
      attempts++;
      const fetched = await fetchCall(deps, callKey, privateKey);
      if (!fetched.ok) continue;
      best = buildInteractionRow(withFetchedCall(message, fetched.call), facts, own);
      // The summary decides; a sentiment the analysis never produced stays NULL rather than
      // holding the summary back as 'missing'.
      if (best.summary) return await write(best, "backfilled");
    }
    // Whatever arrived is kept; the status says the summary never did. Sentiment is never invented.
    await write(best, "missing");
  } catch (e) {
    safeLog(deps, { event: "backfill_failed", call_key: callKey, error: errorText(e) });
  }
}

/** Removes the call's live lines once the call is closed. Never throws (a failure is logged). */
export async function clearLiveLines(deps: Deps, callKey: string): Promise<void> {
  try {
    // The live view switches to the stored messages; the reaper's 7-day sweep removes anything left.
    await deps.store.deleteTranscriptLines(callKey);
  } catch (e) {
    safeLog(deps, { event: "post_call_error", call_key: callKey, step: "deleteTranscriptLines", error: errorText(e) });
  }
}

/** A completed row goes to the call log: queued in this request, then one short delivery try off
 *  the request path. Neither can fail the request; the every-minute outbox job retries. */
async function queueForCallLog(deps: Deps, callKey: string): Promise<void> {
  const queued = await enqueueInteraction(deps, callKey, "end-of-call-report");
  if (queued && airtableConfigured(deps.env)) keepAlive(deps, deliverSoon(deps, callKey));
}

export async function onEndOfCallReport(
  message: VapiMessage,
  deps: Deps,
  options: EndOfCallOptions = {},
): Promise<{ status: number; body: unknown }> {
  const callKey = callIdOf(message);
  if (!callKey) {
    safeLog(deps, { event: "eocr_rejected", reason: "missing_call_id" });
    return { status: 400, body: { error: "missing_call_id" } };
  }
  const { store, env } = deps;
  // A failed read throws: a row built without the escalation or identity facts would carry a
  // wrong outcome, and the 5xx lets VAPI redeliver into an idempotent upsert.
  const facts = await readCallFacts(store, callKey);
  const own = ownNumbers(env);
  const row = buildInteractionRow(message, facts, own);

  const privateKey = str(env.VAPI_PRIVATE_KEY);
  const incomplete = row.analysis_status !== "ok";
  if (incomplete && COMPLETE_ANALYSIS.has(await storedAnalysisStatus(store, callKey) ?? "")) {
    // A partial report, or a redelivery without the analysis, after the complete one. The stored
    // row already holds everything this one carries (the server facts do not change once the call
    // has ended), and the merge would let it replace the transcript, the caller's name, the
    // status and the sentiment source with less.
    safeLog(deps, { event: "eocr_ignored", call_key: callKey, reason: "row_already_complete" });
    await clearLiveLines(deps, callKey);
    return { status: 200, body: {} };
  }
  const conversation = hadConversation(message);
  // Nothing to analyse (a call that never connected), or no way to ask: the answer is already known.
  const runBackfill = incomplete && conversation && privateKey !== null;
  if (incomplete && !runBackfill) {
    row.analysis_status = "missing";
    if (conversation) {
      safeLog(deps, { event: "backfill_skipped", call_key: callKey, reason: "VAPI_PRIVATE_KEY not set" });
    }
  }

  await store.upsertInteraction(row);
  await clearLiveLines(deps, callKey);
  // A report without an end time is not a finished call yet; the reaper closes it if nothing else does.
  if (row.ended_at) await queueForCallLog(deps, callKey);

  if (runBackfill) {
    const delays = options.backfillDelaysMs ?? BACKFILL_DELAYS_MS;
    keepAlive(deps, backfill(deps, message, facts, own, privateKey, delays));
  }
  return { status: 200, body: {} };
}

// ---------------------------------------------------------------------------------------------
// Recovery of a call whose report never came (the reaper, jobs.ts).
// ---------------------------------------------------------------------------------------------
// not_found: VAPI holds no call under the id. unavailable: VAPI could not answer this time.
export type RecoverResult = "recovered" | "superseded" | "not_ended" | "not_found" | "unavailable";

/** The fetched VAPI call shaped as the end-of-call-report it stands in for: the call object
 *  carries the same analysis, artifact, timestamps, cost and customer fields a report does. */
function reportFromCall(fetched: Obj, callKey: string): VapiMessage {
  return { ...fetched, type: "end-of-call-report", call: { ...fetched, id: callKey } };
}

/** GET /call/{id} for a call still open in the database and, when VAPI says it ended, the row the
 *  report would have written, built by the same code from the same server facts. analysis_status
 *  is backfilled with a summary, else missing; a sentiment found is the backfill's. Only reads VAPI
 *  and writes call_interactions, the live lines and the outbox; it never alerts anyone. A store
 *  error throws; VAPI's 404 is "not_found" and any other VAPI failure "unavailable" (the caller
 *  decides what happens next). */
export async function recoverFromCall(
  deps: Deps,
  callKey: string,
  privateKey: string,
  timeoutMs = BACKFILL_FETCH_TIMEOUT_MS,
): Promise<RecoverResult> {
  const response = await fetchCall(deps, callKey, privateKey, timeoutMs);
  if (!response.ok) return response.gone ? "not_found" : "unavailable";
  const fetched = response.call;
  const status = fetched.status;
  if (isoOrNull(fetched.endedAt) === null || (status !== undefined && status !== "ended")) return "not_ended";

  const { store } = deps;
  const facts = await readCallFacts(store, callKey);
  const row = buildInteractionRow(reportFromCall(fetched, callKey), facts, ownNumbers(deps.env));
  // The report can land while this ran; the merge would let this row replace its analysis.
  if (COMPLETE_ANALYSIS.has(await storedAnalysisStatus(store, callKey) ?? "")) return "superseded";
  await store.upsertInteraction({
    ...row,
    sentiment_source: row.sentiment ? "backfill" : null,
    analysis_status: row.summary ? "backfilled" : "missing",
  });
  safeLog(deps, { event: "recovered", call_key: callKey, summary: row.summary !== null });
  // The live lines give way only to stored messages: without them they are the dashboard's only
  // transcript of the call (its fallback view), kept until the 7-day sweep.
  if (Array.isArray(row.messages) && row.messages.length > 0) await clearLiveLines(deps, callKey);
  await enqueueInteraction(deps, callKey, "reaper");
  return "recovered";
}

// ---------------------------------------------------------------------------------------------
// transcript (final lines only).
// ---------------------------------------------------------------------------------------------
export async function onTranscript(message: VapiMessage, deps: Deps): Promise<void> {
  if (message?.transcriptType !== "final") return;
  const role = message.role === "user" || message.role === "assistant" ? message.role : null;
  if (!role) return;
  const callKey = callIdOf(message);
  if (!callKey) {
    safeLog(deps, { event: "transcript_dropped", reason: "missing_call_id" });
    return;
  }
  const spoken = str(message.transcript);
  if (!spoken) return;
  const { store } = deps;

  // The assistant's latest lines, newest first: the question this line may answer, and any re-ask or
  // line check after it that keeps its masking on.
  let recentAssistant: string[] = [];
  let unknownContext = false;
  try {
    recentAssistant = await store.recentAssistantLines(callKey, MASK_CARRY_LINES);
  } catch (e) {
    unknownContext = true;
    safeLog(deps, { event: "post_call_error", call_key: callKey, step: "recentAssistantLines", error: errorText(e) });
  }
  const lastAssistant = recentAssistant[0] ?? null;
  if (lastAssistant === null && !unknownContext) {
    // No assistant line stored: the start of the call, or a line VAPI delivered after the report
    // closed the call and cleared its lines, when the question this answers is gone with them.
    // The record already holds the conversation, so a late line is dropped rather than stored
    // without the masking its question would have given it.
    let ended = false;
    try {
      ended = await interactionEnded(store, callKey);
    } catch (e) {
      unknownContext = true;
      safeLog(deps, { event: "post_call_error", call_key: callKey, step: "interactionEnded", error: errorText(e) });
    }
    if (ended) {
      safeLog(deps, { event: "transcript_dropped", call_key: callKey, reason: "call_ended" });
      return;
    }
  }
  if (lastAssistant === null) {
    // The start of the call: the stub row lets the dashboard show it even on web calls, where
    // status-update never says in-progress.
    try {
      await store.ensureInteraction(stubRow(message, deps, callKey));
    } catch (e) {
      safeLog(deps, { event: "post_call_error", call_key: callKey, step: "ensureInteraction", error: errorText(e) });
    }
  }

  // Without the previous question the answer may be a DOB, so it is withheld.
  const masked = role === "user" && (unknownContext || maskingAfter(recentAssistant));
  const text = masked ? MASKED_ANSWER : redactPII(spoken.slice(0, MAX_LINE_SCAN));
  const timestamp = num(message.timestamp);
  await store.insertTranscriptLine({
    call_key: callKey,
    role,
    text,
    ts_ms: timestamp !== null ? Math.round(timestamp) : deps.now().getTime(),
  });
}

// ---------------------------------------------------------------------------------------------
// status-update.
// ---------------------------------------------------------------------------------------------
/** The same server override escalate applies: the session knows why the caller wanted a person. */
function forwardingReason(level: Level, attempts: AttemptRow[]): EscalationReason {
  if (level === "locked") return "auth_locked";
  if (level === "none" && attempts.some((a) => a.kind === "lookup_miss")) return "not_found";
  return "representative_requested";
}

async function readOr<T>(deps: Deps, callKey: string, step: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    safeLog(deps, { event: "post_call_error", call_key: callKey, step, error: errorText(e) });
    return fallback;
  }
}

async function telegramDelivery(deps: Deps, alert: EscalationAlert): Promise<Delivery> {
  try {
    const result = await sendAlert(deps, alert);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "not delivered" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** The callback_request email through the at-most-once ledger shared with escalate. */
async function teamEmailDelivery(
  deps: Deps,
  callKey: string,
  render: () => { subject: string; html: string },
): Promise<Delivery> {
  try {
    const { env, store } = deps;
    if (!alertSinks(env).includes("email")) return { ok: false, error: "email disabled by ALERT_SINKS" };
    const to = str(env.CLAIMS_TEAM_EMAIL);
    if (!to) return { ok: false, error: "CLAIMS_TEAM_EMAIL not set" };
    // Rendered before the claim, so a template fault cannot strand a 'sending' row.
    const { subject, html } = render();
    const claim = await store.claimEmail(callKey, "callback_request", maskEmail(to));
    if (!claim.claimed) return claim.status === "sent" ? { ok: true } : { ok: false, error: `email ${claim.status}` };
    const sent = await sendEmail(
      deps,
      { to, subject, html, idempotencyKey: `${callKey}:callback_request` },
      CHANNEL_BUDGET_MS,
    );
    try {
      await store.finishEmail(
        callKey,
        "callback_request",
        sent.ok ? "sent" : "failed",
        sent.ok ? sent.id : null,
        sent.ok ? null : sent.error,
      );
    } catch (e) {
      safeLog(deps, { event: "post_call_error", call_key: callKey, step: "finishEmail", error: errorText(e) });
    }
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  } catch (e) {
    return { ok: false, error: `email ledger: ${errorText(e)}` };
  }
}

/** Who the transfer's team email names: the verified account holder, else the confirmed captured
 *  caller (the contact already read for the callback number). A failed read costs the name only. */
async function forwardingCaller(
  deps: Deps,
  callKey: string,
  session: Session | null,
  contact: CallerContact | null,
): Promise<TeamCaller> {
  const customerId = session?.level === "verified" ? session.verified_customer_id : null;
  const customer = customerId
    ? await readOr<Customer | null>(deps, callKey, "getCustomer", () => deps.store.getCustomer(customerId), null)
    : null;
  return teamCallerOf(customer, contact);
}

/** A phone transfer started: the escalation row first, then Telegram and the team email in
 *  parallel. A repeat (redelivery, or escalate already ran) never alerts twice. */
async function onForwarding(message: VapiMessage, deps: Deps, callKey: string): Promise<void> {
  const { store, env } = deps;
  const channel = channelOf(message);
  const own = ownNumbers(env);
  const callerNumber = callerNumberOf(message, own);
  const [session, attempts, contact] = await Promise.all([
    readOr<Session | null>(deps, callKey, "getSession", () => store.getSession(callKey), null),
    readOr<AttemptRow[]>(deps, callKey, "listAttempts", () => store.listAttempts(callKey), []),
    // Best effort: without the row the transfer falls back to the caller id, as before contacts.
    typeof store?.getContact === "function"
      ? readOr<CallerContact | null>(deps, callKey, "getContact", () => store.getContact(callKey), null)
      : Promise.resolve(null),
  ]);
  const level: Level = session?.level ?? "none";
  const verified = level === "verified";
  const reason = forwardingReason(level, attempts);
  // A number the caller said with their details beats the caller id they may have said not to use
  // ("Is the number you're calling from the best one?" "No, it's ..."), as in escalate; kept as stored.
  const captured = contact?.callback_source === "argument" ? storedCallbackNumber(contact.callback_phone, own) : null;
  const callbackPhone = captured ?? callerNumber;

  // upsert_escalation merges every non-null value into an existing row, so this first write
  // carries nothing to merge: a row escalate already wrote keeps the number and the details the
  // caller gave. A database error throws (5xx): VAPI redelivers and the row is written then.
  const base = { callKey, kind: "representative" as const, reason, channel, verified };
  const row = await store.upsertEscalation({ ...base, details: null, callbackPhone: null, callbackSource: "none" });
  if (!row.inserted) return;
  try {
    // The row is this transfer's own, so the server's words and the callback number go on it.
    await store.upsertEscalation({
      ...base,
      details: FORWARDING_DETAILS,
      callbackPhone,
      callbackSource: captured ? "argument" : callerNumber ? "caller_id" : "none",
    });
  } catch (e) {
    // The alert still goes out; a 5xx would find the row on redelivery and never send it.
    safeLog(deps, { event: "post_call_error", call_key: callKey, step: "upsertEscalation", error: errorText(e) });
  }

  const alert: EscalationAlert = { kind: "representative", reason, callKey, channel, verified };
  const timedOut = (): Delivery => ({ ok: false, error: "timeout" });
  // Best effort: a failed read shows an unknown caller and never holds the alert back.
  const caller = await withinBudget(forwardingCaller(deps, callKey, session, contact), CHANNEL_BUDGET_MS, () => ({
    ...UNKNOWN_TEAM_CALLER,
  }));
  const email = teamEmailDelivery(deps, callKey, () =>
    callbackRequestEmail({
      callKey,
      reason,
      verified,
      callbackPhone,
      details: FORWARDING_DETAILS,
      channel,
      dashboardUrl: env.DASHBOARD_URL,
      caller,
    }));
  // The ledger write-back after a slow send must still land after the budget gives up waiting.
  keepAlive(deps, email);
  const [telegramResult, emailResult] = await Promise.all([
    withinBudget(telegramDelivery(deps, alert), CHANNEL_BUDGET_MS, timedOut),
    withinBudget(email, CHANNEL_BUDGET_MS, timedOut),
  ]);
  const errors: string[] = [];
  if (!telegramResult.ok) errors.push(`telegram: ${telegramResult.error}`);
  if (!emailResult.ok) errors.push(`email: ${emailResult.error}`);
  const notified = telegramResult.ok || emailResult.ok;
  try {
    await store.setEscalationDelivery(
      row.id,
      notified ? "sent" : "failed",
      errors.length > 0 ? errors.join("; ") : null,
    );
  } catch (e) {
    // a redelivery would find the row and not retry the alert, so a 5xx gains nothing here
    safeLog(deps, { event: "post_call_error", call_key: callKey, step: "setEscalationDelivery", error: errorText(e) });
  }
}

export async function onStatusUpdate(message: VapiMessage, deps: Deps): Promise<void> {
  const status = message?.status;
  if (status !== "in-progress" && status !== "forwarding") return;
  const callKey = callIdOf(message);
  if (!callKey) {
    safeLog(deps, { event: "status_update_dropped", status, reason: "missing_call_id" });
    return;
  }
  if (status === "forwarding") {
    await onForwarding(message, deps, callKey);
    return;
  }
  const channel = channelOf(message);
  const callerNumber = callerNumberOf(message, ownNumbers(deps.env));
  // Both writes are attempted even if one fails; either failing is a 5xx so VAPI redelivers.
  const results = await Promise.allSettled([
    deps.store.ensureSession(callKey, channel, callerNumber),
    deps.store.ensureInteraction(stubRow(message, deps, callKey)),
  ]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}
