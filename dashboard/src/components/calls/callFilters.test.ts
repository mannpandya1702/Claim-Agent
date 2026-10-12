import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  hasActiveFilters,
  PAGE_SIZE,
  pageWindow,
  parseFilters,
  rangeBounds,
  rangeLabel,
  serializeFilters,
  toSearchParams,
} from "./callFilters";

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

describe("parseFilters / serializeFilters", () => {
  it("defaults to the last 7 days, first page, nothing else", () => {
    expect(parse("")).toEqual(DEFAULT_FILTERS);
    expect(serializeFilters(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("treats the alert deep link ?q=<call id> as an all-time search", () => {
    const f = parse("q=0b9c1f9e-1234-4abc-9def-001122334455");
    expect(f.q).toBe("0b9c1f9e-1234-4abc-9def-001122334455");
    expect(f.range).toBe("all");
    // Round trip keeps the range explicit so a reload means the same thing.
    expect(parse(serializeFilters(f).toString())).toEqual(f);
  });

  it("keeps an explicit range next to a search", () => {
    expect(parse("q=halvorsen&range=30d").range).toBe("30d");
  });

  it("ignores values that are not on the allow lists", () => {
    const f = parse("outcome=hacked&sentiment=angry&channel=fax&range=year&page=-3&flagged=yes");
    expect(f).toEqual(DEFAULT_FILTERS);
  });

  it("round-trips every filter, with a 1-based page in the URL", () => {
    const f = { ...DEFAULT_FILTERS, outcome: "escalated" as const, sentiment: "negative" as const, channel: "webCall", flagged: true, escalated: true, page: 2, range: "90d" as const };
    const qs = serializeFilters(f);
    expect(qs.get("page")).toBe("3");
    expect(parse(qs.toString())).toEqual(f);
  });

  it("round-trips a custom range of Eastern days and orders reversed days", () => {
    const f = parse("range=custom&from=2026-10-01&to=2026-10-05");
    expect(f.range).toBe("custom");
    expect(f.custom).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(serializeFilters(f).toString()).toBe("range=custom&from=2026-10-01&to=2026-10-05");
    expect(parse(serializeFilters(f).toString())).toEqual(f);
    expect(parse("range=custom&from=2026-10-05&to=2026-10-01").custom).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(hasActiveFilters(f)).toBe(true);
    expect(rangeLabel(f)).toBe("Oct 1 – Oct 5");
  });

  it("falls back to the default range when a custom link is broken or longer than a year", () => {
    expect(parse("range=custom&from=2026-02-30&to=2026-03-02")).toEqual(DEFAULT_FILTERS);
    expect(parse("range=custom&from=2026-10-01")).toEqual(DEFAULT_FILTERS);
    expect(parse("range=custom&from=2024-01-01&to=2026-01-01")).toEqual(DEFAULT_FILTERS);
    // with a search, the fallback is all time, as for any search link
    expect(parse("q=appeal&range=custom&from=bad&to=bad").range).toBe("all");
  });

  it("knows when anything narrows the list", () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, flagged: true })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, range: "all" })).toBe(true);
  });
});

describe("toSearchParams", () => {
  it("maps filters to search_calls arguments; off toggles are null, not false", () => {
    const p = toSearchParams({ ...DEFAULT_FILTERS, q: "appeal", page: 1 }, { from: "a", to: "b" });
    expect(p).toEqual({
      p_q: "appeal",
      p_from: "a",
      p_to: "b",
      p_outcome: null,
      p_sentiment: null,
      p_channel: null,
      p_flagged: null,
      p_escalated: null,
      p_limit: PAGE_SIZE,
      p_offset: PAGE_SIZE,
    });
    expect(toSearchParams({ ...DEFAULT_FILTERS, flagged: true, escalated: true }, { from: null, to: null })).toMatchObject({
      p_q: null,
      p_flagged: true,
      p_escalated: true,
    });
  });

  it("leaves both bounds open for all time and uses Eastern midnights otherwise", () => {
    expect(rangeBounds("all")).toEqual({ from: null, to: null });
    const today = rangeBounds("today", new Date("2026-10-12T18:00:00Z"));
    expect(today).toEqual({ from: "2026-10-12T04:00:00.000Z", to: "2026-10-13T04:00:00.000Z" });
  });

  it("spans a custom range from the first day's Eastern midnight to the midnight after the last", () => {
    expect(rangeBounds("custom", new Date(), { from: "2026-10-01", to: "2026-10-05" })).toEqual({
      from: "2026-10-01T04:00:00.000Z",
      to: "2026-10-06T04:00:00.000Z",
    });
    expect(rangeLabel({ range: "all", custom: null })).toBe("All time");
  });
});

describe("pageWindow", () => {
  it("describes the visible slice", () => {
    expect(pageWindow(0, 25, 132)).toEqual({ first: 1, last: 25, total: 132 });
    expect(pageWindow(5, 7, 132)).toEqual({ first: 126, last: 132, total: 132 });
    expect(pageWindow(0, 0, null)).toEqual({ first: 0, last: 0, total: 0 });
  });
});
