// Code -> sentence. The server composes every spoken sentence; the model never paraphrases.
// Everything here is pure and timezone-independent: dates arrive as YYYY-MM-DD strings and are
// read by hand, so neither the server clock nor a TZ setting can shift a spoken date by a day.
import { CLAIM_TYPES, CLAIMS_URL_SPOKEN, type Code, MAIN_LINE_SPOKEN } from "./enums.ts";
import { isPlainEmail } from "./identity.ts";
import type { Claim } from "./types.ts";

const SMALL = (
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen " +
  "eighteen nineteen"
).split(" ");
// Indexed by the tens digit; 0 and 1 never index these (the teens are in SMALL).
const TENS = ["", "", ..."twenty thirty forty fifty sixty seventy eighty ninety".split(" ")];
const SMALL_ORDINALS = (
  "zeroth first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth " +
  "fifteenth sixteenth seventeenth eighteenth nineteenth"
).split(" ");
const TENS_ORDINALS = [
  "",
  "",
  ..."twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth".split(" "),
];
const MONTHS = "January February March April May June July August September October November December".split(" ");

// The contract floor is 999,999; millions are accepted so a large settlement amount is read out
// instead of turning the whole status answer into a system error.
const MAX_WORDS = 999_999_999;

/** VAPI's limit on a spoken tool message (ToolMessageComplete.content maxLength in the OpenAPI). */
export const MAX_SPOKEN_CHARS = 1000;
// Free text from the claims system longer than this is left out rather than cut mid-thought, so one
// claim can never fill the whole spoken answer.
const MAX_DETAIL_CHARS = 240;
const MAX_DOCUMENT_LIST_CHARS = 320;
const MAX_NAME_CHARS = 60;

// ---------------------------------------------------------------------------------------------
// Sentences (exact text; CONTRACTS.md "Sentences").
// ---------------------------------------------------------------------------------------------
const ANYTHING_ELSE = "Is there anything else I can help you with?";
const BAD_ARGS = "Sorry, I didn't catch that. Could you say it again?";
const SYSTEM_ERROR =
  "I'm having trouble reaching our claims system right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?";
const INVALID_PHONE = "I need the full ten-digit number on the account. Could you say it again?";
// The new-caller branch starts here: the sentence ends the turn, so it asks for the name itself. It
// says "if you're new", so a policyholder whose account is under another number can say so and be
// offered a callback instead of new-claim intake (branches-identity.md NOT FOUND).
const NOT_FOUND_FINAL =
  "I'm sorry, I still can't find an account for that number. If you're new with us, I can help you get started. Could I get your first and last name?";
const NEEDS_DOB = "Thanks. For security, what's the date of birth on the account?";
const ALREADY_VERIFIED = "You're already verified. What can I help you with?";
const LOCKED =
  "I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?";
const AUTH_FAILED =
  "I'm sorry, that doesn't match what we have on file. Could you give me your date of birth one more time?";
const NO_LOOKUP_YET = "Before I can check that, I need the phone number on the account. What's the number?";
const DOB_UNREADABLE = "Could you give me the month, day and year?";
const NOT_VERIFIED_PHONE_FOUND =
  "For security, I need the date of birth on the account before I can share that. What's the date of birth?";
const NOT_VERIFIED_NONE =
  "I need to verify your identity before I can share that. What's the phone number on your account?";
const NO_CLAIMS = "I don't see any claims on file for your account. Would you like me to explain how to start one?";
const REP_QUEUED_NO_NUMBER =
  "I've sent your request to our claims team. What's the best number for a representative to reach you?";
const REP_RECORDED = `I've recorded your request. ${ANYTHING_ELSE}`;
const REP_ALREADY_QUEUED =
  `Your request is already with our claims team. A representative will call you back within one business day. ${ANYTHING_ELSE}`;
const REP_UNAVAILABLE =
  `I'm sorry, I couldn't record your request just now. Please call our main line at ${MAIN_LINE_SPOKEN}, and someone will help you. ${ANYTHING_ELSE}`;
const EMERGENCY_LOGGED = "Our team has been told. Are you safe right now?";
const EMERGENCY_DB_FAILED = "Please stay on the line. Are you safe right now?";
const EMAIL_SENT =
  `Done, I've emailed that to the address on your account. It should arrive within a few minutes. ${ANYTHING_ELSE}`;
// A new caller's copy goes to the address they spelled on this call, not to any account.
const EMAIL_SENT_GIVEN =
  `Done, I've emailed that to the address you gave me. It should arrive within a few minutes. ${ANYTHING_ELSE}`;
const EMAIL_ALREADY_SENT = `I've already sent that to your email on this call. ${ANYTHING_ELSE}`;
// A spelled address goes to staff as a pending update (capture_contact); nothing is sent to it.
const NO_EMAIL_ON_FILE =
  `I don't see an email address on your account. If you'd like, you can spell one for me and I'll pass it to our team to add. Or you can find the same information at ${CLAIMS_URL_SPOKEN}. Which would you prefer?`;
const EMAIL_FAILED =
  `I wasn't able to send that email just now. You can find the same information at ${CLAIMS_URL_SPOKEN}, or I can have a representative send it. Which would you prefer?`;
const CONTACT_INVALID_EMAIL =
  "Hmm, I didn't quite catch a full email address. Could you spell it for me, letter by letter?";
const CONTACT_NEEDS_NAME = "Sorry, could I get your first and last name?";
// A phone caller said to use the number they're calling from, but the call carries no usable caller id.
const CONTACT_NEEDS_PHONE = "Sorry, I can't see the number you're calling from. What's the best number to reach you?";
const NOT_PENDING = "Sorry, let me take your details again. What's your first and last name?";
// A verified caller's name comes from the account, so only the address is asked for again.
const NOT_PENDING_EMAIL = "Sorry, could you spell that email for me one more time, letter by letter?";
// A verified caller's own address on file is never replaced from a call (account-takeover guard).
const EMAIL_ON_FILE =
  "There's already an email on your account, so I can't change it on this call. I can have someone from our claims team call you back about it. Would you like that?";
const CONTACT_RETRY_EMAIL = "Sorry about that. Could you spell your email for me one more time, slowly?";
const CONTACT_RETRY_NAME = "Sorry about that. Could you tell me your first and last name one more time?";
const CONTACT_READBACK_PLAIN = "Just to confirm, did I get your details right?";
const DOCUMENT_INSTRUCTIONS =
  `You can upload them at ${CLAIMS_URL_SPOKEN}, email them to claims docs at observeinsurance dot com, or mail them to our claims department, and please include your claim number.`;

// ---------------------------------------------------------------------------------------------
// Number and date words.
// ---------------------------------------------------------------------------------------------
function digitsOf(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
}

/** "115" -> "one one five"; non-digits dropped. */
export function speakDigits(digits: string): string {
  return [...digitsOf(digits)].map((c) => SMALL[Number(c)]).join(" ");
}

/** "+16025550199" or "6025550199" -> "six zero two... five five five... zero one nine nine". */
export function speakPhone(phone: string): string {
  let d = digitsOf(phone);
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  // Three groups with a pause, the way a person reads a number back.
  if (d.length !== 10) return speakDigits(d);
  return `${speakDigits(d.slice(0, 3))}... ${speakDigits(d.slice(3, 6))}... ${speakDigits(d.slice(6))}`;
}

function belowThousand(n: number): string {
  const words: string[] = [];
  if (n >= 100) {
    words.push(SMALL[Math.floor(n / 100)], "hundred");
    n %= 100;
  }
  if (n >= 20) {
    words.push(TENS[Math.floor(n / 10)]);
    if (n % 10) words.push(SMALL[n % 10]);
  } else if (n > 0) {
    words.push(SMALL[n]);
  }
  return words.join(" ");
}

/** Integer 0..999999 -> words ("four thousand eight hundred twenty"). */
export function numberToWords(n: number): string {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_WORDS) {
    throw new RangeError("numberToWords: expected an integer from 0 to 999999999");
  }
  if (n === 0) return "zero";
  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(`${belowThousand(millions)} million`);
  if (thousands) parts.push(`${belowThousand(thousands)} thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

function ordinalWords(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new RangeError("ordinalWords: expected 1..99");
  if (n < 20) return SMALL_ORDINALS[n];
  const tens = Math.floor(n / 10);
  return n % 10 === 0 ? TENS_ORDINALS[tens] : `${TENS[tens]}-${SMALL_ORDINALS[n % 10]}`;
}

function yearWords(y: number): string {
  if (y >= 2000 && y <= 2009) return y === 2000 ? "two thousand" : `two thousand ${SMALL[y - 2000]}`;
  if (y < 1000 || y > 9999) return numberToWords(y);
  const hi = belowThousand(Math.floor(y / 100));
  const lo = y % 100;
  if (lo === 0) return `${hi} hundred`;
  return lo < 10 ? `${hi} oh ${SMALL[lo]}` : `${hi} ${belowThousand(lo)}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-08" -> "October eighth" (adds ", twenty twenty five" style year only when year differs from refYear). Never Date.parse. */
export function speakDate(isoDate: string, refYear?: number): string {
  const m = typeof isoDate === "string" ? ISO_DATE.exec(isoDate.trim()) : null;
  if (!m) throw new RangeError("speakDate: expected YYYY-MM-DD");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError("speakDate: not a calendar date");
  }
  const spoken = `${MONTHS[month - 1]} ${ordinalWords(day)}`;
  return refYear !== undefined && refYear !== year ? `${spoken}, ${yearWords(year)}` : spoken;
}

/** 4820 -> "four thousand eight hundred twenty dollars"; 12.5 -> "twelve dollars and fifty cents". */
export function speakMoney(amount: number): string {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError("speakMoney: expected a non-negative amount");
  }
  const cents = Math.round(amount * 100);
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  const dollarWords = `${numberToWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
  if (rest === 0) return dollarWords;
  const centWords = `${numberToWords(rest)} ${rest === 1 ? "cent" : "cents"}`;
  return dollars === 0 ? centWords : `${dollarWords} and ${centWords}`;
}

// ---------------------------------------------------------------------------------------------
// Email read-back.
// ---------------------------------------------------------------------------------------------
const EMAIL_SYMBOL_WORDS: Readonly<Record<string, string>> = { ".": "dot", "_": "underscore", "-": "dash", "+": "plus" };
// Mail providers callers name as words; any other domain label is spelled out.
const KNOWN_EMAIL_DOMAINS: Readonly<Record<string, string>> = {
  gmail: "gmail",
  yahoo: "yahoo",
  outlook: "outlook",
  hotmail: "hotmail",
  icloud: "i cloud",
  aol: "A, O, L",
  proton: "proton",
  protonmail: "proton mail",
};
// Top-level domains said as words ("dot com"); any other is spelled ("dot c, o").
const WORD_TLDS: ReadonlySet<string> = new Set(["com", "net", "org", "edu", "gov", "mil", "info", "biz", "me"]);

// Letters are capitals: a lone lower-case "a" is easily voiced as the article ("uh"), and the read-back
// is the one place the caller can catch a misheard letter.
function spellOut(s: string): string {
  return [...s].map((c) => EMAIL_SYMBOL_WORDS[c] ?? (/[0-9]/.test(c) ? SMALL[Number(c)] : c.toUpperCase())).join(", ");
}

/** "john.smith42@gmail.com" -> "J, O, H, N, dot, S, M, I, T, H, four, two, at gmail dot com". The
 *  local part letter by letter (capital letters, digits as words, symbols named), a known provider as
 *  a word, any other domain label spelled, and a common top-level domain as a word. Throws on anything
 *  that is not a plain address (identity.ts isPlainEmail). */
export function speakEmail(address: string): string {
  const email = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!isPlainEmail(email)) throw new RangeError("speakEmail: expected a plain address");
  const [local, domain] = email.split("@");
  const labels = domain.split(".");
  const tld = labels.pop()!;
  const parts = labels.map((l) => KNOWN_EMAIL_DOMAINS[l] ?? spellOut(l));
  parts.push(WORD_TLDS.has(tld) ? tld : spellOut(tld));
  return `${spellOut(local)}, at ${parts.join(" dot ")}`;
}

// ---------------------------------------------------------------------------------------------
// Speakability guard.
// ---------------------------------------------------------------------------------------------
// The main line is the one digit run TTS must read as a phone number, so only that exact string
// (not a longer run that happens to contain it) is exempt from the 4+ digit rule.
const MAIN_LINE_EXACT = new RegExp(`(?<![\\d-])${MAIN_LINE_SPOKEN.replace(/[-]/g, "\\-")}(?![\\d-])`, "g");

/** Throws if the text is not safe to speak: non-printable-ASCII, "{{", "<<", JSON braces, digit runs of 4+, words like "null"/"undefined"/"JSON". */
export function assertSpeakable(text: string): void {
  if (typeof text !== "string" || text.trim() === "") throw new Error("unspeakable: empty");
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("unspeakable: non-printable or non-ASCII character");
  if (/[{}]/.test(text)) throw new Error("unspeakable: template or JSON brace");
  if (text.includes("<<")) throw new Error("unspeakable: template marker");
  if (/\b(null|undefined|json|data)\b/i.test(text) || /\bNaN\b|\[object /.test(text)) {
    throw new Error("unspeakable: leaked programming word");
  }
  if (/\d{4,}/.test(text.replace(MAIN_LINE_EXACT, " "))) throw new Error("unspeakable: digit run of four or more");
}

function isSpeakable(text: string): boolean {
  try {
    assertSpeakable(text);
    return true;
  } catch {
    return false;
  }
}

// Free text from the claims system (status detail, document names, adjuster) is folded to ASCII
// and its figures turned into words. Anything still unsafe after that is left out, never spoken.
function speakableText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, " - ")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/[{}]/g, " ");
  t = t.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => {
    try {
      return speakDate(iso);
    } catch {
      return iso;
    }
  });
  t = t.replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/g, (whole, int: string, frac?: string) => {
    const amount = Number(`${int.replace(/,/g, "")}.${(frac ?? "0").padEnd(2, "0")}`);
    return amount <= MAX_WORDS ? speakMoney(amount) : whole;
  });
  t = t.replace(
    /\b(\d{1,2})(?:st|nd|rd|th)\b/gi,
    (whole, n: string) => Number(n) >= 1 ? ordinalWords(Number(n)) : whole,
  );
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, (_whole, n: string) => `${numberWords(n)} percent`);
  t = t.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (n) => numberWords(n));
  t = t.replace(/\s+/g, " ").trim();
  return t && isSpeakable(t) ? t : null;
}

function numberWords(n: string): string {
  const [int, frac] = n.replace(/,/g, "").split(".");
  // A leading zero or a long ungrouped run means an identifier ("0142", "240115"), read digit by
  // digit; quantities that large are written with commas or a dollar sign.
  const identifier = (int.length > 1 && int[0] === "0") || (int.length >= 5 && !n.includes(","));
  const value = Number(int);
  const intWords = identifier || value > MAX_WORDS ? speakDigits(int) : numberToWords(value);
  return frac ? `${intWords} point ${speakDigits(frac)}` : intWords;
}

/** A name as it may be spoken: accents folded, anything but letters, spaces, apostrophes, full stops
 *  and hyphens dropped, and "" when nothing speakable is left or it is longer than a name. */
export function spokenName(raw: unknown): string {
  return speakableName(raw);
}

function speakableName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const t = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^A-Za-z' .-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A real surname can collide with a guarded word ("Null"); drop the name rather than speak around it.
  return /[A-Za-z]/.test(t) && t.length <= MAX_NAME_CHARS && isSpeakable(t) ? t : "";
}

/** speakableText for a claim's free text, left out when it is too long to read in full. */
function claimText(raw: unknown): string | null {
  const t = speakableText(raw);
  return t !== null && t.length <= MAX_DETAIL_CHARS ? t : null;
}

function sentenceCase(t: string): string {
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// get_claim_status.
// ---------------------------------------------------------------------------------------------
function amountOf(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function claimLine(c: Claim, refYear: number | undefined, withInstructions: boolean): string {
  const type = (CLAIM_TYPES as readonly string[]).includes(c.claim_type) ? `${c.claim_type} claim` : "claim";
  const last3 = digitsOf(c.claim_number).slice(-3);
  const head = last3 ? `Your ${type} ending in ${speakDigits(last3)}` : `Your ${type}`;
  const amount = amountOf(c.amount_approved);
  let body: string;
  switch (c.status) {
    case "received":
      body = `was received on ${speakDate(c.filed_on, refYear)} and is waiting for an adjuster to be assigned.`;
      break;
    case "under_review": {
      const adjuster = speakableName(c.adjuster_name);
      const detail = claimText(c.status_detail);
      body = adjuster ? `is under review with your adjuster, ${adjuster}.` : "is under review.";
      if (detail) body += ` ${sentenceCase(detail)}`;
      break;
    }
    case "awaiting_documents": {
      const docs = (Array.isArray(c.documents_required) ? c.documents_required : []).map(speakableText);
      // A partial list would tell the caller they are done when they are not; drop it whole.
      const whole = docs.length > 0 && docs.every((d): d is string => d !== null) ? listWords(docs) : "";
      const list = whole && whole.length <= MAX_DOCUMENT_LIST_CHARS ? `: ${whole}` : "";
      body = `needs a few documents from you before review can continue${list}.`;
      if (c.documents_due) body += ` Please send them by ${speakDate(c.documents_due, refYear)}.`;
      if (withInstructions) body += ` ${DOCUMENT_INSTRUCTIONS}`;
      break;
    }
    case "approved":
      body = amount !== null ? `was approved for ${speakMoney(amount)}.` : "was approved.";
      break;
    case "payment_issued": {
      const payment = amount !== null ? `a payment of ${speakMoney(amount)}` : "a payment";
      body = `was approved, and ${payment} was issued on ${speakDate(c.updated_on, refYear)}.`;
      break;
    }
    case "denied": {
      const reason = claimText((c.status_detail ?? "").split(";")[0]);
      body = "was denied, and I'm sorry about that.";
      if (reason) {
        // Lower-case the first letter so the reason reads as a clause, but keep an acronym intact.
        const clause = /^[A-Z][A-Z]/.test(reason) ? reason : reason.charAt(0).toLowerCase() + reason.slice(1);
        body += ` The reason given is that ${clause.replace(/[\s.,:!?-]+$/, "")}.`;
      }
      body += " You have thirty days to appeal.";
      break;
    }
    case "closed":
      body = "is closed.";
      break;
    default:
      throw new Error("claimsSentence: unknown claim status");
  }
  const line = `${head} ${body}`;
  assertSpeakable(line);
  return line;
}

/** Reading priority when not every claim fits: open claims before closed ones, then the newest. */
function readingOrder(claims: Claim[]): number[] {
  const closed = (c: Claim) => (c.status === "closed" ? 1 : 0);
  return claims.map((_, i) => i).sort((a, b) =>
    closed(claims[a]) - closed(claims[b]) ||
    String(claims[b].filed_on).localeCompare(String(claims[a].filed_on)) ||
    b - a
  );
}

/** The full get_claim_status sentence for a verified caller's claims (non-empty list). refDate = today (YYYY-MM-DD) in America/New_York. */
export function claimsSentence(claims: Claim[], refDate: string): string {
  if (!Array.isArray(claims) || claims.length === 0) throw new Error("claimsSentence: no claims");
  const refMatch = typeof refDate === "string" ? ISO_DATE.exec(refDate.trim()) : null;
  const refYear = refMatch ? Number(refMatch[1]) : undefined;
  const n = claims.length;
  const lead = n > 1 ? `You have ${numberToWords(n)} claims on file. ` : "";
  const which = n === 1 ? "that claim" : n === 2 ? "either claim" : "any of them";
  // Every line is built (and checked) once; a busy account then reads only what fits.
  const lines = claims.map((c) => claimLine(c, refYear, false));
  const withInstructions = claims.map((c) => (c.status === "awaiting_documents" ? claimLine(c, refYear, true) : ""));
  const compose = (picked: number[]): string => {
    // How to send documents is said once, after the last claim read that needs them.
    const lastAwaiting = picked.filter((i) => claims[i].status === "awaiting_documents").at(-1);
    const read = picked.map((i) => (i === lastAwaiting ? withInstructions[i] : lines[i])).join(" ");
    const rest = n - picked.length;
    const unread = rest === 0
      ? ""
      : ` ${rest === 1 ? "There is one more claim" : `There are ${numberToWords(rest)} more claims`} on file, and ` +
        `you can find every claim at ${CLAIMS_URL_SPOKEN}.`;
    return `${lead}${read}${unread} Do you have any questions about ${which}?`;
  };
  const all = claims.map((_, i) => i);
  let text = compose(all);
  if (text.length > MAX_SPOKEN_CHARS) {
    // VAPI refuses a longer spoken tool message, so the claims that matter most are read (in filing
    // order) and the caller is told the rest are on file.
    const picked: number[] = [];
    for (const i of readingOrder(claims)) {
      const next = [...picked, i].sort((a, b) => a - b);
      if (picked.length > 0 && compose(next).length > MAX_SPOKEN_CHARS) break;
      picked.splice(0, picked.length, ...next);
    }
    text = compose(picked);
  }
  assertSpeakable(text);
  return text;
}

// ---------------------------------------------------------------------------------------------
// Code -> sentence.
// ---------------------------------------------------------------------------------------------
function isClaimList(v: unknown): v is Claim[] {
  return Array.isArray(v) && v.length > 0 &&
    v.every((c) => typeof c === "object" && c !== null && "claim_number" in c && "status" in c && "filed_on" in c);
}

function repQueued(d: Record<string, unknown>): string {
  const last4 = digitsOf(d.digits).slice(-4);
  let at = "";
  if (d.target === "account") at = " at the number on your account";
  else if (d.target === "given") {
    at = last4 ? ` at the number you gave me, ending in ${speakDigits(last4)}` : " at the number you gave me";
  } else if (d.target === "caller_id") at = " at the number you're calling from";
  return `I've sent your request and a summary to our claims team. A representative will call you back${at} within one business day. ${ANYTHING_ELSE}`;
}

/** "Thank you, Tobias, you're verified." The opening both verified sentences share (the plain one
 *  here and prior_contacts' welcome-back variant), so the name is cleaned the same way in both. */
export function verifiedThanks(firstName: unknown): string {
  const name = speakableName(firstName);
  return name ? `Thank you, ${name}, you're verified.` : "Thank you, you're verified.";
}

function nationalDigits(v: unknown): string | null {
  let d = digitsOf(v);
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** capture_contact's read-back from {first_name, last_name, email?, callback_phone?}: the names as
 *  spoken words, the address letter by letter and a callback number the caller said, digit by digit
 *  (a number taken from caller id is not read back: nobody said it, so nothing can be misheard).
 *  Without a speakable name there is nothing to read back, so the plain confirmation question stands
 *  in (the tool never stores such a name). */
function contactReadback(d: Record<string, unknown>): string {
  const first = speakableName(d.first_name);
  const full = speakableName(`${typeof d.first_name === "string" ? d.first_name : ""} ${
    typeof d.last_name === "string" ? d.last_name : ""
  }`);
  if (!first || !full) return CONTACT_READBACK_PLAIN;
  let email = "";
  if (typeof d.email === "string" && d.email) {
    try {
      email = speakEmail(d.email);
    } catch {
      return CONTACT_READBACK_PLAIN;
    }
  }
  const digits = nationalDigits(d.callback_phone);
  const number = digits ? `the best number is ${speakPhone(digits)}` : "";
  let text: string;
  if (email && number) {
    text = `Thanks, ${first}. Let me read that back. ${full}, your email is ${email}, and ${number}. Did I get that right?`;
  } else if (email) {
    text = `Thanks, ${first}. Let me read that back. ${full}, and your email is ${email}. Did I get that right?`;
  } else if (number) {
    text = `Thanks, ${first}. Just to confirm, that's ${full}, and ${number}. Did I get that right?`;
  } else {
    text = `Thanks, ${first}. Just to confirm, that's ${full}. Did I get that right?`;
  }
  return isSpeakable(text) && text.length <= MAX_SPOKEN_CHARS ? text : CONTACT_READBACK_PLAIN;
}

/** contact_retry: a plain "no" to the read-back. An email_update read back only the address (the name
 *  is the account's), so it is spelled again; otherwise the caller says which part was wrong rather
 *  than being made to repeat a part that was right. */
function contactRetry(d: Record<string, unknown>): string {
  if (d.part === "email") return CONTACT_RETRY_EMAIL;
  const parts = ["your name"];
  if (d.has_email !== false) parts.push("your email");
  if (d.has_phone === true) parts.push("your number");
  if (parts.length === 1) return CONTACT_RETRY_NAME;
  const which = parts.length === 2 ? `${parts[0]} or ${parts[1]}` : `${parts[0]}, ${parts[1]} or ${parts[2]}`;
  return `Sorry about that. What did I get wrong, ${which}?`;
}

/** Code -> sentence. data carries the few dynamic parts (see CONTRACTS). */
export function sentenceFor(code: Code, data?: Record<string, unknown>): string {
  const d = data ?? {};
  switch (code) {
    case "bad_args":
      return BAD_ARGS;
    case "system_error":
    case "unknown_tool":
      return SYSTEM_ERROR;
    case "invalid_phone":
      return INVALID_PHONE;
    case "not_found": {
      const digits = nationalDigits(d.digits);
      return digits
        ? `I'm not finding an account under ${speakPhone(digits)}. Is that the right number?`
        : "I'm not finding an account under that number. Is that the right number?";
    }
    case "not_found_final":
      return NOT_FOUND_FINAL;
    case "needs_dob":
      return NEEDS_DOB;
    case "already_verified":
      return ALREADY_VERIFIED;
    case "locked":
    case "dob_give_up":
      return LOCKED;
    case "verified":
      return `${verifiedThanks(d.first_name)} What can I help you with today?`;
    case "auth_failed":
      return AUTH_FAILED;
    case "no_lookup_yet":
      return NO_LOOKUP_YET;
    case "dob_unreadable":
      return DOB_UNREADABLE;
    case "ok": {
      // Tools compose this with claimsSentence directly; without the claims there is nothing true
      // to say, so the honest fallback is the trouble line that offers a representative.
      if (!isClaimList(d.claims)) return SYSTEM_ERROR;
      try {
        return claimsSentence(d.claims, typeof d.refDate === "string" ? d.refDate : "");
      } catch {
        return SYSTEM_ERROR;
      }
    }
    case "no_claims":
      return NO_CLAIMS;
    case "not_verified":
      if (d.level === "phone_found") return NOT_VERIFIED_PHONE_FOUND;
      if (d.level === "locked") return LOCKED;
      return NOT_VERIFIED_NONE;
    case "rep_queued":
      return repQueued(d);
    case "rep_queued_no_number":
      return REP_QUEUED_NO_NUMBER;
    case "callback_updated": {
      const digits = nationalDigits(d.digits);
      return digits ? `Got it, ${speakPhone(digits)}. ${ANYTHING_ELSE}` : `Got it. ${ANYTHING_ELSE}`;
    }
    case "rep_recorded":
      return REP_RECORDED;
    case "rep_already_queued":
      return REP_ALREADY_QUEUED;
    case "rep_unavailable":
      return REP_UNAVAILABLE;
    case "emergency_logged":
      return d.db_failed === true ? EMERGENCY_DB_FAILED : EMERGENCY_LOGGED;
    case "email_sent":
      return d.target === "given" ? EMAIL_SENT_GIVEN : EMAIL_SENT;
    case "email_already_sent":
      return EMAIL_ALREADY_SENT;
    case "no_email_on_file":
      return NO_EMAIL_ON_FILE;
    case "email_failed":
      return EMAIL_FAILED;
    case "contact_readback":
      return contactReadback(d);
    case "contact_invalid_email":
      return CONTACT_INVALID_EMAIL;
    case "contact_needs_name":
      return CONTACT_NEEDS_NAME;
    case "contact_needs_phone":
      return CONTACT_NEEDS_PHONE;
    case "email_on_file":
      return EMAIL_ON_FILE;
    case "not_pending":
      return d.verified === true ? NOT_PENDING_EMAIL : NOT_PENDING;
    case "contact_retry":
      return contactRetry(d);
    case "contact_saved_new": {
      const name = speakableName(d.first_name);
      const thanks = name ? `Perfect, thanks ${name}.` : "Perfect, thanks.";
      // Without an address there is nothing to email the steps to, so the website stands in.
      const offer = d.has_email === false
        ? `I can have someone from our claims team call you back, or you can find the steps to start a claim at ${CLAIMS_URL_SPOKEN}. Which would you like?`
        : "I can email you the steps to start a new claim, or have someone from our claims team call you back. Which would you like?";
      return `${thanks} I've saved your details. ${offer}`;
    }
    case "contact_saved_existing": {
      const name = speakableName(d.first_name);
      return `${name ? `Thanks, ${name}.` : "Thanks."} I've passed that email to our team to add to your account. Is there anything else I can help with?`;
    }
    default: {
      // Exhaustive over CODES at compile time; an off-list code at runtime gets the trouble line.
      const _unreachable: never = code;
      return SYSTEM_ERROR;
    }
  }
}
