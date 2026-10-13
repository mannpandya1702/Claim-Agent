// The server tools. Each one turns model arguments (already past the trust boundary) and
// server state into one result code and the exact sentence VAPI speaks. The model never decides
// an outcome: identity comes from the session row, the callback target from the caller, the
// account or the envelope, and a channel counts as delivered only when its transport confirmed it.

import { alertSinks, type EscalationAlert, sendAlert } from "./alert.ts";
import {
  callbackRequestEmail,
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
} from "./enums.ts";
import {
  lastFour,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  parseDobParts,
  usableCallbackNumber,
} from "./identity.ts";
import { parseToolRequest } from "./parse_tool_request.ts";
import { verifiedSentence } from "./prior_contacts.ts";
import { redactPII } from "./redact.ts";
import { assertSpeakable, claimsSentence, sentenceFor, spokenName } from "./speak.ts";
import type {
  AttemptRow,
  CallerContact,
  Claim,
  Customer,
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
  fallback(): ToolResult;
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
function answer(code: Code, data?: Record<string, unknown>): ToolResult {
  return data ? { code, sentence: sentenceFor(code, data), data } : { code, sentence: sentenceFor(code) };
}

const systemError = () => answer("system_error");

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

/** "+16025550177" -> "6025550177". */
function nationalDigits(e164: string): string {
  const d = e164.replace(/\D/g, "");
  return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
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
  return code === "not_found" && phoneE164 ? answer(code, { digits: nationalDigits(phoneE164) }) : answer(code);
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
  if (result.code !== "verified") return answer(result.code);

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
  let sentence = verifiedSentence(firstName, rows, enabled, now);
  if (!isSpeakable(sentence)) sentence = sentenceFor("verified", { first_name: firstName });
  return firstName ? { code: "verified", sentence, data: { first_name: firstName } } : { code: "verified", sentence };
}

// ---------------------------------------------------------------------------------------------
// get_claim_status {}
// ---------------------------------------------------------------------------------------------
async function getClaimStatus(_args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const session = await store.getSession(ctx.callKey);
  if (session?.level !== "verified") return answer("not_verified", { level: session?.level ?? "none" });
  // The customer comes from the session only; the tool takes no customer or claim argument.
  if (!session.verified_customer_id) throw new Error("verified session without a verified customer");
  const claims = await store.getClaims(session.verified_customer_id);
  if (claims.length === 0) return answer("no_claims");
  return {
    code: "ok",
    sentence: claimsSentence(claims, todayInNewYork(ctx.deps.now())),
    data: {
      claims: claims.map((c) => ({
        claim_number_last3: String(c.claim_number ?? "").replace(/\D/g, "").slice(-3),
        status: c.status,
      })),
    },
  };
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

async function sendTeamEmail(
  ctx: Run,
  kind: "callback_request" | "emergency_alert",
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

async function sendTelegramAlert(ctx: Run, alert: EscalationAlert): Promise<Delivery> {
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
  alert: EscalationAlert,
  kind: "callback_request" | "emergency_alert",
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
 *  else the number captured with their details on this call, else caller id. Never our own line. */
function fallbackCallback(ctx: Run, customer: Customer | null, contact: CallerContact | null): Callback {
  const own = ownNumbers(ctx.deps.env);
  const account = usableCallbackNumber(customer?.phone_e164, own);
  if (account) return { phone: account, source: "account" };
  const captured = usableCallbackNumber(contact?.callback_phone, own);
  if (captured) return { phone: captured, source: contact?.callback_source === "caller_id" ? "caller_id" : "argument" };
  const caller = usableCallbackNumber(ctx.callerNumber, own);
  if (caller) return { phone: caller, source: "caller_id" };
  return { phone: null, source: "none" };
}

function queuedData(source: CallbackSource | null, phone: string): Record<string, unknown> | undefined {
  switch (source) {
    case "argument":
      return { target: "given", digits: lastFour(phone) };
    case "account":
      return { target: "account" };
    case "caller_id":
      return { target: "caller_id" };
    default:
      return undefined;
  }
}

function queued(callback: Callback): ToolResult {
  return callback.phone
    ? answer("rep_queued", queuedData(callback.source, callback.phone))
    : answer("rep_queued_no_number");
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
  const given = usableCallbackNumber(args.callback_phone, ownNumbers(env));

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
    return answer("rep_unavailable");
  }

  if (!row.inserted) {
    // A repeat never alerts again; the dashboard row now carries the new number.
    if (given && given !== existing?.callback_phone) {
      return answer("callback_updated", { digits: nationalDigits(given) });
    }
    // A chat answered its first request as if the team had been told, so its repeat says the same.
    const told = row.alertStatus === "sent" || (ctx.isChat && row.alertStatus === "skipped");
    return answer(told ? "rep_already_queued" : "rep_recorded");
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
    return queued(callback);
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
  return delivery.notified ? queued(callback) : answer("rep_recorded");
}

async function replayEscalate(code: Code, args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "rep_queued" && code !== "callback_updated") return answer(code);
  // A retry carries the first delivery's arguments, so a number the caller gave is rebuilt from
  // them. The row is not: a later request may have changed its number since.
  const given = usableCallbackNumber(args.callback_phone, ownNumbers(ctx.deps.env));
  if (code === "callback_updated") return answer(code, given ? { digits: nationalDigits(given) } : undefined);
  if (given) return answer(code, queuedData("argument", given));
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
    return answer(code, queuedData(source, row.callback_phone));
  }
  return answer(code);
}

// ---------------------------------------------------------------------------------------------
// report_emergency {note?}
// ---------------------------------------------------------------------------------------------
const emergencyNotLogged = () => answer("emergency_logged", { db_failed: true });

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
    return emergencyNotLogged();
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
  return answer("emergency_logged");
}

async function replayEmergency(_code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  // "Our team has been told" only when the row the first delivery wrote is really there.
  const rows = await readOr<EscalationRow[] | null>(
    ctx,
    "listEscalations",
    () => ctx.deps.store.listEscalations(ctx.callKey),
    null,
  );
  return rows?.some((r) => r.kind === "emergency") ? answer("emergency_logged") : emergencyNotLogged();
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
    return answer(claim.status === "failed" ? "email_failed" : "email_already_sent");
  }
  const sent = await sendClaimed(ctx, topic, { to, subject: rendered.subject, html: rendered.html }, ctx.deadline - ANSWER_MARGIN_MS);
  return sent.ok ? answer("email_sent", sentData) : answer("email_failed");
}

/** An unverified caller gets one thing by email: the generic steps to start a claim, sent to the
 *  address they spelled and confirmed as a new customer. Nothing from any account goes with it,
 *  every other topic still needs a verified caller with an email on file, and an email_update
 *  (a verified customer's spelled address) is never a recipient. */
async function unverifiedInfoEmail(topic: InfoEmailTopic, session: Session | null, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const level: Level = session?.level ?? "none";
  if (topic !== "how_to_start_claim") return answer("not_verified", { level });
  const contact = await store.getContact(ctx.callKey);
  if (contact?.kind !== "new_customer") {
    // After the lookups ran out, the way forward is the new-caller details, not another number.
    if (level === "none") {
      const attempts = await readOr<AttemptRow[]>(ctx, "listAttempts", () => store.listAttempts(ctx.callKey), []);
      if (attempts.some((a) => a.kind === "lookup_miss")) return answer("contact_needs_name");
    }
    return answer("not_verified", { level });
  }
  if (!contact.confirmed) return readback(contact);
  if (!contact.email) return answer("contact_invalid_email");
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
  if (!to) return answer("no_email_on_file");
  const claims = topic === "how_to_start_claim" ? [] : await store.getClaims(customer.id);
  // Rendered before the claim, so a template fault cannot strand a 'sending' row that would make
  // every later request on this call say "already sent".
  return await sendTopicEmail(ctx, topic, to, renderInfoEmail(topic, customer, claims));
}

async function replayInfoEmail(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  if (code === "contact_readback") {
    const contact = await readOr<CallerContact | null>(ctx, "getContact", () => store.getContact(ctx.callKey), null);
    return contact ? readback(contact) : answer(code);
  }
  if (code !== "not_verified" && code !== "email_sent") return answer(code);
  const session = await readOr<Session | null>(ctx, "getSession", () => store.getSession(ctx.callKey), null);
  if (code === "email_sent") return session?.level === "verified" ? answer(code) : answer(code, { target: "given" });
  return answer(code, { level: session?.level ?? "none" });
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
  c: Pick<CallerContact, "first_name" | "last_name" | "email" | "callback_phone" | "callback_source">,
): ToolResult {
  const data: Record<string, unknown> = { first_name: c.first_name, last_name: c.last_name };
  if (c.email) data.email = c.email;
  if (c.callback_source === "argument" && c.callback_phone) data.callback_phone = c.callback_phone;
  // The address and number are in the sentence, spelled; the result's data carries only the first name.
  return { code: "contact_readback", sentence: sentenceFor("contact_readback", data), data: { first_name: c.first_name } };
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
 *  number out keeps the number the caller said earlier on this call. */
async function contactInput(args: Args, ctx: Run): Promise<{ ok: true; input: ContactInput } | { ok: false; code: Code }> {
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
  let given = usableCallbackNumber(args.callback_phone, own);
  if (!given && args.callback_phone === undefined) {
    // A correction re-sends the name and the address; a number said for an earlier capture stands.
    const prior = await capturedContact(ctx);
    if (prior?.callback_source === "argument") given = usableCallbackNumber(prior.callback_phone, own);
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
  };
}

const PHONE_CHANNELS: ReadonlySet<string> = new Set(["inboundPhoneCall", "outboundPhoneCall"]);

/** A new caller on a phone call left the number out (they said to use the one they're calling from)
 *  but the call has no usable caller id (withheld, international, junk): ask once for the best number.
 *  If they would rather not give one, the next capture is stored without a number. A web call or a
 *  chat never has a caller id, so its prompt asks for the digits and an omitted number means none. */
async function needsCallbackNumber(input: ContactInput, ctx: Run): Promise<boolean> {
  if (input.kind !== "new_customer" || input.callbackSource !== "none" || !PHONE_CHANNELS.has(ctx.channel)) {
    return false;
  }
  // A failed read never asks: asking twice is worse than storing no number.
  const attempts = await readOr<AttemptRow[] | null>(ctx, "listAttempts", () => ctx.deps.store.listAttempts(ctx.callKey), null);
  return attempts !== null &&
    !attempts.some((a) => a.tool_name === "capture_contact" && a.code === "contact_needs_phone");
}

async function captureContact(args: Args, ctx: Run): Promise<ToolResult> {
  const prepared = await contactInput(args, ctx);
  if (!prepared.ok) return answer(prepared.code);
  if (await needsCallbackNumber(prepared.input, ctx)) return answer("contact_needs_phone");
  return readback(await ctx.deps.store.upsertContact(prepared.input));
}

async function replayCapture(code: Code, args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "contact_readback") return answer(code);
  // confirm_contact confirms whatever row is stored, so the read-back is of that row: a later capture
  // may have replaced what this delivery's arguments said. Reading is not a side effect.
  const row = await capturedContact(ctx);
  if (row) return readback(row);
  // No row (or a failed read): the same read-back rebuilt from this delivery's arguments, no write.
  const prepared = await contactInput(args, ctx);
  if (!prepared.ok) return answer(prepared.code);
  const p = prepared.input;
  return readback({
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
 *  which part was wrong among those read back (an email_update read back only the address). */
function confirmedAnswer(row: CallerContact, correct: boolean): ToolResult {
  if (!correct) {
    return row.kind === "email_update"
      ? answer("contact_retry", { part: "email" })
      : answer("contact_retry", { has_email: row.email !== null, has_phone: row.callback_source === "argument" });
  }
  if (row.kind === "email_update") return answer("contact_saved_existing", { first_name: row.first_name });
  return answer("contact_saved_new", row.email ? { first_name: row.first_name } : { first_name: row.first_name, has_email: false });
}

/** Nothing to confirm: a verified caller is asked for the address again (their name is the
 *  account's), anyone else for their details from the start. */
async function notPending(ctx: Run): Promise<ToolResult> {
  const session = await readOr<Session | null>(ctx, "getSession", () => ctx.deps.store.getSession(ctx.callKey), null);
  // The flag only picks the wording; the result keeps not_pending's usual shape.
  return session?.level === "verified"
    ? { code: "not_pending", sentence: sentenceFor("not_pending", { verified: true }) }
    : answer("not_pending");
}

async function confirmContact(args: Args, ctx: Run): Promise<ToolResult> {
  const correct = correctOf(args.correct) === true;
  // A "no" leaves the row unconfirmed (and takes back an earlier "yes"); nothing is deleted.
  const row = await ctx.deps.store.setContactConfirmed(ctx.callKey, correct);
  return row ? confirmedAnswer(row, correct) : await notPending(ctx);
}

async function replayConfirm(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  if (code === "not_pending") return await notPending(ctx);
  if (code !== "contact_retry" && code !== "contact_saved_new" && code !== "contact_saved_existing") {
    return answer(code);
  }
  // Reading the row is not a side effect; the first delivery already wrote what it answered.
  const row = await readOr<CallerContact | null>(ctx, "getContact", () => ctx.deps.store.getContact(ctx.callKey), null);
  if (!row) return answer(code);
  const replayed = confirmedAnswer(row, code !== "contact_retry");
  return replayed.code === code ? replayed : answer(code);
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
    { name: "escalate", run: escalate, fallback: () => answer("rep_unavailable"), replay: replayEscalate },
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
]);

async function guarded(ctx: Run, spec: ToolSpec, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    logError(ctx, "run", e);
    return spec.fallback();
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
      return answer("unknown_tool");
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
      return answer("bad_args");
    }
    if (spec.valid && !spec.valid(args)) {
      safeLog(run, { event: "tool_bad_args", reason: "invalid_value" });
      return answer("bad_args");
    }
    const { claimed, result } = execute(spec, args, run);
    const answered = await withinBudget(result, budgetMs, () => {
      safeLog(run, { event: "tool_timeout", budget_ms: budgetMs });
      return spec.fallback();
    });
    // Counted tools record their code inside their SQL function.
    if (spec.replay) recordCode(run, claimed, answered.code);
    return answered;
  } catch {
    return systemError();
  }
}

/** Dispatch one parsed tool call. Never throws: errors become system_error with its sentence. */
export async function runTool(call: ParsedToolCall, ctx: Omit<ToolCtx, "toolCallId">): Promise<ToolResult> {
  return await runToolWithin(call, ctx, TOOL_BUDGET_MS);
}
