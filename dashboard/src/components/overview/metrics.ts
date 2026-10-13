import { dayKeysInRange, type DateRange } from "@/lib/dates";
import { callReasonMeta, etDayKey, formatDayKey, HUED_OUTCOMES, OUTCOME_META, OUTCOME_ORDER, SENTIMENT_META } from "@/lib/format";
import { CALL_REASONS, type CallReasonCount, type CallsByDayRow, type DashboardMetrics } from "@/lib/types";

/*
 * Pure shaping for the Overview page. Every number is aggregated in SQL (dashboard_metrics,
 * calls_by_day, call_reason_counts); this module only coerces types, fills zero days and orders
 * series so colors follow the outcome, never its rank.
 */

export type OutcomeKey = (typeof OUTCOME_ORDER)[number];

/** What the outcome charts draw: the three hued outcomes and one gray fold for the rest. */
export type StackKey = (typeof HUED_OUTCOMES)[number] | "other";
export const STACK_ORDER: readonly StackKey[] = [...HUED_OUTCOMES, "other"];

export const STACK_META: Record<StackKey, { label: string; color: string }> = {
  resolved: { label: OUTCOME_META.resolved.label, color: OUTCOME_META.resolved.color },
  escalated: { label: OUTCOME_META.escalated.label, color: OUTCOME_META.escalated.color },
  auth_failed: { label: OUTCOME_META.auth_failed.label, color: OUTCOME_META.auth_failed.color },
  other: { label: "Other", color: "var(--series-other)" },
};

/** The chart mark an outcome is drawn in. */
export function stackKeyOf(outcome: OutcomeKey): StackKey {
  return (HUED_OUTCOMES as readonly string[]).includes(outcome) ? (outcome as StackKey) : "other";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function countMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = num(v);
    if (n > 0) out[k] = n;
  }
  return out;
}

/**
 * PostgREST returns bigint and numeric inside jsonb as JSON numbers today, but a string or a
 * missing key must not render "NaN" or crash a tile, so every field is coerced here.
 */
export function normalizeMetrics(raw: unknown): DashboardMetrics {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    calls: num(r.calls),
    completed: num(r.completed),
    in_progress: num(r.in_progress),
    resolved: num(r.resolved),
    containment_rate: numOrNull(r.containment_rate),
    verification_attempted: num(r.verification_attempted),
    verification_success: num(r.verification_success),
    auth_failed: num(r.auth_failed),
    not_found: num(r.not_found),
    escalated: num(r.escalated),
    emergencies: num(r.emergencies),
    escalation_rate: numOrNull(r.escalation_rate),
    avg_handle_seconds: numOrNull(r.avg_handle_seconds),
    avg_cost: numOrNull(r.avg_cost),
    avg_latency_ms: numOrNull(r.avg_latency_ms),
    flagged: num(r.flagged),
    outcomes: countMap(r.outcomes),
    sentiments: countMap(r.sentiments),
    emails_sent: num(r.emails_sent),
    open_escalations: num(r.open_escalations),
    sla_breaches: num(r.sla_breaches),
    escalations_in_range: num(r.escalations_in_range),
  };
}

/** part / whole, or null when there is no whole (renders "n/a", never a fake 0%). */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Outcomes the server may add later fold into "unknown" instead of minting a new color. */
export function outcomeKey(outcome: string | null | undefined): OutcomeKey {
  return outcome && (OUTCOME_ORDER as readonly string[]).includes(outcome) ? (outcome as OutcomeKey) : "unknown";
}

// ---------------------------------------------------------------------------------------------
// Calls per day (stacked by outcome)
// ---------------------------------------------------------------------------------------------

export type DayRow = {
  day: string;
  total: number;
  /** Mark drawn last in this day's stack (gets the rounded data-end), null on a zero day. */
  top: StackKey | null;
  /** Mark sitting on the baseline (no surface gap below it). */
  bottom: StackKey | null;
  /** Calls in the folded outcomes, drawn as one gray segment. */
  other: number;
} & Record<OutcomeKey, number>;

export interface DailySeries {
  rows: DayRow[];
  /** Outcomes with at least one call in range, in OUTCOME_ORDER (the table's columns). */
  outcomes: OutcomeKey[];
  /** Marks with at least one call in range, in STACK_ORDER (the stack and legend order). */
  stack: StackKey[];
  /** Present outcomes that fold into Other, for the legend and tooltip. */
  folded: OutcomeKey[];
  /** Calls per outcome across the range. */
  totals: Record<OutcomeKey, number>;
  /** Calls per mark across the range, for the legend. */
  stackTotals: Record<StackKey, number>;
  total: number;
  /** The busiest day (first one on a tie); null when the range has no calls. */
  peak: { day: string; total: number } | null;
}

function zeroCounts(): Record<OutcomeKey, number> {
  return Object.fromEntries(OUTCOME_ORDER.map((k) => [k, 0])) as Record<OutcomeKey, number>;
}

/** Every Eastern day in the range (zero days included) with per-outcome counts. */
export function buildDailySeries(rows: CallsByDayRow[], range: DateRange): DailySeries {
  const byDay = new Map<string, Record<OutcomeKey, number>>();
  for (const day of dayKeysInRange(range)) byDay.set(day, zeroCounts());

  for (const row of rows) {
    // Rows outside the range only arrive as the previous range's placeholder while a new range
    // loads (the SQL buckets by the same Eastern days); the overlapping days are still correct.
    const counts = byDay.get(String(row.day).slice(0, 10));
    if (counts) counts[outcomeKey(row.outcome)] += num(row.n);
  }

  const totals = zeroCounts();
  const out: DayRow[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, counts]) => {
      let total = 0;
      let other = 0;
      for (const k of OUTCOME_ORDER) {
        const n = counts[k];
        totals[k] += n;
        total += n;
        if (stackKeyOf(k) === "other") other += n;
      }
      const marks = STACK_ORDER.filter((k) => (k === "other" ? other : counts[k]) > 0);
      return { day, total, top: marks[marks.length - 1] ?? null, bottom: marks[0] ?? null, other, ...counts };
    });

  let peak: DailySeries["peak"] = null;
  for (const r of out) if (r.total > 0 && (!peak || r.total > peak.total)) peak = { day: r.day, total: r.total };

  const outcomes = OUTCOME_ORDER.filter((k) => totals[k] > 0);
  const folded = outcomes.filter((k) => stackKeyOf(k) === "other");
  const stackTotals = Object.fromEntries(STACK_ORDER.map((k) => [k, 0])) as Record<StackKey, number>;
  for (const k of outcomes) stackTotals[stackKeyOf(k)] += totals[k];
  return {
    rows: out,
    outcomes,
    stack: STACK_ORDER.filter((k) => stackTotals[k] > 0),
    folded,
    totals,
    stackTotals,
    total: out.reduce((s, r) => s + r.total, 0),
    peak,
  };
}

// ---------------------------------------------------------------------------------------------
// Outcome mix (donut)
// ---------------------------------------------------------------------------------------------

export interface Slice {
  key: StackKey;
  label: string;
  description: string;
  color: string;
  value: number;
  /** 0..1 of all calls in range. */
  share: number;
  /** The outcomes folded into Other, each with its count (empty for a hued slice). */
  members: { key: OutcomeKey; label: string; value: number }[];
}

/** One row per outcome, for the table view: the full breakdown the chart folds. */
export interface OutcomeRow {
  key: OutcomeKey;
  label: string;
  value: number;
  share: number;
}

function mergeOutcomes(outcomes: Record<string, number>): { merged: Record<OutcomeKey, number>; total: number } {
  const merged = zeroCounts();
  for (const [k, v] of Object.entries(outcomes)) merged[outcomeKey(k)] += num(v);
  return { merged, total: OUTCOME_ORDER.reduce((s, k) => s + merged[k], 0) };
}

/**
 * Donut slices in STACK_ORDER (never by size, so a slice keeps its place and color): the hued
 * outcomes present, then one Other slice for everything else.
 */
export function buildOutcomeSlices(outcomes: Record<string, number>): Slice[] {
  const { merged, total } = mergeOutcomes(outcomes);
  if (total === 0) return [];
  const slices: Slice[] = HUED_OUTCOMES.filter((k) => merged[k] > 0).map((k) => ({
    key: k,
    label: OUTCOME_META[k].label,
    description: OUTCOME_META[k].description,
    color: OUTCOME_META[k].color,
    value: merged[k],
    share: merged[k] / total,
    members: [],
  }));
  const members = OUTCOME_ORDER.filter((k) => stackKeyOf(k) === "other" && merged[k] > 0).map((k) => ({
    key: k,
    label: OUTCOME_META[k].label,
    value: merged[k],
  }));
  const otherValue = members.reduce((s, m) => s + m.value, 0);
  if (otherValue > 0) {
    slices.push({
      key: "other",
      label: STACK_META.other.label,
      description: members.map((m) => m.label).join(", "),
      color: STACK_META.other.color,
      value: otherValue,
      share: otherValue / total,
      members,
    });
  }
  return slices;
}

export function buildOutcomeRows(outcomes: Record<string, number>): OutcomeRow[] {
  const { merged, total } = mergeOutcomes(outcomes);
  if (total === 0) return [];
  return OUTCOME_ORDER.filter((k) => merged[k] > 0).map((k) => ({
    key: k,
    label: OUTCOME_META[k].label,
    value: merged[k],
    share: merged[k] / total,
  }));
}

// ---------------------------------------------------------------------------------------------
// Sentiment mix (diverging stacked bar)
// ---------------------------------------------------------------------------------------------

export interface SentimentSegment {
  key: "negative" | "neutral" | "positive";
  label: string;
  color: string;
  value: number;
  /** 0..1 of calls that have a sentiment. */
  share: number;
}

export interface SentimentMix {
  /** Negative, neutral, positive: the bar reads left to right from one pole to the other. */
  segments: SentimentSegment[];
  rated: number;
  /** Calls with no sentiment yet (in progress, or the analysis did not arrive). */
  unrated: number;
}

export function buildSentimentMix(sentiments: Record<string, number>): SentimentMix {
  const keys = ["negative", "neutral", "positive"] as const;
  const values = keys.map((k) => num(sentiments[k]));
  const rated = values.reduce((s, n) => s + n, 0);
  const unrated = Object.entries(sentiments)
    .filter(([k]) => !(keys as readonly string[]).includes(k))
    .reduce((s, [, v]) => s + num(v), 0);
  return {
    segments: keys.map((k, i) => ({
      key: k,
      label: SENTIMENT_META[k].label,
      color: SENTIMENT_META[k].color,
      value: values[i]!,
      share: rated > 0 ? values[i]! / rated : 0,
    })),
    rated,
    unrated,
  };
}

// ---------------------------------------------------------------------------------------------
// Top call reasons (horizontal bars)
// ---------------------------------------------------------------------------------------------

export interface ReasonRow {
  key: string;
  label: string;
  description: string;
  value: number;
  /** 0..1 of calls that have a reason. */
  share: number;
}

export interface ReasonMix {
  /** Reasons with at least one call, most first (ties in CALL_REASONS order). */
  rows: ReasonRow[];
  tagged: number;
  /** Calls in range with no reason yet (in progress or untagged); null when the call total is unknown. */
  untagged: number | null;
}

function reasonOrder(key: string): number {
  const i = (CALL_REASONS as readonly string[]).indexOf(key);
  return i === -1 ? CALL_REASONS.length : i;
}

/**
 * Ranked rows from call_reason_counts. Every bar is one hue (it is one measure across
 * categories), so ranking by size never repaints anything. `calls` is dashboard_metrics' count
 * for the same range, which gives the calls still without a reason.
 */
export function buildReasonMix(counts: readonly CallReasonCount[], calls?: number | null): ReasonMix {
  const merged = new Map<string, number>();
  for (const c of counts) {
    const n = num(c.calls);
    if (!c.call_reason || n <= 0) continue;
    merged.set(c.call_reason, (merged.get(c.call_reason) ?? 0) + n);
  }
  const tagged = [...merged.values()].reduce((s, n) => s + n, 0);
  const rows = [...merged.entries()]
    .sort(([a, x], [b, y]) => y - x || reasonOrder(a) - reasonOrder(b) || (a < b ? -1 : 1))
    .map(([key, value]) => {
      const meta = callReasonMeta(key)!;
      return { key, label: meta.label, description: meta.description, value, share: tagged > 0 ? value / tagged : 0 };
    });
  const untagged = typeof calls === "number" && Number.isFinite(calls) ? Math.max(0, calls - tagged) : null;
  return { rows, tagged, untagged };
}

// ---------------------------------------------------------------------------------------------
// Range caption
// ---------------------------------------------------------------------------------------------

/** "Oct 6 – Oct 12" (or "Oct 12" for one day), in Eastern days, for the filter row. */
export function rangeCaption(range: DateRange): string {
  const first = etDayKey(range.from);
  const last = etDayKey(new Date(new Date(range.to).getTime() - 1));
  if (!first || !last) return "";
  return first === last ? formatDayKey(first) : `${formatDayKey(first)} – ${formatDayKey(last)}`;
}

/** Number of Eastern days the range spans. */
export function rangeDays(range: DateRange): number {
  return dayKeysInRange(range).length;
}
