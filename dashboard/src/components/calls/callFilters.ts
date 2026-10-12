import { customCaption, customRange, DEFAULT_RANGE, parseCustomDays, presetRange, RANGE_PRESETS, type CustomDays, type RangePreset } from "@/lib/dates";
import { OUTCOMES, SENTIMENTS, type Outcome, type SearchCallsParams, type Sentiment } from "@/lib/types";

/*
 * The Calls filters live in the URL (#/calls?q=...&outcome=...), so a Telegram or email link
 * (#/calls?q=<call id>), a reload and the back button all land on the same slice. These helpers
 * are pure: parse what the URL says, write back only what differs from the defaults, and turn
 * the result into search_calls arguments.
 */

export const PAGE_SIZE = 25;

/** "custom" carries its two days in `from` / `to`. */
export type RangeValue = RangePreset | "all" | "custom";

export const RANGE_OPTIONS: { value: Exclude<RangeValue, "custom">; label: string }[] = [
  ...RANGE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
  { value: "all", label: "All time" },
];

/** Channels a caller can arrive on (unknown is a data fallback, not something to filter by). */
export const CHANNEL_FILTERS = ["webCall", "inboundPhoneCall", "outboundPhoneCall", "chat"] as const;

export interface CallFilters {
  q: string;
  range: RangeValue;
  /** Inclusive Eastern days of a custom range; null unless range is "custom". */
  custom: CustomDays | null;
  outcome: Outcome | null;
  sentiment: Sentiment | null;
  channel: string | null;
  flagged: boolean;
  escalated: boolean;
  /** Zero-based page index. */
  page: number;
}

export const DEFAULT_FILTERS: CallFilters = {
  q: "",
  range: DEFAULT_RANGE,
  custom: null,
  outcome: null,
  sentiment: null,
  channel: null,
  flagged: false,
  escalated: false,
  page: 0,
};

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const RANGE_VALUES: RangeValue[] = [...RANGE_OPTIONS.map((o) => o.value), "custom"];

/**
 * URL -> filters. Unknown values fall back to defaults rather than erroring. A link that carries
 * a search but no range (the alert deep link) searches all time, so an older call id still
 * resolves instead of hiding behind the default 7 days.
 */
export function parseFilters(params: URLSearchParams): CallFilters {
  const q = (params.get("q") ?? "").trim();
  const fallback: RangeValue = q ? "all" : DEFAULT_FILTERS.range;
  let range = oneOf(params.get("range"), RANGE_VALUES) ?? fallback;
  // A custom range is only as good as its two days; a broken link falls back like an unknown range.
  const custom = range === "custom" ? parseCustomDays(params.get("from"), params.get("to")) : null;
  if (range === "custom" && !custom) range = fallback;
  const pageNum = Number.parseInt(params.get("page") ?? "", 10);
  return {
    q,
    range,
    custom,
    outcome: oneOf(params.get("outcome"), OUTCOMES),
    sentiment: oneOf(params.get("sentiment"), SENTIMENTS),
    channel: oneOf(params.get("channel"), CHANNEL_FILTERS),
    flagged: params.get("flagged") === "1",
    escalated: params.get("escalated") === "1",
    page: Number.isFinite(pageNum) && pageNum > 1 ? pageNum - 1 : 0,
  };
}

/** Filters -> URL. The range is always written when a search is present, so the parse is stable. */
export function serializeFilters(f: CallFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.range !== DEFAULT_FILTERS.range || f.q) p.set("range", f.range);
  if (f.range === "custom" && f.custom) {
    p.set("from", f.custom.from);
    p.set("to", f.custom.to);
  }
  if (f.outcome) p.set("outcome", f.outcome);
  if (f.sentiment) p.set("sentiment", f.sentiment);
  if (f.channel) p.set("channel", f.channel);
  if (f.flagged) p.set("flagged", "1");
  if (f.escalated) p.set("escalated", "1");
  if (f.page > 0) p.set("page", String(f.page + 1));
  return p;
}

/** True when anything narrows the list beyond the default date range. */
export function hasActiveFilters(f: CallFilters): boolean {
  return (
    f.q !== "" ||
    f.range !== DEFAULT_FILTERS.range ||
    f.outcome !== null ||
    f.sentiment !== null ||
    f.channel !== null ||
    f.flagged ||
    f.escalated
  );
}

/** Date bounds for a range value; "all" leaves both open, "custom" spans its two Eastern days. */
export function rangeBounds(
  range: RangeValue,
  now: Date = new Date(),
  custom: CustomDays | null = null,
): { from: string | null; to: string | null } {
  if (range === "all") return { from: null, to: null };
  if (range === "custom") {
    if (!custom) return rangeBounds(DEFAULT_FILTERS.range, now);
    return customRange(custom.from, custom.to);
  }
  const r = presetRange(range, now);
  return { from: r.from, to: r.to };
}

/** "Last 7 days", "All time" or the custom days ("Oct 1 – Oct 5"). */
export function rangeLabel(f: Pick<CallFilters, "range" | "custom">): string {
  if (f.range === "custom") return f.custom ? customCaption(f.custom) : "";
  return RANGE_OPTIONS.find((o) => o.value === f.range)?.label ?? "";
}

/** search_calls arguments. Booleans are sent only when on: false would mean "only unflagged". */
export function toSearchParams(f: CallFilters, bounds: { from: string | null; to: string | null }): SearchCallsParams {
  return {
    p_q: f.q || null,
    p_from: bounds.from,
    p_to: bounds.to,
    p_outcome: f.outcome,
    p_sentiment: f.sentiment,
    p_channel: f.channel,
    p_flagged: f.flagged ? true : null,
    p_escalated: f.escalated ? true : null,
    p_limit: PAGE_SIZE,
    p_offset: f.page * PAGE_SIZE,
  };
}

/** "26–50 of 132" style range for the footer. */
export function pageWindow(page: number, rowsOnPage: number, total: number | null): { first: number; last: number; total: number } {
  const first = rowsOnPage > 0 ? page * PAGE_SIZE + 1 : 0;
  const last = page * PAGE_SIZE + rowsOnPage;
  return { first, last, total: total ?? last };
}
