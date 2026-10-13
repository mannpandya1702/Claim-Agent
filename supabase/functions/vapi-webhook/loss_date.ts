// The date of a loss as the caller said it ("yesterday", "last Tuesday", "October tenth", "10/10")
// -> a calendar date. start_claim passes the caller's words through unchanged, so the model never does
// date arithmetic: the server reads the phrase against today in New York and the read-back speaks the
// weekday and the date, which is where a misheard or misread date gets caught. Pure: the clock comes
// in as an argument and every calendar step is done on UTC dates, so neither the server's zone nor a
// DST change can move a date by a day. A hedge around a day ("Saturday, I think", "maybe yesterday")
// is the caller's best guess and is read as that day, and a weekend is read as its Saturday: the
// read-back speaks the weekday and date, so a wrong guess is corrected there. Anything else it cannot
// read for certain ("last week", "the other day", "a few days ago") is "unreadable", never a guess.

import { TIMEZONE } from "./enums.ts";

export type LossDateResult = { date: string } | { error: "unreadable" | "future" | "too_old" };

/** A loss older than this many days is past what the phone intake takes (a specialist handles it). */
export const MAX_LOSS_AGE_DAYS = 365;
// Longer text is not a date phrase; refusing it also bounds the matching work.
const MAX_INPUT_CHARS = 120;
const MAX_DAYS_AGO = 30;
const MAX_WEEKS_AGO = 4;
const DAY_MS = 86_400_000;

const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const UNIT_WORDS = "one two three four five six seven eight nine".split(" ");
const UNIT_ORDINALS = "first second third fourth fifth sixth seventh eighth ninth".split(" ");
const TEEN_WORDS = "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TEEN_ORDINALS =
  "tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(" ");

/** Word -> value for every number word a day of the month (or a count up to thirty) is said with. */
const WORD_VALUE = new Map<string, number>([
  ...UNIT_WORDS.map((w, i): [string, number] => [w, i + 1]),
  ...UNIT_ORDINALS.map((w, i): [string, number] => [w, i + 1]),
  ...TEEN_WORDS.map((w, i): [string, number] => [w, i + 10]),
  ...TEEN_ORDINALS.map((w, i): [string, number] => [w, i + 10]),
  ["twenty", 20],
  ["twentieth", 20],
  ["thirty", 30],
  ["thirtieth", 30],
]);
const ORDINAL_WORDS: ReadonlySet<string> = new Set([...UNIT_ORDINALS, ...TEEN_ORDINALS, "twentieth", "thirtieth"]);

const alt = (words: Iterable<string>) => [...words].sort((a, b) => b.length - a.length).join("|");
const MONTH = `(${alt(Object.keys(MONTHS))})`;
const WEEKDAY = `(${alt(Object.keys(WEEKDAYS))})`;
const UNIT = alt([...UNIT_WORDS, ...UNIT_ORDINALS]);
// a number said in words: "ten", "twenty one", "twenty-first", "thirtieth"
const NUMBER_WORDS = `(?:(?:twenty|thirty)(?:[ -](?:${UNIT}))?|twentieth|thirtieth|${
  alt([...TEEN_WORDS, ...TEEN_ORDINALS])
}|${UNIT})`;
// a day of the month: "10", "10th", "tenth", "twenty first"
const DAY = `(\\d{1,2}(?:st|nd|rd|th)?|${NUMBER_WORDS})`;
// an ordinal only (a bare "tenth" or "10th" is a day; a bare "10" is not)
const ORDINAL_DAY = `(\\d{1,2}(?:st|nd|rd|th)|${NUMBER_WORDS})`;
const YEAR_UNIT = alt(UNIT_WORDS);
// "2025", "twenty twenty five", "two thousand and twenty six"
const YEAR =
  `(\\d{4}|twenty[ -](?:twenty|thirty)(?:[ -](?:${YEAR_UNIT}))?|two thousand(?: and)? (?:twenty|thirty)(?:[ -](?:${YEAR_UNIT}))?)`;
// A weekday (or "yesterday") said before an explicit date ("Saturday, October tenth") is ignored: the
// read-back speaks the weekday of the date itself, so a mismatch is heard and corrected there.
const WEEKDAY_PREFIX = `(?:(?:(?:last|this past|past|this) )?(?:${
  alt(Object.keys(WEEKDAYS))
})|yesterday|today) (?:the )?`;

const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const NUMERIC_RE = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?$/;
const MONTH_FIRST_RE = new RegExp(`^${MONTH} (?:the )?${DAY}(?: (?:of )?${YEAR})?$`);
const DAY_FIRST_RE = new RegExp(`^(?:the )?${DAY} (?:of )?${MONTH}(?: (?:of )?${YEAR})?$`);
const THE_DAY_RE = new RegExp(`^(?:the ${DAY}|${ORDINAL_DAY})$`);
const WEEKDAY_RE = new RegExp(`^(?:(last|this past|past|this) )?${WEEKDAY}$`);
// "two nights ago" is two days ago; "a couple of days ago" is two.
const DAYS_AGO_RE = new RegExp(`^(\\d{1,2}|a couple(?: of)?|a|${NUMBER_WORDS}) (?:days?|nights?) ago$`);
const WEEKS_AGO_RE = new RegExp(`^(\\d|a couple(?: of)?|a|one|two|three|four) weeks? ago$`);
// A weekend is read as its Saturday: "last weekend" like "last Saturday", the others like "Saturday".
const WEEKEND_RE = /^(?:(last)|this past|past|over the|during the|the) weekend$/;
const WEEKDAY_PREFIX_RE = new RegExp(`^${WEEKDAY_PREFIX}`);

// Relative days, read after the fillers and a clock time are gone.
const RELATIVE: Readonly<Record<string, number>> = {
  "today": 0,
  "tonight": 0,
  "earlier today": 0,
  "just now": 0,
  "this morning": 0,
  "this afternoon": 0,
  "this evening": 0,
  "yesterday": 1,
  "last night": 1,
  "last evening": 1,
  "yesterday morning": 1,
  "yesterday afternoon": 1,
  "yesterday evening": 1,
  "yesterday night": 1,
  "the day before yesterday": 2,
  "day before yesterday": 2,
  "the night before last": 2,
  "night before last": 2,
};

// Words around a date that carry nothing ("it happened on", "I think", "around"), hedges included: a
// caller unsure of the day still names one, and the read-back is where it gets checked.
const LEADING_FILLER_RE =
  /^(?:um+|uh+|uhm|erm?|hmm+|oh|ok|okay|well|so|like|it (?:was|happened|all happened)|this (?:was|happened)|that (?:was|happened)|happened|i(?:'m| am) not (?:totally |entirely |completely |a hundred percent )?sure|im not sure|not sure|i don't know|i dont know|i(?:'m| am) (?:pretty )?sure|i think|i believe|i guess|i(?:'d| would) say|id say|i want to say|my best guess is|best guess|maybe|probably|sometime|back|around|about|approximately|roughly|early|late|on|it's|its|was)\s+/;
// The same hedges after the date ("Saturday, I think", "two days ago or so").
const TRAILING_FILLER_RE =
  /\s+(?:i think|i believe|i guess|i(?:'m| am) (?:pretty )?sure|i(?:'m| am) not (?:totally |entirely |completely )?sure|im not sure|not sure|maybe|probably|or so|or something|if i remember(?: right| correctly)?|i want to say)$/;
// A clock time after the date ("at 3 pm", "around 10:30", "at noon").
const CLOCK_TIME_RE =
  /\s+(?:at|around|about|by|near|roughly)(?:\s+(?:around|about|roughly))?\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight|night)(?:\s+or so)?$/;
// A part of the day after a date ("Tuesday night", "October tenth in the morning").
const DAY_PART_RE = /\s+(?:in the |at )?(?:morning|afternoon|evening|night|overnight)$/;

const TODAY_FORMAT = new Map<string, Intl.DateTimeFormat>();

/** Today in the zone as [year, month, day]. */
function todayIn(now: Date, tz: string): [number, number, number] {
  let format = TODAY_FORMAT.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    TODAY_FORMAT.set(tz, format);
  }
  const parts = format.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return [get("year"), get("month"), get("day")];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function valid(year: number, month: number, day: number): boolean {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth(year, month);
}

/** Days since 1970-01-01 of a calendar date (UTC arithmetic: no zone, no DST). */
function epochDay(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function isoOf(epoch: number): string {
  return new Date(epoch * DAY_MS).toISOString().slice(0, 10);
}

/** "10", "10th", "tenth", "twenty first", "twenty-one" -> 10 / 21; null for anything else. */
function numberValue(text: string): number | null {
  const digits = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(text);
  if (digits) return Number(digits[1]);
  const words = text.split(/[ -]/);
  if (words.length === 1) return WORD_VALUE.get(words[0]) ?? null;
  if (words.length !== 2 || (words[0] !== "twenty" && words[0] !== "thirty")) return null;
  const unit = WORD_VALUE.get(words[1]);
  return unit !== undefined && unit <= 9 ? WORD_VALUE.get(words[0])! + unit : null;
}

/** A count of days or weeks: "a" is one, "a couple (of)" two, else digits or words. */
function countValue(text: string): number | null {
  if (text === "a") return 1;
  if (text.startsWith("a couple")) return 2;
  return numberValue(text);
}

/** Whether a day said in digits carries a suffix, or in words is an ordinal ("tenth", "twenty first"). */
function isOrdinal(text: string): boolean {
  if (/^\d/.test(text)) return /\d(?:st|nd|rd|th)$/.test(text);
  return ORDINAL_WORDS.has(text.split(/[ -]/).at(-1) ?? "");
}

/** "2025", "twenty twenty five", "two thousand and twenty six" -> the year; null otherwise. */
function yearValue(text: string | undefined): number | null {
  if (text === undefined) return null;
  if (/^\d{4}$/.test(text)) return Number(text);
  const words = text.replace(/^two thousand(?: and)? /, "").replace(/^twenty[ -](?=twenty|thirty)/, "");
  const n = numberValue(words);
  return n === null || n < 20 ? null : 2000 + n;
}

/** Lower-case, accents folded, punctuation that is not part of a date dropped, fillers and a clock
 *  time removed. Slashes and hyphens between digits stay ("10/10", "2026-10-10"). */
function clean(text: string): string {
  let t = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/\b([ap])\.\s?m\.?/g, "$1m")
    .replace(/(\d)\s*([/-])\s*(?=\d)/g, "$1$2")
    .replace(/(\d)\.(?=\d{1,2}\b)/g, "$1/") // "10.10" said as a date
    .replace(/[^a-z0-9/:' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(LEADING_FILLER_RE, "").replace(TRAILING_FILLER_RE, "").replace(CLOCK_TIME_RE, "").trim();
    if (t === before) break;
  }
  return t;
}

/** The date of a past day: the most recent `weekday` on or before today (on today itself only when
 *  allowToday), as days back from today. */
function daysBackTo(weekday: number, todayWeekday: number, allowToday: boolean): number {
  const back = (todayWeekday - weekday + 7) % 7;
  return back === 0 && !allowToday ? 7 : back;
}

/** Read the phrase as a date relative to today. null: not a date this reader knows. Month-day phrases
 *  without a year land in the most recent year where they are not in the future; "the 10th" in the
 *  most recent month where it exists and is not in the future. */
function read(t: string, today: [number, number, number]): { y: number; m: number; d: number } | null {
  const [ty, tm, td] = today;
  const todayEpoch = epochDay(ty, tm, td);
  const back = (days: number) => {
    const iso = isoOf(todayEpoch - days);
    return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
  };

  if (t in RELATIVE) return back(RELATIVE[t]);
  const daysAgo = DAYS_AGO_RE.exec(t);
  if (daysAgo) {
    const n = countValue(daysAgo[1]);
    return n !== null && n >= 1 && n <= MAX_DAYS_AGO ? back(n) : null;
  }
  const weeksAgo = WEEKS_AGO_RE.exec(t);
  if (weeksAgo) {
    const n = countValue(weeksAgo[1]);
    return n !== null && n >= 1 && n <= MAX_WEEKS_AGO ? back(7 * n) : null;
  }
  const todayWeekday = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
  const weekend = WEEKEND_RE.exec(t);
  if (weekend) return back(daysBackTo(WEEKDAYS.saturday, todayWeekday, weekend[1] !== "last"));
  const weekday = WEEKDAY_RE.exec(t);
  if (weekday) {
    // "last Tuesday" on a Tuesday is a week ago; a bare "Tuesday" on a Tuesday is today
    const explicitPast = weekday[1] === "last" || weekday[1] === "this past" || weekday[1] === "past";
    return back(daysBackTo(WEEKDAYS[weekday[2]], todayWeekday, !explicitPast));
  }

  // Explicit dates may follow a weekday ("Saturday, October tenth"); it is dropped.
  const date = t.replace(WEEKDAY_PREFIX_RE, "");
  const iso = ISO_RE.exec(date);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };

  const numeric = NUMERIC_RE.exec(date);
  if (numeric) {
    const m = Number(numeric[1]);
    const d = Number(numeric[2]);
    // US order, as callers here say it; a two-digit year is this century's
    if (numeric[3] !== undefined) {
      const y = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
      return { y, m, d };
    }
    return latestYear(m, d, today);
  }

  const monthFirst = MONTH_FIRST_RE.exec(date);
  const dayFirst = monthFirst ? null : DAY_FIRST_RE.exec(date);
  if (monthFirst || dayFirst) {
    const monthWord = monthFirst ? monthFirst[1] : dayFirst![2];
    const dayWord = monthFirst ? monthFirst[2] : dayFirst![1];
    const yearWord = monthFirst ? monthFirst[3] : dayFirst![3];
    const m = MONTHS[monthWord];
    const d = numberValue(dayWord);
    if (d === null) return null;
    if (yearWord !== undefined) {
      const y = yearValue(yearWord);
      return y === null ? null : { y, m, d };
    }
    return latestYear(m, d, today);
  }

  const theDay = THE_DAY_RE.exec(date);
  if (theDay) {
    const word = theDay[1] ?? theDay[2];
    // a bare number word ("ten") is a count, not a day; "the ten" or "tenth" is a day
    if (theDay[1] === undefined && !isOrdinal(word)) return null;
    const d = numberValue(word);
    if (d === null) return null;
    // this month, else the month before when it is still to come (or this month has no such day)
    for (let k = 0; k < 2; k++) {
      const y = tm - k >= 1 ? ty : ty - 1;
      const m = tm - k >= 1 ? tm - k : 12;
      if (valid(y, m, d) && epochDay(y, m, d) <= todayEpoch) return { y, m, d };
    }
    return null;
  }
  return null;
}

/** Month and day without a year: this year, or last year when this year's is still to come. */
function latestYear(m: number, d: number, today: [number, number, number]): { y: number; m: number; d: number } | null {
  const [ty, tm, td] = today;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  // Compared as calendar positions, so February 29th resolves before validity is checked.
  const y = m > tm || (m === tm && d > td) ? ty - 1 : ty;
  return { y, m, d };
}

/** The caller's phrase -> {date: "YYYY-MM-DD"}, or why not: unreadable (not a date this reader knows
 *  for certain, or not a calendar date), future (after today in the zone), too_old (more than
 *  MAX_LOSS_AGE_DAYS before today). */
export function parseLossDate(text: unknown, now: Date, tz: string = TIMEZONE): LossDateResult {
  if (typeof text !== "string" || text.length > MAX_INPUT_CHARS) return { error: "unreadable" };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { error: "unreadable" };
  let today: [number, number, number];
  try {
    today = todayIn(now, tz);
  } catch {
    return { error: "unreadable" };
  }
  const t = clean(text);
  if (!t) return { error: "unreadable" };
  const found = read(t, today) ?? read(t.replace(DAY_PART_RE, "").trim(), today);
  if (!found || !valid(found.y, found.m, found.d) || found.y < 1900) return { error: "unreadable" };
  const age = epochDay(...today) - epochDay(found.y, found.m, found.d);
  if (age < 0) return { error: "future" };
  if (age > MAX_LOSS_AGE_DAYS) return { error: "too_old" };
  return { date: isoOf(epochDay(found.y, found.m, found.d)) };
}
