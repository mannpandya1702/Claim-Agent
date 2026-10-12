import { describe, expect, it } from "vitest";
import { customRange, presetRange } from "@/lib/dates";
import {
  buildDailySeries,
  buildOutcomeRows,
  buildOutcomeSlices,
  buildSentimentMix,
  normalizeMetrics,
  outcomeKey,
  rangeCaption,
  rangeDays,
  ratio,
} from "./metrics";

describe("normalizeMetrics", () => {
  it("coerces numeric strings, keeps null rates null and drops non-positive map entries", () => {
    const m = normalizeMetrics({
      calls: "12",
      containment_rate: "0.5",
      escalation_rate: null,
      avg_cost: "0.1423",
      outcomes: { resolved: "7", escalated: 0, bogus: "x" },
      sentiments: { positive: 3 },
    });
    expect(m.calls).toBe(12);
    expect(m.containment_rate).toBe(0.5);
    expect(m.escalation_rate).toBeNull();
    expect(m.avg_cost).toBeCloseTo(0.1423);
    expect(m.avg_latency_ms).toBeNull();
    expect(m.outcomes).toEqual({ resolved: 7 });
    expect(m.sentiments).toEqual({ positive: 3 });
    expect(m.flagged).toBe(0);
  });

  it("survives null and non-object input", () => {
    expect(normalizeMetrics(null).calls).toBe(0);
    expect(normalizeMetrics("nope").outcomes).toEqual({});
  });
});

describe("ratio and outcomeKey", () => {
  it("returns null without a denominator", () => {
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });

  it("folds unrecognised outcomes into unknown", () => {
    expect(outcomeKey("resolved")).toBe("resolved");
    expect(outcomeKey("transferred")).toBe("unknown");
    expect(outcomeKey(null)).toBe("unknown");
  });
});

describe("buildDailySeries", () => {
  const range = customRange("2026-10-06", "2026-10-12");

  it("fills zero days, stacks in outcome order and marks top, bottom and peak", () => {
    const s = buildDailySeries(
      [
        { day: "2026-10-07", outcome: "escalated", n: 2 },
        { day: "2026-10-07", outcome: "resolved", n: 3 },
        { day: "2026-10-09", outcome: "not_found", n: 1 },
        { day: "2026-10-12", outcome: "mystery", n: 4 },
      ],
      range,
    );
    expect(s.rows.map((r) => r.day)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
    const oct7 = s.rows[1]!;
    expect(oct7.total).toBe(5);
    expect(oct7.bottom).toBe("resolved");
    expect(oct7.top).toBe("escalated");
    expect(s.rows[0]!.top).toBeNull();
    expect(s.rows[6]!.unknown).toBe(4);
    expect(s.outcomes).toEqual(["resolved", "escalated", "not_found", "unknown"]);
    expect(s.totals.resolved).toBe(3);
    expect(s.total).toBe(10);
    expect(s.peak).toEqual({ day: "2026-10-07", total: 5 });
  });

  it("draws three hued outcomes and folds the rest into one Other mark, keeping the breakdown", () => {
    const s = buildDailySeries(
      [
        { day: "2026-10-12", outcome: "resolved", n: 2 },
        { day: "2026-10-12", outcome: "in_progress", n: 1 },
        { day: "2026-10-12", outcome: "emergency", n: 1 },
        { day: "2026-10-11", outcome: "not_found", n: 3 },
      ],
      range,
    );
    expect(s.stack).toEqual(["resolved", "other"]);
    expect(s.folded).toEqual(["not_found", "emergency", "in_progress"]);
    expect(s.stackTotals).toMatchObject({ resolved: 2, other: 5, escalated: 0, auth_failed: 0 });
    const oct12 = s.rows[6]!;
    expect(oct12.other).toBe(2);
    expect(oct12.in_progress).toBe(1);
    expect([oct12.bottom, oct12.top]).toEqual(["resolved", "other"]);
    expect(s.rows[5]!).toMatchObject({ other: 3, bottom: "other", top: "other" });
  });

  it("ignores rows outside the range (a previous range's placeholder)", () => {
    const s = buildDailySeries(
      [
        { day: "2026-09-20", outcome: "resolved", n: 9 },
        { day: "2026-10-12", outcome: "resolved", n: 1 },
      ],
      range,
    );
    expect(s.total).toBe(1);
    expect(s.rows).toHaveLength(7);
  });

  it("has no peak and no outcomes for an empty range", () => {
    const s = buildDailySeries([], range);
    expect(s.peak).toBeNull();
    expect(s.outcomes).toEqual([]);
    expect(s.rows.every((r) => r.total === 0)).toBe(true);
  });
});

describe("buildOutcomeSlices", () => {
  it("orders slices by outcome, not by size, with shares of the total", () => {
    const slices = buildOutcomeSlices({ auth_failed: 1, resolved: 6, escalated: 3 });
    expect(slices.map((s) => s.key)).toEqual(["resolved", "escalated", "auth_failed"]);
    expect(slices[0]!.share).toBeCloseTo(0.6);
    expect(slices.map((s) => s.color)).toEqual(["var(--series-1)", "var(--series-2)", "var(--series-3)"]);
  });

  it("never draws more than the three validated hues plus a gray Other that names its members", () => {
    const slices = buildOutcomeSlices({
      resolved: 20,
      escalated: 9,
      auth_failed: 8,
      not_found: 7,
      unsupported: 1,
      abandoned: 6,
      in_progress: 2,
      unknown: 30,
    });
    expect(slices.map((s) => s.key)).toEqual(["resolved", "escalated", "auth_failed", "other"]);
    const other = slices[3]!;
    expect(other.value).toBe(46);
    expect(other.color).toBe("var(--series-other)");
    expect(other.members.map((m) => [m.label, m.value])).toEqual([
      ["Not found", 7],
      ["Unsupported", 1],
      ["Abandoned", 6],
      ["In progress", 2],
      ["Unknown", 30],
    ]);
    expect(slices.reduce((s, x) => s + x.value, 0)).toBe(83);
  });

  it("keeps in_progress out of the outcome hues (it is a state)", () => {
    const slices = buildOutcomeSlices({ resolved: 2, in_progress: 1 });
    expect(slices.map((s) => [s.key, s.color])).toEqual([
      ["resolved", "var(--series-1)"],
      ["other", "var(--series-other)"],
    ]);
  });

  it("lists every outcome on its own row for the table view", () => {
    expect(buildOutcomeRows({ resolved: 3, not_found: 1 }).map((r) => [r.label, r.value, r.share])).toEqual([
      ["Resolved", 3, 0.75],
      ["Not found", 1, 0.25],
    ]);
  });

  it("returns nothing when there are no calls", () => {
    expect(buildOutcomeSlices({})).toEqual([]);
    expect(buildOutcomeRows({})).toEqual([]);
  });
});

describe("buildSentimentMix", () => {
  it("orders negative, neutral, positive and keeps unrated calls out of the shares", () => {
    const mix = buildSentimentMix({ positive: 6, neutral: 3, negative: 1, unknown: 4 });
    expect(mix.segments.map((s) => s.key)).toEqual(["negative", "neutral", "positive"]);
    expect(mix.rated).toBe(10);
    expect(mix.unrated).toBe(4);
    expect(mix.segments[2]!.share).toBeCloseTo(0.6);
  });

  it("gives zero shares when nothing is rated", () => {
    const mix = buildSentimentMix({ unknown: 2 });
    expect(mix.rated).toBe(0);
    expect(mix.segments.every((s) => s.share === 0)).toBe(true);
  });
});

describe("range helpers", () => {
  it("captions a multi-day and a one-day range in Eastern days", () => {
    expect(rangeCaption(customRange("2026-10-06", "2026-10-12"))).toBe("Oct 6 – Oct 12");
    expect(rangeCaption(customRange("2026-10-12", "2026-10-12"))).toBe("Oct 12");
  });

  it("counts days across a DST change", () => {
    // US clocks fall back on Nov 1, 2026; the range still spans exactly seven Eastern days.
    expect(rangeDays(customRange("2026-10-29", "2026-11-04"))).toBe(7);
    expect(rangeDays(presetRange("today", new Date("2026-10-12T15:00:00Z")))).toBe(1);
  });
});
