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
// Sentences (exact text; CONTRACTS.md "Sentences"). Written the way a warm, capable person at a
// claims front desk talks: contractions, short sentences, an opener now and then ("Got it.",
// "There you go,", "No worries,") but never the same one twice in a row, sympathy once where it
// matters (a loss being reported, a lock, a denial, a failure on our side) and never on the turn
// before it too, and no stock phrases. Facts, honest-result clauses and each sentence's closing
// question are what the flow and the prompt rely on; the words around them are free to sound human.
// ---------------------------------------------------------------------------------------------
const ANYTHING_ELSE = "Anything else I can help with?";
const BAD_ARGS = "Sorry, I didn't quite catch that. Could you say it again?";
// "on our end", never "system" (rules.md rule 5): the model reads this one aloud, so it says nothing the
// prompt tells it never to say.
const SYSTEM_ERROR =
  "Sorry, I'm having trouble on our end right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?";
const INVALID_PHONE = "Sorry, I'll need the full ten-digit number on the account. Could you say it again?";
const ALREADY_VERIFIED = "You're already verified, so we're all set there. What can I help you with?";
// One apology for a lock: the lock's other sentences (claim_locked) do not say sorry again.
// The steps before a lock (auth_failed, dob_unreadable) do not say sorry, so the apology is not stacked.
const LOCKED =
  "I'm sorry, but I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?";
const AUTH_FAILED =
  "That doesn't quite match what we have on file. Could you give me your date of birth one more time?";
// No "Sure": the lookup filler that follows the number opens with it.
const NO_LOOKUP_YET = "Happy to check that. First, I'll just need the phone number on the account. What's the number?";
const DOB_UNREADABLE = "Just to be sure, could you give me the month, day and year?";
const NOT_VERIFIED_PHONE_FOUND = "Happy to help with that once you're verified. What's the date of birth?";
const NOT_VERIFIED_NONE = "Happy to help with that once I've verified you. What's the phone number on your account?";
const NO_CLAIMS = "I'm not seeing any claims on file for your account. Would you like me to explain how to start one?";
const REP_QUEUED_NO_NUMBER =
  "Done, I've sent your request to our claims team. What's the best number for a representative to reach you?";
const REP_RECORDED = `Okay, I've recorded your request. ${ANYTHING_ELSE}`;
const REP_ALREADY_QUEUED =
  `Your request is already with our claims team, so someone will call you back within one business day. ${ANYTHING_ELSE}`;
const REP_UNAVAILABLE =
  `I'm sorry, I couldn't record your request just now. Please call our main line at ${MAIN_LINE_SPOKEN}, and someone there will help you. ${ANYTHING_ELSE}`;
// The emergency lines keep their safety content word for word; they may only get warmer, never longer.
const EMERGENCY_LOGGED = "I've told our team. Are you safe right now?";
const EMERGENCY_DB_FAILED = "Please stay on the line. Are you safe right now?";
const EMAIL_ALREADY_SENT = `No worries, I've already sent that to your email on this call. ${ANYTHING_ELSE}`;
// A spelled address goes to staff as a pending update (capture_contact); nothing is sent to it.
const NO_EMAIL_ON_FILE =
  `I don't see an email address on your account. If you'd like, you can spell one for me, and I'll pass it to our team to add. Or you can find the same information at ${CLAIMS_URL_SPOKEN}. Which would you prefer?`;
const EMAIL_FAILED =
  `Sorry, that email didn't go through just now. You can find the same information at ${CLAIMS_URL_SPOKEN}, or I can have a representative send it. Which would you prefer?`;
const CONTACT_INVALID_EMAIL =
  "Hmm, I didn't quite catch a full email address. Could you spell it for me, letter by letter?";
const CONTACT_NEEDS_NAME = "Sorry, could I get your first and last name?";
// A phone caller said to use the number they're calling from, but the call carries no usable caller id.
const CONTACT_NEEDS_PHONE = "Sorry, I can't see the number you're calling from. What's the best number to reach you?";
const NOT_PENDING = "Sorry about that, let me take your details again. What's your first and last name?";
// A verified caller's name comes from the account, so only the address is asked for again.
const NOT_PENDING_EMAIL = "Sorry, could you spell that email for me one more time, letter by letter?";
// A verified caller's own address on file is never replaced from a call (account-takeover guard).
const EMAIL_ON_FILE =
  "There's already an email on your account, so I can't change it on this call, but I can have someone from our claims team call you back about it. Would you like that?";
const CONTACT_RETRY_EMAIL = "Sorry about that. Could you spell your email for me one more time, slowly?";
const CONTACT_RETRY_NAME = "Sorry about that. Could you tell me your first and last name one more time?";
const CONTACT_READBACK_PLAIN = "Just to confirm, did I get your details right?";
// start_claim / confirm_claim (first notice of loss).
const ANYTHING_ELSE_SHORT = "Is there anything else I can help with?";
// The caller has usually said what happened already (the greeting asks how Ava can help), so this asks
// for more rather than for the story again. It is the first sentence after the loss was reported, so it
// says sorry once; the resume question and the read-back after it do not say it again.
const START_CLAIM_QUESTION =
  "I'm sorry you're dealing with this. Let's get your claim started. Can you tell me a little more about what happened?";
// A start_claim earlier on the call was sent to verification or to the caller's details first: the loss
// was told then, so on a yes the model files it from what it already has.
const RESUME_CLAIM_QUESTION = "Shall I go ahead and take down that claim now?";
// These three answer a loss told before identity (start_claim's backstop), so each says sorry once; the
// resume question that follows verification or the caller's details does not say it again.
const CLAIM_NEEDS_LOOKUP =
  "I'm sorry to hear that. I can help you start a claim. First, what's the phone number on your account?";
const CLAIM_NEEDS_CONTACT =
  "I'm sorry to hear that. I can take down the details for our claims team. First, can I get your first and last name?";
const CLAIM_NEEDS_VERIFICATION =
  "I'm sorry to hear that. I'll just need to verify you first. What's the date of birth on the account?";
// The lock already said sorry (LOCKED), so this one does not say it again.
const CLAIM_LOCKED =
  "Since I wasn't able to verify your identity, I can't file a claim on this call. I can have a claims specialist call you back to help. Would you like that?";
const CLAIM_NEEDS_DESCRIPTION = "Can you tell me briefly what happened?";
const CLAIM_BAD_DATE = "Sorry, I didn't catch the date. What day did it happen?";
// The second date on the call the server could not read: a specialist helps rather than a third try.
const CLAIM_DATE_HELP = "No problem. A claims specialist can help pin down the date. Would you like a callback?";
// A new caller's confirmed details hold no number to call back on: the intake promises a call.
const CLAIM_NEEDS_PHONE = "Before I take this down, what's the best number for our claims team to reach you?";
const CLAIM_TOO_OLD =
  "Since that was more than a year ago, a claims specialist will need to help with this one. Would you like a callback?";
const CLAIM_NOT_PENDING = "I don't have the claim details yet. Can you tell me what happened?";
const CLAIM_RETRY = "No problem. What should I change?";
// Only when the read-back has nothing it can say (the tool never stores such an intake).
const CLAIM_READBACK_PLAIN = "Let me make sure I have this right. Did I get the details of your claim correct?";
const WEEKDAY_NAMES = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const MAX_READBACK_SUMMARY_CHARS = 80;

// ---------------------------------------------------------------------------------------------
// Phrasings. Every sentence has one phrasing: the chosen warm script ("Thanks! And just to keep
// your account safe...", "Thanks, Tobias. You're all verified.", "I've passed this to our claims
// team..."), so every call hears the same words. The selection plumbing stays (variantIndex picks
// 0..count-1 from the call key and the code, with no clock or randomness), so adding phrasings to a
// list rotates them again with the same replay guarantee: a VAPI retry of the same toolCallId and a
// ledger replay get the same words. Each list keeps the cue words the endpointing rules and the
// transcript masking key on ("date of birth", "right number", "that number", "your email is", "the
// best number is").
// ---------------------------------------------------------------------------------------------
/** How many phrasings each sentence list has (one: the warm script). */
export const PHRASINGS = 1;

/** The phrasing a call hears for one code: 0..count-1 from FNV-1a over the call key and the code.
 *  No clock, no randomness and no runtime hash seed, so every replay of the call picks the same one. */
export function variantIndex(callKey: string | undefined, code: string, count: number = PHRASINGS): number {
  if (typeof callKey !== "string" || callKey === "" || !Number.isInteger(count) || count <= 1) return 0;
  const text = `${callKey}|${code}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

function pick<T>(choices: readonly T[], callKey: string | undefined, code: string): T {
  return choices[variantIndex(callKey, code, choices.length)];
}

// "the date of birth on the account": a caller may be asking about a spouse's or a client's account.
// It opens with a thank-you for the number, and the verified opening thanks them again for the date
// of birth: that warmth beat a plainer opener.
const NEEDS_DOB = [
  "Thanks! And just to keep your account safe, what's the date of birth on the account?",
] as const;
// The first lookup miss reads the number back and asks whether it is right ("right number" is the
// endpointing cue for a corrected number in progress).
const NOT_FOUND_LEADS = ["I'm not finding an account under"] as const;
// The new-caller branch starts here: the sentence ends the turn, so it asks for the name itself. It
// says "if you're new", so a policyholder whose account is under another number can say so and be
// offered a callback instead of new-claim intake (branches-identity.md NOT FOUND).
const NOT_FOUND_FINAL = [
  "I'm sorry, I still can't find an account for that number. If you're new with us, I'd be glad to help you get started. Could I get your first and last name?",
] as const;
// The verified opening every verified answer shares (verifiedThanks), with the plain answer's question.
const VERIFIED_OPENINGS = [
  (name: string) => (name ? `Thanks, ${name}. You're all verified.` : "Thanks. You're all verified."),
] as const;
const VERIFIED_QUESTIONS = ["What can I help you with today?"] as const;
// rep_queued: "passed" means Telegram or the team email confirmed delivery (rep_recorded otherwise).
const REP_QUEUED_LEADS = ["I've passed this to our claims team."] as const;
const ANYTHING_ELSES = [ANYTHING_ELSE] as const;
// "emailed" only when Resend returned an id (the honest-result rule). A new caller's copy goes to the
// address they spelled on this call, not to any account.
const EMAIL_SENT = [
  (to: string) => `There you go, I've emailed that to ${to}. It should arrive within a few minutes. ${ANYTHING_ELSE}`,
] as const;
// Calm, not cheerful: a fire, a flood or an injury is often what was just filed.
const CLAIM_FILED_OPENERS = ["You're all set."] as const;
// The closing question of the claim answers (claim_filed, claim_intake_saved).
const CLAIM_CLOSINGS = [ANYTHING_ELSE_SHORT] as const;
// claim_intake_saved: the details went to the team (and the confirmation, when Resend took it).
const INTAKE_SAVED = [
  (thanks: string, mail: boolean) =>
    `${thanks} I've passed your claim details to our claims team${
      mail ? ", and sent a confirmation to your email" : ""
    }.`,
] as const;
const INTAKE_THANKS = [(name: string) => (name ? `Thanks, ${name}.` : "Thanks.")] as const;
// contact_saved_new: the read-back just thanked them, so this doesn't thank them again.
const CONTACT_SAVED_OPENERS = ["Perfect, I've saved your details."] as const;
const CHOICE_QUESTIONS = ["Which would you like?"] as const;
// start_claim's read-back: the opener, then the claim, the date and "Is that correct?".
// Exported for the battery's start_claim mock, which picks one the way claimReadbackOpener does.
export const CLAIM_READBACK_OPENERS = ["Let me make sure I have this right."] as const;
// capture_contact's read-back openers, with an email (spelled after "your email is") and without one.
const CONTACT_READBACK_OPENERS = [
  { spelled: "Thanks! Let me read that back.", plain: "Thanks! Just to confirm, that's" },
] as const;

/** The variant key of a claim read-back: the date and the summary it reads, so a replay of the same
 *  read-back gets the same opener and a corrected one is picked afresh. */
export function claimReadbackKey(lossDate: string, summary: string): string {
  return `claim_readback|${lossDate}|${summary}`;
}

/** start_claim's read-back opener for this call and this read-back ("Let me make sure I have this
 *  right."): lossDate is the ISO date it reads and summary the phrase it says ("" when it says none). */
export function claimReadbackOpener(callKey?: string, lossDate = "", summary = ""): string {
  return pick(CLAIM_READBACK_OPENERS, callKey, claimReadbackKey(lossDate, summary));
}

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

/** "+16025550199" or "6025550199" -> "six zero two, five five five, zero one nine nine". */
export function speakPhone(phone: string): string {
  let d = digitsOf(phone);
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  // Three groups with a comma between them, the way a person reads a number back: a comma gives a
  // short, even pause, where an ellipsis made the voice trail off and sound unsure.
  if (d.length !== 10) return speakDigits(d);
  return `${speakDigits(d.slice(0, 3))}, ${speakDigits(d.slice(3, 6))}, ${speakDigits(d.slice(6))}`;
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

// Day of the week of a proleptic Gregorian date, 0 = Sunday (Sakamoto's method): arithmetic only,
// like the rest of the speaker, so no zone can move it.
const WEEKDAY_MONTH_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
function weekdayOf(year: number, month: number, day: number): number {
  const y = month < 3 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + WEEKDAY_MONTH_OFFSETS[month - 1] + day) %
    7;
}

/** "2026-10-10" -> "Saturday, October tenth" (the year added as speakDate adds it). The weekday is
 *  computed from the calendar date alone, so it is the same in every zone. */
export function speakLossDate(isoDate: string, refYear?: number): string {
  const spoken = speakDate(isoDate, refYear); // throws on anything but a calendar date
  const [y, m, d] = isoDate.trim().split("-").map(Number);
  return `${WEEKDAY_NAMES[weekdayOf(y, m, d)]}, ${spoken}`;
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
const EMAIL_SYMBOL_WORDS: Readonly<Record<string, string>> = {
  ".": "dot",
  "_": "underscore",
  "-": "dash",
  "+": "plus",
};
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
// get_claim_status: a short summary by default, the details on request.
// ---------------------------------------------------------------------------------------------
/** One spoken turn's ceiling (style.md: short turns; rule 19: never more than 60 words). Every claims
 *  answer is composed to fit it. */
export const MAX_TURN_WORDS = 60;
// The summary reads at most this many clauses (claims read together count as one); the rest are counted.
const MAX_SUMMARY_ITEMS = 4;
// The documents answer lists at most this many claims; any other is mentioned, and the email lists it.
const MAX_DOCUMENT_CLAIMS = 2;

/** Spoken words in a finished sentence: every whitespace-separated token (figures are already words),
 *  except a token of digits and hyphens, such as the main line "1-800-555-0142", which is said a digit
 *  at a time and so counts one word per digit. */
export function spokenWords(text: string): number {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return 0;
  return t.split(/\s+/).reduce((n, w) => n + (/^[\d-]*\d[\d-]*[.,?!]?$/.test(w) ? w.replace(/\D/g, "").length : 1), 0);
}

function amountOf(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function refYearOf(refDate: string): number | undefined {
  const m = typeof refDate === "string" ? ISO_DATE.exec(refDate.trim()) : null;
  return m ? Number(m[1]) : undefined;
}

function capitalised(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// What needs the caller first (documents, a denial), then money, then claims in progress, then closed.
const STATUS_RANK: Readonly<Record<string, number>> = {
  awaiting_documents: 0,
  denied: 1,
  payment_issued: 2,
  approved: 2,
  under_review: 3,
  received: 4,
  closed: 5,
};

/** Two claims awaiting documents: the earlier due date first (it is the one that pauses a claim
 *  soonest), a claim with no due date after any that has one. 0 for any other pair. */
function dueOrder(a: Claim, b: Claim): number {
  if (a.status !== "awaiting_documents" || b.status !== "awaiting_documents") return 0;
  const due = (c: Claim) => (typeof c.documents_due === "string" ? c.documents_due : "");
  const [x, y] = [due(a), due(b)];
  if (x === y) return 0;
  if (!x || !y) return x ? -1 : 1;
  return x.localeCompare(y);
}

/** Reading order for claims: by what the caller has to act on first (among claims awaiting
 *  documents, the earliest due date first), then the newest filed. */
export function byReadingPriority(a: Claim, b: Claim): number {
  return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    dueOrder(a, b) ||
    String(b.filed_on).localeCompare(String(a.filed_on)) ||
    String(b.claim_number).localeCompare(String(a.claim_number));
}

/** "auto claim", or plain "claim" for a type off the list. */
function typeWords(c: Claim): string {
  return (CLAIM_TYPES as readonly string[]).includes(c.claim_type) ? `${c.claim_type} claim` : "claim";
}

/** The claim number's last three digits as words ("one one five"), or "" without three digits. */
function endingWords(c: Claim): string {
  return speakDigits(claimLast3(c.claim_number));
}

/** "Your auto claim ending in one one five". */
function claimHead(c: Claim): string {
  const ending = endingWords(c);
  return ending ? `Your ${typeWords(c)} ending in ${ending}` : `Your ${typeWords(c)}`;
}

const SORRY = "I'm sorry to say.";

/** One claim of the summary: where it stands, in a few words. Amounts and dates only where they are
 *  the status; the reason for a denial, the adjuster's note and the document list wait for a detail.
 *  sorry: whether a denial still says it is sorry (once a turn, rule 16). */
function summaryClause(c: Claim, refYear: number | undefined, sorry: boolean): string {
  const amount = amountOf(c.amount_approved);
  let body: string;
  switch (c.status) {
    case "received":
      body = `was received on ${speakDate(c.filed_on, refYear)} and is waiting for an adjuster.`;
      break;
    case "under_review": {
      const adjuster = speakableName(c.adjuster_name);
      body = adjuster ? `is under review with your adjuster, ${adjuster}.` : "is under review.";
      break;
    }
    case "awaiting_documents":
      body = c.documents_due
        ? `needs documents from you by ${speakDate(c.documents_due, refYear)}.`
        : "needs documents from you.";
      break;
    case "approved":
      body = amount !== null ? `was approved for ${speakMoney(amount)}.` : "was approved.";
      break;
    case "payment_issued": {
      const on = speakDate(c.updated_on, refYear);
      body = amount !== null ? `was paid, ${speakMoney(amount)} on ${on}.` : `was paid on ${on}.`;
      break;
    }
    case "denied":
      body = sorry ? `was denied, ${SORRY}` : "was denied.";
      break;
    case "closed":
      body = "is closed.";
      break;
    default:
      throw new Error("claimsSentence: unknown claim status");
  }
  return `${claimHead(c)} ${body}`;
}

// Statuses whose claims are read in one clause when two or more share them: nothing in the clause
// differs from claim to claim (a claim under review with a named adjuster is read on its own). The
// first form is a pair ("Your claims ending in X and Y were both ..."), the second any other group.
const GROUP_CLAUSES: Readonly<Record<string, readonly [two: string, more: string]>> = {
  received: ["were both received and are waiting for an adjuster.", "were received and are waiting for an adjuster."],
  under_review: ["are both under review.", "are under review."],
  denied: [`were both denied, ${SORRY}`, `were denied, ${SORRY}`],
  closed: ["are both closed.", "are closed."],
};

function groupKey(c: Claim): string | null {
  if (!(c.status in GROUP_CLAUSES) || !endingWords(c)) return null;
  return c.status === "under_review" && speakableName(c.adjuster_name) ? null : c.status;
}

/** "Your claims ending in zero nine zero and eight four nine were both received and ..."; three or
 *  more: "Three of your claims, ending in ..., were received and ...". A group that is every claim on
 *  the account says so instead ("Both of your claims, ending in ...", "All three of your claims, ...")
 *  and stands in for the count. */
function groupClause(group: Claim[], total: number): string {
  const [two, more] = GROUP_CLAUSES[group[0].status];
  const endings = listWords(group.map(endingWords));
  const count = numberToWords(group.length);
  if (group.length === total) {
    return `${group.length === 2 ? "Both" : `All ${count}`} of your claims, ending in ${endings}, ${more}`;
  }
  if (group.length === 2) return `Your claims ending in ${endings} ${two}`;
  return `${capitalised(count)} of your claims, ending in ${endings}, ${more}`;
}

interface SummaryItem {
  claims: Claim[];
  text: string;
}

/** The summary's clauses in reading order; a group stands where its newest claim would. Only the
 *  first denial says it is sorry. */
function summaryItems(claims: Claim[], refYear: number | undefined): SummaryItem[] {
  const ordered = [...claims].sort(byReadingPriority);
  const groups = new Map<string, Claim[]>();
  for (const c of ordered) {
    const key = groupKey(c);
    if (key) groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const items: SummaryItem[] = [];
  const read = new Set<string>();
  let sorry = true;
  for (const c of ordered) {
    const key = groupKey(c);
    const group = key ? groups.get(key) ?? [] : [];
    if (key && group.length >= 2) {
      if (read.has(key)) continue;
      read.add(key);
      items.push({ claims: group, text: groupClause(group, claims.length) });
      if (key === "denied") sorry = false;
    } else {
      items.push({ claims: [c], text: summaryClause(c, refYear, sorry) });
      if (c.status === "denied") sorry = false;
    }
  }
  for (const item of items) assertSpeakable(item.text);
  return items;
}

/** The question the summary ends on (one phrasing, as a list for pick): what the claims read lead to
 *  next. The documents question keeps its options in order ("the second one" is the email), and the
 *  denial's says "the reason" and "appeal", which the prompt's yes is about. */
function summaryQuestions(read: Claim[], total: number): readonly string[] {
  if (read.some((c) => c.status === "awaiting_documents")) {
    return ["Would you like me to go over what's needed, or email you the list?"];
  }
  if (read.some((c) => c.status === "denied")) return ["Would you like to hear the reason and how to appeal?"];
  return [`Do you have any questions about ${total === 1 ? "it" : total === 2 ? "either one" : "any of them"}?`];
}

/** The summary as spoken, and the claims it named (in reading order); the rest were only counted.
 *  How many clauses are read is decided against every phrasing of the closing question, so the
 *  phrasing a call hears never changes which claims it names. */
function summaryPlan(
  claims: Claim[],
  refDate: string,
  maxWords: number,
  callKey?: string,
): { text: string; read: Claim[] } {
  if (!Array.isArray(claims) || claims.length === 0) throw new Error("claimsSentence: no claims");
  const total = claims.length;
  const items = summaryItems(claims, refYearOf(refDate));
  // A group that is every claim already says how many there are.
  const lead = total > 1 && items[0].claims.length < total ? `You have ${numberToWords(total)} claims.` : "";
  const compose = (count: number) => {
    const read = items.slice(0, count).flatMap((item) => item.claims);
    const rest = total - read.length;
    const more = rest === 0
      ? ""
      : rest === 1
      ? "There's one more claim on file."
      : `There are ${numberToWords(rest)} more claims on file.`;
    const texts = summaryQuestions(read, total).map((question) =>
      [lead, ...items.slice(0, count).map((item) => item.text), more, question].filter(Boolean).join(" ")
    );
    return { texts, read };
  };
  let count = Math.min(MAX_SUMMARY_ITEMS, items.length);
  let plan = compose(count);
  while (count > 1 && plan.texts.some((t) => spokenWords(t) > maxWords)) plan = compose(--count);
  const text = pick(plan.texts, callKey, "ok");
  assertSpeakable(text);
  return { text, read: plan.read };
}

/** get_claim_status's summary (code ok) for a verified caller's claims (non-empty list): "You have two
 *  claims." when there are several, one short clause per claim (or per group of claims that read the
 *  same) in reading priority, and one closing question. At most four clauses, and only as many as fit
 *  maxWords; the claims left over are counted ("There's one more claim on file."), never dropped
 *  silently, and a question about which claim offers them first (claimsUnread). refDate = today
 *  (YYYY-MM-DD) in America/New_York. verify_identity's chained read passes what is left of the turn
 *  after its opening. callKey picks the closing question's phrasing (variantIndex). */
export function claimsSentence(
  claims: Claim[],
  refDate: string,
  maxWords: number = MAX_TURN_WORDS,
  callKey?: string,
): string {
  return summaryPlan(claims, refDate, maxWords, callKey).text;
}

/** The claims the default summary (a whole turn's words) only counted, in reading order. */
export function claimsUnread(claims: Claim[], refDate: string): Claim[] {
  const { read } = summaryPlan(claims, refDate, MAX_TURN_WORDS);
  return [...claims].sort(byReadingPriority).filter((c) => !read.includes(c));
}

const DOCUMENT_HOW =
  `You can upload them at ${CLAIMS_URL_SPOKEN}, or email them to claims docs at observeinsurance dot com.`;
const DOCUMENTS_QUESTION = "Would you like me to email you this list too?";
// A list too long to say, or a claim only mentioned: the email carries what was not read.
const DOCUMENTS_QUESTION_FULL = "Would you like me to email you the full list?";
// One claim's details when the adjuster's name leaves no room for how to send them: the documents
// answer (detail documents) says how, and the email carries the list.
const DOCUMENTS_HOW_QUESTION = "Would you like to hear how to send them, or have me email you this list?";
const DOCUMENTS_HOW_QUESTION_FULL = "Would you like to hear how to send them, or have me email you the full list?";
const NO_DOCUMENTS_NEEDED = "None of your claims needs documents right now. Is there anything else I can help with?";

/** The documents a claim still needs as one spoken list, or "" when there are none, any of them
 *  cannot be said (a partial list would tell the caller they are done when they are not), or the
 *  list is too long to read out. */
function documentList(c: Claim): string {
  const docs = (Array.isArray(c.documents_required) ? c.documents_required : []).map(speakableText);
  if (docs.length === 0 || !docs.every((d): d is string => d !== null)) return "";
  const list = listWords(docs);
  return list.length <= MAX_DOCUMENT_LIST_CHARS ? list : "";
}

/** "October twenty-fourth" for a claim's documents due date, or "" without one. */
function dueWords(c: Claim, refYear: number | undefined): string {
  return c.documents_due ? speakDate(c.documents_due, refYear) : "";
}

/** "For your home claim ending in one nine eight, we need photos of the damage, ..., by October
 *  twenty-fourth." Unlisted (or with nothing speakable to list): "a few documents". */
function documentsLine(c: Claim, refYear: number | undefined, withList: boolean): { text: string; listed: boolean } {
  const list = withList ? documentList(c) : "";
  const ending = endingWords(c);
  const due = dueWords(c, refYear);
  return {
    text: `For your ${typeWords(c)}${ending ? ` ending in ${ending}` : ""}, we need ${list || "a few documents"}${
      due ? `, by ${due}` : ""
    }.`,
    listed: list !== "",
  };
}

/** The claims awaiting documents that get no line of their own: mentioned, so none is missed. One is
 *  named by its ending (and its due date, when given) while that fits the turn. */
function documentsToo(rest: Claim[], named: boolean, due: string): string {
  if (rest.length === 0) return "";
  if (rest.length === 1) {
    if (!named) return "One more claim needs documents too.";
    return due ? `${claimHead(rest[0])} needs documents by ${due}.` : `${claimHead(rest[0])} needs documents too.`;
  }
  return `${capitalised(numberToWords(rest.length))} more claims need documents too.`;
}

/** claim_documents: what the claims awaiting documents need, by when, and how to send them, in one
 *  turn. At most two claims get a line (reading order: the earliest due date first); a list that does
 *  not fit becomes "a few documents", and a claim that does not fit is only mentioned (by its ending
 *  and due date while they fit). The closing offer of the email (which carries every list) says "the
 *  full list" whenever something was not read out. */
export function documentsSentence(claims: Claim[], refDate: string, maxWords: number = MAX_TURN_WORDS): string {
  const awaiting = (Array.isArray(claims) ? claims : []).filter((c) => c.status === "awaiting_documents")
    .sort(byReadingPriority);
  if (awaiting.length === 0) throw new Error("documentsSentence: no claim awaits documents");
  const refYear = refYearOf(refDate);
  const [first, second] = awaiting;
  const beyond = awaiting.slice(MAX_DOCUMENT_CLAIMS);
  const rest = awaiting.slice(1);
  const full = (c: Claim) => documentsLine(c, refYear, true);
  const brief = (c: Claim) => documentsLine(c, refYear, false);
  const secondDue = second ? dueWords(second, refYear) : "";
  type Plan = [lines: ReturnType<typeof documentsLine>[], mentioned: Claim[], named: boolean, due: string];
  // The most the turn can hold first: every list, then fewer lists, then the second claim only
  // mentioned (with its due date, then without), then not even named.
  const plans: Plan[] = second
    ? [
      [[full(first), full(second)], beyond, true, ""],
      [[full(first), brief(second)], beyond, true, ""],
      [[full(first)], rest, true, secondDue],
      [[full(first)], rest, true, ""],
      [[brief(first), brief(second)], beyond, true, ""],
      [[brief(first)], rest, true, secondDue],
      [[brief(first)], rest, true, ""],
      [[brief(first)], rest, false, ""],
    ]
    : [[[full(first)], [], true, ""], [[brief(first)], [], true, ""]];
  const texts = plans.map(([lines, mentioned, named, due]) => {
    const everyList = mentioned.length === 0 && lines.every((l) => l.listed);
    return [
      ...lines.map((l) => l.text),
      documentsToo(mentioned, named, due),
      DOCUMENT_HOW,
      everyList ? DOCUMENTS_QUESTION : DOCUMENTS_QUESTION_FULL,
    ].filter(Boolean).join(" ");
  });
  const text = texts.find((t) => spokenWords(t) <= maxWords) ?? texts[texts.length - 1];
  assertSpeakable(text);
  return text;
}

/** claim_detail for a claim awaiting documents: its list and due date, its adjuster, and how to send
 *  them, while they fit. When the adjuster and the instructions do not both fit, the adjuster is said
 *  and the question offers how to send them (the documents answer) or the email. */
function awaitingDetailSentence(c: Claim, refDate: string, maxWords: number): string {
  const refYear = refYearOf(refDate);
  const adjuster = speakableName(c.adjuster_name);
  const adjusterLine = adjuster ? `Your adjuster is ${adjuster}.` : "";
  const texts = [documentsLine(c, refYear, true), documentsLine(c, refYear, false)].flatMap(({ text, listed }) =>
    [
      [text, adjusterLine, DOCUMENT_HOW, listed ? DOCUMENTS_QUESTION : DOCUMENTS_QUESTION_FULL],
      ...(adjusterLine ? [[text, adjusterLine, listed ? DOCUMENTS_HOW_QUESTION : DOCUMENTS_HOW_QUESTION_FULL]] : []),
      [text, DOCUMENT_HOW, listed ? DOCUMENTS_QUESTION : DOCUMENTS_QUESTION_FULL],
    ].map((parts) => parts.filter(Boolean).join(" "))
  );
  const text = texts.find((t) => spokenWords(t) <= maxWords) ?? texts[texts.length - 1];
  assertSpeakable(text);
  return text;
}

/** One part of a claim's details. A required part is always said, in its short form when its full
 *  form does not fit; an optional one only while it fits. Parts are tried by rank (then in order) and
 *  spoken in order. */
interface DetailPart {
  text: string;
  full?: string;
  optional?: boolean;
  rank?: number;
}

function fitParts(parts: DetailPart[], closing: string, maxWords: number): string {
  const chosen = parts.map((p) => (p.optional ? "" : p.text));
  const compose = (said: string[]) => [...said.filter(Boolean), closing].join(" ");
  const tries = parts.map((p, i) => ({ p, i }))
    .filter(({ p }) => (p.optional ? p.text : p.full))
    .sort((a, b) => (a.p.rank ?? 0) - (b.p.rank ?? 0) || a.i - b.i);
  for (const { p, i } of tries) {
    const said = chosen.map((t, j) => (j === i ? (p.optional ? p.text : p.full!) : t));
    if (spokenWords(compose(said)) <= maxWords) chosen[i] = said[i];
  }
  return compose(chosen);
}

// The appeal: the window always; how to appeal (faq.json "Appeals") in the same sentence when it fits.
const APPEAL_WINDOW = "You have thirty days to appeal.";
const APPEAL_HOW =
  "To appeal, send us a short letter within thirty days, saying why you disagree, with any new photos or estimates.";

/** "direct deposit" from a payment note such as "Payment issued by direct deposit": how the payment
 *  went out, said in the payment's own clause rather than as a second sentence repeating it. */
function paymentMethod(note: string | null): string {
  const m = note ? /^payment (?:was )?issued\s+(?:by|via)\s+(.+?)[\s.]*$/i.exec(note) : null;
  return m && spokenWords(m[1]) <= 6 ? m[1] : "";
}

/** claim_detail: the whole story of one claim (its status, the adjuster, the claims system's note, a
 *  denial's reason and how to appeal) in one turn. A claim awaiting documents is told by its documents
 *  and its adjuster. The optional parts are said while they fit; the status and the appeal window
 *  always are. */
export function claimDetailSentence(c: Claim, refDate: string, maxWords: number = MAX_TURN_WORDS): string {
  if (typeof c !== "object" || c === null) throw new Error("claimDetailSentence: no claim");
  if (c.status === "awaiting_documents") return awaitingDetailSentence(c, refDate, maxWords);
  const refYear = refYearOf(refDate);
  const amount = amountOf(c.amount_approved);
  const adjuster = speakableName(c.adjuster_name);
  const note = claimText(c.status_detail);
  const noteLine = note ? sentenceCase(note) : "";
  const adjusterLine = adjuster ? `Your adjuster is ${adjuster}.` : "";
  let parts: DetailPart[];
  switch (c.status) {
    case "received":
      parts = [{
        text: `was received on ${speakDate(c.filed_on, refYear)} and is waiting for an adjuster to be assigned.`,
      }];
      break;
    case "under_review":
      parts = [
        { text: adjuster ? `is under review with your adjuster, ${adjuster}.` : "is under review." },
        { text: noteLine, optional: true },
      ];
      break;
    case "approved":
      parts = [
        { text: amount !== null ? `was approved for ${speakMoney(amount)}.` : "was approved." },
        { text: noteLine, optional: true },
        { text: adjusterLine, optional: true },
      ];
      break;
    case "payment_issued": {
      const payment = amount !== null ? `a payment of ${speakMoney(amount)}` : "a payment";
      const on = speakDate(c.updated_on, refYear);
      const method = paymentMethod(note);
      parts = [
        {
          text: `was approved, and ${payment} was issued on ${on}.`,
          full: method ? `was approved, and ${payment} was issued by ${method} on ${on}.` : undefined,
        },
        // a note that only says how the payment went is said in the clause above, never again
        { text: method ? "" : noteLine, optional: true, rank: 1 },
        { text: adjusterLine, optional: true, rank: 2 },
      ];
      break;
    }
    case "denied": {
      // The reason is the note's first clause (the seeded note goes on to the appeal window).
      const reason = claimText((c.status_detail ?? "").split(";")[0]);
      // Lower-case the first letter so the reason reads as a clause, but keep an acronym intact.
      const clause = reason && (/^[A-Z][A-Z]/.test(reason) ? reason : reason.charAt(0).toLowerCase() + reason.slice(1));
      // The summary already said it was sorry (rule 16): the details lead with the reason.
      parts = [
        {
          text: "was denied.",
          full: clause ? `was denied because ${clause.replace(/[\s.,:!?-]+$/, "")}.` : undefined,
          rank: 0,
        },
        { text: adjusterLine, optional: true, rank: 2 },
        { text: APPEAL_WINDOW, full: APPEAL_HOW, rank: 1 },
      ];
      break;
    }
    case "closed":
      parts = [
        { text: "is closed." },
        { text: noteLine, optional: true },
        { text: adjusterLine, optional: true },
      ];
      break;
    default:
      throw new Error("claimDetailSentence: unknown claim status");
  }
  const head = claimHead(c);
  parts[0] = { ...parts[0], text: `${head} ${parts[0].text}`, full: parts[0].full && `${head} ${parts[0].full}` };
  const text = fitParts(parts, ANYTHING_ELSE_SHORT, maxWords);
  assertSpeakable(text);
  return text;
}

/** The most claims a question about which claim offers (the rest stay on file for a later turn). */
export const MAX_WHICH_CLAIMS = 4;
// Only when no claim on offer has an ending to say: by type, never by a number (rule 11).
const NOT_IDENTIFIED = "Which claim do you mean, your auto, home or property claim?";
// Two claims of the same type with the same ending are told apart by where they stand.
const WHICH_STATUS: Readonly<Record<string, string>> = {
  received: "that was received",
  under_review: "that's under review",
  awaiting_documents: "that needs documents",
  approved: "that was approved",
  payment_issued: "that was paid",
  denied: "that was denied",
  closed: "that's closed",
};

function orWords(items: string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/** claim_not_identified from {claims: [{claim_number_last3, claim_type?, status?}]}: the claims the
 *  caller's words matched, or every claim with the ones the summary only counted first. The first
 *  four with an ending are offered by type and ending ("Which claim do you mean, your home claim
 *  ending in one nine eight or your auto claim ending in one one five?"; "Which auto claim do you
 *  mean, the one ending in ...?" when they share a type), and by where they stand when type and
 *  ending are the same. Without two endings to offer it asks by type. */
function notIdentified(d: Record<string, unknown>): string {
  const offered = (Array.isArray(d.claims) ? d.claims : [])
    .map((raw) => {
      const c = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
      const type = typeof c.claim_type === "string" && (CLAIM_TYPES as readonly string[]).includes(c.claim_type)
        ? c.claim_type
        : "";
      const status = typeof c.status === "string" && c.status in WHICH_STATUS ? c.status : "";
      return { last3: claimLast3(c.claim_number_last3), type, status };
    })
    .filter((c) => c.last3 !== "")
    .slice(0, MAX_WHICH_CLAIMS);
  if (offered.length < 2) return NOT_IDENTIFIED;
  const typed = offered.every((c) => c.type !== "");
  const sameType = typed && offered.every((c) => c.type === offered[0].type);
  const twin = (c: typeof offered[number]) =>
    offered.filter((o) => o.last3 === c.last3 && (!typed || o.type === c.type)).length > 1;
  const status = (c: typeof offered[number]) => (twin(c) && c.status ? ` ${WHICH_STATUS[c.status]}` : "");
  if (!typed || sameType) {
    const which = sameType ? `Which ${offered[0].type} claim do you mean` : "Which claim do you mean";
    if (!offered.some(twin)) return `${which}, the one ending in ${orWords(offered.map((c) => speakDigits(c.last3)))}?`;
    return `${which}, ${orWords(offered.map((c) => `the one ending in ${speakDigits(c.last3)}${status(c)}`))}?`;
  }
  return `Which claim do you mean, ${
    orWords(offered.map((c) => `your ${c.type} claim ending in ${speakDigits(c.last3)}${status(c)}`))
  }?`;
}

// ---------------------------------------------------------------------------------------------
// Code -> sentence.
// ---------------------------------------------------------------------------------------------
function isClaimList(v: unknown): v is Claim[] {
  return Array.isArray(v) && v.length > 0 &&
    v.every((c) => typeof c === "object" && c !== null && "claim_number" in c && "status" in c && "filed_on" in c);
}

/** A claims sentence from {claims, refDate}. Tools compose these directly; without the claims there is
 *  nothing true to say, so the honest fallback is the trouble line that offers a representative. */
function fromClaims(d: Record<string, unknown>, compose: (claims: Claim[], refDate: string) => string): string {
  if (!isClaimList(d.claims)) return SYSTEM_ERROR;
  try {
    return compose(d.claims, typeof d.refDate === "string" ? d.refDate : "");
  } catch {
    return SYSTEM_ERROR;
  }
}

function repQueued(d: Record<string, unknown>, callKey?: string): string {
  const last4 = digitsOf(d.digits).slice(-4);
  let at = "";
  if (d.target === "account") at = " at the number on your account";
  else if (d.target === "given") {
    at = last4 ? ` at the number you gave me, ending in ${speakDigits(last4)},` : " at the number you gave me";
  } else if (d.target === "caller_id") at = " at the number you're calling from";
  const i = variantIndex(callKey, "rep_queued");
  return `${REP_QUEUED_LEADS[i]} Someone will call you back${at} within one business day. ${ANYTHING_ELSES[i]}`;
}

/** "Thanks, Tobias. You're all verified." The opening every verified sentence shares (the plain one here,
 *  prior_contacts' welcome-back variant, and the chained claims read and file-claim openings built from
 *  them), so the name is cleaned the same way in all, and one call hears one phrasing of it. It stays
 *  neutral ("Thanks", not "Perfect"): a denial or a reported loss can follow it in the same breath. */
export function verifiedThanks(firstName: unknown, callKey?: string): string {
  return pick(VERIFIED_OPENINGS, callKey, "verified")(speakableName(firstName));
}

/** The verified sentence without its closing question: "Thanks, Tobias. You're all verified." (the
 *  welcome-back variant keeps its "Welcome back. I see you called on ..." part). */
export function withoutTrailingQuestion(sentence: string): string {
  const text = typeof sentence === "string" ? sentence.trim() : "";
  return text.endsWith("?") ? text.replace(/\s*[^.!?]*\?$/, "").trim() : text;
}

/** verify_identity with intent file_claim: the verified opening, then straight into the loss; or, when
 *  the loss was already told to a start_claim that asked for verification first (resume), whether to
 *  take it down now. */
export function verifiedFileClaimSentence(verified: string, resume = false): string {
  const opening = withoutTrailingQuestion(verified);
  const question = resume ? RESUME_CLAIM_QUESTION : START_CLAIM_QUESTION;
  return opening ? `${opening} ${question}` : question;
}

/** verify_identity with intent claim_status: the verified opening, then the status read itself. */
export function verifiedStatusSentence(verified: string, status: string): string {
  const opening = withoutTrailingQuestion(verified);
  return opening ? `${opening} ${status}` : status;
}

/** The last three digits of a claim number for speech, or "" when there are not three. */
function claimLast3(v: unknown): string {
  const d = digitsOf(v);
  return d.length >= 3 ? d.slice(-3) : "";
}

/** A short summary the read-back may say ("for a cracked windshield"): made speakable, first letter
 *  lower-cased (an acronym is kept), and left out when it is empty, too long or unsafe. */
function readbackSummary(raw: unknown): string {
  // template or markup characters mean the text is not the caller's phrase: say nothing of it
  if (typeof raw !== "string" || /[{}<>[\]]/.test(raw) || !/[A-Za-z]/.test(raw)) return "";
  const t = speakableText(raw);
  if (!t || t.length > MAX_READBACK_SUMMARY_CHARS) return "";
  const phrase = /^[A-Z][A-Z]/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
  return phrase.replace(/[\s.,:;!?-]+$/, "");
}

/** start_claim's read-back from {claim_type, loss_date, summary?, today?}: "Let me make sure I have
 *  this right. An auto claim, for a cracked windshield, from Saturday, October tenth. Is that
 *  correct?" The year is said only when it is not this year (today's). */
function claimReadback(d: Record<string, unknown>, callKey?: string): string {
  const type = typeof d.claim_type === "string" && (CLAIM_TYPES as readonly string[]).includes(d.claim_type)
    ? d.claim_type
    : "";
  const refMatch = typeof d.today === "string" ? ISO_DATE.exec(d.today.trim()) : null;
  let when = "";
  try {
    when = typeof d.loss_date === "string"
      ? speakLossDate(d.loss_date, refMatch ? Number(refMatch[1]) : undefined)
      : "";
  } catch {
    when = "";
  }
  if (!type || !when) return CLAIM_READBACK_PLAIN;
  const article = type === "auto" ? "An" : "A";
  const summary = readbackSummary(d.summary);
  const opener = claimReadbackOpener(callKey, typeof d.loss_date === "string" ? d.loss_date.trim() : "", summary);
  const full = `${opener} ${article} ${type} claim${summary ? `, for ${summary},` : ""} from ${when}. Is that correct?`;
  if (isSpeakable(full)) return full;
  const plain = `${opener} ${article} ${type} claim from ${when}. Is that correct?`;
  return isSpeakable(plain) ? plain : CLAIM_READBACK_PLAIN;
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
function contactReadback(d: Record<string, unknown>, callKey?: string): string {
  const first = speakableName(d.first_name);
  const full = speakableName(
    `${typeof d.first_name === "string" ? d.first_name : ""} ${typeof d.last_name === "string" ? d.last_name : ""}`,
  );
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
  // The full name is the first thing read back, so the thanks before it does not say the name too.
  const { spelled, plain } = pick(CONTACT_READBACK_OPENERS, callKey, "contact_readback");
  let text: string;
  if (email && number) {
    text = `${spelled} ${full}, your email is ${email}, and ${number}. Did I get that right?`;
  } else if (email) {
    text = `${spelled} ${full}, and your email is ${email}. Did I get that right?`;
  } else if (number) {
    text = `${plain} ${full}, and ${number}. Did I get that right?`;
  } else {
    text = `${plain} ${full}. Did I get that right?`;
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

/** Code -> sentence. data carries the few dynamic parts (see CONTRACTS); callKey picks the phrasing of
 *  a sentence whose list has several (variantIndex). Every list has one today, so a call key changes
 *  nothing: with or without one, every sentence is the warm script. */
export function sentenceFor(code: Code, data?: Record<string, unknown>, callKey?: string): string {
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
      const lead = pick(NOT_FOUND_LEADS, callKey, digits ? `${code}|${digits}` : code);
      return `${lead} ${digits ? speakPhone(digits) : "that number"}. Is that the right number?`;
    }
    case "not_found_final":
      return pick(NOT_FOUND_FINAL, callKey, code);
    case "needs_dob":
      return pick(NEEDS_DOB, callKey, code);
    case "already_verified":
      return ALREADY_VERIFIED;
    case "locked":
    case "dob_give_up":
      return LOCKED;
    case "verified":
      return `${verifiedThanks(d.first_name, callKey)} ${pick(VERIFIED_QUESTIONS, callKey, code)}`;
    case "auth_failed":
      return AUTH_FAILED;
    case "no_lookup_yet":
      return NO_LOOKUP_YET;
    case "dob_unreadable":
      return DOB_UNREADABLE;
    case "ok":
      return fromClaims(d, (claims, refDate) => claimsSentence(claims, refDate, MAX_TURN_WORDS, callKey));
    case "no_claims":
      return NO_CLAIMS;
    case "claim_documents":
      return fromClaims(d, documentsSentence);
    case "no_documents_needed":
      return NO_DOCUMENTS_NEEDED;
    case "claim_detail":
      return fromClaims(d, (claims, refDate) => {
        if (claims.length !== 1) throw new Error("claim_detail: expected one claim");
        return claimDetailSentence(claims[0], refDate);
      });
    case "claim_not_identified":
      return notIdentified(d);
    case "not_verified":
      if (d.level === "phone_found") return NOT_VERIFIED_PHONE_FOUND;
      if (d.level === "locked") return LOCKED;
      return NOT_VERIFIED_NONE;
    case "rep_queued":
      return repQueued(d, callKey);
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
      return pick(EMAIL_SENT, callKey, code)(
        d.target === "given" ? "the address you gave me" : "the address on your account",
      );
    case "email_already_sent":
      return EMAIL_ALREADY_SENT;
    case "no_email_on_file":
      return NO_EMAIL_ON_FILE;
    case "email_failed":
      return EMAIL_FAILED;
    case "contact_readback":
      return contactReadback(d, callKey);
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
      // The read-back just thanked them and said their full name, so this neither thanks them nor says
      // the name again; the name comes once more, warmly, when the claim is taken (claim_intake_saved).
      // A start_claim already asked for these details first: the loss was told, so it is taken down now.
      // Otherwise taking it down on this call comes first; without an address there is nothing to email
      // the steps to, so the website stands in.
      const i = variantIndex(callKey, code);
      const offer = d.resume_claim === true
        ? RESUME_CLAIM_QUESTION
        : d.has_email === false
        ? `I can take down what happened now, have someone from our claims team call you back, or you can find the steps to start a claim at ${CLAIMS_URL_SPOKEN}. ${
          CHOICE_QUESTIONS[i]
        }`
        : `I can take down what happened now, email you the steps to start a claim, or have someone from our claims team call you back. ${
          CHOICE_QUESTIONS[i]
        }`;
      return `${CONTACT_SAVED_OPENERS[i]} ${offer}`;
    }
    case "contact_saved_existing":
      // The read-back just thanked them and said their name, so this says neither again.
      return "Got it. I've passed that email to our team to add to your account. Is there anything else I can help with?";
    case "claim_readback":
      return claimReadback(d, callKey);
    case "claim_needs_lookup":
      return CLAIM_NEEDS_LOOKUP;
    case "claim_needs_contact":
      return CLAIM_NEEDS_CONTACT;
    case "claim_needs_verification":
      return CLAIM_NEEDS_VERIFICATION;
    case "claim_locked":
      return CLAIM_LOCKED;
    case "claim_needs_description":
      return CLAIM_NEEDS_DESCRIPTION;
    case "claim_bad_date":
      return CLAIM_BAD_DATE;
    case "claim_too_old":
      return CLAIM_TOO_OLD;
    case "claim_date_help":
      return CLAIM_DATE_HELP;
    case "claim_needs_phone":
      return CLAIM_NEEDS_PHONE;
    case "claim_already_filed": {
      const last3 = claimLast3(d.claim_last3);
      return `Your claim is already filed${
        last3 ? `, with a number ending in ${speakDigits(last3)}` : ""
      }. ${ANYTHING_ELSE_SHORT}`;
    }
    case "claim_not_pending":
      return CLAIM_NOT_PENDING;
    case "claim_retry":
      return CLAIM_RETRY;
    case "claim_filed": {
      const i = variantIndex(callKey, code);
      const last3 = claimLast3(d.claim_last3);
      const number = last3 ? `Your claim number ends in ${speakDigits(last3)}` : "Your claim is filed";
      // "emailed" only when Resend returned an id for the confirmation (the honest-result rule)
      const mail = d.emailed === true ? ", and I've emailed the details to the email on file" : "";
      return `${CLAIM_FILED_OPENERS[i]} ${number}${mail}. An adjuster will reach out within one business day. ${
        CLAIM_CLOSINGS[i]
      }`;
    }
    case "claim_intake_saved": {
      const i = variantIndex(callKey, code);
      const saved = INTAKE_SAVED[i](INTAKE_THANKS[i](speakableName(d.first_name)), d.emailed === true);
      return `${saved} A specialist will call you within one business day to finish setting it up. ${
        CLAIM_CLOSINGS[i]
      }`;
    }
    default: {
      // Exhaustive over CODES at compile time; an off-list code at runtime gets the trouble line.
      const _unreachable: never = code;
      return SYSTEM_ERROR;
    }
  }
}
