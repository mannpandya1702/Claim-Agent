import { TZDate } from "@date-fns/tz";
import { addDays, startOfDay } from "date-fns";
import { TIME_ZONE } from "./format";

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
