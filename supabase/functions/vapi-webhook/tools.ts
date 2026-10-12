// The six server tools. Each one turns model arguments (already past the trust boundary) and
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
} from "./email.ts";
import {
  type CallbackSource,
  type Code,
  CODES,
  type EmailKind,
  type EscalationReason,
  INFO_EMAIL_TOPICS,
  type InfoEmailTopic,
  type Level,
  MODEL_ESCALATION_REASONS,
  type ServerTool,
  TIMEZONE,
} from "./enums.ts";
import { lastFour, normalisePhone, parseDobParts, usableCallbackNumber } from "./identity.ts";
import { parseToolRequest } from "./parse_tool_request.ts";
import { verifiedSentence } from "./prior_contacts.ts";
import { redactPII } from "./redact.ts";
import { assertSpeakable, claimsSentence, sentenceFor } from "./speak.ts";
import type {
  AttemptRow,
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

/** Callback target: the number the caller gave, else the verified account's, else caller id. Never our own line. */
async function callbackFor(
  ctx: Run,
  given: string | null,
  existing: EscalationRow | null,
  session: Session | null,
): Promise<Callback> {
  if (given) return { phone: given, source: "argument" };
  // On a repeat only a number the caller just gave may replace the one on the row; a fallback
  // number would overwrite what they said.
  if (existing?.callback_phone) return { phone: null, source: "none" };
  const own = ownNumbers(ctx.deps.env);
  const customerId = session?.level === "verified" ? session.verified_customer_id : null;
  if (customerId) {
    const customer = await readOr(ctx, "getCustomer", () => ctx.deps.store.getCustomer(customerId), null);
    const account = usableCallbackNumber(customer?.phone_e164, own);
    if (account) return { phone: account, source: "account" };
  }
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
  const [session, attempts, escalations] = await Promise.all([
    readOr<Session | null>(ctx, "getSession", () => store.getSession(callKey), null),
    readOr<AttemptRow[]>(ctx, "listAttempts", () => store.listAttempts(callKey), []),
    readOr<EscalationRow[]>(ctx, "listEscalations", () => store.listEscalations(callKey), []),
  ]);
  const level: Level = session?.level ?? "none";
  const verified = level === "verified";
  const reason = escalationReason(args, level, attempts);
  const existing = escalations.find((e) => e.kind === "representative") ?? null;
  const callback = await callbackFor(ctx, given, existing, session);

  let row: Awaited<ReturnType<Store["upsertEscalation"]>>;
  try {
    row = await store.upsertEscalation({
      callKey,
      kind: "representative",
      reason,
      details,
      callbackPhone: callback.phone,
      callbackSource: callback.source,
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
    }));
  writeBack(
    ctx,
    "setEscalationDelivery",
    () => store.setEscalationDelivery(row.id, delivery.notified ? "sent" : "failed", delivery.error),
  );
  // "Sent" and a timeframe are promised only when a channel confirmed delivery.
  return delivery.notified ? queued(callback) : answer("rep_recorded");
}

async function replayEscalate(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "rep_queued" && code !== "callback_updated") return answer(code);
  // The sentence's number comes from the row the first delivery wrote; reading it is not a side effect.
  const rows = await readOr<EscalationRow[]>(
    ctx,
    "listEscalations",
    () => ctx.deps.store.listEscalations(ctx.callKey),
    [],
  );
  const row = rows.find((r) => r.kind === "representative");
  const phone = row?.callback_phone ?? null;
  const source = row?.callback_source ?? null;
  if (code === "callback_updated") return answer(code, phone ? { digits: nationalDigits(phone) } : undefined);
  return answer(code, phone ? queuedData(source, phone) : undefined);
}

// ---------------------------------------------------------------------------------------------
// report_emergency {note?}
// ---------------------------------------------------------------------------------------------
const emergencyNotLogged = () => answer("emergency_logged", { db_failed: true });

async function reportEmergency(args: Args, ctx: Run): Promise<ToolResult> {
  const { store, env } = ctx.deps;
  const callKey = ctx.callKey;
  const details = cleanDetails(args.note);
  const session = await readOr<Session | null>(ctx, "getSession", () => store.getSession(callKey), null);
  const verified = session?.level === "verified";
  // The tool never asks for a number; whatever the server already knows goes on the row for staff.
  const callback = await callbackFor(ctx, null, null, session);
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
        () => emergencyEmail({ callKey, note: details, channel: ctx.channel, dashboardUrl: env.DASHBOARD_URL }),
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

async function sendInfoEmail(args: Args, ctx: Run): Promise<ToolResult> {
  const { store } = ctx.deps;
  const topic = args.topic as InfoEmailTopic; // checked by valid() before the tool runs
  const session = await store.getSession(ctx.callKey);
  if (session?.level !== "verified") return answer("not_verified", { level: session?.level ?? "none" });
  const customer = await verifiedCustomer(store, session);
  const to = typeof customer.email === "string" ? customer.email.trim() : "";
  // The address is never taken by voice; without one on file the caller is pointed to the website.
  if (!to) return answer("no_email_on_file");
  const claims = topic === "how_to_start_claim" ? [] : await store.getClaims(customer.id);
  // Rendered before the claim, so a template fault cannot strand a 'sending' row that would make
  // every later request on this call say "already sent".
  const { subject, html } = renderInfoEmail(topic, customer, claims);

  const claim = await store.claimEmail(ctx.callKey, topic, maskEmail(to));
  if (!claim.claimed) {
    // At most one send per topic per call: a failed one is not retried on this call either.
    return answer(claim.status === "failed" ? "email_failed" : "email_already_sent");
  }
  const sent = await sendClaimed(ctx, topic, { to, subject, html }, ctx.deadline - ANSWER_MARGIN_MS);
  return answer(sent.ok ? "email_sent" : "email_failed");
}

async function replayInfoEmail(code: Code, _args: Args, ctx: Run): Promise<ToolResult> {
  if (code !== "not_verified") return answer(code);
  const session = await readOr<Session | null>(ctx, "getSession", () => ctx.deps.store.getSession(ctx.callKey), null);
  return answer(code, { level: session?.level ?? "none" });
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
]);

async function guarded(ctx: Run, spec: ToolSpec, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    logError(ctx, "run", e);
    return spec.fallback();
  }
}

async function execute(spec: ToolSpec, args: Args, ctx: Run): Promise<ToolResult> {
  let claimed = false;
  if (spec.replay) {
    const replay = spec.replay;
    try {
      const prior = await ctx.deps.store.claimAttempt(ctx.callKey, ctx.toolCallId, spec.name);
      if (prior !== null) return await guarded(ctx, spec, () => replay(asCode(prior), args, ctx));
      claimed = true;
    } catch (e) {
      // Every side effect behind these tools is keyed on its own (escalation and email ledgers),
      // so running without the claim costs a timeline entry, never a second send.
      logError(ctx, "claimAttempt", e);
    }
  }
  const result = await guarded(ctx, spec, () => spec.run(args, ctx));
  if (claimed) {
    writeBack(ctx, "setAttemptCode", () => ctx.deps.store.setAttemptCode(ctx.callKey, ctx.toolCallId, result.code));
  }
  return result;
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
    return await withinBudget(execute(spec, args, run), budgetMs, () => {
      safeLog(run, { event: "tool_timeout", budget_ms: budgetMs });
      return spec.fallback();
    });
  } catch {
    return systemError();
  }
}

/** Dispatch one parsed tool call. Never throws: errors become system_error with its sentence. */
export async function runTool(call: ParsedToolCall, ctx: Omit<ToolCtx, "toolCallId">): Promise<ToolResult> {
  return await runToolWithin(call, ctx, TOOL_BUDGET_MS);
}
