import { describe, expect, it } from "vitest";
import {
  HUED_OUTCOMES,
  CALL_REASON_META,
  CALLER_TYPE_META,
  callerLabel,
  callerTypeMeta,
  callReasonMeta,
  channelLabel,
  etDayKey,
  flagMeta,
  FLAG_META,
  formatCalendarDate,
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
  isAsSaid,
  isDialable,
  isInProgress,
  maskPhone,
  minutesBetween,
  OUTCOME_META,
  OUTCOME_ORDER,
  outcomeMeta,
  sentimentMeta,
} from "./format";
import { CALL_REASONS, CALLER_TYPES, FLAGS, OUTCOMES } from "./types";

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
    // bare digits are a number noted as said: never labelled +1, whatever their shape
    expect(maskPhone("6025550199")).toBe("... 0199");
    expect(maskPhone("+44 20 7946 0958")).toBe("... 0958");
    expect(maskPhone(null)).toBe("—");
    expect(maskPhone("12")).toBe("...");
  });
  it("masks a number from abroad or one noted as said without claiming it is +1", () => {
    expect(maskPhone("+442079460958")).toBe("... 0958");
    expect(maskPhone("+61491570156")).toBe("... 0156");
    // ten digits that cannot be North American (exchange 155) are the caller's own words
    expect(maskPhone("9601550123")).toBe("... 0123");
    expect(maskPhone("5550177")).toBe("... 0177");
  });
  it("shows the full number on the detail page", () => {
    expect(formatPhone("+16025550101")).toBe("+1 602 555 0101");
    // noted as said (a caller abroad giving ten digits): shown as said, never as +1
    expect(formatPhone("6025550101")).toBe("602 555 0101");
    expect(formatPhone("16025550101")).toBe("160 255 501 01");
    // written by hand with its punctuation (an env value) reads as North American when it could be
    expect(formatPhone("(602) 555-0100")).toBe("+1 602 555 0100");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
    expect(formatPhone("+61491570156")).toBe("+61491570156");
    expect(formatPhone("9601550123")).toBe("960 155 0123");
    expect(formatPhone("02079460958")).toBe("020 794 609 58");
    expect(formatPhone("5550177")).toBe("555 0177");
    expect(formatPhone("weird")).toBe("weird");
  });
  it("dials only a number with its country code", () => {
    for (const n of ["+16025550101", "+442079460958", "+61491570156"]) expect(isDialable(n)).toBe(true);
    for (const n of ["9601550123", "6025550101", "5550177", "602-555-0101", "+4412", null, undefined]) {
      expect(isDialable(n)).toBe(false);
    }
    for (const n of ["9601550123", "6025550101", "5550177", "02079460958"]) expect(isAsSaid(n)).toBe(true);
    for (const n of ["+16025550101", "+442079460958", "555017", "1234567890123456", null]) expect(isAsSaid(n)).toBe(false);
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
  it("prints a calendar date column (a loss date) as written, with its weekday", () => {
    expect(formatCalendarDate("2026-10-10")).toBe("Sat, Oct 10, 2026");
    // year boundary and the DST change day keep their own day
    expect(formatCalendarDate("2026-01-01")).toBe("Thu, Jan 1, 2026");
    expect(formatCalendarDate("2026-11-01")).toBe("Sun, Nov 1, 2026");
    expect(formatCalendarDate(null)).toBe("—");
    expect(formatCalendarDate("last Tuesday")).toBe("last Tuesday");
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
  it("words every call reason and never invents one for a call without", () => {
    expect(CALL_REASONS.map((r) => CALL_REASON_META[r].label)).toEqual([
      "Claim status",
      "File a claim",
      "Documents",
      "General question",
      "Speak to an agent",
      "Update details",
      "Emergency",
      "Other",
    ]);
    for (const r of CALL_REASONS) expect(CALL_REASON_META[r].description.length).toBeGreaterThan(5);
    expect(callReasonMeta("speak_to_agent")).toMatchObject({ reason: "speak_to_agent", label: "Speak to an agent" });
    expect(callReasonMeta(null)).toBeNull();
    expect(callReasonMeta("")).toBeNull();
    expect(callReasonMeta("billing_dispute")?.label).toBe("Billing dispute");
    expect(FLAG_META.claim_promised_without_filing.label).toBe("Claim promised, not filed");
  });
  it("words every caller type and reads anything else as unknown, never a guess", () => {
    for (const t of CALLER_TYPES) expect(CALLER_TYPE_META[t].description.length).toBeGreaterThan(10);
    expect(callerTypeMeta("existing")).toMatchObject({ type: "existing", label: "Existing" });
    expect(callerTypeMeta("new")).toMatchObject({ type: "new", label: "New" });
    expect(callerTypeMeta("unknown")).toMatchObject({ type: "unknown", label: "Unknown" });
    expect(callerTypeMeta(null).type).toBe("unknown");
    expect(callerTypeMeta(undefined).type).toBe("unknown");
    expect(callerTypeMeta("returning").type).toBe("unknown");
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
