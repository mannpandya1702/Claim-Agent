// Identity helpers: phone and DOB normalisation, the callback-number rules, and a pure mirror of the
// SQL identity state machine. Postgres stays the source of truth in production; the mirror lets
// fake_store.ts and the unit tests walk the same ladder without a database.
//
// Two kinds of phone number, kept apart on purpose:
//   lookup key       normalisePhone: the number on an account, always North American (+1XXXXXXXXXX)
//   callback number  normaliseCallbackNumber: any number a caller can be called back on. A number the
//                    caller gives is noted as given: never refused for its country or its length.
// A callback number is stored in one of three forms: "+1XXXXXXXXXX" (North American), "+" and 8 to 15
// digits (international) or 7 to 15 bare digits (noted as said, no country code). A number given on a
// call from abroad is read against its caller id (givenCallbackNumber), and a stored one is never read
// again (storedCallbackNumber): only a number written with "+" carries a country code.
import type { Code, Level } from "./enums.ts";

/** Caller-stated phone -> account lookup key, E.164 (+1XXXXXXXXXX) or null. Strip non-digits; 11 digits
 *  only with a leading 1; require exactly 10 after that; reject all-same digits. Accounts are North
 *  American; a callback number is a different thing (normaliseCallbackNumber). */
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
  // ten-digit number" after they had said ten digits.
  return `+1${digits}`;
}

/** A callback number as it is stored, or null (a number given on a call from abroad is first read against
 *  its caller id: givenCallbackNumber). In order:
 *  - North American: 10 digits, or 11 with a leading 1 (with or without "+"), neither the area code nor
 *    the exchange starting with 0 or 1 -> "+1XXXXXXXXXX". 555-01xx is valid on purpose: the demo data
 *    lives in the fiction range.
 *  - International, given with its country code ("+44 20 7946 0958", "0044 20 7946 0958", or a
 *    carrier's caller id such as "+61491570156") -> E.164, "+" and 8 to 15 digits. A "+1" number
 *    that is not North American falls to the next rule.
 *  - Anything else of 7 to 15 digits is noted exactly as said, as its digits ("9601550123"): placing a
 *    number without a country code is the team's job, and a caller is never refused for it.
 *  Refused: fewer than 7 or more than 15 digits, one digit repeated throughout, and the placeholders a
 *  carrier sends for a withheld caller id ("anonymous", "restricted"). Self-contained (no references
 *  outside the function), so the chat battery's mock tools can run this very function. */
export function normaliseCallbackNumber(raw: unknown): string | null {
  let text: string;
  if (typeof raw === "string") text = raw.trim().replace(/^plus\b\s*/i, "+");
  else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) text = String(raw);
  else return null;
  if (text.length > 64 || /^(anonymous|unknown|restricted|private|unavailable|withheld|blocked)$/i.test(text)) {
    return null;
  }
  const all = text.replace(/\D/g, "");
  // The digits after an international prefix ("+", or "00" before a country code), else null.
  const afterPrefix = text.startsWith("+") ? all : /^00[1-9]/.test(all) ? all.slice(2) : null;
  const core = afterPrefix ?? all;
  if (/^(\d)\1*$/.test(core.length === 11 && core[0] === "1" ? core.slice(1) : core)) return null;
  const nanp = (d: string) => (/^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `+1${d}` : null);
  if (core.length === 11 && core[0] === "1" && nanp(core.slice(1))) return nanp(core.slice(1));
  if (afterPrefix === null && core.length === 10 && nanp(core)) return nanp(core);
  if (afterPrefix !== null && /^[2-9]\d{7,14}$/.test(afterPrefix)) return `+${afterPrefix}`;
  return all.length >= 7 && all.length <= 15 ? all : null;
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

/** A usable callback number: normaliseCallbackNumber, and never our own line (any of ownNumbers,
 *  however the env list writes it). Junk caller ids, repeated digits and too few or too many digits
 *  are null; a number outside North America is kept. */
export function usableCallbackNumber(raw: unknown, ownNumbers: string[]): string | null {
  const number = normaliseCallbackNumber(raw);
  if (!number) return null;
  const listed = Array.isArray(ownNumbers) ? ownNumbers : [];
  const own = listed.flatMap((n) => [normaliseCallbackNumber(n), normalisePhone(n)]);
  return own.includes(number) ? null : number;
}

/** A callback number the caller gave on this call (escalate's or capture_contact's callback_phone), read
 *  against the call's caller id. On a call from abroad (a caller id with a country code other than 1), a
 *  number given without a country code is never taken for a North American one: the caller's own number
 *  in its national form ("020 7946 0958" or "2079460958" from +442079460958, or the same digits after the
 *  country code without the "+") is that caller id, so its read-back says the country code; any other is
 *  noted exactly as said ("6025550177", not "+16025550177"). A number given with its country code, and any
 *  number on a call with no caller id or a North American one, is read as usableCallbackNumber reads it. */
export function givenCallbackNumber(raw: unknown, ownNumbers: string[], callerId: unknown): string | null {
  const read = usableCallbackNumber(raw, ownNumbers);
  const caller = usableCallbackNumber(callerId, ownNumbers);
  if (!read || !caller || !/^\+[2-9]/.test(caller)) return read;
  const text = typeof raw === "string" ? raw.trim().replace(/^plus\b\s*/i, "+") : String(raw);
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") || /^00[1-9]/.test(digits)) return read;
  const callerDigits = caller.slice(1);
  const national = callerDigits.slice(countryCodeLength(callerDigits));
  if (digits === national || digits === `0${national}` || digits === callerDigits) return caller;
  return digits;
}

// The forms a callback number is stored in: E.164, or 7 to 15 digits noted as said (0011's CHECK).
const STORED_CALLBACK_RE = /^(?:\+[1-9]\d{7,14}|\d{7,15})$/;

/** A callback number read back from a row (caller_contacts, escalations), kept exactly as stored: a stored
 *  number is never read again, so "6025550177" noted as said on a call from abroad stays as said instead
 *  of turning into a North American number. null for what usableCallbackNumber refuses (junk, our own
 *  line); a value in no stored form is read as usableCallbackNumber reads it. */
export function storedCallbackNumber(stored: unknown, ownNumbers: string[]): string | null {
  const read = usableCallbackNumber(stored, ownNumbers);
  return read && typeof stored === "string" && STORED_CALLBACK_RE.test(stored) ? stored : read;
}

/** Real caller id from the envelope (call.customer.number), North American or international, or null
 *  for web calls and junk. */
export function callerIdNumber(raw: unknown, ownNumbers: string[]): string | null {
  // Only phone characters: stripping the non-digits out of a SIP URI could assemble a plausible
  // number from a host or port.
  if (typeof raw !== "string" || !/^\s*\+?[\d\s().-]+$/.test(raw)) return null;
  return usableCallbackNumber(raw, ownNumbers);
}

// ITU-T E.164 country codes of one and two digits; every other country code has three.
const ONE_DIGIT_COUNTRY_CODES: ReadonlySet<string> = new Set(["1", "7"]);
const TWO_DIGIT_COUNTRY_CODES: ReadonlySet<string> = new Set(
  ("20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 " +
    "81 82 84 86 90 91 92 93 94 95 98").split(" "),
);

/** How many of an international number's digits (after the "+") are its country code. */
function countryCodeLength(digits: string): number {
  return ONE_DIGIT_COUNTRY_CODES.has(digits[0]) ? 1 : TWO_DIGIT_COUNTRY_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

/** Digits in groups of three, the last group taking up to four ("9601550123" -> 960 155 0123). */
function digitGroups(digits: string): string[] {
  const groups: string[] = [];
  let i = 0;
  for (; digits.length - i > 4; i += 3) groups.push(digits.slice(i, i + 3));
  if (i < digits.length) groups.push(digits.slice(i));
  return groups;
}

export interface PhoneGroups {
  kind: "north_american" | "international" | "as_said";
  countryCode: string | null; // "1" for North American, the E.164 country code for international
  groups: string[]; // the number after its country code
}

/** How a stored callback number is read back and shown: a North American one ("+1" and ten digits) as
 *  area code, exchange and line ("602", "555", "0101"); an international one as its country code, then
 *  the rest in groups of three with a last group of up to four; one noted as said the same way from its
 *  first digit. Only a number written with "+" has a country code: bare digits are kept whole as said,
 *  so "16025550177" keeps its 1 and ten digits read 3-3-4. null without a digit. */
export function phoneGroups(number: string): PhoneGroups | null {
  const text = typeof number === "string" ? number.trim() : "";
  const d = text.replace(/\D/g, "");
  if (!d) return null;
  const plus = text.startsWith("+");
  if (plus && d.length === 11 && d[0] === "1") {
    const n = d.slice(1);
    return { kind: "north_american", countryCode: "1", groups: [n.slice(0, 3), n.slice(3, 6), n.slice(6)] };
  }
  if (plus && d.length >= 8) {
    const size = countryCodeLength(d);
    return { kind: "international", countryCode: d.slice(0, size), groups: digitGroups(d.slice(size)) };
  }
  return { kind: "as_said", countryCode: null, groups: digitGroups(d) };
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

// ---------------------------------------------------------------------------------------------
// The name a caller gives for a callback (escalate's caller_name, stored on the escalation row by
// 0012_callback_caller_name.sql): who the claims team should ask for when they call back.
// ---------------------------------------------------------------------------------------------
/** Longest name a callback request stores (the CHECK on escalations.caller_name). */
export const MAX_CALLER_NAME_CHARS = 80;

/** The name a caller gave for a callback (escalate's caller_name) as it is stored, or null. Trimmed with
 *  its spaces collapsed, curly apostrophes and dashes made plain, a lead-in such as "it's" or "my name is"
 *  dropped, and a sentence's closing full stop too ("Priya." but not "J.R."). Letters (accented ones
 *  included), spaces, apostrophes, hyphens and full stops only, 1 to 80 characters and at most five words.
 *  Refused: anything with a digit or another symbol (a phone number, an email address), and words that only
 *  say there is no name ("unknown", "no", "none", "rather not say", a title on its own). An all-lower or
 *  all-upper name is title-cased, as normaliseName does. Self-contained (no references outside the
 *  function), so the chat battery's mock tools can run this very function. */
export function normaliseCallerName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const s = raw.normalize("NFC")
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(?:it's|it is|this is|my name is|my name's|name's|i'm|i am|call me|ask for|just ask for|they can ask for)\s+/i,
      "",
    )
    .replace(/\s*([-'])\s*/g, "$1")
    .replace(/(\p{L}{3})\.+$/u, "$1");
  const length = [...s].length;
  if (length < 1 || length > 80 || !/^[\p{L}\p{M}' .-]+$/u.test(s) || !/\p{L}/u.test(s)) return null;
  const words = s.split(" ");
  // more words than a name has, or an email address said aloud ("priya at example dot com")
  if (words.length > 5 || /\bat\b.*\bdot\b/i.test(s)) return null;
  // Words that only say there is no name, or decline to give one, or point at a number instead, and
  // titles with no name after them.
  const empty = new Set([
    "on",
    "in",
    "of",
    "the",
    "this",
    "same",
    "number",
    "phone",
    "use",
    "your",
    "here",
    "now",
    "later",
    "back",
    "good",
    "great",
    "nothing",
    "else",
    "bye",
    "hello",
    "hi",
    "unknown",
    "no",
    "none",
    "nope",
    "nah",
    "nobody",
    "noone",
    "anonymous",
    "anon",
    "name",
    "not",
    "given",
    "provided",
    "declined",
    "caller",
    "customer",
    "rather",
    "say",
    "prefer",
    "to",
    "skip",
    "pass",
    "thanks",
    "thank",
    "you",
    "just",
    "call",
    "me",
    "null",
    "undefined",
    "unspecified",
    "unavailable",
    "dont",
    "know",
    "doesnt",
    "matter",
    "whatever",
    "anyone",
    "anybody",
    "it",
    "its",
    "is",
    "my",
    "i",
    "id",
    "im",
    "would",
    "want",
    "tell",
    "that",
    "thats",
    "fine",
    "ok",
    "okay",
    "sure",
    "yes",
    "yeah",
    "please",
    "test",
    "user",
    "mr",
    "mrs",
    "ms",
    "miss",
    "mx",
    "dr",
    "sir",
    "madam",
    "maam",
  ]);
  const plain = words.map((w) => w.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[.'-]/g, ""));
  if (plain.every((w) => w === "" || empty.has(w))) return null;
  return s === s.toLowerCase() || s === s.toUpperCase()
    ? s.toLowerCase().replace(/(^|[' .-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    : s;
}

/** The part of a stored caller name a sentence thanks them by: the first word ("Priya" of "Priya Raman"),
 *  or a title with the word after it ("Dr. Shah"), without a closing full stop ("J.R." -> "J.R"). "" when
 *  there is no name. */
export function callerFirstName(name: unknown): string {
  const words = typeof name === "string" ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (words.length === 0) return "";
  const title = /^(mr|mrs|ms|miss|mx|dr|sir)\.?$/i.test(words[0]) && words.length > 1;
  return (title ? `${words[0]} ${words[1]}` : words[0]).replace(/\.+$/, "");
}

/** Last four digits for logs and sentences; never more. */
export function lastFour(e164: string): string {
  return typeof e164 === "string" ? e164.replace(/\D/g, "").slice(-4) : "";
}

/** Different numbers that may miss on one call; the one that reaches it is told not_found_final, and
 *  so is every lookup after it. */
export const MAX_LOOKUP_MISSES = 3;

/** Pure mirror of the SQL state machine (lookup_customer_attempt / verify_dob_attempt), used by
 *  fake_store.ts and identity_test.ts. The SQL functions remain the source of truth in production. */
export interface IdentityState {
  level: Level;
  /** Different numbers that missed on this call (lookup_miss rows; an old row without a number key
   *  counts as a number of its own). */
  misses: number;
  /** The keys of those numbers (lookup_numbers.number_hash, 0010), so a number that missed is known again. */
  missed: string[];
  wrong: number;
  unreadable: number;
  candidate: string | null;
  verified: string | null;
}
export type IdentityEvent =
  /** numberKey: how the ledger knows the number (lookup_numbers.number_hash, the hex SHA-256 of the
   *  E.164). Defaults to phoneE164, which is all an in-memory replay needs. */
  | { type: "lookup"; phoneE164: string | null; customerId: string | null; numberKey?: string }
  | { type: "dob"; valid: boolean; matches: boolean };

export function initialIdentity(): IdentityState {
  return { level: "none", misses: 0, missed: [], wrong: 0, unreadable: 0, candidate: null, verified: null };
}

// Branch order matches the SQL exactly: level first, then readability, then the counters. The
// `unreadable` counter is the verify_identity one only (the SQL filters on tool_name), so an
// unreadable phone never moves the caller toward dob_give_up.
export function step(s: IdentityState, e: IdentityEvent): { state: IdentityState; code: Code } {
  const next: IdentityState = { ...s, missed: [...s.missed] };
  if (e.type === "lookup") {
    if (s.level === "verified") return { state: next, code: "already_verified" };
    if (s.level === "locked") return { state: next, code: "locked" };
    if (e.phoneE164 === null) return { state: next, code: "invalid_phone" };
    const key = e.numberKey ?? e.phoneE164;
    // A number that already missed (the caller said yes to "Is that the right number?") is final for
    // that number only: a different one may still be tried while fewer than three have missed.
    if (s.missed.includes(key)) return { state: next, code: "not_found_final" };
    if (s.misses >= MAX_LOOKUP_MISSES) return { state: next, code: "not_found_final" };
    if (e.customerId !== null) {
      next.level = "phone_found";
      next.candidate = e.customerId;
      return { state: next, code: "needs_dob" };
    }
    next.misses = s.misses + 1;
    next.missed.push(key);
    return { state: next, code: next.misses >= MAX_LOOKUP_MISSES ? "not_found_final" : "not_found" };
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
