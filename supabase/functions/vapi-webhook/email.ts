// Resend client and the plain-HTML email templates. The client is honest: ok only when Resend
// returned a message id, because "sent" is spoken only after that. Each send carries an
// Idempotency-Key (call_key:kind), so a retried request can never deliver twice. Templates are
// rendered from DB facts and already-redacted text, never from model words; every value is
// HTML-escaped and the output is pure ASCII (anything else becomes a numeric character reference).

import { dashboardLink, shortCallId } from "./alert.ts";
import { CLAIM_TYPES, type ClaimIntakeKind, ESCALATION_REASONS, MAIN_LINE_SPOKEN } from "./enums.ts";
import { phoneGroups } from "./identity.ts";
import { redactPII } from "./redact.ts";
import type { CallerContact, Claim, Customer, Deps, Session, Store } from "./types.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  idempotencyKey: string;
}

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "onboarding@resend.dev";
// Resend refuses longer keys; ours are call_key:kind, far below this.
const MAX_IDEMPOTENCY_KEY = 256;
const MAX_ERROR = 300;
const ADDRESS_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]+$/;
const ADDRESS_IN_TEXT_RE = /[^\s@,;<>()"'\[\]]+@[^\s@,;<>()"'\[\]]+/g;

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException ? e.name === "TimeoutError" || e.name === "AbortError" : false;
}

// Resend's error messages can quote the recipient ("You can only send testing emails to your own
// email address (...)"); the emails ledger stores masked addresses only, so its error column must too.
function cleanError(message: string): string {
  return message.replace(ADDRESS_IN_TEXT_RE, (m) => maskEmail(m)).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);
}

/** POST https://api.resend.com/emails (Bearer RESEND_API_KEY, Idempotency-Key header), from RESEND_FROM_EMAIL.
 *  AbortSignal.timeout(timeoutMs). Never throws: {ok:true,id} | {ok:false,status?,error}. */
export async function sendEmail(
  deps: Deps,
  msg: EmailMessage,
  timeoutMs = 2500,
): Promise<{ ok: true; id: string } | { ok: false; status?: number; error: string }> {
  try {
    const apiKey = deps.env.RESEND_API_KEY?.trim() ?? "";
    if (!apiKey) return { ok: false, error: "resend not configured" };
    const to = typeof msg?.to === "string" ? msg.to.trim() : "";
    if (!ADDRESS_RE.test(to)) return { ok: false, error: "invalid recipient" };
    const key = typeof msg.idempotencyKey === "string" ? msg.idempotencyKey : "";
    // Without a key a retry could deliver twice; refuse rather than send unguarded.
    if (!key || key.length > MAX_IDEMPOTENCY_KEY || !/^[\x21-\x7e]+$/.test(key)) {
      return { ok: false, error: "invalid idempotency key" };
    }
    const from = deps.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM;
    const res = await deps.fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ from, to: [to], subject: String(msg.subject ?? ""), html: String(msg.html ?? "") }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: { id?: unknown; message?: unknown } | null = null;
    try {
      body = await res.json();
    } catch (e) {
      if (isTimeout(e)) return { ok: false, error: "timeout" };
      body = null;
    }
    if (res.ok) {
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      return id ? { ok: true, id } : { ok: false, status: res.status, error: `resend ${res.status}: missing id` };
    }
    const message = typeof body?.message === "string" && body.message.trim() ? body.message : res.statusText || "error";
    return { ok: false, status: res.status, error: `resend ${res.status}: ${cleanError(message)}` };
  } catch (e) {
    if (isTimeout(e)) return { ok: false, error: "timeout" };
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: `resend request failed: ${cleanError(detail)}` };
  }
}

/** "owner@example.com" -> "o***@example.com". */
export function maskEmail(address: string): string {
  const s = typeof address === "string" ? address.trim() : "";
  const at = s.lastIndexOf("@");
  if (at < 0) return "***";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return `${local ? local[0] : ""}***@${domain}`;
}

// ---------------------------------------------------------------------------------------------
// Text helpers.
// ---------------------------------------------------------------------------------------------
const MONTHS = "January February March April May June July August September October November December".split(" ");
const OFFICE_HOURS = "Monday to Friday, 8 AM to 6 PM Eastern";
const CLAIMS_URL = "observeinsurance.com/claims";
const DOCS_EMAIL = "claimsdocs@observeinsurance.com";
const MAILING_ADDRESS = "Observe Insurance Claims Department, 100 Market Street, Suite 400, San Francisco, CA 94105";
const APPEAL_DAYS = 30;

/** HTML-escape and force ASCII: non-ASCII characters become numeric references, control characters are dropped. */
export function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&#39;";
    else if (ch === "\n" || ch === "\t") out += ch;
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) continue;
    else if (cp > 0x7e) out += `&#${cp};`;
    else out += ch;
  }
  return out;
}

/** Escaped text with line breaks kept. */
function textBlock(value: string): string {
  return escapeHtml(value.trim()).replace(/\r?\n/g, "<br>");
}

/** Subject lines are headers, not HTML: fold accents away and drop anything still outside ASCII. */
function asciiLine(value: unknown, max = 120): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim()
    .slice(0, max);
}

/** "2026-10-24" -> "October 24, 2026", read by hand so no server timezone can move the day. */
export function writtenDate(iso: string | null | undefined): string | null {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim()) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** 4820 -> "$4,820.00"; null when the amount is missing or not a finite non-negative number. */
function money(amount: unknown): string | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  const [whole, cents] = n.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Ends a fragment with a full stop unless it already has terminal punctuation. */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function claimTypeWord(type: unknown): string {
  return typeof type === "string" && (CLAIM_TYPES as readonly string[]).includes(type) ? type : "insurance";
}

function claimNumber(c: Claim): string {
  return typeof c.claim_number === "string" && c.claim_number.trim() ? c.claim_number.trim() : "on file";
}

function documentsOf(c: Claim): string[] {
  return (Array.isArray(c.documents_required) ? c.documents_required : [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => d.trim());
}

/** A stored callback number as the team reads it, every digit kept: "+16025550101" -> "(602) 555-0101
 *  (+16025550101)"; "+442079460958" -> "+44 207 946 0958 (international)"; a number noted as the caller
 *  said it, with no country code, "9601550123" -> "960 155 0123 (as said, no country code)". Anything
 *  else is shown as stored. */
export function writtenPhone(stored: string): string {
  const s = stored.trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]} (${s})`;
  const g = /^\+?\d+$/.test(s) ? phoneGroups(s) : null;
  if (!g) return s;
  return g.kind === "international"
    ? `+${g.countryCode} ${g.groups.join(" ")} (international)`
    : `${g.groups.join(" ")} (as said, no country code)`;
}

const REASON_LABELS: Record<string, string> = {
  representative_requested: "Caller asked for a representative",
  emergency: "Possible emergency",
  auth_locked: "Identity could not be verified; caller is locked out",
  not_found: "No account found for the number given",
  unsupported_question: "Question the assistant cannot answer",
  transfer_failed: "Phone transfer failed",
};

function reasonText(reason: string): string {
  const r = typeof reason === "string" ? reason.trim() : "";
  if ((ESCALATION_REASONS as readonly string[]).includes(r)) return `${REASON_LABELS[r]} (${r})`;
  return r ? r : "Not given";
}

// ---------------------------------------------------------------------------------------------
// Layout.
// ---------------------------------------------------------------------------------------------
const STYLE_BODY =
  "margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5";
const STYLE_H1 = "font-size:20px;margin:0 0 16px";
const STYLE_H2 = "font-size:16px;margin:24px 0 8px";
const STYLE_TH = "text-align:left;vertical-align:top;padding:4px 16px 4px 0;color:#555555;font-weight:normal";
const STYLE_TD = "vertical-align:top;padding:4px 0";
const STYLE_WARN = "color:#b00020;font-weight:bold";
const STYLE_FOOT = "margin-top:32px;color:#666666;font-size:13px";

function page(title: string, content: string[], footer: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`,
    `<body style="${STYLE_BODY}">`,
    '<div style="max-width:600px">',
    `<h1 style="${STYLE_H1}">${escapeHtml(title)}</h1>`,
    ...content,
    `<p style="${STYLE_FOOT}">${footer}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

const para = (html: string) => `<p>${html}</p>`;
const h2 = (text: string) => `<h2 style="${STYLE_H2}">${escapeHtml(text)}</h2>`;
const list = (tag: "ul" | "ol", items: string[]) => `<${tag}>${items.map((i) => `<li>${i}</li>`).join("")}</${tag}>`;

function table(rows: [string, string][]): string {
  const body = rows.map(([k, v]) =>
    `<tr><th style="${STYLE_TH}">${escapeHtml(k)}</th><td style="${STYLE_TD}">${v}</td></tr>`
  );
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">${body.join("")}</table>`;
}

function greeting(customer: { first_name?: string | null }): string {
  const name = typeof customer?.first_name === "string" ? customer.first_name.trim() : "";
  return para(name ? `Hello ${escapeHtml(name)},` : "Hello,");
}

const CUSTOMER_FOOTER = escapeHtml(
  `Questions? Call us at ${MAIN_LINE_SPOKEN}, ${OFFICE_HOURS}. ${MAILING_ADDRESS}. ` +
    "You are receiving this email because you asked for it on a call with Observe Insurance.",
);
const TEAM_FOOTER = escapeHtml(
  "Sent by the Observe Insurance claims assistant. Details are redacted; the full record is on the dashboard (staff sign-in required).",
);

function linkLine(link: string | null): string {
  return link
    ? para(`<a href="${escapeHtml(link)}">Open this call on the dashboard</a><br>${escapeHtml(link)}`)
    : para("Dashboard link not configured.");
}

// ---------------------------------------------------------------------------------------------
// Shared customer-facing blocks.
// ---------------------------------------------------------------------------------------------
function howToSendBlock(claimNumbers: string[]): string[] {
  const ref = claimNumbers.length === 1
    ? `your claim number, ${claimNumbers[0]},`
    : claimNumbers.length > 1
    ? `the claim number (${claimNumbers.join(" or ")})`
    : "your claim number";
  return [
    h2("How to send your documents"),
    list("ol", [
      escapeHtml(`Upload them at ${CLAIMS_URL}`),
      escapeHtml(`Email them to ${DOCS_EMAIL}`),
      escapeHtml(`Mail them to ${MAILING_ADDRESS}`),
    ]),
    para(
      escapeHtml(
        `Whichever way you choose, please include ${ref} with everything you send so we can match it to the right claim.`,
      ),
    ),
  ];
}

function documentsBlock(c: Claim): string[] {
  const docs = documentsOf(c);
  const due = writtenDate(c.documents_due);
  const out: string[] = [];
  if (docs.length > 0) {
    out.push(para("Review can continue once we receive:"), list("ul", docs.map((d) => escapeHtml(sentenceCase(d)))));
  } else {
    out.push(
      para(
        escapeHtml(
          `We do not have the document list on file yet. Please call ${MAIN_LINE_SPOKEN} and we will tell you what we need.`,
        ),
      ),
    );
  }
  if (due) out.push(para(`<strong>${escapeHtml(`Please send them by ${due}.`)}</strong>`));
  return out;
}

function claimHeading(c: Claim): string {
  return h2(`${sentenceCase(claimTypeWord(c.claim_type))} claim ${claimNumber(c)}`);
}

// ---------------------------------------------------------------------------------------------
// Who called, for the team emails. The claims team calls these people back, so the emails carry the
// name, the full callback number and any address the caller spelled; the Telegram card does not
// (alert.ts keeps it ids and enums only).
// ---------------------------------------------------------------------------------------------
export const UNKNOWN_CALLER_NAME = "Unknown caller";
export const CALLER_EMAIL_LABEL = "Email (caller-provided, unverified)";

/** The caller as the team emails show them. name: the verified account holder's full name
 *  (source "account"), else the name the caller gave and confirmed (source "caller"), else null.
 *  email: the address the caller spelled and confirmed on this call; never the one on the account. */
export interface TeamCaller {
  name: string | null;
  nameSource: "account" | "caller" | null;
  email: string | null;
}

export const UNKNOWN_TEAM_CALLER: TeamCaller = { name: null, nameSource: null, email: null };

/** Pure: the verified customer (only for a verified session) and the call's caller_contacts row. An
 *  unconfirmed capture contributes nothing: what the caller said "no" to is not passed on. */
export function teamCallerOf(
  verified: Pick<Customer, "first_name" | "last_name"> | null,
  contact: CallerContact | null,
): TeamCaller {
  const confirmed = contact?.confirmed === true ? contact : null;
  const email = typeof confirmed?.email === "string" && confirmed.email.trim() ? confirmed.email.trim() : null;
  const accountName = verified
    ? `${verified.first_name ?? ""} ${verified.last_name ?? ""}`.replace(/\s+/g, " ").trim()
    : "";
  if (accountName) return { name: accountName, nameSource: "account", email };
  const given = confirmed ? `${confirmed.first_name} ${confirmed.last_name}`.replace(/\s+/g, " ").trim() : "";
  return given ? { name: given, nameSource: "caller", email } : { name: null, nameSource: null, email };
}

/** The call's TeamCaller from the store, for a caller that holds only the call key (the forwarding
 *  path, the sla job). Best effort: a failed read costs the name, never the alert. */
export async function loadTeamCaller(store: Store, callKey: string, session: Session | null): Promise<TeamCaller> {
  const safely = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  const customerId = session?.level === "verified" ? session.verified_customer_id : null;
  const [customer, contact] = await Promise.all([
    customerId ? safely(() => store.getCustomer(customerId)) : Promise.resolve(null),
    typeof store?.getContact === "function" ? safely(() => store.getContact(callKey)) : Promise.resolve(null),
  ]);
  return teamCallerOf(customer, contact);
}

/** Who to call back for one escalation, for a job that holds only its call key and kind (the sla
 *  re-alert): the TeamCaller and the number on the escalation row. Best effort, never throws. */
export async function loadEscalationContact(
  store: Store,
  callKey: string,
  kind: string,
): Promise<{ caller: TeamCaller; callbackPhone: string | null }> {
  let session: Session | null = null;
  let callbackPhone: string | null = null;
  try {
    const [s, rows] = await Promise.all([store.getSession(callKey), store.listEscalations(callKey)]);
    session = s;
    callbackPhone = rows.find((r) => r.kind === kind)?.callback_phone ?? null;
  } catch {
    // the re-alert still goes out with what is known
  }
  return { caller: await loadTeamCaller(store, callKey, session), callbackPhone };
}

function callerRows(caller: TeamCaller): [string, string][] {
  const name = typeof caller.name === "string" && caller.name.trim() ? caller.name.trim() : null;
  const rows: [string, string][] = [[
    "Caller name",
    name === null
      ? UNKNOWN_CALLER_NAME
      : caller.nameSource === "caller"
      ? `${escapeHtml(name)} (caller-provided, unverified)`
      : escapeHtml(name),
  ]];
  const email = typeof caller.email === "string" && caller.email.trim() ? caller.email.trim() : null;
  if (email) rows.push([CALLER_EMAIL_LABEL, escapeHtml(email)]);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Team templates.
// ---------------------------------------------------------------------------------------------
export function callbackRequestEmail(p: {
  callKey: string;
  reason: string;
  verified: boolean;
  callbackPhone: string | null;
  details: string | null;
  channel: string;
  dashboardUrl?: string;
  caller?: TeamCaller; // absent: shown as an unknown caller
}): { subject: string; html: string } {
  const verified = p.verified === true;
  const details = typeof p.details === "string" && p.details.trim() ? redactPII(p.details) : null;
  const phone = typeof p.callbackPhone === "string" && p.callbackPhone.trim() ? p.callbackPhone : null;
  const content: string[] = [];
  if (!verified) content.push(`<p style="${STYLE_WARN}">UNVERIFIED: do not disclose claim details.</p>`);
  content.push(
    table([
      ["Call id", escapeHtml(p.callKey)],
      ["Reason", escapeHtml(reasonText(p.reason))],
      ["Identity verified", verified ? "Yes" : "No"],
      ...callerRows(p.caller ?? UNKNOWN_TEAM_CALLER),
      ["Callback number", phone ? escapeHtml(writtenPhone(phone)) : "None given yet (check the dashboard)"],
      ["Channel", escapeHtml(p.channel || "unknown")],
      ["Details (redacted)", details ? textBlock(details) : "None"],
    ]),
    para(escapeHtml("Please call back within one business day.")),
    linkLine(dashboardLink(p.dashboardUrl, p.callKey)),
  );
  return {
    subject: asciiLine(`Callback requested: call ${shortCallId(p.callKey)}`),
    html: page("Callback requested", content, TEAM_FOOTER),
  };
}

export function emergencyEmail(p: {
  callKey: string;
  note: string | null;
  channel: string;
  dashboardUrl?: string;
  // Staff following up on an emergency need to know who it was and how to reach them; both are
  // optional so a caller without them still gets the core alert.
  verified?: boolean;
  callbackPhone?: string | null;
  caller?: TeamCaller; // absent: shown as an unknown caller
}): {
  subject: string;
  html: string;
} {
  const note = typeof p.note === "string" && p.note.trim() ? redactPII(p.note) : null;
  const verified = p.verified === true;
  const phone = typeof p.callbackPhone === "string" && p.callbackPhone.trim() ? p.callbackPhone : null;
  const content = [
    `<p style="${STYLE_WARN}">POSSIBLE EMERGENCY REPORTED. The caller may be in danger right now.</p>`,
    para(escapeHtml(
      "The assistant's emergency step reads the 911 and 988 safety line to the caller before this report is logged.",
    )),
    table([
      ["Call id", escapeHtml(p.callKey)],
      ["Reason", escapeHtml(reasonText("emergency"))],
      ["Identity verified", verified ? "Yes" : "No"],
      ...callerRows(p.caller ?? UNKNOWN_TEAM_CALLER),
      ["Callback number", phone ? escapeHtml(writtenPhone(phone)) : "None known (check the dashboard)"],
      ["Channel", escapeHtml(p.channel || "unknown")],
      ["Note (redacted)", note ? textBlock(note) : "No note given"],
    ]),
    linkLine(dashboardLink(p.dashboardUrl, p.callKey)),
  ];
  return {
    subject: asciiLine(`POSSIBLE EMERGENCY REPORTED: call ${shortCallId(p.callKey)}`),
    html: page("Possible emergency reported", content, TEAM_FOOTER),
  };
}

/** The team's notice of a claim taken by phone (confirm_claim). A verified customer's claim is filed
 *  and has a number; a new caller's is a lead intake for a specialist to call back and set up. Staff
 *  need who to call and what happened, so it carries the name, the number and the caller's words
 *  (redacted, capped at 500 characters), like the callback email. */
export function claimIntakeEmail(p: {
  callKey: string;
  intakeKind: ClaimIntakeKind;
  claimType: string;
  lossDate: string;
  description: string | null; // already redacted at capture; redacted again here
  claimNumber: string | null;
  verified: boolean;
  callbackPhone: string | null;
  channel: string;
  dashboardUrl?: string;
  caller?: TeamCaller; // absent: shown as an unknown caller
}): { subject: string; html: string } {
  const lead = p.intakeKind === "lead_intake";
  const verified = p.verified === true;
  const description = typeof p.description === "string" && p.description.trim()
    ? redactPII(p.description).slice(0, 500)
    : null;
  const number = typeof p.claimNumber === "string" && p.claimNumber.trim() ? p.claimNumber.trim() : null;
  const phone = typeof p.callbackPhone === "string" && p.callbackPhone.trim() ? p.callbackPhone : null;
  const type = claimTypeWord(p.claimType);
  const content: string[] = [];
  if (lead) {
    content.push(
      `<p style="${STYLE_WARN}">${
        escapeHtml("NEW CALLER: no account on file. Please call back within one business day to set up the claim.")
      }</p>`,
    );
  } else if (!verified) {
    content.push(`<p style="${STYLE_WARN}">UNVERIFIED: do not disclose claim details.</p>`);
  }
  content.push(
    table([
      ["Call id", escapeHtml(p.callKey)],
      ["Intake", lead ? "Details taken from a new caller (no claim filed yet)" : "Claim filed for a verified customer"],
      ["Claim number", number ? escapeHtml(number) : lead ? "None yet (set up on the callback)" : "Not assigned"],
      ["Claim type", escapeHtml(sentenceCase(type))],
      ["Date of loss", escapeHtml(writtenDate(p.lossDate) ?? "Not given")],
      ["Identity verified", verified ? "Yes" : "No"],
      ...callerRows(p.caller ?? UNKNOWN_TEAM_CALLER),
      ["Phone number", phone ? escapeHtml(writtenPhone(phone)) : "None known (check the dashboard)"],
      ["Channel", escapeHtml(p.channel || "unknown")],
      ["What happened (redacted)", description ? textBlock(description) : "Not given"],
    ]),
    para(escapeHtml(
      lead
        ? "The caller was told a specialist will call within one business day to finish setting up the claim."
        : "The customer was told an adjuster will reach out within one business day.",
    )),
    linkLine(dashboardLink(p.dashboardUrl, p.callKey)),
  );
  const subject = lead
    ? `New claim intake from a new caller: call ${shortCallId(p.callKey)}`
    : `New claim filed by phone: ${number ?? "claim"} (${type})`;
  return {
    subject: asciiLine(subject),
    html: page(lead ? "New claim intake from a new caller" : "New claim filed by phone", content, TEAM_FOOTER),
  };
}

export function slaRealertEmail(p: {
  callKey: string;
  kind: string;
  reason: string;
  minutesOpen: number;
  dashboardUrl?: string;
  // Who to call back. Optional so a caller that has not read them still sends the re-alert; when
  // given they are shown like the first alert's (loadTeamCaller, escalations.callback_phone).
  caller?: TeamCaller;
  callbackPhone?: string | null;
}): { subject: string; html: string } {
  const minutes = Number.isFinite(p.minutesOpen) ? Math.max(0, Math.round(p.minutesOpen)) : null;
  const kind = asciiLine(p.kind, 40) || "escalation";
  const open = minutes === null ? "for a while" : `for ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const content = [
    `<p style="${STYLE_WARN}">${
      escapeHtml(`This ${kind} escalation has been open ${open} and nobody has claimed it.`)
    }</p>`,
    table([
      ["Call id", escapeHtml(p.callKey)],
      ["Kind", escapeHtml(kind)],
      ["Reason", escapeHtml(reasonText(p.reason))],
      ["Minutes open", minutes === null ? "Unknown" : String(minutes)],
      ...(p.caller ? callerRows(p.caller) : []),
      ...(p.caller || p.callbackPhone !== undefined
        ? [[
          "Callback number",
          typeof p.callbackPhone === "string" && p.callbackPhone.trim()
            ? escapeHtml(writtenPhone(p.callbackPhone))
            : "None known (check the dashboard)",
        ] as [string, string]]
        : []),
    ]),
    linkLine(dashboardLink(p.dashboardUrl, p.callKey)),
  ];
  const subjectOpen = minutes === null ? "" : ` after ${minutes} minutes`;
  return {
    subject: asciiLine(`Still unclaimed${subjectOpen}: ${kind} call ${shortCallId(p.callKey)}`),
    html: page("Escalation still unclaimed", content, TEAM_FOOTER),
  };
}

function humanKey(key: string): string {
  return sentenceCase(asciiLine(key, 80).replace(/[_-]+/g, " ").trim()) || "Value";
}

function statValue(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? escapeHtml(String(value)) : "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.trim() ? textBlock(redactPII(value)) : "-";
  if (depth >= 3) return "-";
  if (Array.isArray(value)) {
    return value.length ? list("ul", value.map((v) => statValue(v, depth + 1))) : "None";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? table(entries.map(([k, v]) => [humanKey(k), statValue(v, depth + 1)])) : "None";
  }
  return "-";
}

export function digestEmail(p: { date: string; stats: Record<string, unknown> }): { subject: string; html: string } {
  const date = asciiLine(p.date, 40) || "today";
  const entries = p.stats && typeof p.stats === "object" ? Object.entries(p.stats) : [];
  const content = entries.length
    ? [table(entries.map(([k, v]) => [humanKey(k), statValue(v, 1)]))]
    : [para("No activity was recorded.")];
  return {
    subject: asciiLine(`Observe Claims daily digest: ${date}`),
    html: page(`Daily digest for ${date}`, content, TEAM_FOOTER),
  };
}

// ---------------------------------------------------------------------------------------------
// Customer templates (send_info_email topics).
// ---------------------------------------------------------------------------------------------
export function documentChecklistEmail(p: { customer: Customer; claims: Claim[] }): { subject: string; html: string } {
  const waiting = (Array.isArray(p.claims) ? p.claims : []).filter((c) => c?.status === "awaiting_documents");
  const numbers = waiting.map(claimNumber).filter((n) => n !== "on file");
  const content = [greeting(p.customer)];
  if (waiting.length === 0) {
    content.push(para("None of your claims is waiting for documents right now, so there is nothing you need to send."));
  } else {
    content.push(para("Here is the list of documents we need from you, as you asked on your call."));
    for (const c of waiting) {
      content.push(claimHeading(c), ...documentsBlock(c));
      const adjuster = typeof c.adjuster_name === "string" ? c.adjuster_name.trim() : "";
      if (adjuster) content.push(para(escapeHtml(`Your adjuster: ${adjuster}.`)));
    }
  }
  content.push(...howToSendBlock(numbers));
  const subject = numbers.length === 1
    ? `Documents needed for claim ${numbers[0]}`
    : waiting.length > 0
    ? "Documents needed for your claims"
    : "Your Observe Insurance document checklist";
  return { subject: asciiLine(subject), html: page("Your document checklist", content, CUSTOMER_FOOTER) };
}

function statusBlock(c: Claim): string[] {
  const filed = writtenDate(c.filed_on);
  const updated = writtenDate(c.updated_on);
  const amount = money(c.amount_approved);
  const adjuster = typeof c.adjuster_name === "string" ? c.adjuster_name.trim() : "";
  const detail = typeof c.status_detail === "string" ? c.status_detail.trim() : "";
  const out: string[] = [];
  const status = (label: string, text: string) =>
    out.push(para(`<strong>${escapeHtml(`Status: ${label}.`)}</strong> ${escapeHtml(text)}`));
  switch (c.status) {
    case "received":
      status(
        "Received",
        `We received your claim${filed ? ` on ${filed}` : ""}. It is waiting for an adjuster to be assigned.`,
      );
      break;
    case "under_review":
      status(
        "Under review",
        adjuster ? `Your claim is under review with your adjuster, ${adjuster}.` : "Your claim is under review.",
      );
      break;
    case "awaiting_documents":
      status("Waiting for documents from you", "We need a few documents from you.");
      out.push(...documentsBlock(c));
      break;
    case "approved":
      status("Approved", amount ? `Your claim was approved for ${amount}.` : "Your claim was approved.");
      break;
    case "payment_issued": {
      const payment = amount ? `a payment of ${amount}` : "a payment";
      status("Payment issued", `Your claim was approved, and ${payment} was issued${updated ? ` on ${updated}` : ""}.`);
      break;
    }
    case "denied":
      status("Denied", "We're sorry, your claim was denied.");
      if (detail) out.push(para(escapeHtml(`The reason given: ${sentence(detail)}`)));
      out.push(para(escapeHtml(
        `You have ${APPEAL_DAYS} days to appeal. Call us at ${MAIN_LINE_SPOKEN} if you have questions about the decision.`,
      )));
      break;
    case "closed":
      status("Closed", "This claim is closed.");
      break;
    default:
      status("On file", "Please call us for the current status of this claim.");
  }
  if (detail && c.status !== "denied") out.push(para(escapeHtml(`Note: ${sentence(detail)}`)));
  const facts = [
    filed ? `Filed on ${filed}.` : "",
    updated ? `Last updated ${updated}.` : "",
    adjuster && c.status !== "under_review" ? `Adjuster: ${adjuster}.` : "",
  ].filter(Boolean);
  if (facts.length) out.push(para(escapeHtml(facts.join(" "))));
  return out;
}

export function claimSummaryEmail(p: { customer: Customer; claims: Claim[] }): { subject: string; html: string } {
  const claims = (Array.isArray(p.claims) ? p.claims : []).filter((c) => c && typeof c === "object");
  const content = [greeting(p.customer)];
  if (claims.length === 0) {
    content.push(
      para("We don't see any claims on file for your account."),
      para(escapeHtml(
        `To start one, visit ${CLAIMS_URL}, use the Observe Insurance mobile app, or call ${MAIN_LINE_SPOKEN}.`,
      )),
    );
  } else {
    const count = claims.length === 1 ? "the claim" : `the ${claims.length} claims`;
    content.push(para(escapeHtml(`Here is a summary of ${count} on your account, as you asked on your call.`)));
    for (const c of claims) content.push(claimHeading(c), ...statusBlock(c));
    const waiting = claims.filter((c) => c.status === "awaiting_documents").map(claimNumber).filter((n) =>
      n !== "on file"
    );
    if (waiting.length) content.push(...howToSendBlock(waiting));
  }
  return {
    subject: asciiLine("Your Observe Insurance claim summary"),
    html: page("Your claim summary", content, CUSTOMER_FOOTER),
  };
}

/** The customer's confirmation of a claim taken by phone (confirm_claim), from database facts only:
 *  the claim number (a verified customer's filed claim), the type, the date of loss and the
 *  documents to gather, plus how to send them. A new caller's (lead intake) has no number yet: a
 *  specialist calls to set the claim up. The caller's own description is never included. */
export function claimReceivedEmail(p: {
  customer: { first_name?: string | null };
  intakeKind: ClaimIntakeKind;
  claimType: string;
  lossDate: string;
  claimNumber: string | null;
  documents: readonly string[];
}): { subject: string; html: string } {
  const lead = p.intakeKind === "lead_intake";
  const type = claimTypeWord(p.claimType);
  const number = !lead && typeof p.claimNumber === "string" && p.claimNumber.trim() ? p.claimNumber.trim() : null;
  const loss = writtenDate(p.lossDate);
  const docs = (Array.isArray(p.documents) ? p.documents : [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => escapeHtml(sentenceCase(d.trim())));
  const rows: [string, string][] = [];
  if (number) rows.push(["Claim number", escapeHtml(number)]);
  rows.push(["Claim type", escapeHtml(sentenceCase(type))]);
  if (loss) rows.push(["Date of loss", escapeHtml(loss)]);
  const content = [
    greeting(p.customer),
    para(escapeHtml(
      lead
        ? `Thanks for calling Observe Insurance. We've passed the details of your ${type} claim to our claims team.`
        : `We've received your ${type} claim, reported on your call with Observe Insurance.`,
    )),
    table(rows),
    h2("What happens next"),
    para(escapeHtml(
      lead
        ? "A claims specialist will call you within one business day to finish setting up your claim and give you a claim number."
        : "An adjuster will reach out within one business day.",
    )),
  ];
  if (docs.length > 0) {
    content.push(
      h2(lead ? "It helps to have these ready" : "Documents to gather"),
      list("ul", docs),
    );
  }
  content.push(...howToSendBlock(number ? [number] : []));
  const subject = number ? `We received your claim ${number}` : `We received the details of your ${type} claim`;
  return { subject: asciiLine(subject), html: page("Your claim", content, CUSTOMER_FOOTER) };
}

/** The steps to start a claim. A verified customer's copy names their policy number; a new caller's
 *  (newCustomer: greeted by the first name they gave, sent to the address they spelled) is generic and
 *  carries nothing from any account. */
export function howToStartEmail(p: {
  customer: { first_name?: string | null; policy_number?: string | null };
  newCustomer?: boolean;
}): { subject: string; html: string } {
  const newCustomer = p.newCustomer === true;
  const policy = !newCustomer && typeof p.customer?.policy_number === "string" ? p.customer.policy_number.trim() : "";
  const content = [
    greeting(p.customer),
    para(
      newCustomer
        ? "Thanks for calling Observe Insurance. Here is how to start a new claim, as you asked on your call."
        : "Here is how to start a new claim, as you asked on your call.",
    ),
    h2("Three ways to start a claim"),
    list("ul", [
      escapeHtml(`Online at ${CLAIMS_URL}`),
      escapeHtml("In the Observe Insurance mobile app"),
      escapeHtml(`By phone at ${MAIN_LINE_SPOKEN}, ${OFFICE_HOURS}`),
    ]),
    h2("Have this ready"),
    list("ul", [
      escapeHtml(
        policy
          ? `Your policy number: ${policy}`
          : newCustomer
          ? "Your policy number, if you have one"
          : "Your policy number",
      ),
      escapeHtml("The date of the loss"),
      escapeHtml("A short description of what happened"),
    ]),
    h2("What happens next"),
    list("ol", [
      escapeHtml("Your claim is filed and you receive a claim number."),
      escapeHtml("We review the claim."),
      escapeHtml("An adjuster is assigned to your claim."),
      escapeHtml("Your adjuster asks for any documents we need, such as photos or estimates."),
      escapeHtml("We make a decision and, if the claim is approved, issue your payment."),
    ]),
    para(escapeHtml("Most decisions are made within 10 business days of receiving complete documents.")),
  ];
  return {
    subject: asciiLine("How to start a claim with Observe Insurance"),
    html: page("How to start a claim", content, CUSTOMER_FOOTER),
  };
}
