import { TZDate } from "@date-fns/tz";
import { addDays, startOfDay } from "date-fns";
import { formatDayKey, TIME_ZONE } from "./format";

/*
 * Date ranges for dashboard_metrics, calls_by_day and search_calls. Ranges are half-open
 * [from, to) and their edges are Eastern midnights, so a "day" here is the same day the SQL
 * buckets by and the digest reports.
 */

export type RangePreset = "today" | "7d" | "30d" | "90d";

export interface DateRange {
  /** ISO instant, inclusive. */
  from: string;
  /** ISO instant, exclusive. */
  to: string;
}

export const RANGE_PRESETS: { value: RangePreset; label: string; days: number }[] = [
  { value: "today", label: "Today", days: 1 },
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
];

export const DEFAULT_RANGE: RangePreset = "7d";

function iso(d: Date): string {
  return new Date(d.getTime()).toISOString();
}

/** The Eastern day containing `now` and the `days - 1` days before it. */
export function presetRange(preset: RangePreset, now: Date = new Date()): DateRange {
  const days = RANGE_PRESETS.find((p) => p.value === preset)?.days ?? 7;
  const today = startOfDay(new TZDate(now.getTime(), TIME_ZONE));
  return { from: iso(addDays(today, -(days - 1))), to: iso(addDays(today, 1)) };
}

/** Eastern midnight starting the given "YYYY-MM-DD" day. */
export function etDayStart(day: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Not a YYYY-MM-DD day: ${day}`);
  return new Date(new TZDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), TIME_ZONE).getTime());
}

/** Inclusive custom range of Eastern days, for the date pickers. */
export function customRange(fromDay: string, toDay: string): DateRange {
  const a = etDayStart(fromDay);
  const b = etDayStart(toDay);
  const [start, end] = a <= b ? [a, b] : [b, a];
  return { from: iso(start), to: iso(addDays(new TZDate(end.getTime(), TIME_ZONE), 1)) };
}

// ---------------------------------------------------------------------------------------------
// Custom ranges: two Eastern days in the URL (?range=custom&from=2026-10-01&to=2026-10-05)
// ---------------------------------------------------------------------------------------------

/** First and last Eastern day of a custom range, both inclusive, "YYYY-MM-DD". */
export interface CustomDays {
  from: string;
  to: string;
}

/** The daily chart draws one column per day; past a year it stops being readable. */
export const MAX_CUSTOM_DAYS = 366;

/** A real calendar day in "YYYY-MM-DD" form (2026-02-30 is not). */
export function isDayKey(value: string | null | undefined): value is string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Inclusive day count of a custom range (1 for a single day). */
export function customDayCount(days: CustomDays): number {
  const a = Date.UTC(...ymd(days.from));
  const b = Date.UTC(...ymd(days.to));
  return Math.round(Math.abs(b - a) / 86_400_000) + 1;
}

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y!, m! - 1, d!];
}

/**
 * Both days valid, in order, and within MAX_CUSTOM_DAYS; anything else is null so the page falls
 * back to its default range instead of erroring on a hand-edited link.
 */
export function parseCustomDays(from: string | null | undefined, to: string | null | undefined): CustomDays | null {
  if (!isDayKey(from) || !isDayKey(to)) return null;
  const days = from <= to ? { from, to } : { from: to, to: from };
  return customDayCount(days) <= MAX_CUSTOM_DAYS ? days : null;
}

/** "Oct 1 – Oct 5", or one day alone; the year appears when the two days are in different years. */
export function customCaption(days: CustomDays): string {
  if (days.from === days.to) return formatDayKey(days.from);
  if (days.from.slice(0, 4) !== days.to.slice(0, 4)) {
    return `${formatDayKey(days.from)}, ${days.from.slice(0, 4)} – ${formatDayKey(days.to)}, ${days.to.slice(0, 4)}`;
  }
  return `${formatDayKey(days.from)} – ${formatDayKey(days.to)}`;
}

/** Every Eastern day key in a range, so a chart can show zero-call days instead of skipping them. */
export function dayKeysInRange(range: DateRange): string[] {
  const keys: string[] = [];
  let cursor = new TZDate(new Date(range.from).getTime(), TIME_ZONE);
  const end = new Date(range.to).getTime();
  for (let i = 0; i < 400 && cursor.getTime() < end; i++) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    keys.push(`${y}-${m}-${d}`);
    cursor = addDays(cursor, 1);
  }
  return keys;
}
