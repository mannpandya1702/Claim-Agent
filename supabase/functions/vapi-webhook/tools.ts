// The server tools. Each one turns model arguments (already past the trust boundary) and
// server state into one result code and the exact sentence VAPI speaks. The model never decides
// an outcome: identity comes from the session row, the callback target from the caller, the
// account or the envelope, and a channel counts as delivered only when its transport confirmed it.

import { alertSinks, type ClaimIntakeAlert, type EscalationAlert, sendAlert, type TeamAlert } from "./alert.ts";
import {
  callbackRequestEmail,
  claimIntakeEmail,
  claimReceivedEmail,
  claimSummaryEmail,
  documentChecklistEmail,
  emergencyEmail,
  howToStartEmail,
  maskEmail,
  sendEmail,
  teamCallerOf,
} from "./email.ts";
import {
  type CallbackSource,
  CLAIM_DOCUMENTS,
  CLAIM_STATUS_DETAILS,
  CLAIM_TYPES,
  type ClaimStatusDetail,
  type ClaimType,
  type Code,
  CODES,
  type ContactCallbackSource,
  type ContactKind,
  type EmailKind,
  type EscalationReason,
  INFO_EMAIL_TOPICS,
  type InfoEmailTopic,
  type Level,
  MODEL_ESCALATION_REASONS,
  type ServerTool,
  TIMEZONE,
  VERIFY_INTENTS,
  type VerifyIntent,
} from "./enums.ts";
import {
  givenCallbackNumber,
  lastFour,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  parseDobParts,
  storedCallbackNumber,
  usableCallbackNumber,
} from "./identity.ts";
import { parseLossDate } from "./loss_date.ts";
import { parseToolRequest } from "./parse_tool_request.ts";
import { statusOpening, verifiedSentence } from "./prior_contacts.ts";
import { redactPII } from "./redact.ts";
import {
  assertSpeakable,
  byReadingPriority,
  claimDetailSentence,
  claimsSentence,
  claimsUnread,
  documentsSentence,
  MAX_SPOKEN_CHARS,
  MAX_TURN_WORDS,
  MAX_WHICH_CLAIMS,
  sentenceFor,
  spokenName,
  spokenWords,
  verifiedFileClaimSentence,
  verifiedStatusSentence,
} from "./speak.ts";
import type {
  AttemptRow,
  CallerContact,
  Claim,
  ClaimIntake,
  Customer,
  EmailRow,
  Env,
  EscalationRow,
  ParsedToolCall,
  PriorInteraction,
  Session,
  Store,
  ToolCtx,
  ToolResult,
} from "./types.ts";

/** Wall-clock budget for one tool call; VAPI's own tool timeout is 10 s. */
export const TOOL_BUDGET_MS = 5000;
// Each notification channel (Telegram, team email, customer email) gets at most this much.
const CHANNEL_BUDGET_MS = 2500;
// Kept back from the budget so the answer leaves before the budget timer fires; the write-backs
// that follow a transport run in the background and never hold the answer.
const ANSWER_MARGIN_MS = 250;
const MAX_DETAILS = 500;
// Bound the redaction work on huge model text; only the first MAX_DETAILS characters survive.
const MAX_DETAILS_SCAN = 2000;
const PRIOR_CONTACTS_LIMIT = 3;
const MAX_LOG_ERROR = 300;

type Args = Record<string, unknown>;
type Delivery = { ok: true } | { ok: false; error: string };
type Callback = { phone: string | null; source: CallbackSource };

// The per-call context plus what the tool bodies need for bookkeeping.
interface Run extends ToolCtx {
  tool: ServerTool;
  deadline: number; // Date.now() value at which the budget runs out
}

interface ToolSpec {
  name: ServerTool;
  run(args: Args, ctx: Run): Promise<ToolResult>;
  // The answer when the tool throws or overruns its budget.
  fallback(ctx: Run): ToolResult;
  // Uncounted tools claim their toolCallId in the attempts ledger first; a second delivery of
  // the same id is answered here from the stored code, without repeating any side effect.
  replay?(code: Code, args: Args, ctx: Run): Promise<ToolResult>;
  // Argument checks that must pass before anything is read or written (else bad_args).
  valid?(args: Args): boolean;
  // A caller in danger is never asked to repeat themselves: refused arguments are dropped instead.
  neverRefuse?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------------------------
/** The tool result for a code, worded for this call: the call key picks the phrasing of the sentences
 *  that have several (speak.ts variantIndex), so a retry or replay of the call hears the same words. */
function answer(ctx: Pick<ToolCtx, "callKey">, code: Code, data?: Record<string, unknown>): ToolResult {
  return data
    ? { code, sentence: sentenceFor(code, data, ctx.callKey), data }
    : { code, sentence: sentenceFor(code, undefined, ctx.callKey) };
}

const systemError = (ctx: Pick<ToolCtx, "callKey">) => answer(ctx, "system_error");

function asCode(value: string): Code {
  return (CODES as readonly string[]).includes(value) ? value as Code : "system_error";
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.slice(0, MAX_LOG_ERROR);
}

function safeLog(ctx: Run, event: Record<string, unknown>): void {
  try {
    ctx.deps.log({ call_key: ctx.callKey, tool: ctx.tool, ...event });
  } catch {
    // a logging fault must never change a tool result
  }
}

function logError(ctx: Run, step: string, e: unknown): void {
  safeLog(ctx, { event: "tool_error", step, error: errorText(e) });
}

/** A read whose failure only costs enrichment: logged, and the fallback is used instead. */
async function readOr<T>(ctx: Run, step: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    logError(ctx, step, e);
    return fallback;
  }
}

/** Bookkeeping that must not hold the answer: started now, finished under waitUntil. */
function writeBack(ctx: Run, step: string, write: () => Promise<unknown>): void {
  let task: Promise<void>;
  try {
    task = write().then(() => undefined, (e) => logError(ctx, step, e));
  } catch (e) {
    logError(ctx, step, e);
    return;
  }
  try {
    ctx.deps.waitUntil(task);
  } catch {
    // the write is already running and handles its own failure
  }
}

/** Resolves with the work's value, or with onTimeout() once ms have passed. The timer is always cleared. */
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

function channelBudget(ctx: Run): number {
  return Math.min(CHANNEL_BUDGET_MS, ctx.deadline - Date.now() - ANSWER_MARGIN_MS);
}

function ownNumbers(env: Env): string[] {
  return typeof env?.OWN_NUMBERS === "string" ? env.OWN_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** A callback number as its read-back takes it: a North American number as its ten digits
 *  ("+16025550177" -> "6025550177"); an international one ("+442079460958") or one noted as said
 *  ("9601550123") as stored. */
function readBackNumber(phone: string): string {
  return /^\+1\d{10}$/.test(phone) ? phone.slice(2) : phone;
}

const NY_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today in New York as YYYY-MM-DD: the reference date for spoken claim dates. */
function todayInNewYork(now: Date): string {
  const parts = NY_DAY.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Model-written free text for an escalation row: redacted first, then cut, or null. */
function cleanDetails(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  // Redact the whole text before cutting it, so a number split at the limit cannot slip through.
  const clean = redactPII(text.slice(0, MAX_DETAILS_SCAN)).replace(/\s+/g, " ").trim().slice(0, MAX_DETAILS).trim();
  return clean || null;
}

function isSpeakable(text: string): boolean {
  try {
    assertSpeakable(text);
    return true;
  } catch {
    return false;
  }
}

async function verifiedCustomer(store: Store, session: Session): Promise<Customer> {
  if (!session.verified_customer_id) throw new Error("verified session without a verified customer");
  const customer = await store.getCustomer(session.verified_customer_id);
  if (!customer) throw new Error("verified customer row missing");
  return customer;
}

// ---------------------------------------------------------------------------------------------
// lookup_customer {phone}
// ---------------------------------------------------------------------------------------------
const LOOKUP_CODES: ReadonlySet<Code> = new Set<Code>([
  "invalid_phone",
  "not_found",
  "not_found_final",
  "needs_dob",
  "locked",
  "already_verified",
]);

async function lookupCustomer(args: Args, ctx: Run): Promise<ToolResult> {
  // An unreadable number still goes to the SQL function, which records it as uncounted.
  const phoneE164 = normalisePhone(args.phone);
  const { code } = await ctx.deps.store.lookupCustomerAttempt({
    callKey: ctx.callKey,
    channel: ctx.channel,
    phoneE164,
    toolCallId: ctx.toolCallId,
    callerNumber: ctx.callerNumber,
  });
  if (!LOOKUP_CODES.has(code)) throw new Error("lookup_customer_attempt returned an unexpected code");
  return code === "not_found" && phoneE164
    ? answer(ctx, code, { digits: readBackNumber(phoneE164) })
    : answer(ctx, code);
}

// ---------------------------------------------------------------------------------------------
// verify_identity {dob_month, dob_day, dob_year}
// ---------------------------------------------------------------------------------------------
const VERIFY_CODES: ReadonlySet<Code> = new Set<Code>([
  "verified",
  "auth_failed",
  "locked",
  "no_lookup_yet",
  "dob_unreadable",
  "dob_give_up",
]);

function verifyIntentOf(v: unknown): VerifyIntent {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  // An intent off the list never refuses a verification; it only loses the shortcut.
  return (VERIFY_INTENTS as readonly string[]).includes(s) ? s as VerifyIntent : "other";
}

// start_claim answers that sent the caller to verify (or look up) first, or to give their details first.
const VERIFY_RESUME_CODES: ReadonlySet<string> = new Set(["claim_needs_verification", "claim_needs_lookup"]);
const CONTACT_RESUME_CODES: ReadonlySet<string> = new Set([
  "claim_needs_contact",
  "claim_needs_lookup",
  "claim_needs_phone",
]);

/** Whether a start_claim on this call was answered with one of `codes` (or a confirm_claim with
 *  claim_needs_phone, when that is one of them): the caller already told the loss, and was sent to verify
 *  or give their details first. The next sentence then asks whether to take it down now instead of asking
 *  what happened again. A failed read asks what happened. */
async function claimWaiting(ctx: Run, codes: ReadonlySet<string>): Promise<boolean> {
  const attempts = await readOr<AttemptRow[]>(ctx, "listAttempts", () => ctx.deps.store.listAttempts(ctx.callKey), []);
  return attempts.some((a) =>
    a.code !== null && codes.has(a.code) &&
    (a.tool_name === "start_claim" || (a.tool_name === "confirm_claim" && a.code === "claim_needs_phone"))
  );
}

function claimsData(claims: Claim[]): Record<string, unknown>[] {
  return claims.map((c) => ({
    claim_number_last3: String(c.claim_number ?? "").replace(/\D/g, "").slice(-3),
    status: c.status,
  }));
}

/** verify_identity with intent claim_status reads the claims summary in the same call, after a short
 *  opening (statusOpening), within one turn's words. The read is recorded in the ledger as a
 *  get_claim_status of its own (toolCallId "<id>:status"), so the post-call outcome and the flags see
 *  a status read exactly as they would for the separate tool. A replay finds that row and records
 *  nothing again (the claims are simply read again, as a get_claim_status replay does); a failed read
 *  gives the plain verified answer. */
async function chainedStatus(
  ctx: Run,
  customerId: string,
  opening: string,
): Promise<{ sentence: string; claims: Claim[] } | null> {
  const { store } = ctx.deps;
  const statusId = `${ctx.toolCallId}:status`;
  let holds = false;
  try {
    holds = (await store.claimAttempt(ctx.callKey, statusId, "get_claim_status")) === null;
  } catch (e) {
    // the answer still goes out; only the timeline entry (and the resolved outcome) is lost
    logError(ctx, "claimAttempt", e);
  }
  const record = (code: Code) => {
    if (holds) writeBack(ctx, "setAttemptCode", () => store.setAttemptCode(ctx.callKey, statusId, code));
  };
  try {
    const claims = await store.getClaims(customerId);
    // The summary follows the opening in the same turn, so it gets the words the opening leaves.
    const status = claims.length === 0
      ? sentenceFor("no_claims")
      : claimsSentence(claims, todayInNewYork(ctx.deps.now()), MAX_TURN_WORDS - spokenWords(opening), ctx.callKey);
    const sentence = verifiedStatusSentence(opening, status);
    if (!isSpeakable(sentence) || sentence.length > MAX_SPOKEN_CHARS) throw new Error("chained status not speakable");
    record(claims.length === 0 ? "no_claims" : "ok");
    return { sentence, claims };
  } catch (e) {
    logError(ctx, "chainedStatus", e);
    record("system_error");
    return null;
  }
}

async function verifyIdentity(args: Args, ctx: Run): Promise<ToolResult> {
  const { store, env } = ctx.deps;
  const now = ctx.deps.now();
  // The UTC year matches the bound the SQL function applies with extract(year from now()).
  const dob = parseDobParts(args.dob_month, args.dob_day, args.dob_year, now.getUTCFullYear());
  const result = await store.verifyDobAttempt({
    callKey: ctx.callKey,
    year: dob?.year ?? null,
    month: dob?.month ?? null,
    day: dob?.day ?? null,
    toolCallId: ctx.toolCallId,
  });
  if (!VERIFY_CODES.has(result.code)) throw new Error("verify_dob_attempt returned an unexpected code");
  if (result.code !== "verified") return answer(ctx, result.code);

  const firstName = typeof result.firstName === "string" ? result.firstName.trim() : "";
  const enabled = env.PRIOR_CONTACTS_ENABLED === "true";
  const customerId = result.customerId;
  // History only colours the greeting; a failed read gives the plain sentence, never an error.
  const rows: PriorInteraction[] = enabled && customerId
    ? await readOr(
      ctx,
      "priorInteractions",
      () => store.priorInteractions(customerId, ctx.callKey, PRIOR_CONTACTS_LIMIT),
      [],
    )
    : [];
  let sentence = verifiedSentence(firstName, rows, enabled, now, ctx.callKey);
  if (!isSpeakable(sentence)) sentence = sentenceFor("verified", { first_name: firstName }, ctx.callKey);
  const data: Record<string, unknown> = firstName ? { first_name: firstName } : {};
  const verified = (text: string): ToolResult =>
    Object.keys(data).length > 0 ? { code: "verified", sentence: text, data } : { code: "verified", sentence: text };

  // The caller usually said why they called before verifying; the verified answer leads straight on.
  const intent = verifyIntentOf(args.intent);
  if (intent === "file_claim") {
    const resume = await claimWaiting(ctx, VERIFY_RESUME_CODES);
    return verified(verifiedFileClaimSentence(sentence, resume));
  }
  if (intent === "claim_status" && customerId) {
    const chained = await chainedStatus(ctx, customerId, statusOpening(firstName, rows, enabled, ctx.callKey));
    if (chained) {
      data.status_read = true;
      data.claims = claimsData(chained.claims);
      return verified(chained.sentence);
    }
  }
  return verified(sentence);
}

// ---------------------------------------------------------------------------------------------
// get_claim_status {detail?, claim_ending?}
// ---------------------------------------------------------------------------------------------
/** What claim_ending names, as a key of up to three space-separated parts in this order: a claim
 *  type ("auto", "home", "property"), a status ("denied", "payment_issued", "approved", ...) and the
 *  last digits ("198"). "home 198" for "the home one ending in 198"; "" when it names nothing.
 *  Digits are a numeral group ("198", "CLM-240198", or single digits said apart, "1 9 8") or digit
 *  words ("one nine eight", or one after "ending in"); dates and amounts are never read as an ending
 *  ("the one paid October 8" is the paid claim), and two different endings ("198 or 115") name no
 *  digits at all, so the tool asks which. Self-contained (no module references), so the battery's
 *  VAPI code tool runs this same reading from its source. */
export function claimEndingKey(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const text = ` ${String(v).toLowerCase()} `
    .replace(new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s*\\d{4}\\b)?`, "g"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${month})\\b`, "g"), " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/\$\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|bucks|cents?)\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/g, " ");
  const tokens = text.split(/[^a-z0-9]+/).filter((t) => t !== "");
  const digitWords: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  const types: Record<string, string> = {
    auto: "auto",
    car: "auto",
    vehicle: "auto",
    home: "home",
    house: "home",
    property: "property",
  };
  const statuses: Record<string, string> = {
    received: "received",
    review: "under_review",
    documents: "awaiting_documents",
    document: "awaiting_documents",
    docs: "awaiting_documents",
    paperwork: "awaiting_documents",
    approved: "approved",
    paid: "payment_issued",
    payment: "payment_issued",
    denied: "denied",
    denial: "denied",
    closed: "closed",
  };
  // Runs of adjacent numerals and digit words. Single digits said apart join into one ending; a
  // longer numeral is an ending of its own. Digit words alone count only as two or more, after
  // "ending in", or as the whole answer: "the home one" names a type, not a claim ending in one.
  const groups: string[] = [];
  let run: string[] = [];
  const flush = (end: number) => {
    if (run.length === 0) return;
    const words = run.every((t) => t in digitWords);
    const before = tokens[end - run.length - 1] ?? "";
    const cue = before === "in" || before === "ending" || before === "ends";
    if (words && !(run.length >= 2 || cue || run.length === tokens.length)) {
      run = [];
      return;
    }
    const digits = run.map((t) => digitWords[t] ?? t);
    if (digits.every((d) => d.length === 1)) groups.push(digits.join(""));
    else groups.push(...digits.filter((d) => d.length > 1));
    run = [];
  };
  tokens.forEach((t, i) => {
    if (/^[0-9]+$/.test(t) || t in digitWords) run.push(t);
    else flush(i);
  });
  flush(tokens.length);
  // One ending, or several that agree ("CLM-240198, ending 198"); anything else names no digits.
  const longest = groups.reduce((a, b) => (b.length > a.length ? b : a), "");
  const digits = groups.every((g) => longest.endsWith(g)) ? longest : "";
  const one = (found: string[]) => (new Set(found).size === 1 ? found[0] : "");
  const type = one(tokens.filter((t) => t in types).map((t) => types[t]));
  const status = one(tokens.filter((t) => t in statuses).map((t) => statuses[t]));
  return [type, status, digits].filter(Boolean).join(" ");
}

/** Whether a claim (its number's digits, type and status) is the one a claimEndingKey key names:
 *  every part of the key must fit ("approved" fits a claim that has since been paid). Self-contained,
 *  like claimEndingKey, so the battery's mock matches claims exactly as the server does. */
export function claimMatchesKey(digits: string, type: string, status: string, key: string): boolean {
  if (!key) return false;
  return key.split(" ").every((part) =>
    /^[0-9]+$/.test(part)
      ? digits.endsWith(part)
      : part === "auto" || part === "home" || part === "property"
      ? type === part
      : part === "approved"
      ? status === "approved" || status === "payment_issued"
      : status === part
  );
}

/** The claims claim_ending names (claimMatchesKey), in the order given. */
function claimsNamed(claims: Claim[], key: string): Claim[] {
  return claims.filter((c) =>
    claimMatchesKey(String(c.claim_number ?? "").replace(/\D/g, ""), c.claim_type, c.status, key)
  );
}

/** claim_not_identified's data: the claims offered, by ending, type and status (ids and enums only). */
export function claimChoicesData(claims: Claim[]): Record<string, unknown>[] {
  return claims.map((c) => ({
    claim_number_last3: String(c.claim_number ?? "").replace(/\D/g, "").slice(-3),
    claim_type: c.claim_type,
    status: c.status,
  }));
}

/** The claims a question about which claim offers, at most MAX_WHICH_CLAIMS: the ones the caller's
 *  words matched (named, two or more) in reading order; otherwise every claim, the ones the summary
 *  only counted ("There are two more claims on file.") first, so the caller hears their endings. */
export function claimsToOffer(claims: Claim[], named: Claim[], today: string): Claim[] {
  if (named.length > 1) return [...named].sort(byReadingPriority).slice(0, MAX_WHICH_CLAIMS);
  const unread = claimsUnread(claims, today);
  const read = [...claims].sort(byReadingPriority).filter((c) => !unread.includes(c));
  return [...unread, ...read].slice(0, MAX_WHICH_CLAIMS);
}

function statusDetailOf(v: unknown, key: string): ClaimStatusDetail {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if ((CLAIM_STATUS_DETAILS as readonly string[]).includes(s)) return s as ClaimStatusDetail;
  // An off-list or missing detail never refuses: a named claim means that claim, else the summary.
  return key ? "claim" : "summary";
}

async function getClaimStatus(args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const session = await store.getSession(ctx.callKey);
  if (session?.level !== "verified") return answer(ctx, "not_verified", { level: session?.level ?? "none" });
  // The customer comes from the session only; claim_ending only picks among that customer's claims.
  if (!session.verified_customer_id) throw new Error("verified session without a verified customer");
  const claims = await store.getClaims(session.verified_customer_id);
  if (claims.length === 0) return answer(ctx, "no_claims");
  const today = todayInNewYork(ctx.deps.now());
  const key = claimEndingKey(args.claim_ending);
  const read = (code: Code, sentence: string, which: Claim[]): ToolResult => ({
    code,
    sentence,
    data: { claims: claimsData(which) },
  });
  switch (statusDetailOf(args.detail, key)) {
    case "documents": {
      const awaiting = claims.filter((c) => c.status === "awaiting_documents");
      if (awaiting.length === 0) return answer(ctx, "no_documents_needed");
      // A claim the caller named narrows the list only when it is one of those awaiting documents.
      const named = claimsNamed(awaiting, key);
      const which = named.length === 1 ? named : awaiting;
      return read("claim_documents", documentsSentence(which, today), which);
    }
    case "claim": {
      const named = claimsNamed(claims, key);
      // An account's only claim is the one they mean, whatever words came with it (a misheard ending,
      // a type it is not): its details say its type and ending, so a wrong guess is plain to hear.
      const one = named.length === 1 ? named[0] : claims.length === 1 ? claims[0] : null;
      if (one) return read("claim_detail", claimDetailSentence(one, today), [one]);
      return answer(ctx, "claim_not_identified", { claims: claimChoicesData(claimsToOffer(claims, named, today)) });
    }
    default:
      return read("ok", claimsSentence(claims, today, MAX_TURN_WORDS, ctx.callKey), claims);
  }
}

// ---------------------------------------------------------------------------------------------
// Notifications (escalate, report_emergency).
// ---------------------------------------------------------------------------------------------
/** Send through the email ledger once its row is claimed; the outcome is written back either way. */
async function sendClaimed(
  ctx: Run,
  kind: EmailKind,
  msg: { to: string; subject: string; html: string },
  deadline: number,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const timeoutMs = Math.min(CHANNEL_BUDGET_MS, deadline - Date.now());
  // With no time left the request is never started: a send nobody waits for could deliver while
  // the caller is told it did not.
  const sent = timeoutMs > 0
    ? await sendEmail(ctx.deps, { ...msg, idempotencyKey: `${ctx.callKey}:${kind}` }, timeoutMs)
    : { ok: false as const, error: "timeout" };
  writeBack(
    ctx,
    "finishEmail",
    () =>
      ctx.deps.store.finishEmail(
        ctx.callKey,
        kind,
        sent.ok ? "sent" : "failed",
        sent.ok ? sent.id : null,
        sent.ok ? null : sent.error,
      ),
  );
  return sent.ok ? sent : { ok: false, error: sent.error };
}

// The team emails a tool sends through the ledger (each at most once per call).
type TeamEmailKind = "callback_request" | "emergency_alert" | "claim_intake";

async function sendTeamEmail(
  ctx: Run,
  kind: TeamEmailKind,
  render: () => { subject: string; html: string },
  deadline: number,
): Promise<Delivery> {
  try {
    const { env, store } = ctx.deps;
    if (!alertSinks(env).includes("email")) return { ok: false, error: "email disabled by ALERT_SINKS" };
    const to = typeof env.CLAIMS_TEAM_EMAIL === "string" ? env.CLAIMS_TEAM_EMAIL.trim() : "";
    if (!to) return { ok: false, error: "CLAIMS_TEAM_EMAIL not set" };
    // Rendered before the claim, so a template fault cannot strand a 'sending' row.
    const { subject, html } = render();
    const claim = await store.claimEmail(ctx.callKey, kind, maskEmail(to));
    if (!claim.claimed) return claim.status === "sent" ? { ok: true } : { ok: false, error: `email ${claim.status}` };
    const sent = await sendClaimed(ctx, kind, { to, subject, html }, deadline);
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  } catch (e) {
    return { ok: false, error: `email ledger: ${errorText(e)}` };
  }
}

async function sendTelegramAlert(ctx: Run, alert: TeamAlert): Promise<Delivery> {
  try {
    const result = await sendAlert(ctx.deps, alert);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "not delivered" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Telegram and the team email in parallel, each under its own budget. Notified = either confirmed. */
async function notifyTeam(
  ctx: Run,
  alert: TeamAlert,
  kind: TeamEmailKind,
  render: () => { subject: string; html: string },
): Promise<{ notified: boolean; error: string | null }> {
  const budget = channelBudget(ctx);
  if (budget <= 0) return { notified: false, error: "telegram: timeout; email: timeout" };
  const deadline = Date.now() + budget;
  const timedOut = (): Delivery => ({ ok: false, error: "timeout" });
  const [telegram, email] = await Promise.all([
    withinBudget(sendTelegramAlert(ctx, alert), budget, timedOut),
    withinBudget(sendTeamEmail(ctx, kind, render, deadline), budget, timedOut),
  ]);
  const errors: string[] = [];
  if (!telegram.ok) errors.push(`telegram: ${telegram.error}`);
  if (!email.ok) errors.push(`email: ${email.error}`);
  return { notified: telegram.ok || email.ok, error: errors.length > 0 ? errors.join("; ") : null };
}

/** The verified customer of the session, or null (unverified, or a failed read: enrichment only). */
async function verifiedAccount(ctx: Run, session: Session | null): Promise<Customer | null> {
  const customerId = session?.level === "verified" ? session.verified_customer_id : null;
  return customerId ? await readOr(ctx, "getCustomer", () => ctx.deps.store.getCustomer(customerId), null) : null;
}

/** The call's captured contact, or null (none, or a failed read: enrichment only). */
async function capturedContact(ctx: Run): Promise<CallerContact | null> {
  return await readOr<CallerContact | null>(ctx, "getContact", () => ctx.deps.store.getContact(ctx.callKey), null);
}

/** The callback target when the caller gave no number with this request: the verified account's,
 *  else the number captured with their details on this call (as stored), else caller id. Never our own
 *  line. */
function fallbackCallback(ctx: Run, customer: Customer | null, contact: CallerContact | null): Callback {
  const own = ownNumbers(ctx.deps.env);
  const account = usableCallbackNumber(customer?.phone_e164, own);
  if (account) return { phone: account, source: "account" };
  const captured = storedCallbackNumber(contact?.callback_phone, own);
  if (captured) return { phone: captured, source: contact?.callback_source === "caller_id" ? "caller_id" : "argument" };
  const caller = usableCallbackNumber(ctx.callerNumber, own);
  if (caller) return { phone: caller, source: "caller_id" };
  return { phone: null, source: "none" };
}

/** A repeat request on a row that holds no number: the number this call can give it now (the verified
 *  account's, one captured with the caller's details, or caller id), written to the row. False when
 *  there is none or the write failed, so the sentence asks for one instead of promising a call. The
 *  row has no number, so nothing the caller said can be overwritten. */
async function fillCallback(
  ctx: Run,
  session: Session | null,
  contact: CallerContact | null,
  row: { reason: EscalationReason; verified: boolean },
): Promise<boolean> {
  const callback = fallbackCallback(ctx, await verifiedAccount(ctx, session), contact);
  if (!callback.phone) return false;
  try {
    await ctx.deps.store.upsertEscalation({
      callKey: ctx.callKey,
      kind: "representative",
      reason: row.reason,
      details: null,
      callbackPhone: callback.phone,
      callbackSource: callback.source,
      channel: ctx.channel,
      verified: row.verified,
    });
    return true;
  } catch (e) {
    logError(ctx, "upsertEscalation", e);
    return false;
  }
}

function queuedData(source: CallbackSource | null, phone: string): Record<string, unknown> | undefined {
  switch (source) {
    case "argument":
      // A North American number is named by its last four; one from abroad or noted as said is read in
      // full, so a wrong country code or a missing digit can still be heard (speak.ts repQueued).
      return /^\+1\d{10}$/.test(phone)
        ? { target: "given", digits: lastFour(phone) }
        : { target: "given", number: phone };
    case "account":
      return { target: "account" };
    case "caller_id":
      return { target: "caller_id" };
    default:
      return undefined;
  }
}

function queued(ctx: Run, callback: Callback): ToolResult {
  return callback.phone
    ? answer(ctx, "rep_queued", queuedData(callback.source, callback.phone))
    : answer(ctx, "rep_queued_no_number");
}

// ---------------------------------------------------------------------------------------------
// escalate {reason?, details?, callback_phone?}
// ---------------------------------------------------------------------------------------------
function escalationReason(args: Args, level: Level, attempts: AttemptRow[]): EscalationReason {
  const raw = typeof args.reason === "string" ? args.reason.trim() : "";
  const model: EscalationReason = (MODEL_ESCALATION_REASONS as readonly string[]).includes(raw)
    ? raw as EscalationReason
    : "representative_requested";
  // The session knows why the caller ended up here better than the model does.
  if (level === "locked") return "auth_locked";
  if (level === "none" && model === "representative_requested" && attempts.some((a) => a.kind === "lookup_miss")) {
    return "not_found";
  }
  return model;
}

async function escalate(args: Args, ctx: Run): Promise<ToolResult> {
  const { store, env } = ctx.deps;
  const callKey = ctx.callKey;
  const details = cleanDetails(args.details);
  // Read against the caller id: on a call from abroad, the caller's own number said in its national
  // form is that caller id, and no number given without a country code is made North American.
  const given = givenCallbackNumber(args.callback_phone, ownNumbers(env), ctx.callerNumber);

  // Enrichment reads are best effort: a failed read costs a label, and the row matters more.
  const [session, attempts, escalations, contact] = await Promise.all([
    readOr<Session | null>(ctx, "getSession", () => store.getSession(callKey), null),
    readOr<AttemptRow[]>(ctx, "listAttempts", () => store.listAttempts(callKey), []),
    readOr<EscalationRow[] | null>(ctx, "listEscalations", () => store.listEscalations(callKey), null),
    capturedContact(ctx),
  ]);
  const level: Level = session?.level ?? "none";
  const verified = level === "verified";
  const reason = escalationReason(args, level, attempts);
  const existing = escalations?.find((e) => e.kind === "representative") ?? null;

  // upsert_escalation merges every non-null value into a row that already exists, so the first
  // write carries only what a repeat may merge: a number the caller just gave, and details where
  // the row is known to have none. A failed read therefore can never let a fallback number or new
  // details overwrite what the caller said on an earlier request.
  let row: Awaited<ReturnType<Store["upsertEscalation"]>>;
  try {
    row = await store.upsertEscalation({
      callKey,
      kind: "representative",
      reason,
      details: existing && !existing.details ? details : null,
      callbackPhone: given,
      callbackSource: given ? "argument" : "none",
      channel: ctx.channel,
      verified,
    });
  } catch (e) {
    logError(ctx, "upsertEscalation", e);
    return answer(ctx, "rep_unavailable");
  }

  if (!row.inserted) {
    // A repeat never alerts again; the dashboard row now carries the new number.
    if (given && given !== existing?.callback_phone) {
      return answer(ctx, "callback_updated", { digits: readBackNumber(given) });
    }
    // A chat answered its first request as if the team had been told, so its repeat says the same.
    const told = row.alertStatus === "sent" || (ctx.isChat && row.alertStatus === "skipped");
    if (!told) return answer(ctx, "rep_recorded");
    // "Someone will call you back" only with a number to call: the row's, or one this call can give it.
    if (!row.callbackPhone && !(await fillCallback(ctx, session, contact, { reason, verified }))) {
      return answer(ctx, "rep_queued_no_number");
    }
    return answer(ctx, "rep_already_queued");
  }

  // This call created the row, so the rest of the request can go on it without overwriting anything.
  const customer = await verifiedAccount(ctx, session);
  let callback: Callback = given ? { phone: given, source: "argument" } : fallbackCallback(ctx, customer, contact);
  if (details || (!given && callback.phone)) {
    try {
      await store.upsertEscalation({
        callKey,
        kind: "representative",
        reason,
        details,
        callbackPhone: given ? null : callback.phone,
        callbackSource: given ? "none" : callback.source,
        channel: ctx.channel,
        verified,
      });
    } catch (e) {
      logError(ctx, "upsertEscalation", e);
      // A number that never reached the row is not promised; the sentence asks for one instead.
      if (!given) callback = { phone: null, source: "none" };
    }
  }

  if (ctx.isChat) {
    writeBack(ctx, "setEscalationDelivery", () => store.setEscalationDelivery(row.id, "skipped", null));
    return queued(ctx, callback);
  }
  const alert: EscalationAlert = { kind: "representative", reason, callKey, channel: ctx.channel, verified };
  const delivery = await notifyTeam(ctx, alert, "callback_request", () =>
    callbackRequestEmail({
      callKey,
      reason,
      verified,
      callbackPhone: callback.phone,
      details,
      channel: ctx.channel,
      dashboardUrl: env.DASHBOARD_URL,
      caller: teamCallerOf(customer, contact),
    }));
  writeBack(
    ctx,
    "setEscalationDelivery",
    () => store.setEscalationDelivery(row.id, delivery.notified ? "sent" : "failed", delivery.error),
  );
  // "Sent" and a timeframe are promised only when a channel confirmed delivery.
  return delivery.notified ? queued(ctx, callback) : answer(ctx, "rep_recorded");
}

async function replayEscalate(code: Code, args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "rep_queued" && code !== "callback_updated") return answer(ctx, code);
  // A retry carries the first delivery's arguments, so a number the caller gave is rebuilt from
  // them (against the same caller id). The row is not: a later request may have changed its number since.
  const given = givenCallbackNumber(args.callback_phone, ownNumbers(ctx.deps.env), ctx.callerNumber);
  if (code === "callback_updated") return answer(ctx, code, given ? { digits: readBackNumber(given) } : undefined);
  if (given) return answer(ctx, code, queuedData("argument", given));
  // Without an argument the first answer named the fallback this delivery wrote when it created the
  // row. Only a number given later can have replaced it, and then that target is no longer known,
  // so the sentence names none rather than a different one. Reading the row is not a side effect.
  const rows = await readOr<EscalationRow[]>(
    ctx,
    "listEscalations",
    () => ctx.deps.store.listEscalations(ctx.callKey),
    [],
  );
  const row = rows.find((r) => r.kind === "representative");
  const source = row?.callback_source ?? null;
  if (row?.callback_phone && (source === "account" || source === "caller_id")) {
    return answer(ctx, code, queuedData(source, row.callback_phone));
  }
  return answer(ctx, code);
}

// ---------------------------------------------------------------------------------------------
// report_emergency {note?}
// ---------------------------------------------------------------------------------------------
const emergencyNotLogged = (ctx: Pick<ToolCtx, "callKey">) => answer(ctx, "emergency_logged", { db_failed: true });

async function reportEmergency(args: Args, ctx: Run): Promise<ToolResult> {
  const { store, env } = ctx.deps;
  const callKey = ctx.callKey;
  const details = cleanDetails(args.note);
  const [session, contact] = await Promise.all([
    readOr<Session | null>(ctx, "getSession", () => store.getSession(callKey), null),
    capturedContact(ctx),
  ]);
  const verified = session?.level === "verified";
  const customer = await verifiedAccount(ctx, session);
  // The tool never asks for a number; whatever the server already knows goes on the row for staff.
  const callback = fallbackCallback(ctx, customer, contact);
  const alert: EscalationAlert = { kind: "emergency", reason: "emergency", callKey, channel: ctx.channel, verified };

  let row: Awaited<ReturnType<Store["upsertEscalation"]>>;
  try {
    row = await store.upsertEscalation({
      callKey,
      kind: "emergency",
      reason: "emergency",
      details,
      callbackPhone: callback.phone,
      callbackSource: callback.source,
      channel: ctx.channel,
      verified,
    });
  } catch (e) {
    logError(ctx, "upsertEscalation", e);
    // Without a row the dashboard shows nothing, so the page still goes out: a duplicate page on a
    // retry beats a missed emergency. The email waits for its ledger, which shares the database.
    if (!ctx.isChat) {
      const budget = channelBudget(ctx);
      if (budget > 0) {
        await withinBudget(sendTelegramAlert(ctx, alert), budget, (): Delivery => ({ ok: false, error: "timeout" }));
      }
    }
    return emergencyNotLogged(ctx);
  }

  if (row.inserted) {
    if (ctx.isChat) {
      writeBack(ctx, "setEscalationDelivery", () => store.setEscalationDelivery(row.id, "skipped", null));
    } else {
      const delivery = await notifyTeam(
        ctx,
        alert,
        "emergency_alert",
        () =>
          emergencyEmail({
            callKey,
            note: details,
            channel: ctx.channel,
            dashboardUrl: env.DASHBOARD_URL,
            verified,
            callbackPhone: row.callbackPhone,
            caller: teamCallerOf(customer, contact),
          }),
      );
      writeBack(
        ctx,
        "setEscalationDelivery",
        () => store.setEscalationDelivery(row.id, delivery.notified ? "sent" : "failed", delivery.error),
      );
    }
  }
  return answer(ctx, "emergency_logged");
}

async function replayEmergency(_code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  // "I've told our team" only when the row the first delivery wrote is really there.
  const rows = await readOr<EscalationRow[] | null>(
    ctx,
    "listEscalations",
    () => ctx.deps.store.listEscalations(ctx.callKey),
    null,
  );
  return rows?.some((r) => r.kind === "emergency") ? answer(ctx, "emergency_logged") : emergencyNotLogged(ctx);
}

// ---------------------------------------------------------------------------------------------
// send_info_email {topic}
// ---------------------------------------------------------------------------------------------
function isInfoTopic(v: unknown): v is InfoEmailTopic {
  return typeof v === "string" && (INFO_EMAIL_TOPICS as readonly string[]).includes(v);
}

function renderInfoEmail(
  topic: InfoEmailTopic,
  customer: Customer,
  claims: Claim[],
): { subject: string; html: string } {
  switch (topic) {
    case "document_checklist":
      return documentChecklistEmail({ customer, claims });
    case "claim_summary":
      return claimSummaryEmail({ customer, claims });
    case "how_to_start_claim":
      return howToStartEmail({ customer });
  }
}

/** Claim the (call, topic) ledger row, then send: at most one send per topic per call, and "sent"
 *  only after Resend returned an id. sentData marks where it went for the spoken sentence. */
async function sendTopicEmail(
  ctx: Run,
  topic: InfoEmailTopic,
  to: string,
  rendered: { subject: string; html: string },
  sentData?: Record<string, unknown>,
): Promise<ToolResult> {
  const claim = await ctx.deps.store.claimEmail(ctx.callKey, topic, maskEmail(to));
  if (!claim.claimed) {
    // At most one send per topic per call: a failed one is not retried on this call either.
    return answer(ctx, claim.status === "failed" ? "email_failed" : "email_already_sent");
  }
  const sent = await sendClaimed(
    ctx,
    topic,
    { to, subject: rendered.subject, html: rendered.html },
    ctx.deadline - ANSWER_MARGIN_MS,
  );
  return sent.ok ? answer(ctx, "email_sent", sentData) : answer(ctx, "email_failed");
}

/** An unverified caller gets one thing by email: the generic steps to start a claim, sent to the
 *  address they spelled and confirmed as a new customer. Nothing from any account goes with it,
 *  every other topic still needs a verified caller with an email on file, and an email_update
 *  (a verified customer's spelled address) is never a recipient. */
async function unverifiedInfoEmail(topic: InfoEmailTopic, session: Session | null, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const level: Level = session?.level ?? "none";
  if (topic !== "how_to_start_claim") return answer(ctx, "not_verified", { level });
  const contact = await store.getContact(ctx.callKey);
  if (contact?.kind !== "new_customer") {
    // After the lookups ran out, the way forward is the new-caller details, not another number.
    if (level === "none") {
      const attempts = await readOr<AttemptRow[]>(ctx, "listAttempts", () => store.listAttempts(ctx.callKey), []);
      if (attempts.some((a) => a.kind === "lookup_miss")) return answer(ctx, "contact_needs_name");
    }
    return answer(ctx, "not_verified", { level });
  }
  if (!contact.confirmed) return readback(ctx, contact);
  if (!contact.email) return answer(ctx, "contact_invalid_email");
  // Rendered before the claim, so a template fault cannot strand a 'sending' row.
  const rendered = howToStartEmail({ customer: { first_name: contact.first_name }, newCustomer: true });
  return await sendTopicEmail(ctx, topic, contact.email, rendered, { target: "given" });
}

async function sendInfoEmail(args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const topic = args.topic as InfoEmailTopic; // checked by valid() before the tool runs
  const session = await store.getSession(ctx.callKey);
  if (session?.level !== "verified") return await unverifiedInfoEmail(topic, session, ctx);
  const customer = await verifiedCustomer(store, session);
  const to = typeof customer.email === "string" ? customer.email.trim() : "";
  // Only the address on file: one spelled on this call is a pending update for staff, never a
  // recipient (anyone who verified could otherwise send the account's details anywhere).
  if (!to) return answer(ctx, "no_email_on_file");
  const claims = topic === "how_to_start_claim" ? [] : await store.getClaims(customer.id);
  // Rendered before the claim, so a template fault cannot strand a 'sending' row that would make
  // every later request on this call say "already sent".
  return await sendTopicEmail(ctx, topic, to, renderInfoEmail(topic, customer, claims));
}

async function replayInfoEmail(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  if (code === "contact_readback") {
    const contact = await readOr<CallerContact | null>(ctx, "getContact", () => store.getContact(ctx.callKey), null);
    return contact ? readback(ctx, contact) : answer(ctx, code);
  }
  if (code !== "not_verified" && code !== "email_sent") return answer(ctx, code);
  const session = await readOr<Session | null>(ctx, "getSession", () => store.getSession(ctx.callKey), null);
  if (code === "email_sent") {
    return session?.level === "verified" ? answer(ctx, code) : answer(ctx, code, { target: "given" });
  }
  return answer(ctx, code, { level: session?.level ?? "none" });
}

// ---------------------------------------------------------------------------------------------
// capture_contact {first_name, last_name, email?, callback_phone?}
// ---------------------------------------------------------------------------------------------
interface ContactInput {
  callKey: string;
  kind: ContactKind;
  firstName: string;
  lastName: string;
  email: string | null;
  callbackPhone: string | null;
  callbackSource: ContactCallbackSource;
  customerId: string | null;
}

/** The read-back of what is stored: names, the address letter by letter, and a callback number the
 *  caller said (one taken from caller id was never said, so there is nothing to mishear). */
function readback(
  ctx: Pick<ToolCtx, "callKey">,
  c: Pick<CallerContact, "first_name" | "last_name" | "email" | "callback_phone" | "callback_source">,
): ToolResult {
  const data: Record<string, unknown> = { first_name: c.first_name, last_name: c.last_name };
  if (c.email) data.email = c.email;
  if (c.callback_source === "argument" && c.callback_phone) data.callback_phone = c.callback_phone;
  // The address and number are in the sentence, spelled; the result's data carries only the first name.
  return {
    code: "contact_readback",
    sentence: sentenceFor("contact_readback", data, ctx.callKey),
    data: { first_name: c.first_name },
  };
}

/** Both name parts, or null. A full name in first_name with no last_name is split at its last space. */
function callerNames(first: unknown, last: unknown): { first: string; last: string } | null {
  let f = typeof first === "string" ? first.trim() : "";
  let l = typeof last === "string" ? last.trim() : "";
  if (!l && /\s/.test(f)) {
    const at = f.search(/\s+\S+$/);
    l = f.slice(at).trim();
    f = f.slice(0, at).trim();
  }
  const nf = normaliseName(f);
  const nl = normaliseName(l);
  // Stored only when it can be read back.
  if (!nf || !nl || !spokenName(nf) || !spokenName(`${nf} ${nl}`)) return null;
  return { first: nf, last: nl };
}

/** Validates and normalises the arguments against the session; reads only. A verified caller's name
 *  is the account's (never asked, never taken from the model) and their capture is an email_update,
 *  which needs an address and is only for an account with none on file; anyone else is a
 *  new_customer, whose name is required and email optional. A correction that leaves the callback
 *  number out keeps the number the caller said earlier on this call. unclear: a number was passed
 *  (it has digits) that gives no callback number (too few or too many digits, our own line). */
async function contactInput(
  args: Args,
  ctx: Run,
): Promise<{ ok: true; input: ContactInput; unclear: boolean } | { ok: false; code: Code }> {
  const { store, env } = ctx.deps;
  const session = await store.getSession(ctx.callKey);
  let names: { first: string; last: string } | null;
  let customerId: string | null = null;
  let kind: ContactKind;
  if (session?.level === "verified") {
    const customer = await verifiedCustomer(store, session);
    // The prompt asks for an address only after send_info_email found none on file; the server holds
    // the same line, so nobody who passed (or talked past) verification can file a change request
    // that would put their own address next to an account that already has one.
    if (typeof customer.email === "string" && customer.email.trim()) return { ok: false, code: "email_on_file" };
    names = { first: customer.first_name.trim().slice(0, 40), last: customer.last_name.trim().slice(0, 40) };
    customerId = customer.id;
    kind = "email_update";
  } else {
    names = callerNames(args.first_name, args.last_name);
    if (!names) return { ok: false, code: "contact_needs_name" };
    kind = "new_customer";
  }
  const rawEmail = args.email;
  const emailGiven = rawEmail !== undefined && rawEmail !== null && !(typeof rawEmail === "string" && !rawEmail.trim());
  const email = emailGiven ? normaliseEmail(rawEmail) : null;
  if ((emailGiven || kind === "email_update") && !email) return { ok: false, code: "contact_invalid_email" };

  const own = ownNumbers(env);
  // Read against the caller id, as escalate reads it.
  let given = givenCallbackNumber(args.callback_phone, own, ctx.callerNumber);
  if (!given && args.callback_phone === undefined) {
    // A correction re-sends the name and the address; a number said for an earlier capture stands, as stored.
    const prior = await capturedContact(ctx);
    if (prior?.callback_source === "argument") given = storedCallbackNumber(prior.callback_phone, own);
  }
  const callerId = given ? null : usableCallbackNumber(ctx.callerNumber, own);
  return {
    ok: true,
    input: {
      callKey: ctx.callKey,
      kind,
      firstName: names.first,
      lastName: names.last,
      email,
      callbackPhone: given ?? callerId,
      callbackSource: given ? "argument" : callerId ? "caller_id" : "none",
      customerId,
    },
    unclear: !given && hasDigits(args.callback_phone),
  };
}

const PHONE_CHANNELS: ReadonlySet<string> = new Set(["inboundPhoneCall", "outboundPhoneCall"]);

/** A value with at least one digit: what the model heard as a number, usable or not. */
function hasDigits(v: unknown): boolean {
  return (typeof v === "string" || typeof v === "number") && /\d/.test(String(v));
}

/** contact_needs_phone. unclear: the number passed gave no callback number, so the sentence says it didn't
 *  get that number rather than that it can't see the caller id; the result keeps its usual shape. */
function needsPhone(ctx: Run, unclear: boolean): ToolResult {
  return unclear
    ? { code: "contact_needs_phone", sentence: sentenceFor("contact_needs_phone", { unclear: true }, ctx.callKey) }
    : answer(ctx, "contact_needs_phone");
}

/** The best-number question a new caller's capture asks before anything is stored, or null. Asked when a
 *  number was passed that gives no callback number and the call has no caller id to fall back on (a
 *  number that came out wrong is never dropped without a word), or when a phone caller left the number
 *  out (they said to use the one they're calling from) but the call has no usable caller id (withheld or
 *  junk). Once per call: if they would rather not give one, the next capture is stored without a number,
 *  and a callback or a claim asks for one again before anything is promised. A web call or a chat that
 *  leaves the number out stores none: its prompt asks for the digits, so an omitted number means none. */
async function numberQuestion(input: ContactInput, unclear: boolean, ctx: Run): Promise<ToolResult | null> {
  if (input.kind !== "new_customer" || input.callbackSource !== "none") return null;
  if (!unclear && !PHONE_CHANNELS.has(ctx.channel)) return null;
  // A failed read never asks: asking twice is worse than storing no number.
  const attempts = await readOr<AttemptRow[] | null>(
    ctx,
    "listAttempts",
    () => ctx.deps.store.listAttempts(ctx.callKey),
    null,
  );
  if (
    attempts === null || attempts.some((a) => a.tool_name === "capture_contact" && a.code === "contact_needs_phone")
  ) {
    return null;
  }
  return needsPhone(ctx, unclear);
}

async function captureContact(args: Args, ctx: Run): Promise<ToolResult> {
  const prepared = await contactInput(args, ctx);
  if (!prepared.ok) return answer(ctx, prepared.code);
  const question = await numberQuestion(prepared.input, prepared.unclear, ctx);
  if (question) return question;
  return readback(ctx, await ctx.deps.store.upsertContact(prepared.input));
}

async function replayCapture(code: Code, args: Args, ctx: Run): Promise<ToolResult> {
  // Only a number that came out wrong was asked about with digits passed (a usable one is never asked about).
  if (code === "contact_needs_phone") return needsPhone(ctx, hasDigits(args.callback_phone));
  if (code !== "contact_readback") return answer(ctx, code);
  // confirm_contact confirms whatever row is stored, so the read-back is of that row: a later capture
  // may have replaced what this delivery's arguments said. Reading is not a side effect.
  const row = await capturedContact(ctx);
  if (row) return readback(ctx, row);
  // No row (or a failed read): the same read-back rebuilt from this delivery's arguments, no write.
  const prepared = await contactInput(args, ctx);
  if (!prepared.ok) return answer(ctx, prepared.code);
  const p = prepared.input;
  return readback(ctx, {
    first_name: p.firstName,
    last_name: p.lastName,
    email: p.email,
    callback_phone: p.callbackPhone,
    callback_source: p.callbackSource,
  });
}

// ---------------------------------------------------------------------------------------------
// confirm_contact {correct}
// ---------------------------------------------------------------------------------------------
function correctOf(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "yes" ? true : s === "false" || s === "no" ? false : null;
}

/** The answer to the caller's yes or no on the read-back, from the row it was given on. A "no" asks
 *  which part was wrong among those read back (an email_update read back only the address). A new
 *  caller's yes offers to take the loss down now; when a start_claim already asked for these details
 *  (resume), it asks whether to take that claim down. */
function confirmedAnswer(ctx: Run, row: CallerContact, correct: boolean, resume: boolean): ToolResult {
  if (!correct) {
    return row.kind === "email_update"
      ? answer(ctx, "contact_retry", { part: "email" })
      : answer(ctx, "contact_retry", { has_email: row.email !== null, has_phone: row.callback_source === "argument" });
  }
  if (row.kind === "email_update") return answer(ctx, "contact_saved_existing", { first_name: row.first_name });
  const data: Record<string, unknown> = { first_name: row.first_name };
  if (!row.email) data.has_email = false;
  if (resume) data.resume_claim = true;
  return answer(ctx, "contact_saved_new", data);
}

async function contactAnswer(row: CallerContact, correct: boolean, ctx: Run): Promise<ToolResult> {
  const resume = correct && row.kind === "new_customer" && await claimWaiting(ctx, CONTACT_RESUME_CODES);
  return confirmedAnswer(ctx, row, correct, resume);
}

/** Nothing to confirm: a verified caller is asked for the address again (their name is the
 *  account's), anyone else for their details from the start. */
async function notPending(ctx: Run): Promise<ToolResult> {
  const session = await readOr<Session | null>(ctx, "getSession", () => ctx.deps.store.getSession(ctx.callKey), null);
  // The flag only picks the wording; the result keeps not_pending's usual shape.
  return session?.level === "verified"
    ? { code: "not_pending", sentence: sentenceFor("not_pending", { verified: true }, ctx.callKey) }
    : answer(ctx, "not_pending");
}

async function confirmContact(args: Args, ctx: Run): Promise<ToolResult> {
  const correct = correctOf(args.correct) === true;
  // A "no" leaves the row unconfirmed (and takes back an earlier "yes"); nothing is deleted.
  const row = await ctx.deps.store.setContactConfirmed(ctx.callKey, correct);
  return row ? await contactAnswer(row, correct, ctx) : await notPending(ctx);
}

async function replayConfirm(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  if (code === "not_pending") return await notPending(ctx);
  if (code !== "contact_retry" && code !== "contact_saved_new" && code !== "contact_saved_existing") {
    return answer(ctx, code);
  }
  // Reading the row is not a side effect; the first delivery already wrote what it answered.
  const row = await readOr<CallerContact | null>(ctx, "getContact", () => ctx.deps.store.getContact(ctx.callKey), null);
  if (!row) return answer(ctx, code);
  const replayed = await contactAnswer(row, code !== "contact_retry", ctx);
  return replayed.code === code ? replayed : answer(ctx, code);
}

// ---------------------------------------------------------------------------------------------
// start_claim {claim_type, loss_date, description, summary?}
// ---------------------------------------------------------------------------------------------
const MIN_DESCRIPTION_WORDS = 3;
const MAX_SUMMARY_WORDS = 8;
const MAX_SUMMARY_CHARS = 80;

type ClaimGate =
  | { ok: true; kind: ClaimIntake["kind"]; customerId: string | null; contact: CallerContact | null }
  | { ok: false; code: Code };

function claimTypeOf(v: unknown): ClaimType | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (CLAIM_TYPES as readonly string[]).includes(s) ? s as ClaimType : null;
}

/** The caller's words for storage (redacted, one line, at most 500 characters), or null when they
 *  hold fewer than three words: not enough for anyone to act on. */
function cleanDescription(raw: unknown): string | null {
  const words = typeof raw === "string" ? raw.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length : 0;
  return words >= MIN_DESCRIPTION_WORDS ? cleanDetails(raw) : null;
}

// The caller's own words in the first person: Ava would say them as if they were hers ("for i hit a
// deer"). "my" and "our" read as "your"; anything else first-person drops the phrase ("I-95" is a road).
const FIRST_PERSON = /\b(?:i(?!-\d)|me|we|us|mine|myself|ours|ourselves|i'm|i've|i'd|i'll|we're|we've|we'd|we'll)\b/i;

/** The read-back phrase for storage: redacted, accents folded, letters, digits, spaces and ' - ,
 *  only, "my" and "our" said as "your", at most eight words and 80 characters, and speakable; null
 *  when it is missing, longer, in the first person, or nothing speakable is left (the read-back then
 *  leaves it out). */
function cleanSummary(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = redactPII(raw.slice(0, MAX_DETAILS_SCAN)).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'").replace(/[^A-Za-z0-9 ',-]+/g, " ").replace(/\s+/g, " ")
    .replace(/^[\s,'-]+|[\s,'-]+$/g, "")
    .replace(/\b(?:my|our)\b/gi, (w) => (w[0] === "M" || w[0] === "O" ? "Your" : "your"));
  if (!text || text.split(" ").length > MAX_SUMMARY_WORDS || text.length > MAX_SUMMARY_CHARS) return null;
  if (FIRST_PERSON.test(text)) return null;
  return /[A-Za-z]/.test(text) && isSpeakable(text) ? text : null;
}

/** What the summary column holds when the caller's summary is unusable: the type's own label, which
 *  the read-back never says (it would only repeat the type). */
function fallbackSummary(type: ClaimType): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} claim`;
}

function claimLast3Of(row: Pick<ClaimIntake, "claim_number"> | null): string | null {
  const digits = String(row?.claim_number ?? "").replace(/\D/g, "");
  return digits.length >= 3 ? digits.slice(-3) : null;
}

/** The read-back of the stored intake: what confirm_claim will file. */
function intakeReadback(ctx: Run, row: ClaimIntake, now: Date): ToolResult {
  const spoken: Record<string, unknown> = {
    claim_type: row.claim_type,
    loss_date: row.loss_date,
    today: todayInNewYork(now),
  };
  if (row.summary !== fallbackSummary(row.claim_type)) spoken.summary = row.summary;
  return {
    code: "claim_readback",
    sentence: sentenceFor("claim_readback", spoken, ctx.callKey),
    data: { claim_type: row.claim_type, loss_date: row.loss_date },
  };
}

function alreadyFiled(ctx: Run, row: ClaimIntake): ToolResult {
  const last3 = claimLast3Of(row);
  return last3 ? answer(ctx, "claim_already_filed", { claim_last3: last3 }) : answer(ctx, "claim_already_filed");
}

/** Who may report a loss on this call, from server state only: a locked caller cannot; a caller whose
 *  number matched verifies first; a verified customer files a claim on the session's account (never
 *  one named in the arguments); anyone else is a new caller whose details must be confirmed first
 *  (capture_contact), after the lookup that showed they have no account. */
async function claimGate(ctx: Run): Promise<ClaimGate> {
  const { store } = ctx.deps;
  const session = await store.getSession(ctx.callKey);
  const level: Level = session?.level ?? "none";
  if (level === "locked") return { ok: false, code: "claim_locked" };
  if (level === "phone_found") return { ok: false, code: "claim_needs_verification" };
  if (level === "verified") {
    if (!session?.verified_customer_id) throw new Error("verified session without a verified customer");
    return { ok: true, kind: "claim", customerId: session.verified_customer_id, contact: null };
  }
  const contact = await store.getContact(ctx.callKey);
  if (contact?.kind === "new_customer" && contact.confirmed) {
    return { ok: true, kind: "lead_intake", customerId: null, contact };
  }
  // An unreadable number was never a lookup; a hit or a miss was.
  const attempts = await store.listAttempts(ctx.callKey);
  const looked = attempts.some((a) => a.kind === "lookup_miss" || a.kind === "lookup_hit");
  return { ok: false, code: looked ? "claim_needs_contact" : "claim_needs_lookup" };
}

/** The number a new caller's intake is called back on: the one confirmed with their details (as stored),
 *  else caller id. null when the call has neither: then no sentence promises a specialist's call, and
 *  start_claim and confirm_claim ask for the best number instead (claim_needs_phone). */
function leadCallback(ctx: Run, confirmed: CallerContact | null): string | null {
  const own = ownNumbers(ctx.deps.env);
  return storedCallbackNumber(confirmed?.callback_phone, own) ?? usableCallbackNumber(ctx.callerNumber, own);
}

/** A date the server could not read a second time on this call is not asked for a third time: a
 *  specialist helps instead. A failed read asks again. */
async function badDate(ctx: Run): Promise<ToolResult> {
  const attempts = await readOr<AttemptRow[]>(ctx, "listAttempts", () => ctx.deps.store.listAttempts(ctx.callKey), []);
  const before = attempts.some((a) => a.tool_name === "start_claim" && a.code === "claim_bad_date");
  return answer(ctx, before ? "claim_date_help" : "claim_bad_date");
}

async function startClaim(args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const gate = await claimGate(ctx);
  if (!gate.ok) return answer(ctx, gate.code);
  const existing = await store.getClaimIntake(ctx.callKey);
  if (existing?.confirmed) return alreadyFiled(ctx, existing);
  // A new caller's intake promises a call from a specialist, so it needs a number to call (a capture
  // with the number they say then needs its own read-back, which confirms it).
  if (gate.kind === "lead_intake" && !leadCallback(ctx, gate.contact)) return answer(ctx, "claim_needs_phone");

  const claimType = claimTypeOf(args.claim_type);
  if (!claimType) return answer(ctx, "bad_args");
  const description = cleanDescription(args.description);
  if (!description) return answer(ctx, "claim_needs_description");
  // The caller's words for the date, read by the server; the model does no date arithmetic.
  const loss = parseLossDate(args.loss_date, ctx.deps.now());
  if ("error" in loss) return loss.error === "too_old" ? answer(ctx, "claim_too_old") : await badDate(ctx);

  const row = await store.upsertClaimIntake({
    callKey: ctx.callKey,
    kind: gate.kind,
    claimType,
    lossDate: loss.date,
    summary: cleanSummary(args.summary) ?? fallbackSummary(claimType),
    description,
    customerId: gate.customerId,
  });
  // Filed in the meantime (a parallel confirm): the filed claim stands and is never rewritten.
  return row.confirmed ? alreadyFiled(ctx, row) : intakeReadback(ctx, row, ctx.deps.now());
}

async function replayStart(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "claim_readback" && code !== "claim_already_filed") return answer(ctx, code);
  // confirm_claim files whatever intake is stored, so the read-back is of that row: a later
  // start_claim may have replaced what this delivery's arguments said. Reading is not a side effect.
  const row = await readOr<ClaimIntake | null>(
    ctx,
    "getClaimIntake",
    () => ctx.deps.store.getClaimIntake(ctx.callKey),
    null,
  );
  if (!row) return answer(ctx, code);
  return code === "claim_already_filed" ? alreadyFiled(ctx, row) : intakeReadback(ctx, row, ctx.deps.now());
}

// ---------------------------------------------------------------------------------------------
// confirm_claim {correct}
// ---------------------------------------------------------------------------------------------
/** The customer's confirmation (claim_received) through the at-most-once ledger, to the address the
 *  caller may be sent to: true only when Resend returned an id (now, or for an earlier delivery). */
async function sendClaimReceived(ctx: Run, row: ClaimIntake, firstName: string, to: string): Promise<boolean> {
  const budget = channelBudget(ctx);
  if (budget <= 0) return false;
  const deadline = Date.now() + budget;
  const work = (async (): Promise<boolean> => {
    // Rendered before the claim, so a template fault cannot strand a 'sending' row.
    const rendered = claimReceivedEmail({
      customer: { first_name: firstName },
      intakeKind: row.kind,
      claimType: row.claim_type,
      lossDate: row.loss_date,
      claimNumber: row.kind === "claim" ? row.claim_number : null,
      documents: CLAIM_DOCUMENTS[row.claim_type] ?? [],
    });
    const claim = await ctx.deps.store.claimEmail(ctx.callKey, "claim_received", maskEmail(to));
    if (!claim.claimed) return claim.status === "sent";
    const sent = await sendClaimed(ctx, "claim_received", { to, ...rendered }, deadline);
    return sent.ok;
  })().catch((e) => {
    logError(ctx, "claimReceived", e);
    return false;
  });
  return await withinBudget(work, budget, () => false);
}

/** After filing: the customer's confirmation and the team's notice (Telegram and the team email) run
 *  in parallel, each within its own budget. The sentence says "emailed" only when Resend returned an
 *  id for the confirmation; the team's channels never change what the caller hears. A chat session
 *  sends the confirmation but skips the team alerts, as escalate does. */
async function announceFiled(row: ClaimIntake, ctx: Run): Promise<ToolResult> {
  const { store, env } = ctx.deps;
  const lead = row.kind === "lead_intake";
  const customerId = lead ? null : row.customer_id;
  const [session, customer, contact] = await Promise.all([
    readOr<Session | null>(ctx, "getSession", () => store.getSession(ctx.callKey), null),
    customerId ? readOr<Customer | null>(ctx, "getCustomer", () => store.getCustomer(customerId), null) : null,
    capturedContact(ctx),
  ]);
  const verified = !lead && session?.level === "verified";
  // A new caller's confirmation goes only to the address they spelled and confirmed as a new caller
  // (an email_update address is never a recipient); a customer's only to the address on file.
  const newCaller = contact?.kind === "new_customer" && contact.confirmed ? contact : null;
  const to = (lead ? newCaller?.email : customer?.email)?.trim() ?? "";
  const firstName = (lead ? newCaller?.first_name : customer?.first_name)?.trim() ?? "";
  const last3 = lead ? null : claimLast3Of(row);
  const phone = lead
    ? leadCallback(ctx, newCaller)
    : customer?.phone_e164 ?? usableCallbackNumber(ctx.callerNumber, ownNumbers(env));

  const alert: ClaimIntakeAlert = {
    kind: "claim_intake",
    intakeKind: row.kind,
    claimType: row.claim_type,
    callKey: ctx.callKey,
    channel: ctx.channel,
    verified,
    claimLast3: last3,
  };
  const [emailed, team] = await Promise.all([
    to ? sendClaimReceived(ctx, row, firstName, to) : Promise.resolve(false),
    ctx.isChat ? Promise.resolve(null) : notifyTeam(ctx, alert, "claim_intake", () =>
      claimIntakeEmail({
        callKey: ctx.callKey,
        intakeKind: row.kind,
        claimType: row.claim_type,
        lossDate: row.loss_date,
        description: row.description,
        claimNumber: lead ? null : row.claim_number,
        verified,
        callbackPhone: phone,
        channel: ctx.channel,
        dashboardUrl: env.DASHBOARD_URL,
        caller: teamCallerOf(verified ? customer : null, contact),
      })),
  ]);
  if (team && !team.notified) safeLog(ctx, { event: "claim_intake_alert_failed", error: team.error });
  if (lead) return answer(ctx, "claim_intake_saved", { first_name: firstName, emailed });
  return answer(ctx, "claim_filed", last3 ? { claim_last3: last3, emailed } : { emailed });
}

async function confirmClaim(args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  if (correctOf(args.correct) !== true) {
    // A "no" leaves the intake unconfirmed for the corrected start_claim; a filed one stays filed.
    const row = await store.rejectClaimIntake(ctx.callKey);
    if (!row) return answer(ctx, "claim_not_pending");
    return row.confirmed ? alreadyFiled(ctx, row) : answer(ctx, "claim_retry");
  }
  const before = await store.getClaimIntake(ctx.callKey);
  if (!before) return answer(ctx, "claim_not_pending");
  // Filed by an earlier confirm: nothing is filed, sent or paged again.
  if (before.confirmed) return alreadyFiled(ctx, before);
  if (before.kind === "lead_intake") {
    // A new caller's intake promises a specialist's call, so it is filed only with a number to call. The
    // one start_claim saw may be gone since (a correction that came out without a usable number): ask.
    const contact = await store.getContact(ctx.callKey);
    const confirmed = contact?.kind === "new_customer" && contact.confirmed ? contact : null;
    if (!leadCallback(ctx, confirmed)) return answer(ctx, "claim_needs_phone");
  }
  const filed = await store.fileClaimIntake(ctx.callKey);
  if (!filed) return answer(ctx, "claim_not_pending");
  if (!filed.intake.confirmed) throw new Error("file_claim_intake returned an unfiled intake");
  // Filed by a parallel delivery while this one waited on the row lock (a redelivery of the same
  // confirm): that delivery sends and pages, so this one only answers, as a replay would.
  if (!filed.filedNow) {
    const code = filed.intake.kind === "lead_intake" ? "claim_intake_saved" : "claim_filed";
    return await filedAnswer(code, filed.intake, ctx);
  }
  return await announceFiled(filed.intake, ctx);
}

/** claim_filed or claim_intake_saved for an intake another delivery filed, rebuilt from what it left
 *  behind: nothing is filed, sent or paged again, and "emailed" stands only on a ledger row Resend
 *  confirmed (one still sending is not). */
async function filedAnswer(
  code: "claim_filed" | "claim_intake_saved",
  row: ClaimIntake | null,
  ctx: Run,
): Promise<ToolResult> {
  const [emails, contact] = await Promise.all([
    readOr<EmailRow[]>(ctx, "listEmails", () => ctx.deps.store.listEmails(ctx.callKey), []),
    code === "claim_intake_saved" ? capturedContact(ctx) : Promise.resolve(null),
  ]);
  const emailed = emails.some((e) => e.kind === "claim_received" && e.status === "sent");
  if (code === "claim_intake_saved") {
    const firstName = contact?.kind === "new_customer" && contact.confirmed ? contact.first_name : "";
    return answer(ctx, code, { first_name: firstName, emailed });
  }
  const last3 = claimLast3Of(row);
  return answer(ctx, code, last3 ? { claim_last3: last3, emailed } : { emailed });
}

async function replayConfirmClaim(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "claim_filed" && code !== "claim_intake_saved" && code !== "claim_already_filed") {
    return answer(ctx, code);
  }
  const row = await readOr<ClaimIntake | null>(
    ctx,
    "getClaimIntake",
    () => ctx.deps.store.getClaimIntake(ctx.callKey),
    null,
  );
  if (code === "claim_already_filed") return row ? alreadyFiled(ctx, row) : answer(ctx, code);
  return await filedAnswer(code, row, ctx);
}

// ---------------------------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------------------------
const TOOLS: ReadonlyMap<string, ToolSpec> = new Map<string, ToolSpec>([
  // Counted tools: the SQL functions claim the toolCallId and record the timeline themselves.
  ["lookup_customer", { name: "lookup_customer", run: lookupCustomer, fallback: systemError }],
  ["verify_identity", { name: "verify_identity", run: verifyIdentity, fallback: systemError }],
  [
    "get_claim_status",
    // Read-only, so a replay simply reads again.
    {
      name: "get_claim_status",
      run: getClaimStatus,
      fallback: systemError,
      replay: (_c, a, ctx) => getClaimStatus(a, ctx),
    },
  ],
  [
    "escalate",
    // The trouble sentence offers the very callback that just failed, so escalate's own failure
    // answer is the main-line apology instead.
    {
      name: "escalate",
      run: escalate,
      fallback: (ctx) => answer(ctx, "rep_unavailable"),
      replay: replayEscalate,
    },
  ],
  [
    "report_emergency",
    {
      name: "report_emergency",
      run: reportEmergency,
      fallback: emergencyNotLogged,
      replay: replayEmergency,
      neverRefuse: true,
    },
  ],
  [
    "send_info_email",
    {
      name: "send_info_email",
      run: sendInfoEmail,
      fallback: systemError,
      replay: replayInfoEmail,
      valid: (args) => isInfoTopic(args.topic),
    },
  ],
  [
    "capture_contact",
    // Replays read back the stored row (what confirm_contact will confirm); the row is written once.
    { name: "capture_contact", run: captureContact, fallback: systemError, replay: replayCapture },
  ],
  [
    "confirm_contact",
    {
      name: "confirm_contact",
      run: confirmContact,
      fallback: systemError,
      replay: replayConfirm,
      valid: (args) => correctOf(args.correct) !== null,
    },
  ],
  [
    "start_claim",
    // Replays read back the stored intake (what confirm_claim will file); the row is written once.
    { name: "start_claim", run: startClaim, fallback: systemError, replay: replayStart },
  ],
  [
    "confirm_claim",
    {
      name: "confirm_claim",
      run: confirmClaim,
      fallback: systemError,
      replay: replayConfirmClaim,
      valid: (args) => correctOf(args.correct) !== null,
    },
  ],
]);

async function guarded(ctx: Run, spec: ToolSpec, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    logError(ctx, "run", e);
    return spec.fallback(ctx);
  }
}

interface Execution {
  // Settles once the replay guard is decided: true when this delivery holds the toolCallId row.
  claimed: Promise<boolean>;
  result: Promise<ToolResult>;
}

function execute(spec: ToolSpec, args: Args, ctx: Run): Execution {
  let settle!: (claimed: boolean) => void;
  const claimed = new Promise<boolean>((resolve) => (settle = resolve));
  const result = (async (): Promise<ToolResult> => {
    if (spec.replay) {
      const replay = spec.replay;
      try {
        const prior = await ctx.deps.store.claimAttempt(ctx.callKey, ctx.toolCallId, spec.name);
        if (prior !== null) {
          settle(false);
          return await guarded(ctx, spec, () => replay(asCode(prior), args, ctx));
        }
        settle(true);
      } catch (e) {
        // Every side effect behind these tools is keyed on its own (escalation and email ledgers),
        // so running without the claim costs a timeline entry, never a second send.
        logError(ctx, "claimAttempt", e);
      }
    }
    settle(false);
    return await guarded(ctx, spec, () => spec.run(args, ctx));
  })();
  // A later settle is a no-op, so this only decides a guard that nothing above could reach.
  result.then(() => settle(false), () => settle(false));
  return { claimed, result };
}

/** The ledger keeps the code VAPI received: the tool's own answer, or its fallback once the budget
 *  ran out. A run that finishes late writes nothing, so a retry of the toolCallId replays what the
 *  caller heard and the post-call outcome reads what the server actually said. */
function recordCode(ctx: Run, claimed: Promise<boolean>, code: Code): void {
  writeBack(ctx, "setAttemptCode", async () => {
    if (await claimed) await ctx.deps.store.setAttemptCode(ctx.callKey, ctx.toolCallId, code);
  });
}

/** runTool with an explicit budget in milliseconds (tests use a short one). Never throws. */
export async function runToolWithin(
  call: ParsedToolCall,
  ctx: Omit<ToolCtx, "toolCallId">,
  budgetMs: number,
): Promise<ToolResult> {
  try {
    const spec = typeof call?.name === "string" ? TOOLS.get(call.name) : undefined;
    if (!spec) {
      try {
        ctx.deps.log({ event: "unknown_tool", call_key: ctx.callKey });
      } catch {
        // logging never changes the answer
      }
      return answer(ctx, "unknown_tool");
    }
    const run: Run = { ...ctx, toolCallId: String(call.id), tool: spec.name, deadline: Date.now() + budgetMs };
    const request = parseToolRequest(spec.name, call.args);
    let args: Args;
    if (request.ok) {
      args = request.args;
    } else if (spec.neverRefuse) {
      safeLog(run, { event: "tool_args_dropped", reason: request.reason });
      args = {};
    } else {
      safeLog(run, { event: "tool_bad_args", reason: request.reason });
      return answer(ctx, "bad_args");
    }
    if (spec.valid && !spec.valid(args)) {
      safeLog(run, { event: "tool_bad_args", reason: "invalid_value" });
      return answer(ctx, "bad_args");
    }
    const { claimed, result } = execute(spec, args, run);
    const answered = await withinBudget(result, budgetMs, () => {
      safeLog(run, { event: "tool_timeout", budget_ms: budgetMs });
      return spec.fallback(run);
    });
    // Counted tools record their code inside their SQL function.
    if (spec.replay) recordCode(run, claimed, answered.code);
    return answered;
  } catch {
    return systemError(ctx);
  }
}

/** Dispatch one parsed tool call. Never throws: errors become system_error with its sentence. */
export async function runTool(call: ParsedToolCall, ctx: Omit<ToolCtx, "toolCallId">): Promise<ToolResult> {
  return await runToolWithin(call, ctx, TOOL_BUDGET_MS);
}
