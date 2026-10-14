// GoHighLevel CRM adapter: the third outbox destination (0008_ghl.sql). One interaction.completed
// event per call becomes, on the sub-account in GHL_LOCATION_ID, a contact found (or created) on a
// trusted number, a set of oi- tags, one note of server facts and up to three follow-up tasks.
//
// GHL never sits in the call path: the post-call writer queues the row 90 s out (outbox.ts) and the
// every-minute job delivers it. Contacts are keyed only on numbers the server trusts: the verified
// customer's phone_e164 from our database, the number a new caller confirmed on the read-back, or a
// phone call's caller id. A number, name or email the model heard and nobody confirmed never finds,
// names or fills a contact. A number the caller said (and confirmed) shows they heard it right, not
// that it is theirs, so it may create a contact but never writes to one GHL already holds.
//
// Delivery runs in steps: contact -> tags -> note -> tasks -> done. Each step's result is merged into
// outbox_events.progress before the next starts, so a retry repeats only what is missing and a
// complete row replays with zero requests. Contact create is search-first and adopts the existing
// contact on GHL's duplicate 400; tags go only through the additive endpoint (a PUT carrying tags
// replaces them); the one PUT fills fields that are empty in GHL, so a human's edit always wins. No
// custom fields, no opportunities, no messages: nothing here can start outreach to a contact.

import { dashboardLink } from "./alert.ts";
import { maskEmail, writtenDate } from "./email.ts";
import { CALL_REASONS, type EscalationReason, GHL_TAGS, type GhlTag, OUTCOMES, TIMEZONE } from "./enums.ts";
import { callerIdNumber, lastFour } from "./identity.ts";
import { redactPII } from "./redact.ts";
import type {
  CallerContact,
  ClaimIntake,
  Customer,
  Deps,
  Env,
  EscalationRow,
  OutboxRow,
  Session,
  Store,
} from "./types.ts";

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
/** One request's timeout; a request never gets more than the run has left. */
export const GHL_TIMEOUT_MS = 4000;
/** The first delivery waits this long after the call, so the analysis backfill (about 5, 20 and
 *  65 s after the report) has landed and the tags and the note carry the final outcome and reason. */
export const GHL_DELAY_S = 90;
/** The source a created contact carries. */
export const GHL_SOURCE = "Observe voice agent";
/** GHL rate-limits per location (100 requests per 10 s window); a 429 waits this long by default. */
const RATE_LIMIT_DEFAULT_S = 10;
/** A request starts only with at least this much of the run left; otherwise the delivery pauses
 *  with its attempt given back and the next run resumes at the step it stopped before. A write GHL
 *  cannot take back (a create, a note, a task) waits for a full GHL_TIMEOUT_MS instead: cut short by
 *  the run's own deadline it may still land in GHL, and the retry would then make it twice. */
const MIN_REQUEST_MS = 1000;
const MAX_ERROR = 200;
const MAX_SUMMARY = 1500;
const MAX_DESCRIPTION = 500;
const SEARCH_PAGE_LIMIT = 20;
const LONG_DIGITS_RE = /\d{7,}/g;
// What GHL's phone field takes: E.164, "+" and 8 to 15 digits (North American or international). A
// callback number noted as the caller said it, without a country code, is never sent there: GHL
// refuses it, and the refusal would come back on every retry of the outbox row.
const E164_RE = /^\+[1-9]\d{7,14}$/;
const PHONE_CHANNELS: ReadonlySet<string> = new Set(["inboundPhoneCall", "outboundPhoneCall"]);
// The two requests whose body names the location; every other one acts on a contact id.
const LOCATION_PATHS: ReadonlySet<string> = new Set(["/contacts/", "/contacts/search"]);

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Token and location; without either the destination is off (its rows are never claimed). */
export function ghlConfigured(env: Pick<Env, "GHL_TOKEN" | "GHL_LOCATION_ID">): boolean {
  return !!env?.GHL_TOKEN?.trim() && !!env?.GHL_LOCATION_ID?.trim();
}

// ---------------------------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------------------------
// duplicate: a create matched an existing contact (meta names it); not_found: the contact id is
// unknown (GHL answers 400 "Contact with id ... not found"); config: the token or its scopes, which
// pause the destination; rate_limited and transient may pass; invalid is this request's own fault.
export type GhlErrorKind = "duplicate" | "not_found" | "config" | "rate_limited" | "transient" | "invalid";

export type GhlResult =
  | { ok: true; status: number; data: Obj }
  | {
    ok: false;
    status?: number;
    kind: GhlErrorKind;
    error: string;
    retryable: boolean;
    retryAfterS?: number;
    meta?: { contactId: string | null; matchingField: string | null };
  };

/** An error as it may be stored or logged: runs of 7+ digits masked (GHL can quote a phone number
 *  back), one line, at most 200 characters. */
export function ghlErrorText(text: string): string {
  return String(text).replace(LONG_DIGITS_RE, "[digits]").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);
}

function messageOf(body: unknown, fallback: string): string {
  if (!isObj(body)) return fallback;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  if (Array.isArray(body.message) && body.message.length > 0) return body.message.map(String).join("; ");
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  return fallback;
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

/** One GHL request. Bearer token, the 2021-07-28 version, JSON only with a body, and locationId
 *  added to the create and search bodies. Never throws; no retries inside (the outbox tick is the
 *  retry). */
export async function ghlRequest(
  deps: Deps,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Obj,
  timeoutMs = GHL_TIMEOUT_MS,
): Promise<GhlResult> {
  const token = str(deps.env.GHL_TOKEN);
  const locationId = str(deps.env.GHL_LOCATION_ID);
  const where = `${method} ${path}`;
  if (!token || !locationId) return { ok: false, kind: "config", error: "ghl not configured", retryable: false };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Version: GHL_API_VERSION,
    Accept: "application/json",
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(LOCATION_PATHS.has(path) ? { ...body, locationId } : body);
  }
  let res: Response;
  let data: unknown = {};
  try {
    res = await deps.fetch(`${GHL_BASE_URL}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(Math.max(Math.floor(timeoutMs), 1)),
    });
    const text = await res.text();
    try {
      data = text.trim() ? JSON.parse(text) : {};
    } catch {
      data = {}; // an error page, or an empty 2xx
    }
  } catch (e) {
    const detail = isTimeout(e) ? `ghl timeout ${where}` : `ghl network ${where}: ${(e as Error)?.message ?? e}`;
    return { ok: false, kind: "transient", error: ghlErrorText(detail), retryable: true };
  }
  if (res.ok) return { ok: true, status: res.status, data: isObj(data) ? data : {} };

  const message = messageOf(data, res.statusText || "error");
  const error = ghlErrorText(`ghl ${res.status} ${where}: ${message}`);
  const status = res.status;
  if (status === 400 && /duplicat/i.test(message)) {
    const meta = isObj(data) && isObj(data.meta) ? data.meta : {};
    return {
      ok: false,
      status,
      kind: "duplicate",
      error,
      retryable: false,
      meta: { contactId: str(meta.contactId), matchingField: str(meta.matchingField) },
    };
  }
  if (status === 404 || (status === 400 && /not found/i.test(message))) {
    return { ok: false, status, kind: "not_found", error, retryable: false };
  }
  if (status === 401 || status === 403) return { ok: false, status, kind: "config", error, retryable: false };
  if (status === 429) {
    const ms = Number(res.headers.get("x-ratelimit-interval-milliseconds"));
    const retryAfterS = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : RATE_LIMIT_DEFAULT_S;
    return { ok: false, status, kind: "rate_limited", error, retryable: true, retryAfterS };
  }
  if (status >= 500) return { ok: false, status, kind: "transient", error, retryable: true };
  return { ok: false, status, kind: "invalid", error, retryable: false };
}

// ---------------------------------------------------------------------------------------------
// Facts.
// ---------------------------------------------------------------------------------------------
/** The call_interactions columns the adapter reads (selected fresh at delivery time). */
export interface InteractionForGhl {
  vapi_call_id: string;
  channel: string | null;
  outcome: string | null;
  call_reason: string | null;
  summary: string | null; // already redacted when stored
  caller_type: string | null;
  caller_phone: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

/** Exactly the InteractionForGhl columns, in the select list store.ts sends. */
export const GHL_COLUMNS = [
  "vapi_call_id",
  "channel",
  "outcome",
  "call_reason",
  "summary",
  "caller_type",
  "caller_phone",
  "started_at",
  "ended_at",
  "created_at",
] as const satisfies readonly (keyof InteractionForGhl)[];
// A column added to the interface but not to the list fails the type check here.
const _everyGhlColumn: Exclude<keyof InteractionForGhl, typeof GHL_COLUMNS[number]> extends never ? true : never = true;
void _everyGhlColumn;

export interface GhlFacts {
  interaction: InteractionForGhl;
  session: Session | null;
  customer: Customer | null; // the customer this call verified
  candidatePhone: string | null; // a locked call's candidate account number: compared, never written
  contact: CallerContact | null;
  escalations: EscalationRow[];
  intake: ClaimIntake | null;
}

/** Everything one delivery reads, fresh. null when the call has no record (the row goes dead). */
export async function loadGhlFacts(store: Store, callKey: string): Promise<GhlFacts | null> {
  const [interaction, session, contact, escalations, intake] = await Promise.all([
    store.getInteractionForGhl(callKey),
    store.getSession(callKey),
    store.getContact(callKey),
    store.listEscalations(callKey),
    store.getClaimIntake(callKey),
  ]);
  if (!interaction) return null;
  const verifiedId = session?.level === "verified" ? session.verified_customer_id : null;
  const lockedId = session?.level === "locked" ? session.candidate_customer_id : null;
  const [customer, candidate] = await Promise.all([
    verifiedId ? store.getCustomer(verifiedId) : null,
    lockedId ? store.getCustomer(lockedId) : null,
  ]);
  return {
    interaction,
    session,
    customer: customer && customer.id === verifiedId ? customer : null,
    candidatePhone: candidate?.phone_e164 ?? null,
    contact,
    escalations: escalations ?? [],
    intake,
  };
}

// ---------------------------------------------------------------------------------------------
// Who the contact is.
// ---------------------------------------------------------------------------------------------
// verified     the customer this call verified: searched on their phone_e164, created on a miss,
//              filled where GHL is empty on a hit
// lead         a new caller who confirmed their details on the read-back: searched on that number,
//              created with that name and email on a miss; on a hit, additive writes only when the
//              number is the call's caller id (createOnly otherwise: a number the caller said may
//              be anyone's, so a hit is skipped). A number noted as said (no country code) is never a
//              key: a phone call's caller id keys the lead instead, and the note names the number
// search_only  anyone else on a phone call: searched on the caller id; a hit gets tags and a note of
//              server facts, a miss is skipped
// skip         nothing trusted to key on (a web caller, no caller id, the locked candidate's number)
export type GhlMode = "verified" | "lead" | "search_only" | "skip";

export interface CallerPlan {
  mode: GhlMode;
  key: string | null; // the E.164 number the contact is searched on
  // what a create may carry and the enrichment wants (verified, lead); null: never create
  create: { firstName: string; lastName: string; email: string | null } | null;
  enrich: boolean; // verified only: fill the fields that are empty in GHL from `create`
  // lead on a number the caller said: only a contact this adapter creates is written to; a search hit
  // (or a duplicate create) is someone GHL already knows, and the delivery is skipped
  createOnly?: boolean;
  status: "verified" | "lead" | "unverified" | "locked";
  reason?: string; // why a skip
}

function e164(raw: unknown): string | null {
  return typeof raw === "string" && E164_RE.test(raw.trim()) ? raw.trim() : null;
}

function ownNumbers(env: Env): string[] {
  return typeof env?.OWN_NUMBERS === "string" ? env.OWN_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const skip = (reason: string, status: CallerPlan["status"] = "unverified"): CallerPlan => ({
  mode: "skip",
  key: null,
  create: null,
  enrich: false,
  status,
  reason,
});

/** A phone call's caller id as a key (E.164, own numbers left out), or null. The session holds the
 *  envelope's caller id; without a session no tool ran, so the record's caller_phone can only be that
 *  same caller id. */
function phoneCallerId(facts: GhlFacts, own: string[]): string | null {
  const session = facts.session;
  const channel = facts.interaction.channel ?? session?.channel ?? null;
  if (!channel || !PHONE_CHANNELS.has(channel)) return null;
  const raw = session ? session.caller_number : facts.contact ? null : facts.interaction.caller_phone;
  return e164(callerIdNumber(raw, own));
}

/** Pure: who the call's contact is and what may be written to it, from server facts only. */
export function planCaller(facts: GhlFacts, own: string[]): CallerPlan {
  const session = facts.session;
  const level = session?.level ?? "none";
  if (level === "verified") {
    const customer = facts.customer;
    if (!customer || customer.id !== session?.verified_customer_id) {
      return skip("verified_customer_missing", "verified");
    }
    const key = e164(customer.phone_e164);
    if (!key) return skip("verified_without_phone", "verified");
    return {
      mode: "verified",
      key,
      create: { firstName: customer.first_name, lastName: customer.last_name, email: str(customer.email) },
      enrich: true,
      status: "verified",
    };
  }
  // Only with no account in play: next to a phone match the caller did not verify, a "new" name and
  // number would most likely be the account holder's (post_call.ts has the same guard).
  const contact = facts.contact;
  if (level === "none" && !session?.candidate_customer_id && contact?.kind === "new_customer" && contact.confirmed) {
    const create = { firstName: contact.first_name, lastName: contact.last_name, email: str(contact.email) };
    const callerId = phoneCallerId(facts, own);
    const key = e164(contact.callback_phone);
    if (key) {
      // The envelope's caller id is the caller's own line; a number they said is only what they said,
      // unless it is that same caller id.
      const createOnly = contact.callback_source !== "caller_id" && key !== callerId;
      return { mode: "lead", key, create, enrich: false, ...(createOnly ? { createOnly } : {}), status: "lead" };
    }
    if (!contact.callback_phone) return skip("new_caller_without_number", "lead");
    // A number noted as said, without a country code, never goes into GHL's phone field (the note carries
    // its last four): the call's own caller id keys the lead instead, as the caller's own line.
    if (callerId) return { mode: "lead", key: callerId, create, enrich: false, status: "lead" };
    return skip("new_caller_number_without_country_code", "lead");
  }
  const status = level === "locked" ? "locked" : "unverified";
  const channel = facts.interaction.channel ?? session?.channel ?? null;
  if (!channel || !PHONE_CHANNELS.has(channel)) return skip("web_unverified", status);
  const callerId = phoneCallerId(facts, own);
  if (!callerId) return skip("no_caller_id", status);
  // A locked caller never touches the account they failed to verify, even from its own number.
  if (level === "locked" && facts.candidatePhone && callerId === facts.candidatePhone) {
    return skip("locked_candidate_number", status);
  }
  return { mode: "search_only", key: callerId, create: null, enrich: false, status };
}

export interface GhlContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  dnd?: boolean;
  dndSettings?: Record<string, unknown>;
  dateAdded?: string;
  [k: string]: unknown;
}

function fullName(c: { firstName?: unknown; lastName?: unknown }): string {
  return `${typeof c.firstName === "string" ? c.firstName : ""} ${typeof c.lastName === "string" ? c.lastName : ""}`
    .toLowerCase().replace(/\s+/g, " ").trim();
}

/** The contact to use among the search hits: for a verified caller the one hit whose full name is
 *  theirs (case-insensitive), otherwise the oldest by dateAdded. */
export function pickContact(hits: unknown[], plan: CallerPlan): GhlContact | null {
  const usable = (Array.isArray(hits) ? hits : []).filter((h): h is GhlContact => isObj(h) && !!str(h.id));
  if (usable.length <= 1) return usable[0] ?? null;
  if (plan.mode === "verified" && plan.create) {
    const want = fullName(plan.create);
    const named = usable.filter((h) => fullName(h) === want);
    if (named.length === 1) return named[0];
  }
  const added = (c: GhlContact) => {
    const t = Date.parse(String(c.dateAdded ?? ""));
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return usable.reduce((best, c) => (added(c) < added(best) ? c : best));
}

/** Pure: the fill-only PUT body. Only firstName, lastName and email, only where GHL holds nothing
 *  and we have a value; never tags, phone or do-not-contact settings. kept: fields both sides hold
 *  with different values (a human's edit, left alone), for the log by name only. */
export function fillMissing(
  contact: GhlContact,
  desired: { firstName: string; lastName: string; email: string | null },
): {
  patch: Partial<Record<"firstName" | "lastName" | "email", string>>;
  kept: string[];
} {
  const patch: Partial<Record<"firstName" | "lastName" | "email", string>> = {};
  const kept: string[] = [];
  for (const field of ["firstName", "lastName", "email"] as const) {
    const want = str(desired[field]);
    const have = str(contact[field]);
    if (!want) continue;
    if (!have) patch[field] = want;
    else if (have.toLowerCase() !== want.toLowerCase()) kept.push(field);
  }
  return { patch, kept };
}

/** Do-not-contact: dnd set, or any channel's dndSettings status other than "inactive". Only the
 *  oi-lead-new tag (the one a workflow could start outreach from) waits on it. */
export function contactBlocked(contact: unknown): boolean {
  if (!isObj(contact)) return false;
  if (contact.dnd === true) return true;
  if (!isObj(contact.dndSettings)) return false;
  return Object.values(contact.dndSettings).some((v) => !(isObj(v) && v.status === "inactive"));
}

// ---------------------------------------------------------------------------------------------
// What is written.
// ---------------------------------------------------------------------------------------------
const isPhone = (facts: GhlFacts) => PHONE_CHANNELS.has(facts.interaction.channel ?? facts.session?.channel ?? "");
const representative = (facts: GhlFacts) => facts.escalations.find((e) => e.kind === "representative") ?? null;
const emergency = (facts: GhlFacts) => facts.escalations.find((e) => e.kind === "emergency") ?? null;
// A claim taken on this call, for a contact that is the caller's own (verified or lead).
const filedIntake = (facts: GhlFacts, plan: CallerPlan) =>
  facts.intake?.confirmed === true && (plan.mode === "verified" || plan.mode === "lead") ? facts.intake : null;

/** Pure: the tags for this call's contact. created: the adapter created the contact; blocked: it is
 *  do-not-contact. Every tag is one of GHL_TAGS. */
export function tagsFor(facts: GhlFacts, plan: CallerPlan, state: { created: boolean; blocked: boolean }): GhlTag[] {
  const tags: string[] = ["oi-voice", isPhone(facts) ? "oi-channel-phone" : "oi-channel-web"];
  const callerType = facts.interaction.caller_type;
  if (callerType === "existing") tags.push("oi-caller-existing");
  else if (callerType === "new") tags.push("oi-caller-new");
  if (plan.status === "verified") tags.push("oi-verified");
  else if (plan.status === "unverified") tags.push("oi-unverified");
  else if (plan.status === "locked") tags.push("oi-verify-locked");
  if (plan.mode === "lead") {
    if (!state.created) tags.push("oi-phone-matched");
    else if (!state.blocked) tags.push("oi-lead-new");
  }
  const outcome = facts.interaction.outcome;
  if (outcome && (OUTCOMES as readonly string[]).includes(outcome)) tags.push(`oi-outcome-${outcome}`);
  const reason = facts.interaction.call_reason;
  if (reason && (CALL_REASONS as readonly string[]).includes(reason)) tags.push(`oi-reason-${reason}`);
  if (representative(facts)) tags.push("oi-callback");
  if (emergency(facts)) tags.push("oi-emergency");
  const intake = filedIntake(facts, plan);
  if (intake?.kind === "claim" && plan.mode === "verified") tags.push("oi-claim-filed");
  if (intake?.kind === "lead_intake" && plan.mode === "lead") tags.push("oi-claim-intake");
  const known: ReadonlySet<string> = new Set(GHL_TAGS);
  return [...new Set(tags)].filter((t): t is GhlTag => known.has(t));
}

const REASON_LABELS: Readonly<Record<EscalationReason, string>> = {
  representative_requested: "representative requested",
  emergency: "possible emergency",
  auth_locked: "identity not verified",
  not_found: "no account found",
  unsupported_question: "question the assistant could not answer",
  transfer_failed: "phone transfer failed",
};

function reasonLabel(reason: unknown): string {
  return typeof reason === "string" && reason in REASON_LABELS
    ? REASON_LABELS[reason as EscalationReason]
    : "callback requested";
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "Oct 12, 2026, 11:04 AM ET", from formatToParts so no locale spacing character leaks in. */
function easternTime(iso: string | null): string | null {
  const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const p: Record<string, string> = {};
  for (const part of eastern.formatToParts(new Date(t))) p[part.type] = part.value;
  return `${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toUpperCase()} ET`;
}

function channelLabel(channel: string | null): string {
  if (channel === "inboundPhoneCall" || channel === "outboundPhoneCall") return "phone";
  if (channel === "webCall") return "web";
  if (channel === "chat") return "chat";
  return "unknown channel";
}

/** A lead keyed on its caller id: the number the caller confirmed instead (one noted as said, never a key),
 *  or null. */
function leadNumber(facts: GhlFacts, plan: CallerPlan): string | null {
  const phone = facts.contact?.confirmed === true ? facts.contact.callback_phone : null;
  return plan.mode === "lead" && phone && phone !== plan.key ? phone : null;
}

/** "Callback number ending 0123", with "(as said, no country code)" after a number noted as said, so the
 *  team knows to work out where to dial it. null without four digits. */
function callbackLine(phone: string | null | undefined): string | null {
  if (!phone || lastFour(phone).length !== 4) return null;
  return `Callback number ending ${lastFour(phone)}${e164(phone) ? "" : " (as said, no country code)"}`;
}

function callerLine(plan: CallerPlan, level: string, keyedOnCallerId: boolean): string {
  if (plan.mode === "verified") return "Caller: existing customer, identity verified on the call";
  if (plan.mode === "lead") {
    return keyedOnCallerId
      ? "Caller: new caller, name confirmed on the call; contact keyed on the caller ID"
      : "Caller: new caller, name and number confirmed on the call";
  }
  if (plan.status === "locked") return "Caller: matched by caller ID only; identity verification failed (locked)";
  return level === "phone_found"
    ? "Caller: matched by caller ID only; an account was found but identity was not verified"
    : "Caller: matched by caller ID only; identity not verified";
}

function claimLines(intake: ClaimIntake): string[] {
  const loss = writtenDate(intake.loss_date) ?? intake.loss_date;
  const head = intake.kind === "claim"
    ? `Claim filed by phone: ${intake.claim_type}, loss on ${loss}${
      intake.claim_number ? `, claim number ${intake.claim_number}` : ""
    }`
    : `Claim details taken for a specialist to set up: ${intake.claim_type}, loss on ${loss}`;
  return [head, `What happened (caller's words, redacted): ${cap(redactPII(intake.description), MAX_DESCRIPTION)}`];
}

/** Pure: the note body. Server facts, the redacted summary for a caller whose contact this is, the
 *  claim taken on the call, the escalation, the callback number's last four digits, the captured
 *  email masked, the dashboard link and a marker line. Never a transcript, a date of birth, a full
 *  phone number, a recording, or any name (an unverified or locked call's summary is left out
 *  whole, since it may carry the name the caller gave or the account holder's). */
export function renderNote(facts: GhlFacts, plan: CallerPlan, dashboardUrl?: string): string {
  const i = facts.interaction;
  const header = ["Observe voice agent"];
  const when = easternTime(i.started_at ?? i.ended_at ?? i.created_at);
  if (when) header.push(when);
  header.push(channelLabel(i.channel ?? facts.session?.channel ?? null));
  header.push(`outcome ${i.outcome && (OUTCOMES as readonly string[]).includes(i.outcome) ? i.outcome : "unknown"}`);
  if (i.call_reason && (CALL_REASONS as readonly string[]).includes(i.call_reason)) {
    header.push(`reason ${i.call_reason}`);
  }
  const contact = facts.contact?.confirmed === true ? facts.contact : null;
  const keyedOnCallerId = plan.mode === "lead" && contact?.callback_phone !== plan.key;
  const lines = [header.join(" · "), callerLine(plan, facts.session?.level ?? "none", keyedOnCallerId)];
  const own = plan.mode === "verified" || plan.mode === "lead";
  const summary = own && i.summary ? redactPII(i.summary).replace(/\s+/g, " ").trim() : "";
  if (summary) lines.push(`Summary: ${cap(summary, MAX_SUMMARY)}`);
  const intake = filedIntake(facts, plan);
  if (intake) lines.push(...claimLines(intake));
  const rep = representative(facts);
  if (rep) lines.push(`Callback requested: ${reasonLabel(rep.reason)}`);
  if (emergency(facts)) lines.push("Emergency reported on the call");
  // The escalation's number; else, for a lead keyed on its caller id, the number the caller confirmed.
  const callback = callbackLine(
    [rep, emergency(facts)].find((e) => e?.callback_phone)?.callback_phone ?? leadNumber(facts, plan),
  );
  if (callback) lines.push(callback);
  if (own && contact?.email) {
    lines.push(
      contact.kind === "new_customer"
        ? `Email (caller-provided, confirmed on the call): ${maskEmail(contact.email)}`
        : `Email update requested (caller-provided, not verified): ${maskEmail(contact.email)}`,
    );
  }
  const link = dashboardLink(dashboardUrl, i.vapi_call_id);
  if (link) lines.push(`Dashboard: ${link}`);
  lines.push(`ref oi/interaction.completed/${i.vapi_call_id}`);
  return lines.join("\n");
}

export interface GhlTask {
  title: string;
  body: string;
  dueDate: string;
  completed: false; // GHL requires the field
  assignedTo?: string; // a GHL user; never the contact itself
}

export const TASK_KINDS = ["callback", "emergency", "claim"] as const;
export type TaskKind = typeof TASK_KINDS[number];

const HOUR_MS = 60 * 60 * 1000;

function tzOffsetMs(at: number, tz: string): number {
  const parts: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (const p of fmt.formatToParts(new Date(at))) parts[p.type] = p.value;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/** The next weekday (Monday to Friday) after `from`'s date in `tz`, at `hour`:00 local time, so a
 *  Friday or a Saturday is due Monday. The offset is read through Intl at the target instant, so a
 *  DST change in between moves the UTC time, not the local one. No holiday calendar. */
export function nextBusinessDayDue(from: Date, tz = TIMEZONE, hour = 10): Date {
  const parts: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const p of fmt.formatToParts(from)) parts[p.type] = p.value;
  // Calendar arithmetic on a UTC date carrying the local day; only the day of the week is read here.
  const day = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour);
  let at = wall - tzOffsetMs(wall, tz);
  at = wall - tzOffsetMs(at, tz); // the offset at the target instant itself
  return new Date(at);
}

/** Pure: the follow-up tasks this call asks for. callback: a representative escalation, due an hour
 *  after it; emergency: due now, for the emergency user; claim: a claim taken on the call, due the
 *  next business day at 10:00 Eastern. */
export function tasksFor(
  facts: GhlFacts,
  plan: CallerPlan,
  env: Pick<Env, "GHL_ASSIGNEE_USER_ID" | "GHL_EMERGENCY_USER_ID" | "DASHBOARD_URL">,
  now: Date,
): Partial<Record<TaskKind, GhlTask>> {
  const callKey = facts.interaction.vapi_call_id;
  const link = dashboardLink(env.DASHBOARD_URL, callKey);
  const tail = [...(link ? [`Dashboard: ${link}`] : []), `ref oi/interaction.completed/${callKey}`];
  const assignee = str(env.GHL_ASSIGNEE_USER_ID);
  const assigned = (user: string | null) => (user ? { assignedTo: user } : {});
  const out: Partial<Record<TaskKind, GhlTask>> = {};

  const rep = representative(facts);
  if (rep) {
    const created = Date.parse(rep.created_at);
    const line = callbackLine(rep.callback_phone);
    const number = line ? [line] : [];
    out.callback = {
      title: `Call back: ${reasonLabel(rep.reason)}`,
      body: [
        `The caller asked for a callback on a voice call (${reasonLabel(rep.reason)}).`,
        ...number,
        ...tail,
      ].join("\n"),
      dueDate: new Date((Number.isFinite(created) ? created : now.getTime()) + HOUR_MS).toISOString(),
      completed: false,
      ...assigned(assignee),
    };
  }
  if (emergency(facts)) {
    out.emergency = {
      title: "URGENT: emergency reported on call",
      body: [
        "An emergency was reported on a voice call. Check the call and the alert on the dashboard.",
        ...tail,
      ].join("\n"),
      dueDate: now.toISOString(),
      completed: false,
      ...assigned(str(env.GHL_EMERGENCY_USER_ID) ?? assignee),
    };
  }
  const intake = filedIntake(facts, plan);
  if (intake) {
    const loss = writtenDate(intake.loss_date) ?? intake.loss_date;
    const number = intake.kind === "claim" && intake.claim_number ? ` (${intake.claim_number})` : "";
    const filed = Date.parse(intake.confirmed_at ?? "");
    // A lead keyed on its caller id: the number the caller confirmed for the call back, by its last four.
    const callback = callbackLine(leadNumber(facts, plan));
    out.claim = {
      title: `New claim: ${intake.claim_type} loss on ${loss}${number}`,
      body: [
        intake.kind === "claim"
          ? "Filed by phone by a verified customer. Assign an adjuster."
          : "A new caller reported a loss. Call them back to set up the claim.",
        ...(callback ? [callback] : []),
        ...tail,
      ].join("\n"),
      dueDate: nextBusinessDayDue(new Date(Number.isFinite(filed) ? filed : now.getTime())).toISOString(),
      completed: false,
      ...assigned(assignee),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Delivery.
// ---------------------------------------------------------------------------------------------
// delivered: every step done (or nothing to do: a skip); externalId is the contact id. retry: a
// rate limit, an outage or a timeout, not before retryAfterS. dead: a request GHL refused for its
// own content. config: the token or its scopes (the destination pauses; the attempt is given back).
// paused: the run's deadline came between steps (the attempt is given back; the next run resumes).
// superseded: a re-arm or a re-claim took the row mid-delivery; what was done is recorded.
export type GhlDelivery =
  | { outcome: "delivered"; externalId: string | null }
  | { outcome: "retry"; error: string; retryAfterS: number }
  | { outcome: "dead"; error: string }
  | { outcome: "config"; error: string }
  | { outcome: "paused"; error: string }
  | { outcome: "superseded" };

/** Seconds before a transient failure is tried again: 60, 120, 240, 480 for attempts 1 to 4 (the
 *  fifth failure is the last), so a GHL outage of a quarter of an hour still delivers. */
export function ghlBackoffS(attempt: number): number {
  return 60 * 2 ** Math.min(Math.max(attempt, 1) - 1, 4);
}

const PAUSED: GhlDelivery = { outcome: "paused", error: "paused at the run deadline; the next run resumes" };
const SUPERSEDED: GhlDelivery = { outcome: "superseded" };
// A skip, or a caller-id search with no match: the event is done and no contact was touched.
const DELIVERED_NOTHING: GhlDelivery = { outcome: "delivered", externalId: null };

function safeLog(deps: Deps, event: Record<string, unknown>): void {
  try {
    deps.log(event);
  } catch {
    // a logging fault must never change what is delivered
  }
}

/** One delivery attempt of a claimed ghl row, step by step until `deadline` (epoch ms on deps.now).
 *  claimedAt is the row's write time after the last progress save: the guard for finishOutbox.
 *  Throws only when the store does (the outbox counts an error; the row keeps its spent attempt). */
export async function deliverGhl(deps: Deps, row: OutboxRow, deadline: number): Promise<
  { result: GhlDelivery; claimedAt: string }
> {
  let claimedAt = row.updated_at;
  const progress: Obj = { ...(isObj(row.progress) ? row.progress : {}) };
  const callKey = row.ref_id;
  const done = (result: GhlDelivery) => ({ result, claimedAt });

  // The merge always lands (it records what GHL already holds); false means the claim is gone.
  async function save(patch: Obj): Promise<boolean> {
    const saved = await deps.store.saveOutboxProgress(row.id, patch, { attempt: row.attempts, claimedAt });
    Object.assign(progress, patch);
    if (!saved) return false;
    claimedAt = saved.savedAt;
    return saved.held;
  }
  // write: a request GHL cannot take back (a create, a note, a task), sent only with its full timeout
  // left; the others (a search, a GET, the additive tags, the fill-only PUT) are safe to repeat.
  async function call(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: Obj,
    write = false,
  ): Promise<GhlResult | "paused"> {
    const left = deadline - deps.now().getTime();
    if (left < (write ? GHL_TIMEOUT_MS : MIN_REQUEST_MS)) return "paused";
    return await ghlRequest(deps, method, path, body, write ? GHL_TIMEOUT_MS : Math.min(GHL_TIMEOUT_MS, left));
  }
  const failure = (res: Extract<GhlResult, { ok: false }>): GhlDelivery => {
    if (res.kind === "config") return { outcome: "config", error: res.error };
    if (res.kind === "rate_limited") {
      return { outcome: "retry", error: res.error, retryAfterS: res.retryAfterS ?? RATE_LIMIT_DEFAULT_S };
    }
    if (res.retryable) return { outcome: "retry", error: res.error, retryAfterS: ghlBackoffS(row.attempts) };
    return { outcome: "dead", error: res.error };
  };

  if (row.kind !== "interaction.completed") return done({ outcome: "dead", error: "unsupported event" });
  if (progress.done === true) return done({ outcome: "delivered", externalId: str(progress.contact_id) });
  const loaded = await loadGhlFacts(deps.store, callKey);
  if (!loaded) return done({ outcome: "dead", error: "record missing" });
  const facts: GhlFacts = loaded;
  const plan = planCaller(facts, ownNumbers(deps.env));

  if (plan.mode === "skip") {
    safeLog(deps, { event: "ghl_skipped", call_key: callKey, reason: plan.reason });
    return done(await save({ mode: "skip", skipped: plan.reason, done: true }) ? DELIVERED_NOTHING : SUPERSEDED);
  }

  type Search = { ok: true; contacts: unknown[] } | Extract<GhlResult, { ok: false }> | "paused";
  async function search(key: string): Promise<Search> {
    const res = await call("POST", "/contacts/search", {
      filters: [{ field: "phone", operator: "eq", value: key }],
      page: 1,
      pageLimit: SEARCH_PAGE_LIMIT,
    });
    if (res === "paused" || !res.ok) return res;
    return { ok: true, contacts: Array.isArray(res.data.contacts) ? res.data.contacts : [] };
  }

  // Fill-only, best effort: a failure is logged and the event goes on (the token refusing is the
  // exception, as every later step would meet it too).
  async function enrich(hit: GhlContact): Promise<GhlDelivery | null> {
    if (!plan.create) return null;
    const { patch, kept } = fillMissing(hit, plan.create);
    const fields = Object.keys(patch);
    if (kept.length > 0) safeLog(deps, { event: "ghl_enrich_kept", call_key: callKey, fields: kept });
    if (fields.length > 0) {
      const res = await call("PUT", `/contacts/${encodeURIComponent(hit.id)}`, patch);
      if (res === "paused") return null;
      if (!res.ok) {
        if (res.kind === "config") return failure(res);
        safeLog(deps, { event: "ghl_enrich_failed", call_key: callKey, error: res.error });
        return await save({ enriched: false }) ? null : SUPERSEDED;
      }
    }
    return await save({ enriched: fields }) ? null : SUPERSEDED;
  }

  // A lead on a number the caller said that GHL already holds: someone GHL knows, maybe a stranger.
  // Nothing is written to them; the event is done.
  async function notCallers(): Promise<GhlDelivery> {
    safeLog(deps, { event: "ghl_skipped", call_key: callKey, reason: "lead_number_not_caller_id" });
    return await save({ mode: plan.mode, skipped: "lead_number_not_caller_id", done: true })
      ? DELIVERED_NOTHING
      : SUPERSEDED;
  }

  // Search first; a hit is used (and, for a verified caller, filled where empty); a miss is created
  // when the plan allows it and skipped otherwise. null: the contact id is in progress.
  async function resolve(): Promise<GhlDelivery | null> {
    const key = plan.key!;
    const found = await search(key);
    if (found === "paused") return PAUSED;
    if (!found.ok) return failure(found);
    const hit = pickContact(found.contacts, plan);
    if (hit && plan.createOnly) return await notCallers();
    if (hit) {
      safeLog(deps, { event: "ghl_contact", call_key: callKey, mode: plan.mode, matches: found.contacts.length });
      if (!(await save({ mode: plan.mode, contact_id: hit.id, contact_created: false, dnd: contactBlocked(hit) }))) {
        return SUPERSEDED;
      }
      return plan.enrich ? await enrich(hit) : null;
    }
    if (!plan.create) {
      safeLog(deps, { event: "ghl_skipped", call_key: callKey, reason: "no_matching_contact" });
      return await save({ mode: plan.mode, skipped: "no_matching_contact", done: true })
        ? DELIVERED_NOTHING
        : SUPERSEDED;
    }
    const body: Obj = {
      firstName: plan.create.firstName,
      lastName: plan.create.lastName,
      phone: key,
      source: GHL_SOURCE,
      ...(plan.create.email ? { email: plan.create.email } : {}),
    };
    let res = await call("POST", "/contacts/", body, true);
    if (res === "paused") return PAUSED;
    if (
      !res.ok && res.kind === "duplicate" && body.email && res.meta?.matchingField && res.meta.matchingField !== "phone"
    ) {
      // The address is another contact's: create on the number alone; a contact is never adopted by email.
      delete body.email;
      safeLog(deps, { event: "ghl_email_conflict", call_key: callKey });
      res = await call("POST", "/contacts/", body, true);
      if (res === "paused") return PAUSED;
    }
    if (!res.ok && res.kind === "duplicate") {
      // The number exists after all (a race, or the search index behind a write): adopt that contact,
      // unless it is one only the caller's word ties to them.
      if (plan.createOnly) return await notCallers();
      let id = res.meta?.contactId ?? null;
      if (!id) {
        const again = await search(key);
        if (again === "paused") return PAUSED;
        if (!again.ok) return failure(again);
        id = pickContact(again.contacts, plan)?.id ?? null;
      }
      if (!id) return { outcome: "retry", error: res.error, retryAfterS: ghlBackoffS(row.attempts) };
      safeLog(deps, { event: "ghl_contact", call_key: callKey, mode: plan.mode, adopted: true });
      if (!plan.enrich) {
        return await save({ mode: plan.mode, contact_id: id, contact_created: false, dnd: null }) ? null : SUPERSEDED;
      }
      // A verified caller's adopted contact is filled where empty, as a search hit is: read it first.
      const read = await call("GET", `/contacts/${encodeURIComponent(id)}`);
      if (read === "paused") return PAUSED;
      if (!read.ok && read.kind !== "not_found") return failure(read);
      const body = read.ok ? (isObj(read.data.contact) ? read.data.contact : read.data) : null;
      // Only the contact itself is filled from: an answer of another shape would read as all empty.
      const adopted = body && str(body.id) === id ? body as GhlContact : null;
      if (!(await save({ mode: plan.mode, contact_id: id, contact_created: false, dnd: contactBlocked(adopted) }))) {
        return SUPERSEDED;
      }
      return adopted ? await enrich(adopted) : null;
    }
    if (!res.ok) return failure(res);
    const created = isObj(res.data.contact) ? res.data.contact : res.data;
    const id = str(created.id);
    if (!id) return { outcome: "retry", error: "ghl POST /contacts/: no contact id in the response", retryAfterS: 60 };
    safeLog(deps, { event: "ghl_contact", call_key: callKey, mode: plan.mode, created: true });
    return await save({ mode: plan.mode, contact_id: id, contact_created: true, dnd: contactBlocked(created) })
      ? null
      : SUPERSEDED;
  }

  // One write on the resolved contact. A contact GHL no longer knows (merged or deleted) clears the
  // stored id, and the tags that went to it, and is resolved again, once per delivery; the contact
  // found (or created) then gets its tags before the pending write. A second miss waits for the next
  // attempt.
  let reResolved = false;
  async function onContact(write: (id: string) => Promise<GhlResult | "paused">, isTags = false): Promise<
    { data: Obj } | { stop: GhlDelivery }
  > {
    for (let turn = 0; turn < 3; turn++) {
      const id = str(progress.contact_id);
      if (!id) {
        const stop = (await resolve()) ?? (isTags ? null : await tagStep());
        if (stop) return { stop };
        continue;
      }
      const res = await write(id);
      if (res === "paused") return { stop: PAUSED };
      if (res.ok) return { data: res.data };
      if (res.kind !== "not_found") return { stop: failure(res) };
      safeLog(deps, { event: "ghl_contact_gone", call_key: callKey, again: reResolved });
      if (!(await save({ contact_id: null, contact_created: null, tags_done: false }))) return { stop: SUPERSEDED };
      if (reResolved) return { stop: { outcome: "retry", error: res.error, retryAfterS: ghlBackoffS(row.attempts) } };
      reResolved = true;
    }
    return { stop: { outcome: "retry", error: "ghl contact could not be resolved", retryAfterS: 60 } };
  }

  // The additive tags, once per contact (computed when sent: a created contact gets oi-lead-new).
  async function tagStep(): Promise<GhlDelivery | null> {
    if (progress.tags_done === true) return null;
    const tags = tagsFor(facts, plan, { created: progress.contact_created === true, blocked: progress.dnd === true });
    const r = await onContact((id) => call("POST", `/contacts/${encodeURIComponent(id)}/tags`, { tags }), true);
    if ("stop" in r) return r.stop;
    return await save({ tags_done: true, tags }) ? null : SUPERSEDED;
  }

  if (!str(progress.contact_id)) {
    const stop = await resolve();
    if (stop) return done(stop);
  }

  const tagged = await tagStep();
  if (tagged) return done(tagged);

  if (!str(progress.note_id)) {
    const body = renderNote(facts, plan, deps.env.DASHBOARD_URL);
    const r = await onContact((id) => call("POST", `/contacts/${encodeURIComponent(id)}/notes`, { body }, true));
    if ("stop" in r) return done(r.stop);
    // A 2xx without an id still made the note; recording it keeps a retry from making another.
    const noteId = str(isObj(r.data.note) ? r.data.note.id : r.data.id) ?? "unknown";
    if (!(await save({ note_id: noteId }))) return done(SUPERSEDED);
  }

  const tasks = tasksFor(facts, plan, deps.env, deps.now());
  for (const kind of TASK_KINDS) {
    const task = tasks[kind];
    const key = `task_${kind}_id`;
    if (!task || str(progress[key])) continue;
    const r = await onContact((id) => call("POST", `/contacts/${encodeURIComponent(id)}/tasks`, { ...task }, true));
    if ("stop" in r) return done(r.stop);
    const taskId = str(isObj(r.data.task) ? r.data.task.id : r.data.id) ?? "unknown";
    if (!(await save({ [key]: taskId }))) return done(SUPERSEDED);
  }

  if (!(await save({ done: true }))) return done(SUPERSEDED);
  return done({ outcome: "delivered", externalId: str(progress.contact_id) });
}
