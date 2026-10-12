import { describe, expect, it } from "vitest";
import type { Attempt, Escalation } from "@/lib/types";
import { endedSince, escalationBadge, LIVE_LIST_CAP, lastAttempt, splitLiveCalls } from "./liveCalls";

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("splitLiveCalls", () => {
  it("keeps calls under 2 hours live and moves older ones to possibly stuck", () => {
    const { active, stuck } = splitLiveCalls(
      [
        { vapi_call_id: "a", created_at: ago(3), ended_at: null },
        { vapi_call_id: "b", created_at: ago(119), ended_at: null },
        { vapi_call_id: "c", created_at: ago(121), ended_at: null },
        { vapi_call_id: "d", created_at: ago(1), ended_at: ago(0) },
      ],
      NOW,
    );
    expect(active.map((c) => c.vapi_call_id)).toEqual(["a", "b"]);
    expect(stuck.map((c) => c.vapi_call_id)).toEqual(["c"]);
  });
});

describe("endedSince", () => {
  it("returns calls that left the live list", () => {
    const prev = [{ vapi_call_id: "a" }, { vapi_call_id: "b" }];
    expect(endedSince(prev, [{ vapi_call_id: "b" }, { vapi_call_id: "c" }])).toEqual([{ vapi_call_id: "a" }]);
    expect(endedSince(undefined, [{ vapi_call_id: "a" }])).toEqual([]);
  });

  it("ignores a full page, where a call can fall off the end without ending", () => {
    const full = Array.from({ length: LIVE_LIST_CAP }, (_, i) => ({ vapi_call_id: `n${i}` }));
    expect(endedSince([{ vapi_call_id: "old" }], full)).toEqual([]);
  });
});

describe("lastAttempt", () => {
  it("picks the newest tool result", () => {
    const a = (id: string, at: string): Attempt => ({ call_key: "c", tool_call_id: id, tool_name: id, kind: "other", code: "ok", created_at: at });
    expect(lastAttempt([a("lookup_customer", ago(3)), a("verify_identity", ago(1)), a("x", ago(2))])?.tool_name).toBe("verify_identity");
    expect(lastAttempt([])).toBeNull();
  });
});

describe("escalationBadge", () => {
  const e = (over: Partial<Escalation>) => ({ kind: "representative", status: "open", claimed_by: null, ...over }) as Escalation;

  it("ranks an emergency above a representative request", () => {
    expect(escalationBadge([e({}), e({ kind: "emergency" })])).toEqual({ tone: "critical", label: "Emergency", emergency: true });
    expect(escalationBadge([e({ kind: "emergency", status: "claimed" })])?.label).toBe("Emergency, claimed");
  });

  it("words a representative request by its status", () => {
    expect(escalationBadge([e({})])).toEqual({ tone: "warning", label: "Escalation open", emergency: false });
    expect(escalationBadge([e({ status: "claimed", claimed_by: "ana@example.com" })])?.label).toBe("Claimed by ana@example.com");
    expect(escalationBadge([e({ status: "done" })])?.tone).toBe("good");
    expect(escalationBadge([])).toBeNull();
  });
});
