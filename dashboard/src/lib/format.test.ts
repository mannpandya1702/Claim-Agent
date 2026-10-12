import { describe, expect, it } from "vitest";
import {
  HUED_OUTCOMES,
  callerLabel,
  channelLabel,
  etDayKey,
  flagMeta,
  FLAG_META,
  formatCount,
  formatDate,
  formatDateTime,
  formatDayKey,
  formatDuration,
  formatLatency,
  formatMoney,
  formatPercent,
  formatPhone,
  formatRelative,
  formatStamp,
  formatTime,
  isInProgress,
  maskPhone,
  minutesBetween,
  OUTCOME_META,
  OUTCOME_ORDER,
  outcomeMeta,
  sentimentMeta,
} from "./format";
import { FLAGS, OUTCOMES } from "./types";

describe("durations and stamps", () => {
  it.each([
    [0, "0:00"],
    [7, "0:07"],
    [75, "1:15"],
    [599.6, "10:00"],
    [3725, "1:02:05"],
    [-4, "0:00"],
  ])("formatDuration(%s) = %s", (input, out) => {
    expect(formatDuration(input)).toBe(out);
  });

  it("shows a dash for a duration that does not exist yet", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("formatStamp is mm:ss and keeps counting minutes", () => {
    expect(formatStamp(0)).toBe("00:00");
    expect(formatStamp(9.99)).toBe("00:09");
    expect(formatStamp(65)).toBe("01:05");
    expect(formatStamp(3600)).toBe("60:00");
  });
});

describe("money, rates, latency, counts", () => {
  it("prints n/a for a missing cost, never $0", () => {
    expect(formatMoney(null)).toBe("n/a");
    expect(formatMoney(undefined)).toBe("n/a");
  });
  it("keeps three decimals below a dollar and two above", () => {
    expect(formatMoney(0.1423)).toBe("$0.142");
    expect(formatMoney("0.0870")).toBe("$0.087");
    expect(formatMoney(12.5)).toBe("$12.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(0.1, { digits: 2 })).toBe("$0.10");
  });
  it("formats rates and latency", () => {
    expect(formatPercent(0.724)).toBe("72%");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatLatency(820.4)).toBe("820 ms");
    expect(formatLatency(1440)).toBe("1.4 s");
    expect(formatLatency(null)).toBe("n/a");
  });
  it("compacts large counts only", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(12_900)).toBe("12.9K");
    expect(formatCount(null)).toBe("—");
  });
});

describe("phone numbers", () => {
  it("masks the middle digits for lists", () => {
    expect(maskPhone("+16025550101")).toBe("+1 602 ... 0101");
    expect(maskPhone("6025550199")).toBe("+1 602 ... 0199");
    expect(maskPhone("+44 20 7946 0958")).toBe("... 0958");
    expect(maskPhone(null)).toBe("—");
    expect(maskPhone("12")).toBe("...");
  });
  it("shows the full number on the detail page", () => {
    expect(formatPhone("+16025550101")).toBe("+1 602 555 0101");
    expect(formatPhone("weird")).toBe("weird");
  });
});

describe("dates are Eastern", () => {
  // 19:04Z on Oct 12 2026 is 3:04 PM EDT.
  const iso = "2026-10-12T19:04:09Z";
  it("formats date and time in America/New_York", () => {
    expect(formatDateTime(iso)).toBe("Oct 12, 3:04 PM");
    expect(formatDate(iso)).toBe("Oct 12");
    expect(formatTime(iso)).toBe("3:04 PM");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
  });
  it("buckets late-evening UTC instants into the Eastern day", () => {
    expect(etDayKey("2026-10-13T03:30:00Z")).toBe("2026-10-12");
    expect(etDayKey("2026-10-13T04:30:00Z")).toBe("2026-10-13");
  });
  it("prints a calls_by_day key without shifting the day", () => {
    expect(formatDayKey("2026-10-12")).toBe("Oct 12");
  });
  it("relative time and minutes use an injectable clock", () => {
    const now = new Date("2026-10-12T19:40:00Z");
    expect(formatRelative("2026-10-12T19:39:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-12T19:05:00Z", now)).toBe("35 minutes ago");
    expect(minutesBetween("2026-10-12T19:05:00Z", now)).toBe(35);
  });
});

describe("badge maps", () => {
  it("covers every outcome: three hued in slot order (the all-pairs cap), the rest in the gray fold", () => {
    for (const o of OUTCOMES) expect(OUTCOME_ORDER).toContain(o);
    expect(HUED_OUTCOMES.map((o) => OUTCOME_META[o].color)).toEqual(["var(--series-1)", "var(--series-2)", "var(--series-3)"]);
    expect(OUTCOME_ORDER.slice(0, 3)).toEqual([...HUED_OUTCOMES]);
    for (const o of OUTCOME_ORDER.slice(3)) expect(OUTCOME_META[o].color).toBe("var(--series-other)");
  });
  it("falls back to Unknown for null or unexpected outcomes", () => {
    expect(outcomeMeta(null).label).toBe("Unknown");
    expect(outcomeMeta("bogus").label).toBe("Unknown");
    expect(outcomeMeta("auth_failed").label).toBe("Auth failed");
  });
  it("maps sentiment onto the diverging scale", () => {
    expect(sentimentMeta("positive").color).toBe("var(--diverging-pos)");
    expect(sentimentMeta("negative").color).toBe("var(--diverging-neg)");
    expect(sentimentMeta(null).label).toBe("n/a");
  });
  it("explains every flag in plain English and humanizes unknown ones", () => {
    for (const f of FLAGS) expect(FLAG_META[f].explanation.length).toBeGreaterThan(20);
    expect(flagMeta("new_flag_kind").label).toBe("New flag kind");
  });
  it("labels callers, channels and live state", () => {
    expect(callerLabel(null)).toBe("Unknown caller");
    expect(callerLabel("  ")).toBe("Unknown caller");
    expect(callerLabel("Tobias Halvorsen")).toBe("Tobias Halvorsen");
    expect(channelLabel("webCall")).toBe("Web");
    expect(channelLabel(null)).toBe("Unknown");
    expect(isInProgress({ ended_at: null })).toBe(true);
    expect(isInProgress({ ended_at: "2026-10-12T19:04:09Z" })).toBe(false);
  });
});
