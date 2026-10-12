import { dayKeysInRange, type DateRange } from "@/lib/dates";
import { etDayKey, formatDayKey, OUTCOME_META, OUTCOME_ORDER, SENTIMENT_META } from "@/lib/format";
import type { CallsByDayRow, DashboardMetrics } from "@/lib/types";

/*
 * Pure shaping for the Overview page. Every number is aggregated in SQL (dashboard_metrics,
 * calls_by_day); this module only coerces types, fills zero days and orders series so colors
 * follow the outcome, never its rank.
 */

export type OutcomeKey = (typeof OUTCOME_ORDER)[number];

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
  /** Outcome drawn last in this day's stack (gets the rounded data-end), null on a zero day. */
  top: OutcomeKey | null;
  /** Outcome sitting on the baseline (no surface gap below it). */
  bottom: OutcomeKey | null;
} & Record<OutcomeKey, number>;

export interface DailySeries {
  rows: DayRow[];
  /** Outcomes with at least one call in range, in OUTCOME_ORDER (the stack and legend order). */
  outcomes: OutcomeKey[];
  /** Calls per outcome across the range, for the legend. */
  totals: Record<OutcomeKey, number>;
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
      let top: OutcomeKey | null = null;
      let bottom: OutcomeKey | null = null;
      for (const k of OUTCOME_ORDER) {
        const n = counts[k];
        totals[k] += n;
        total += n;
        if (n > 0) {
          bottom ??= k;
          top = k;
        }
      }
      return { day, total, top, bottom, ...counts };
    });

  let peak: DailySeries["peak"] = null;
  for (const r of out) if (r.total > 0 && (!peak || r.total > peak.total)) peak = { day: r.day, total: r.total };

  return {
    rows: out,
    outcomes: OUTCOME_ORDER.filter((k) => totals[k] > 0),
    totals,
    total: out.reduce((s, r) => s + r.total, 0),
    peak,
  };
}

// ---------------------------------------------------------------------------------------------
// Outcome mix (donut)
// ---------------------------------------------------------------------------------------------

export interface Slice {
  key: OutcomeKey | "other";
  label: string;
  description: string;
  color: string;
  value: number;
  /** 0..1 of all calls in range. */
  share: number;
}

/** A donut stays readable only up to about six segments; past that the smallest fold into Other. */
export const MAX_SLICES = 6;

export function buildOutcomeSlices(outcomes: Record<string, number>, maxSlices = MAX_SLICES): Slice[] {
  const merged = zeroCounts();
  for (const [k, v] of Object.entries(outcomes)) merged[outcomeKey(k)] += num(v);
  const total = OUTCOME_ORDER.reduce((s, k) => s + merged[k], 0);
  if (total === 0) return [];

  const present = OUTCOME_ORDER.filter((k) => merged[k] > 0);
  const slice = (k: OutcomeKey): Slice => ({
    key: k,
    label: OUTCOME_META[k].label,
    description: OUTCOME_META[k].description,
    color: OUTCOME_META[k].color,
    value: merged[k],
    share: merged[k] / total,
  });
  if (present.length <= maxSlices) return present.map(slice);

  // "unknown" is already the gray "other" slot, so it always folds rather than showing two grays.
  const named = present.filter((k) => k !== "unknown");
  const keep = new Set<OutcomeKey>([...named].sort((a, b) => merged[b] - merged[a]).slice(0, maxSlices - 1));
  const folded = present.filter((k) => !keep.has(k));
  const otherValue = folded.reduce((s, k) => s + merged[k], 0);
  return [
    ...OUTCOME_ORDER.filter((k) => keep.has(k)).map(slice),
    {
      key: "other",
      label: "Other",
      description: folded.map((k) => OUTCOME_META[k].label).join(", "),
      color: "var(--series-other)",
      value: otherValue,
      share: otherValue / total,
    },
  ];
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
