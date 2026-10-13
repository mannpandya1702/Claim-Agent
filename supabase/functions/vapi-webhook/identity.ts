// Identity helpers: phone and DOB normalisation, the callback-number junk filter, and a pure mirror
// of the SQL identity state machine. Postgres stays the source of truth in production; the mirror
// lets fake_store.ts and the unit tests walk the same ladder without a database.
import type { Code, Level } from "./enums.ts";

// Caller-ID placeholders carriers send instead of a number.
const JUNK_CALLER_ID = /^(anonymous|unknown|restricted|private|unavailable|withheld|blocked)$/i;

/** Caller-stated phone -> E.164 (+1XXXXXXXXXX) or null. Strip non-digits; 11 digits only with a leading 1;
 *  require exactly 10 after that; reject all-same digits and NANP-invalid area/exchange (first digit 0/1). */
export function normalisePhone(raw: unknown): string | null {
  let digits: string;
  if (typeof raw === "string") digits = raw.replace(/\D/g, "");
  else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) digits = String(raw);
  else return null;
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (/^(\d)\1{9}$/.test(digits)) return null;
  // No numbering-plan rule here: this is a lookup key, and any ten digits the caller said deserve
  // an answer from the database ("I'm not finding an account under ..."), which lets them correct
  // a digit. Rejecting a full ten digits as unreadable told a real caller "I need the full
  // ten-digit number" after they had said ten digits. Dialability is checked only for callbacks.
  return `+1${digits}`;
}

/** A number the claims team can dial back: normalisePhone plus the NANP rule (neither the area
 *  code nor the exchange may start with 0 or 1). 555-01xx stays valid on purpose, since the demo
 *  data lives in the fiction range. */
export function normaliseNanp(raw: unknown): string | null {
  const e164 = normalisePhone(raw);
  if (!e164) return null;
  const d = e164.slice(2);
  if (d[0] === "0" || d[0] === "1" || d[3] === "0" || d[3] === "1") return null;
  return e164;
}

function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\s*\d{1,4}\s*$/.test(v)) return Number(v.trim());
  return null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Integers only (numeric strings accepted); impossible dates (month 13, Feb 30, year < 1900 or > refYear) -> null. */
export function parseDobParts(
  m: unknown,
  d: unknown,
  y: unknown,
  refYear: number,
): { year: number; month: number; day: number } | null {
  const month = toInt(m);
  const day = toInt(d);
  const year = toInt(y);
  if (month === null || day === null || year === null) return null;
  if (year < 1900 || year > refYear) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** A usable callback number: normalisePhone + junk filter (Anonymous/unknown/restricted, repeated digits, any of ownNumbers). */
export function usableCallbackNumber(raw: unknown, ownNumbers: string[]): string | null {
  if (typeof raw === "string" && JUNK_CALLER_ID.test(raw.trim())) return null;
  const e164 = normaliseNanp(raw);
  if (!e164) return null;
  // Our own line must never become a callback target, however the env list was written.
  const own = (Array.isArray(ownNumbers) ? ownNumbers : []).map(normalisePhone);
  return own.includes(e164) ? null : e164;
}

/** Real caller id from the envelope (call.customer.number) or null for web calls / junk. */
export function callerIdNumber(raw: unknown, ownNumbers: string[]): string | null {
  // Only phone characters: stripping the non-digits out of a SIP URI could assemble a plausible
  // ten-digit number from a host or port.
  if (typeof raw !== "string" || !/^\s*\+?[\d\s().-]+$/.test(raw)) return null;
  return usableCallbackNumber(raw, ownNumbers);
}

// ---------------------------------------------------------------------------------------------
// Caller-given contact details (capture_contact). The model passes what it heard, sometimes in the
// spoken form ("j o h n dot smith at gmail dot com"); these turn it into one stored value or null.
// ---------------------------------------------------------------------------------------------
// Whole spoken phrases first, then single spoken words; everything else is kept as written.
const EMAIL_PHRASES: [RegExp, string][] = [
  [/\bat the rate(?: of)?\b|\bat sign\b|\bat symbol\b/g, " @ "],
  [/\bfull stop\b/g, " . "],
];
const EMAIL_WORDS: Readonly<Record<string, string>> = {
  at: "@",
  dot: ".",
  period: ".",
  point: ".",
  underscore: "_",
  underline: "_",
  dash: "-",
  hyphen: "-",
  minus: "-",
  plus: "+",
};
/** Longest address accepted from a caller; real ones are far shorter, and the read-back of a longer
 *  one would not fit VAPI's spoken-message limit. */
export const MAX_EMAIL_CHARS = 100;
const EMAIL_LOCAL_RE = /^[a-z0-9._+-]{1,64}$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^[a-z]{2,24}$/;

/** A plain address: one @, a local part of letters, digits and . _ + - (no leading, trailing or
 *  doubled dot), and a domain of at least two labels ending in a letters-only top-level domain. */
export function isPlainEmail(address: unknown): address is string {
  if (typeof address !== "string" || address.length > MAX_EMAIL_CHARS) {
    return false;
  }
  const parts = address.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !EMAIL_LOCAL_RE.test(local) || local.startsWith(".") ||
    local.endsWith(".") || local.includes("..")
  ) {
    return false;
  }
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((l) => DOMAIN_LABEL_RE.test(l)) &&
    TLD_RE.test(labels[labels.length - 1]);
}

/** Caller-given email -> lower-case plain address, or null. Spoken forms are read (" at " -> "@",
 *  " dot " -> ".", underscore, dash, plus), spaces and commas between spelled letters are dropped,
 *  and the result must be a plain address (isPlainEmail). Spoken digit words are kept as words: a
 *  name like "fourseasons" is as likely as a digit, and the read-back lets the caller correct it. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4 * MAX_EMAIL_CHARS) return null;
  let s = raw.normalize("NFKC").toLowerCase().replace(
    /[\u2010-\u2015\u2212]/g,
    "-",
  ).replace(/^\s*mailto:/, "");
  for (const [re, to] of EMAIL_PHRASES) s = s.replace(re, to);
  const joined = s.split(/[\s,;]+/).filter(Boolean).map((t) => EMAIL_WORDS[t] ?? t).join("");
  // Quotes, brackets or closing punctuation around the address are not part of it.
  const address = joined.replace(/^[<("'\[]+/, "").replace(
    /[>)"'\].,;:!?]+$/,
    "",
  );
  return isPlainEmail(address) ? address : null;
}

/** Longest single name part (first or last) accepted from a caller. */
export const MAX_NAME_PART_CHARS = 40;
// What a model writes when it has no name, or a form label instead of one.
const NAME_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "unknown",
  "caller",
  "customer",
  "anonymous",
  "n/a",
  "na",
  "none",
  "nobody",
  "no name",
  "not provided",
  "not given",
  "name",
  "first",
  "last",
  "first name",
  "last name",
  "surname",
  "test",
  "user",
  "sir",
  "madam",
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
]);
// Words of letters joined by single spaces, apostrophes or hyphens (checked on the accent-folded
// form, so "Jose" and "Jose" with an accent are both accepted and both speakable).
const NAME_SHAPE_RE = /^[A-Za-z]+(?:[' -][A-Za-z]+)*$/;

function titleCase(name: string): string {
  return name.toLowerCase().replace(
    /(^|[' -])(\p{L})/gu,
    (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
  );
}

/** One caller-given name part -> trimmed name, or null. Letters, spaces, apostrophes and hyphens
 *  only (full stops are dropped: "St. John" -> "St John"), 1 to 40 characters, no placeholder
 *  ("unknown", "first name"). An all-lower or all-upper name is title-cased; any other casing is
 *  kept as the caller's own ("McDonald", "van der Berg"). */
export function normaliseName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4 * MAX_NAME_PART_CHARS) {
    return null;
  }
  const s = raw.normalize("NFC")
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\./g, " ")
    .replace(/\s*([-'])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 1 || s.length > MAX_NAME_PART_CHARS) return null;
  const folded = s.normalize("NFKD").replace(/\p{M}/gu, "");
  if (
    !NAME_SHAPE_RE.test(folded) || NAME_PLACEHOLDERS.has(folded.toLowerCase())
  ) return null;
  return s === s.toLowerCase() || s === s.toUpperCase() ? titleCase(s) : s;
}

/** Last four digits for logs and sentences; never more. */
export function lastFour(e164: string): string {
  return typeof e164 === "string" ? e164.replace(/\D/g, "").slice(-4) : "";
}

/** Pure mirror of the SQL state machine (lookup_customer_attempt / verify_dob_attempt), used by
 *  fake_store.ts and identity_test.ts. The SQL functions remain the source of truth in production. */
export interface IdentityState {
  level: Level;
  misses: number;
  wrong: number;
  unreadable: number;
  candidate: string | null;
  verified: string | null;
}
export type IdentityEvent =
  | { type: "lookup"; phoneE164: string | null; customerId: string | null }
  | { type: "dob"; valid: boolean; matches: boolean };

export function initialIdentity(): IdentityState {
  return { level: "none", misses: 0, wrong: 0, unreadable: 0, candidate: null, verified: null };
}

// Branch order matches the SQL exactly: level first, then readability, then the counters. The
// `unreadable` counter is the verify_identity one only (the SQL filters on tool_name), so an
// unreadable phone never moves the caller toward dob_give_up.
export function step(s: IdentityState, e: IdentityEvent): { state: IdentityState; code: Code } {
  const next: IdentityState = { ...s };
  if (e.type === "lookup") {
    if (s.level === "verified") return { state: next, code: "already_verified" };
    if (s.level === "locked") return { state: next, code: "locked" };
    if (e.phoneE164 === null) return { state: next, code: "invalid_phone" };
    if (s.misses >= 2) return { state: next, code: "not_found_final" };
    if (e.customerId !== null) {
      next.level = "phone_found";
      next.candidate = e.customerId;
      return { state: next, code: "needs_dob" };
    }
    next.misses = s.misses + 1;
    return { state: next, code: next.misses >= 2 ? "not_found_final" : "not_found" };
  }

  if (s.level === "verified") return { state: next, code: "verified" };
  if (s.level === "locked") return { state: next, code: "locked" };
  if (s.level === "none") return { state: next, code: "no_lookup_yet" };
  if (!e.valid) {
    next.unreadable = s.unreadable + 1;
    return { state: next, code: next.unreadable >= 3 ? "dob_give_up" : "dob_unreadable" };
  }
  if (e.matches) {
    next.level = "verified";
    next.verified = s.candidate;
    return { state: next, code: "verified" };
  }
  next.wrong = s.wrong + 1;
  if (next.wrong >= 2) {
    next.level = "locked";
    return { state: next, code: "locked" };
  }
  return { state: next, code: "auth_failed" };
}
