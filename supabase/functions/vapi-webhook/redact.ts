// PII redaction for every stored text: transcript, summary, messages, analysis_raw, escalation
// details and live transcript lines. Phone numbers and dates of birth arrive in whatever shape
// the caller, the ASR or the model produced, so matching is by shape (digit runs in any grouping,
// spoken digit words, full dates with a birth-plausible year), never by one canonical format.
// Email addresses likewise: written, or spelled aloud since callers give one by voice (capture_contact).

import { MAIN_LINE_SPOKEN } from "./enums.ts";

/** The masked replacement for a user turn that answers a sensitive question. */
export const MASKED_ANSWER = "[answer withheld]";

const DOB_TOKEN = "[date of birth]";
const EMAIL_TOKEN = "[email]";
const phoneToken = (digits: string) => `[phone ending ${digits.slice(-4)}]`;

// A date is DOB-shaped only with a year at least this many years back. Claim, filing and
// document-due dates (this year, last year, next year) stay readable; an account holder's birth
// year is never that recent.
const MIN_BIRTH_AGE_YEARS = 5;
const MIN_BIRTH_YEAR = 1900;

// Our own published number is not caller PII; redacting it would hide what the agent offered.
const MAIN_LINE_DIGITS = MAIN_LINE_SPOKEN.replace(/\D/g, "").replace(/^1/, "");

// ---------------------------------------------------------------------------------------------
// Number words
// ---------------------------------------------------------------------------------------------
const UNIT_VALUE = new Map<string, number>([
  ["zero", 0],
  ["oh", 0],
  ["o", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
]);
const TEEN_VALUE = new Map<string, number>([
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
]);
const TENS_VALUE = new Map<string, number>([
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
]);
const ORDINAL_VALUE = new Map<string, number>([
  ["first", 1],
  ["second", 2],
  ["third", 3],
  ["fourth", 4],
  ["fifth", 5],
  ["sixth", 6],
  ["seventh", 7],
  ["eighth", 8],
  ["ninth", 9],
  ["tenth", 10],
  ["eleventh", 11],
  ["twelfth", 12],
  ["thirteenth", 13],
  ["fourteenth", 14],
  ["fifteenth", 15],
  ["sixteenth", 16],
  ["seventeenth", 17],
  ["eighteenth", 18],
  ["nineteenth", 19],
  ["twentieth", 20],
  ["thirtieth", 30],
]);

const UNIT_ALT = "zero|oh|o|one|two|three|four|five|six|seven|eight|nine";
const CARD_UNIT_ALT = "one|two|three|four|five|six|seven|eight|nine";
const ORD_UNIT_ALT = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth";
const TEEN_ALT = [...TEEN_VALUE.keys()].join("|");
const ORD_TEEN_ALT =
  "tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth";
const TENS_ALT = [...TENS_VALUE.keys()].join("|");
// one space-or-hyphen joint inside a spoken number ("eighty six", "eighty-six")
const J = String.raw`(?:[ \t]*-[ \t]*|[ \t]+)`;

/** Words -> integer for the closed vocabulary the date patterns accept; null when unknown. */
function wordsValue(words: string[]): number | null {
  let total = 0;
  for (const w of words) {
    const v = UNIT_VALUE.get(w) ?? TEEN_VALUE.get(w) ?? TENS_VALUE.get(w) ?? ORDINAL_VALUE.get(w);
    if (v === undefined) return null;
    total += v;
  }
  return words.length ? total : null;
}

const splitWords = (s: string) => s.toLowerCase().split(/[\s,-]+/).filter((w) => w && w !== "and" && w !== "the");

// ---------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------
// One piece of a written or spoken number. A numeric piece glued to letters (a UUID segment,
// "14th") is never part of a phone; a word piece is a whole word. "plus" starts an international
// number said aloud ("plus four four, two zero seven, ...").
const PHONE_PIECE = [
  String.raw`\+?(?:\(\d+(?!\d)\)|\d+(?!\d))(?![A-Za-z_])`,
  String.raw`\b(?:double|triple)${J}(?:${UNIT_ALT}|\d)\b`,
  String.raw`\b(?:${TENS_ALT})(?:${J}(?:${CARD_UNIT_ALT}))?\b`,
  String.raw`\b(?:${TEEN_ALT})\b`,
  String.raw`\b(?:${UNIT_ALT})\b`,
  String.raw`\bplus\b`,
].join("|");
// Between pieces: spaces, a dash, a dot or an ellipsis ("six zero two... five five five"), a
// comma followed by a space (so "4,820" stays two numbers), or nothing right after a closing
// parenthesis ("(602)555-0101").
const PHONE_SEP = String.raw`(?:[ \t]*(?:\.{1,3}|-{1,2})[ \t]*|[ \t]*,[ \t]+|[ \t]+|(?<=\)))`;
// A run never starts inside a word, after "$", or after "LETTERS-" (CLM-240115, POL-7301).
const PHONE_RUN_RE = new RegExp(
  String.raw`(?<![\w$])(?<![A-Za-z]-)(?:${PHONE_PIECE})(?:${PHONE_SEP}(?:${PHONE_PIECE}))*`,
  "gi",
);
const PHONE_PIECE_RE = new RegExp(PHONE_PIECE, "gi");
// The fewest and the most digits a number given without the North American shape can have (E.164
// allows 15 after the country code).
const MIN_OTHER_DIGITS = 7;
const MAX_OTHER_DIGITS = 15;
// Right after these words a stretch of digits is something other than a phone, so only a full North
// American number counts: the claim endings a status sentence lists ("ending in one nine eight, one one
// five, zero nine zero") and a policy or claim number ("The policy number is 7301 2244.").
const CLAIM_ENDING_LEAD = /\b(?:ending|ends)(?:[ \t]+in)?[ \t,:]*$/i;
const REFERENCE_LEAD = /\b(?:policy|claim)[ \t]+(?:number|no\.?|#)(?:[ \t]+(?:is|was))?[ \t,:#]*$/i;

function pieceDigits(piece: string): string {
  const p = piece.toLowerCase();
  if (p === "plus") return "";
  if (!/[a-z]/.test(p)) return p.replace(/\D/g, "");
  const words = p.split(/[\s-]+/).filter(Boolean);
  if (words[0] === "double" || words[0] === "triple") {
    const d = /^\d$/.test(words[1]) ? words[1] : String(UNIT_VALUE.get(words[1]));
    return d.repeat(words[0] === "double" ? 2 : 3);
  }
  const tens = TENS_VALUE.get(words[0]);
  if (tens !== undefined) return String(tens + (words[1] ? UNIT_VALUE.get(words[1]) ?? 0 : 0));
  return String(TEEN_VALUE.get(words[0]) ?? UNIT_VALUE.get(words[0]));
}

interface Piece {
  start: number;
  end: number;
  digits: string;
  numeric: boolean; // written in figures
  spoken: boolean; // one digit said aloud ("zero" to "nine", "oh"), or "double" or "triple" and one
  plus: boolean; // "+44" or the word "plus": a country code follows
}

interface Hit {
  first: number;
  last: number;
  digits: string;
}

/** The phone starting at piece i: consecutive pieces adding up to exactly 10 digits, or 11 with
 *  a leading 1 (preferred). Aligning to piece boundaries keeps an adjacent year or count out. */
function phoneAt(pieces: Piece[], i: number): Hit | null {
  let digits = "";
  let ten: Hit | null = null;
  for (let j = i; j < pieces.length; j++) {
    // "plus" leads a number; later on it is a word between two numbers
    if (j > i && pieces[j].digits === "") break;
    digits += pieces[j].digits;
    if (digits.length === 10) ten = { first: i, last: j, digits };
    else if (digits.length === 11 && digits[0] === "1") return { first: i, last: j, digits };
    if (digits.length >= 11) break;
  }
  return ten;
}

const sepBefore = (run: string, pieces: Piece[], j: number) => run.slice(pieces[j - 1].end, pieces[j].start);
// A piece a number given digit by digit is made of: figures, or one digit said aloud. A counting word
// ("twenty", "fifteen") belongs to a year or an amount, and "plus" is a word between two numbers.
const phoneLike = (p: Piece) => p.numeric || p.spoken;
const single = (p: Piece) => p.spoken || (p.numeric && p.digits.length === 1);

/** Whether piece j continues the number piece j - 1 is part of. A sentence end (". " after a digit: "five
 *  eight. Two weeks ago") never joins; a comma joins digits said or written one at a time ("nine six zero,
 *  one five five"), never figures of two or more ("1200, 1500" and "2019, 2021" are lists); spaces, dashes,
 *  dots without a space and ellipses join. */
function joins(run: string, pieces: Piece[], j: number): boolean {
  const sep = sepBefore(run, pieces, j);
  if (/^[ \t]*\.[ \t]+$/.test(sep)) return false;
  return !sep.includes(",") || (single(pieces[j - 1]) && single(pieces[j]));
}

/** Where the stretch of pieces from i that reads as one number ends (exclusive): phone-like pieces that
 *  join (joins), stopping before a piece in stop. Piece i itself is the caller's to check. */
function stretchEnd(run: string, pieces: Piece[], i: number, stop: (k: number) => boolean): number {
  let end = i + 1;
  while (end < pieces.length && !stop(end) && phoneLike(pieces[end]) && joins(run, pieces, end)) end++;
  return end;
}

/** stretchEnd from every piece, stopping before a protected one, worked out once per run from the right,
 *  so a long run costs linear time. */
function stretchEnds(run: string, pieces: Piece[], blocked: Set<number>): number[] {
  const ends: number[] = new Array(pieces.length);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const next = i + 1;
    const joined = next < pieces.length && !blocked.has(next) && phoneLike(pieces[next]) && joins(run, pieces, next);
    ends[i] = joined ? ends[next] : next;
  }
  return ends;
}

/** The most pieces from i whose digits stay within 15 (after an international "00"), if they reach
 *  seven; null otherwise. */
function longestAt(pieces: Piece[], i: number, end: number): Hit | null {
  let digits = "";
  let best: Hit | null = null;
  for (let j = i; j < end; j++) {
    if (j > i && pieces[j].digits === "") break;
    const next = digits + pieces[j].digits;
    if (next.replace(/^00(?=[1-9])/, "").length > MAX_OTHER_DIGITS) break;
    digits = next;
    if (digits.replace(/^00(?=[1-9])/, "").length >= MIN_OTHER_DIGITS) best = { first: i, last: j, digits };
  }
  return best;
}

/** An international number said with its country code ("+44 20 7946 0958", "plus six one ...",
 *  "0044 20 ..."), within its stretch (ending at end), so a number after a sentence end or a list never
 *  joins it; a "+1" number is North American and left to phoneAt. */
function internationalAt(pieces: Piece[], i: number, end: number): Hit | null {
  let head = "";
  for (let j = i; j < end && head.length < 3; j++) head += pieces[j].digits;
  const prefixed = pieces[i].plus ? /^[2-9]/.test(head) : /^00[1-9]/.test(head);
  return prefixed ? longestAt(pieces, i, end) : null;
}

/** Whether the first ten digits of a longer stretch end on piece j at the close of a group: figures of
 *  two or more ("602 555 0101"), or a comma, a dash, a dot or an ellipsis after it rather than a space. */
function groupEnds(run: string, pieces: Piece[], j: number): boolean {
  if (pieces[j].numeric && pieces[j].digits.length > 1) return true;
  return j + 1 < pieces.length && !/^[ \t]+$/.test(sepBefore(run, pieces, j + 1));
}

/** A number of 11 to 15 digits given without a country code, said or read back in groups ("zero two
 *  zero, seven nine four, six zero nine, five eight", "0 2 0 7 9 4 6 0 9 5 8"), taken whole: a ten-digit
 *  match would leave its last digits in clear and name the wrong last four. Not a North American number
 *  with its 1 (phoneAt), and not one whose first ten digits close a group: that is a full North American
 *  number with something else after it ("602 555 0101 2 claims"). */
function longNumberAt(run: string, pieces: Piece[], i: number, end: number): Hit | null {
  if (!phoneLike(pieces[i])) return null;
  let digits = "";
  for (let j = i; j < end; j++) {
    digits += pieces[j].digits;
    if (digits.length > MAX_OTHER_DIGITS) return null; // longer: not a phone (every piece has a digit)
  }
  if (digits.length < 11 || (digits.length === 11 && digits[0] === "1")) return null;
  let count = 0;
  for (let j = i; j < end && count < 10; j++) {
    count += pieces[j].digits.length;
    if (count === 10 && groupEnds(run, pieces, j)) return null;
  }
  return { first: i, last: end - 1, digits };
}

const year = (p: Piece) => p.numeric && /^(?:19|20)\d\d$/.test(p.digits);
const short = (p: Piece | undefined) => !!p && p.numeric && p.digits.length >= 1 && p.digits.length <= 2;

/** Pieces that are something other than a phone even when their digits add up to one: a date
 *  (2026-10-08, 10 08 2026), a ZIP+4 (85004-1234), a span of years (2019-2026) or a decimal number
 *  (0.0123456). */
function protectedPieces(run: string, pieces: Piece[]): Set<number> {
  const out = new Set<number>();
  const sep = (j: number) => sepBefore(run, pieces, j);
  for (let j = 0; j < pieces.length; j++) {
    const [a, b, c] = [pieces[j], pieces[j + 1], pieces[j + 2]];
    if ((year(a) && short(b) && short(c)) || (short(a) && short(b) && c && year(c))) {
      out.add(j).add(j + 1).add(j + 2);
    }
    if (!b || !a.numeric || !b.numeric) continue;
    if (sep(j + 1) === "-" && a.digits.length === 5 && b.digits.length === 4) out.add(j).add(j + 1);
    if (year(a) && year(b) && /^\s*-?\s*$/.test(sep(j + 1))) out.add(j).add(j + 1);
    if (sep(j + 1) === "." && pieces.length === 2) out.add(j).add(j + 1);
  }
  return out;
}

/** Numbers given without the North American shape, in the pieces no full number took: a stretch
 *  (stretchEnd) of 7 to 15 digits, as a number from abroad or one said without its country code would
 *  be. A longer stretch is not a phone and is left whole (never partly redacted). */
function otherNumbers(run: string, pieces: Piece[], taken: boolean[], blocked: Set<number>): Hit[] {
  const stop = (k: number) => taken[k] || blocked.has(k);
  const hits: Hit[] = [];
  let i = 0;
  while (i < pieces.length) {
    if (stop(i) || !phoneLike(pieces[i])) {
      i++;
      continue;
    }
    const end = stretchEnd(run, pieces, i, stop);
    const digits = pieces.slice(i, end).map((p) => p.digits).join("");
    const count = digits.replace(/^00(?=[1-9])/, "").length;
    // Our own published line, however it was split ("five five five, zero one four two"), stays.
    const ownLine = digits.length < 11 && MAIN_LINE_DIGITS.endsWith(digits);
    if (count >= MIN_OTHER_DIGITS && count <= MAX_OTHER_DIGITS && !ownLine) {
      hits.push({ first: i, last: end - 1, digits });
    }
    i = end;
  }
  return hits;
}

function redactPhones(text: string): string {
  return text.replace(PHONE_RUN_RE, (run: string, offset: number) => {
    const pieces: Piece[] = [...run.matchAll(PHONE_PIECE_RE)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      digits: pieceDigits(m[0]),
      numeric: !/[a-z]/i.test(m[0]),
      spoken: /^(?:double|triple)\b/i.test(m[0]) || UNIT_VALUE.has(m[0].toLowerCase()),
      plus: m[0].startsWith("+") || m[0].toLowerCase() === "plus",
    }));
    const blocked = protectedPieces(run, pieces);
    const ends = stretchEnds(run, pieces, blocked);
    // A run glued to an identifier (a UUID segment), or right after claim endings or a policy or claim
    // number, holds only full numbers: North American, or international with its country code.
    const before = text.slice(Math.max(0, offset - 40), offset);
    const after = text.slice(offset + run.length, offset + run.length + 2);
    const guarded = CLAIM_ENDING_LEAD.test(before) || REFERENCE_LEAD.test(before) || /[A-Za-z0-9]-$/.test(before) ||
      /^-[A-Za-z0-9]/.test(after);
    // A full number: international with its country code, one of 11 to 15 digits without one, or North
    // American (our own line is kept).
    const taken = pieces.map(() => false);
    const hits: Hit[] = [];
    let i = 0;
    while (i < pieces.length) {
      // A stretch is taken whole from its first piece only: never the tail of a longer one (a card number).
      const free = !blocked.has(i);
      const starts = i === 0 || taken[i - 1] || blocked.has(i - 1) || !phoneLike(pieces[i - 1]) ||
        !joins(run, pieces, i);
      const hit = (free ? internationalAt(pieces, i, ends[i]) : null) ??
        (free && starts && !guarded ? longNumberAt(run, pieces, i, ends[i]) : null) ?? phoneAt(pieces, i);
      if (!hit) {
        i++;
        continue;
      }
      for (let k = hit.first; k <= hit.last; k++) taken[k] = true;
      if (hit.digits.slice(-10) !== MAIN_LINE_DIGITS) hits.push(hit);
      i = hit.last + 1;
    }
    if (!guarded) hits.push(...otherNumbers(run, pieces, taken, blocked));
    hits.sort((a, b) => a.first - b.first);
    let out = "";
    let cursor = 0;
    for (const hit of hits) {
      out += run.slice(cursor, pieces[hit.first].start) + phoneToken(hit.digits);
      cursor = pieces[hit.last].end;
    }
    return out + run.slice(cursor);
  });
}

// ---------------------------------------------------------------------------------------------
// Dates of birth
// ---------------------------------------------------------------------------------------------
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_ALT = [...MONTH_NAMES, "sept", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
  .join("|");
const MONTH = String.raw`(?:${MONTH_ALT})\b\.?`;

// Day of month as a numeral (14, 14th) or words (fourteen, fourteenth, twenty first).
const DAY =
  String.raw`(?:(?:3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)?|(?:twenty|thirty)${J}(?:${ORD_UNIT_ALT}|${CARD_UNIT_ALT})` +
  String.raw`|${ORD_TEEN_ALT}|${TEEN_ALT}|twentieth|thirtieth|twenty|thirty|${ORD_UNIT_ALT}|${CARD_UNIT_ALT})\b`;

// Year as digits (1986, '86, 86) or words (nineteen eighty six, nineteen oh five, two thousand
// five, eighty six). A bare two-digit year only counts here, right after a month and a day: that
// is how callers shorten a birth year, and the plausibility check still keeps recent years out.
const YEAR_TAIL = String
  .raw`(?:(?:oh|o|zero)${J}(?:${CARD_UNIT_ALT})|${TEEN_ALT}|(?:${TENS_ALT})(?:${J}(?:${CARD_UNIT_ALT}))?|hundred)`;
const SHORT_SPOKEN_YEAR = String
  .raw`(?:oh|o|zero)${J}(?:${CARD_UNIT_ALT})|(?:${TENS_ALT})(?:${J}(?:${CARD_UNIT_ALT}))?`;
const YEAR = String.raw`(?:(?:19|20)\d\d(?!\d)|'?\d\d(?!\d|[.,]\d)|(?:nineteen|twenty)${J}${YEAR_TAIL}\b` +
  String
    .raw`|two${J}thousand(?:${J}(?:and${J})?(?:${TEEN_ALT}|(?:${TENS_ALT})(?:${J}(?:${CARD_UNIT_ALT}))?|${CARD_UNIT_ALT}))?\b` +
  String.raw`|(?:${SHORT_SPOKEN_YEAR})\b)`;
const DAY_YEAR_SEP = String.raw`(?:[ \t]*,[ \t]*|[ \t]+)(?:of[ \t]+)?`;

const DOB_MONTH_FIRST_RE = new RegExp(
  String.raw`\b${MONTH},?[ \t]+(?:the[ \t]+)?(${DAY})${DAY_YEAR_SEP}(${YEAR})`,
  "gi",
);
const DOB_DAY_FIRST_RE = new RegExp(
  String.raw`\b(?:the[ \t]+)?(${DAY})[ \t]+(?:of[ \t]+)?${MONTH}${DAY_YEAR_SEP}(${YEAR})`,
  "gi",
);
// Numeric: the same separator twice; a following "T<digit>" (ISO timestamp) still counts.
const NUM_END = String.raw`(?:(?![\w/]|[.\-]\d)|(?=T\d))`;
const DOB_MDY_RE = new RegExp(String.raw`(?<![\w/.\-])(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})${NUM_END}`, "g");
const DOB_YMD_RE = new RegExp(String.raw`(?<![\w/.\-])((?:19|20)\d{2})([/.\-])(\d{1,2})\2(\d{1,2})${NUM_END}`, "g");
// "3 14 1986" or "3 14 86" as the ASR writes a spoken DOB; never the middle of a longer digit run.
const DOB_SPACED_RE =
  /(?<![\w.,$\-])(?<!\d[ \t])(\d{1,2})[ \t]+(\d{1,2})[ \t]+((?:19|20)\d{2}|\d{2})(?![\w]|[.,\-]\d)/g;
// A written address: local part, @, a dotted domain. Brackets and quotes end it, so the tokens
// this file writes are never read as part of one. Both parts are bounded at the RFC 5321 lengths
// (64 and 255): unbounded, a long run with no "@" was scanned again from every position (quadratic).
const EMAIL_RE = /[^\s@,;:<>()"'\[\]]{1,64}@[^\s@,;:<>()"'\[\]]{1,255}\.[A-Za-z]{2,24}(?![A-Za-z])/g;
// Every spoken-address pattern below must stay linear: this runs on every stored text, including the
// emergency note before the page goes out, and a synchronous regex cannot be cut off by a timer. So
// "dot" is never also a label token (each " dot " then ends exactly one label, one way), the
// alternatives inside a repeat never overlap, and every repeat inside one match is bounded.
//
// A spelled address as capture_contact reads it back (speak.ts speakEmail): letters, digits or symbol
// words joined by commas, "at", then dotted domain labels ("J, A, N, E, at gmail dot com", "A, at
// gmail dot com", "A, B, at E, X, A, M, P, L, E dot C, O").
const SPELLED_EMAIL_RE =
  /\b(?:[a-z0-9]+, ){1,64}at (?:(?!(?:dot|observeinsurance)\b)[a-z0-9]+(?:,? (?!dot\b)[a-z0-9]+){0,63} dot ){1,6}[a-z]+(?:, [a-z]\b){0,23}/gi;
// An address said aloud, as the ASR writes it without an @: a local part of words joined by spoken
// separators ("jane dot doe", "jane underscore doe", "jsmith") or of single letters ("j a n e"),
// then "at", then a domain said with "dot" ("acmecorp dot com", "i cloud dot com") or written
// ("yahoo.com"). Our own published domain is not caller PII (claims docs at observeinsurance dot com).
const SPOKEN_SEP = String.raw`(?:dot|period|underscore|dash|hyphen|plus)`;
const SPOKEN_LOCAL_UNIT = String
  .raw`(?:(?!(?:${SPOKEN_SEP}|at)\b)[a-z0-9][a-z0-9._+-]{0,62}[a-z0-9]|[a-z0-9]\b(?:,? [a-z0-9]\b){0,63})`;
const SPOKEN_LABEL = String
  .raw`(?!(?:dot|observeinsurance)\b)[a-z0-9][a-z0-9-]{0,62}(?: (?!dot\b)[a-z0-9][a-z0-9-]{0,62})?`;
const SPOKEN_DOMAIN = String.raw`(?:(?:${SPOKEN_LABEL}) dot ){1,6}[a-z]{2,24}\b` +
  String.raw`|(?!observeinsurance\b)[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,5}\.[a-z]{2,24}\b`;
const SPOKEN_EMAIL_RE = new RegExp(
  String.raw`\b${SPOKEN_LOCAL_UNIT}(?:,? ${SPOKEN_SEP},? ${SPOKEN_LOCAL_UNIT}){0,8},? at (?:${SPOKEN_DOMAIN})`,
  "gi",
);

function expandTwoDigitYear(yy: number, refYear: number): number {
  return 2000 + yy <= refYear ? 2000 + yy : 1900 + yy;
}

function yearValue(text: string, refYear: number): number | null {
  const t = text.trim();
  if (/^\d{4}$/.test(t)) return Number(t);
  if (/^'?\d{2}$/.test(t)) return expandTwoDigitYear(Number(t.replace("'", "")), refYear);
  const words = splitWords(t);
  if (words[0] === "two" && words[1] === "thousand") {
    if (words.length === 2) return 2000;
    const rest = wordsValue(words.slice(2));
    return rest === null || rest > 99 ? null : 2000 + rest;
  }
  const century = words[0] === "nineteen" ? 1900 : words[0] === "twenty" ? 2000 : null;
  if (century === null || words.length === 1 && words[0] === "twenty") {
    // a spoken two-digit year: "eighty six", "oh five", "twenty" alone
    const short = wordsValue(words);
    return short === null || short > 99 || words.some((w) => TEEN_VALUE.has(w) || ORDINAL_VALUE.has(w))
      ? null
      : expandTwoDigitYear(short, refYear);
  }
  const tail = words.slice(1);
  if (tail.length === 1 && tail[0] === "hundred") return century;
  const rest = wordsValue(tail);
  return rest === null || rest > 99 ? null : century + rest;
}

function dayValue(text: string): number | null {
  const t = text.trim().toLowerCase();
  const num = /^(\d{1,2})/.exec(t);
  if (num) return Number(num[1]);
  return wordsValue(splitWords(t));
}

function birthPlausible(year: number | null, refYear: number): boolean {
  return year !== null && year >= MIN_BIRTH_YEAR && year <= refYear - MIN_BIRTH_AGE_YEARS;
}

const validDay = (d: number | null) => d !== null && d >= 1 && d <= 31;

function redactDates(text: string, refYear: number): string {
  const words = (match: string, day: string, year: string) =>
    validDay(dayValue(day)) && birthPlausible(yearValue(year, refYear), refYear) ? DOB_TOKEN : match;
  // dayFirstOk: a numeric date that leads with month or day may be either (3/14/1986, 14/03/1986);
  // year-first is always year-month-day
  const numeric = (match: string, month: number, day: number, year: number, dayFirstOk: boolean) => {
    const md = month >= 1 && month <= 12 && day >= 1 && day <= 31;
    const dm = dayFirstOk && day >= 1 && day <= 12 && month >= 1 && month <= 31;
    return (md || dm) && birthPlausible(year, refYear) ? DOB_TOKEN : match;
  };
  return text
    .replace(DOB_MONTH_FIRST_RE, (m, day: string, year: string) => words(m, day, year))
    .replace(DOB_DAY_FIRST_RE, (m, day: string, year: string) => words(m, day, year))
    .replace(
      DOB_YMD_RE,
      (m, y: string, _s: string, mo: string, d: string) => numeric(m, Number(mo), Number(d), Number(y), false),
    )
    .replace(DOB_MDY_RE, (m, mo: string, _s: string, d: string, y: string) => {
      const year = y.length === 2 ? expandTwoDigitYear(Number(y), refYear) : Number(y);
      return numeric(m, Number(mo), Number(d), year, true);
    })
    .replace(DOB_SPACED_RE, (m, mo: string, d: string, y: string) => {
      const year = y.length === 2 ? expandTwoDigitYear(Number(y), refYear) : Number(y);
      return numeric(m, Number(mo), Number(d), year, true);
    });
}

function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, EMAIL_TOKEN).replace(SPELLED_EMAIL_RE, EMAIL_TOKEN).replace(
    SPOKEN_EMAIL_RE,
    EMAIL_TOKEN,
  );
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
/** redactPII against an explicit reference year (the DOB year bound); redactPII uses today's. */
export function redactPIIAsOf(text: string, refYear: number): string {
  // Addresses first, so the digits in one are never read as a phone or a date; then dates, so a
  // spoken DOB next to a phone is not read as part of the phone's digits.
  return redactPhones(redactDates(redactEmails(text), refYear));
}

/** Phone-like digit runs (602-555-0101, (602) 555 0101, +16025550101, 6025550101, spaced digits) -> "[phone ending 0101]";
 *  international numbers with a country code (+44 20 7946 0958, 0044 ..., "plus four four, ...") and any other
 *  stretch of 7 to 15 digits (a number said without its country code, 9601550123) the same way, except a date,
 *  a ZIP+4, a span of years, a decimal, a UUID segment, claim endings and our own main line;
 *  DOB-shaped dates (March 14, 1986 / 3/14/1986 / 1986-03-14 / 14 March 1986 / march fourteenth nineteen eighty six /
 *  march 14th 86 / 3 14 86) -> "[date of birth]"; email addresses, written or spelled aloud
 *  ("j, a, n, e, at gmail dot com", "jane at gmail dot com") -> "[email]".
 *  Claim numbers (CLM-240115) and money stay. Idempotent. null/undefined -> same. */
export function redactPII(text: string): string;
export function redactPII(text: null | undefined): null;
export function redactPII(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return redactPIIAsOf(String(text), new Date().getUTCFullYear());
}

// The base cues (date of birth, birthday, phone number, number on the account, ten-digit)
// plus the other server sentences whose answer is a DOB or a phone number: dob_unreadable asks
// for "the month, day and year", not_found asks "Is that the right number?", and
// rep_queued_no_number asks for "the best number". The model words its own follow-ups for a
// partial date ("When were you born?", "And what year?"), so those count too. A caller spelling
// an email address (or a name) answers "email address", "spell" or the read-back's "your email
// is", so that answer is withheld the same way: the confirmed address is kept in caller_contacts.
// The model words its own email questions too ("Could I get your email?", "What email should I
// use?"), so any question asking for an email counts; "that email" or "email the documents" does not.
// A number the model takes in pieces after missing it (rules.md rule 23: "Let's take the phone number
// three digits at a time.", then "And the next three digits?", "And the last four?") asks for each
// piece without saying "phone number", and a piece is too short for redactPII, so asking for digits
// or for the next or last group counts too.
// The window to the question mark is bounded, so a long line costs linear time.
const SENSITIVE_ASK_RE =
  /(date of birth|birth ?date|birthday|\bborn\b|\bDOB\b|(month|day|year) of birth|(what|which) year|phone number|number on (the|your) account|ten-digit|ten digit|month, day,? and (the )?year|(best|right) number|reach you|email address|\bspell|your email is|what(?:'s| is) (?:the best |your )?email|\b(?:your|an|which|what) email\b[^.?!]{0,80}\?|\bdigits\b|\b(?:next|last|first) (?:three|four)\b)/i;

/** A short re-ask of whatever the caller just said ("Sorry, I didn't quite catch that. Could you say that
 *  again?", rules.md rule 23, the low-confidence hook, bad_args), a line check when the caller can't
 *  hear Ava ("Sorry about that, can you hear me now?", "Yes, I can hear you.", "I'm still here.", rule
 *  25), or a hold line while they look for it (the silence hooks' "No rush, I'm right here." and "Take
 *  all the time you need.", or "Sure, take your time."). Right after a sensitive question each one still
 *  waits on the same answer, so the masking that question started carries on through it. */
export const REASK_RE =
  /\b(catch|caught|missed that|say (that|it) again|one more time|repeat that|hear (me|you)|(I['\u2019]m|I am) here|(right|still) here|take (all the|your) time)\b/i;

/** True when an assistant line asks for a date of birth, a phone number or an email address. */
export function asksForSensitive(assistantText: string | null | undefined): boolean {
  return typeof assistantText === "string" && SENSITIVE_ASK_RE.test(assistantText);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, refYear: number, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactPIIAsOf(value, refYear);
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(walk(item, refYear, seen));
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, refYear, seen);
    return out;
  }
  return value;
}

/** Deep-redact every string value in a JSON-like value (for analysis_raw). */
export function redactDeep<T>(value: T): T {
  return walk(value, new Date().getUTCFullYear(), new WeakMap()) as T;
}
