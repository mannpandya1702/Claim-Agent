import { describe, expect, it } from "vitest";
import type { EscalationListRow } from "@/lib/types";
import { callKeysOf, formatWait, parseKind, parseTab, summariseOpen, visibleRows } from "./queue";

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function esc(over: Partial<EscalationListRow>): EscalationListRow {
  return {
    id: "e",
    call_key: "call",
    kind: "representative",
    reason: "representative_requested",
    details: null,
    callback_phone_masked: null,
    channel: "webCall",
    verified: false,
    callback_source: "none",
    alert_status: "sent",
    delivery_error: null,
    status: "open",
    claimed_by: null,
    claimed_at: null,
    closed_by: null,
    closed_at: null,
    close_note: null,
    realerted_at: null,
    created_at: ago(1),
    updated_at: ago(1),
    ...over,
  };
}

describe("queue parsing", () => {
  it("falls back to the open tab and every kind for unknown values", () => {
    expect(parseTab("claimed")).toBe("claimed");
    expect(parseTab("done")).toBe("done");
    expect(parseTab("everything")).toBe("open");
    expect(parseTab(null)).toBe("open");
    expect(parseKind("emergency")).toBe("emergency");
    expect(parseKind("x")).toBe("all");
  });
});

describe("summariseOpen", () => {
  it("counts open rows, SLA breaches (30 minutes and older) and the oldest wait", () => {
    const s = summariseOpen(
      [
        esc({ id: "a", created_at: ago(42) }),
        esc({ id: "b", created_at: ago(30) }),
        esc({ id: "c", created_at: ago(29), kind: "emergency" }),
        esc({ id: "d", created_at: ago(90), status: "claimed" }),
      ],
      NOW,
    );
    expect(s).toEqual({ open: 3, breached: 2, oldestMinutes: 42, oldestAt: ago(42), emergencies: 1 });
  });

  it("is empty for an empty queue", () => {
    expect(summariseOpen([], NOW)).toEqual({ open: 0, breached: 0, oldestMinutes: null, oldestAt: null, emergencies: 0 });
  });
});

describe("visibleRows", () => {
  it("re-checks status and applies the kind filter", () => {
    const rows = [esc({ id: "a" }), esc({ id: "b", status: "claimed" }), esc({ id: "c", kind: "emergency" })];
    expect(visibleRows(rows, "open", "all").map((r) => r.id)).toEqual(["a", "c"]);
    expect(visibleRows(rows, "open", "emergency").map((r) => r.id)).toEqual(["c"]);
    expect(visibleRows(rows, "claimed", "all").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("helpers", () => {
  it("formats waits in minutes, hours and days", () => {
    expect(formatWait(7)).toBe("7 min");
    expect(formatWait(60)).toBe("1 h");
    expect(formatWait(75)).toBe("1 h 15 min");
    expect(formatWait(1500)).toBe("1 d 1 h");
    expect(formatWait(null)).toBe("—");
  });

  it("builds a stable, de-duplicated key list", () => {
    expect(callKeysOf([{ call_key: "b" }, { call_key: "a" }, { call_key: "b" }])).toEqual(["a", "b"]);
  });
});
