import { describe, expect, it } from "vitest";
import { customRange, dayKeysInRange, etDayStart, presetRange } from "./dates";

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
