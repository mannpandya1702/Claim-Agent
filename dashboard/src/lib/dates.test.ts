import { describe, expect, it } from "vitest";
import { customCaption, customDayCount, customRange, dayKeysInRange, etDayStart, isDayKey, parseCustomDays, presetRange } from "./dates";

describe("Eastern date ranges", () => {
  // 01:30Z on Oct 13 is still Oct 12 in New York (EDT, UTC-4).
  const now = new Date("2026-10-13T01:30:00Z");

  it("today spans the Eastern day, not the UTC day", () => {
    expect(presetRange("today", now)).toEqual({ from: "2026-10-12T04:00:00.000Z", to: "2026-10-13T04:00:00.000Z" });
  });

  it("last 7 days includes today and the six before it", () => {
    const r = presetRange("7d", now);
    expect(r.from).toBe("2026-10-06T04:00:00.000Z");
    expect(r.to).toBe("2026-10-13T04:00:00.000Z");
    expect(dayKeysInRange(r)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
  });

  it("handles the daylight-saving change (Nov 1, 2026)", () => {
    const r = customRange("2026-10-31", "2026-11-01");
    expect(r.from).toBe("2026-10-31T04:00:00.000Z");
    expect(r.to).toBe("2026-11-02T05:00:00.000Z");
    expect(dayKeysInRange(r)).toEqual(["2026-10-31", "2026-11-01"]);
  });

  it("accepts reversed custom days and rejects malformed ones", () => {
    expect(customRange("2026-10-12", "2026-10-10").from).toBe("2026-10-10T04:00:00.000Z");
    expect(() => etDayStart("10/12/2026")).toThrow();
  });
});

describe("custom ranges", () => {
  it("accepts only real calendar days", () => {
    expect(isDayKey("2026-10-12")).toBe(true);
    expect(isDayKey("2026-02-29")).toBe(false);
    expect(isDayKey("2028-02-29")).toBe(true);
    expect(isDayKey("2026-10-12T00:00")).toBe(false);
    expect(isDayKey(null)).toBe(false);
  });

  it("orders the two days, counts them inclusively and caps the span at a year", () => {
    expect(parseCustomDays("2026-10-05", "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(customDayCount({ from: "2026-10-01", to: "2026-10-05" })).toBe(5);
    expect(customDayCount({ from: "2026-10-12", to: "2026-10-12" })).toBe(1);
    expect(parseCustomDays("2025-10-12", "2026-10-12")).toEqual({ from: "2025-10-12", to: "2026-10-12" });
    expect(parseCustomDays("2025-10-11", "2026-10-12")).toBeNull();
  });

  it("captions a range, adding years only when they differ", () => {
    expect(customCaption({ from: "2026-10-01", to: "2026-10-05" })).toBe("Oct 1 – Oct 5");
    expect(customCaption({ from: "2026-10-12", to: "2026-10-12" })).toBe("Oct 12");
    expect(customCaption({ from: "2025-12-29", to: "2026-01-04" })).toBe("Dec 29, 2025 – Jan 4, 2026");
  });
});
