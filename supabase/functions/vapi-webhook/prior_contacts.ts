// Returning-caller memory: the welcome-back clause verify_identity speaks on a DOB match. It is
// composed by the server from the customer's last completed calls, so nothing is disclosed
// before verification and the model never has to remember to fetch history. Only the date of
// the newest prior call reaches the sentence; summaries, phone numbers and dates of birth never do.

import { TIMEZONE } from "./enums.ts";
import type { PriorInteraction } from "./types.ts";

const MAX_ROWS = 3;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINAL_ONES = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
const ORDINAL_TEENS = [
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
];

const nyDate = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric", month: "long", day: "numeric" });

function twoDigitWords(n: number): string {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
}

/** 10 -> "tenth", 21 -> "twenty first", 30 -> "thirtieth". */
function ordinalDay(day: number): string {
  if (day < 10) return ORDINAL_ONES[day];
  if (day < 20) return ORDINAL_TEENS[day - 10];
  const tens = Math.floor(day / 10);
  if (day % 10 === 0) return `${TENS[tens].slice(0, -1)}ieth`;
  return `${TENS[tens]} ${ORDINAL_ONES[day % 10]}`;
}

/** 2025 -> "twenty twenty five", 2005 -> "two thousand five", 1999 -> "nineteen ninety nine". */
function yearWords(year: number): string {
  if (year >= 2000 && year <= 2009) return year === 2000 ? "two thousand" : `two thousand ${ONES[year - 2000]}`;
  const head = twoDigitWords(Math.floor(year / 100));
  const tail = year % 100;
  if (tail === 0) return `${head} hundred`;
  return tail < 10 ? `${head} oh ${ONES[tail]}` : `${head} ${twoDigitWords(tail)}`;
}

function nyParts(d: Date): { year: number; month: string; day: number } {
  const parts = nyDate.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: Number(get("year")), month: get("month"), day: Number(get("day")) };
}

/** "October tenth" in New York, plus ", twenty twenty five" when the year is not this year. */
function spokenCallDate(at: Date, now: Date): string {
  const call = nyParts(at);
  const today = nyParts(now);
  const base = `${call.month} ${ordinalDay(call.day)}`;
  return call.year === today.year ? base : `${base}, ${yearWords(call.year)}`;
}

// Only full timestamps with an explicit zone: a zone-less string would be read in the runtime's
// local time and could land on the wrong day.
const ZONED_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;

function startedAt(row: PriorInteraction): Date | null {
  const s = typeof row?.started_at === "string" ? row.started_at.trim() : "";
  if (!ZONED_TIMESTAMP_RE.test(s)) return null;
  const d = new Date(s.replace(" ", "T"));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** First names are spoken by TTS: ASCII only (accents folded), single spaces. */
function spokenName(firstName: string): string {
  return String(firstName ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Verified sentence with optional welcome-back clause. rows = last completed interactions (newest first,
 *  already excluding this call). enabled=false, empty rows -> plain sentence. Date in words in America/New_York. */
export function verifiedSentence(firstName: string, rows: PriorInteraction[], enabled: boolean, now: Date): string {
  const name = spokenName(firstName);
  const thanks = name ? `Thank you, ${name}, you're verified.` : "Thank you, you're verified.";
  const plain = `${thanks} What can I help you with today?`;
  if (!enabled || !Array.isArray(rows) || rows.length === 0) return plain;

  let newest: Date | null = null;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const at = startedAt(row);
    if (at && (!newest || at.getTime() > newest.getTime())) newest = at;
  }
  if (!newest) return plain;
  return `${thanks} Welcome back. I see you called on ${spokenCallDate(newest, now)}. ` +
    "Is this about the same claim as last time, or something else?";
}
