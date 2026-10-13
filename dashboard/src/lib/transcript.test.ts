import { describe, expect, it } from "vitest";
import { fromLiveLines, fromStoredMessages, MERGE_GAP_MS, transcriptToText, type Bubble, type ToolChip } from "./transcript";

const bubbles = (items: ReturnType<typeof fromStoredMessages>) => items.filter((i): i is Bubble => i.kind === "bubble");
const chips = (items: ReturnType<typeof fromStoredMessages>) => items.filter((i): i is ToolChip => i.kind === "tool");

describe("fromStoredMessages", () => {
  it("maps both role vocabularies and drops system", () => {
    const items = fromStoredMessages([
      { role: "system", text: "You are Ava", t: 0 },
      { role: "assistant", text: "Hi, this is Ava.", t: 0.5 },
      { role: "user", text: "Checking my claim.", t: 3 },
      { role: "bot", text: "Sure, what number are you calling from?", t: 5 },
    ]);
    expect(items.map((i) => (i.kind === "bubble" ? i.speaker : i.kind))).toEqual(["agent", "caller", "agent"]);
    expect(items.some((i) => i.kind === "bubble" && i.text.includes("You are Ava"))).toBe(false);
  });

  it("stamps mm:ss from t (seconds from start), with secondsFromStart as an alias", () => {
    const items = fromStoredMessages([
      { role: "assistant", text: "Hello", t: 0 },
      { role: "user", text: "Hi", t: 65.9 },
      { role: "assistant", text: "Okay", secondsFromStart: 601 },
    ]);
    expect(items.map((i) => i.stamp)).toEqual(["00:00", "01:05", "10:01"]);
  });

  it("orders tool chips by time and never renders arguments", () => {
    const items = fromStoredMessages([
      { role: "assistant", text: "Can I get your phone number?", t: 2 },
      { role: "tool", tool: "verify_identity", code: "verified", t: 30, arguments: { dob: "1986-03-14" } },
      { role: "user", text: "It is on file", t: 10 },
      { role: "tool", tool: "lookup_customer", code: "needs_dob", t: 15, arguments: '{"phone":"+16025550101"}' },
    ]);
    expect(items.map((i) => i.t)).toEqual([2, 10, 15, 30]);
    expect(chips(items).map((c) => `${c.tool}:${c.code}`)).toEqual(["lookup_customer:needs_dob", "verify_identity:verified"]);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("1986");
    expect(serialized).not.toContain("6025550101");
  });

  it("keeps a chip without a code and labels squad members", () => {
    const items = fromStoredMessages([
      { role: "assistant", text: "Let me check that policy.", t: 1, name: "Knowledge" },
      { role: "tool", tool: "faq_search", t: 2 },
    ]);
    expect(bubbles(items)[0]?.name).toBe("Knowledge");
    expect(chips(items)[0]).toMatchObject({ tool: "faq_search", code: null });
  });

  it("tolerates junk: non-arrays, empty text, missing times", () => {
    expect(fromStoredMessages(null)).toEqual([]);
    expect(fromStoredMessages({ role: "user" })).toEqual([]);
    const items = fromStoredMessages([null, 7, { role: "user", text: "   " }, { role: "assistant", text: "A", t: 4 }, { role: "user", text: "B" }]);
    expect(items.map((i) => (i.kind === "bubble" ? i.text : ""))).toEqual(["A", "B"]);
    // a missing t inherits the previous one, so written order survives the sort
    expect(items[1]?.t).toBe(4);
  });
});

describe("fromLiveLines", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 14, 0, s)).toISOString();

  it("stamps from ts_ms offsets relative to the first line, whatever order rows arrive in", () => {
    const items = fromLiveLines([
      { id: 2, role: "user", text: "My claim please", ts_ms: 1_700_000_065_000, created_at: at(66) },
      { id: 1, role: "assistant", text: "Hi, this is Ava", ts_ms: 1_700_000_000_000, created_at: at(1) },
    ]);
    expect(items.map((i) => i.stamp)).toEqual(["00:00", "01:05"]);
    expect(bubbles(items).map((b) => b.speaker)).toEqual(["agent", "caller"]);
  });

  it("merges consecutive same-role lines closer than 3 s and keeps the first stamp", () => {
    const items = fromLiveLines([
      { id: 1, role: "assistant", text: "Thanks.", ts_ms: 10_000 },
      { id: 2, role: "assistant", text: "One moment.", ts_ms: 10_000 + MERGE_GAP_MS - 1 },
      { id: 3, role: "assistant", text: "Found it.", ts_ms: 10_000 + MERGE_GAP_MS - 1 + MERGE_GAP_MS },
    ]);
    expect(bubbles(items).map((b) => b.text)).toEqual(["Thanks. One moment.", "Found it."]);
    expect(items[0]?.stamp).toBe("00:00");
  });

  it("never merges across speakers", () => {
    const items = fromLiveLines([
      { id: 1, role: "assistant", text: "Your date of birth?", ts_ms: 0 },
      { id: 2, role: "user", text: "[date of birth]", ts_ms: 500 },
      { id: 3, role: "assistant", text: "Thanks", ts_ms: 1000 },
    ]);
    expect(bubbles(items)).toHaveLength(3);
  });

  it("accepts the bot vocabulary and drops system lines", () => {
    const items = fromLiveLines([
      { id: 1, role: "bot", text: "Hello", ts_ms: 0 },
      { id: 2, role: "system", text: "internal", ts_ms: 10 },
    ]);
    expect(items).toHaveLength(1);
    expect(bubbles(items)[0]?.speaker).toBe("agent");
  });

  it("places a tool chip after the last line created no later than it", () => {
    const items = fromLiveLines(
      [
        { id: 1, role: "assistant", text: "What number?", ts_ms: 0, created_at: at(1) },
        { id: 2, role: "user", text: "[phone ending 0101]", ts_ms: 4000, created_at: at(5) },
        { id: 3, role: "assistant", text: "And your date of birth?", ts_ms: 9000, created_at: at(10) },
      ],
      [{ tool_call_id: "t1", tool_name: "lookup_customer", code: "needs_dob", created_at: at(7) }],
    );
    expect(items.map((i) => (i.kind === "tool" ? `tool:${i.code}` : i.speaker))).toEqual([
      "agent",
      "caller",
      "tool:needs_dob",
      "agent",
    ]);
    // stamp from the server clock relative to the first line, never before the line it follows
    expect(chips(items)[0]?.stamp).toBe("00:06");
  });

  it("does not merge two same-speaker lines that have a chip between them", () => {
    const items = fromLiveLines(
      [
        { id: 1, role: "assistant", text: "Checking.", ts_ms: 0, created_at: at(0) },
        { id: 2, role: "assistant", text: "You're verified.", ts_ms: 1500, created_at: at(2) },
      ],
      [{ tool_call_id: "t2", tool_name: "verify_identity", code: "verified", created_at: at(1) }],
    );
    expect(items.map((i) => i.kind)).toEqual(["bubble", "tool", "bubble"]);
  });

  it("orders several chips by created_at and puts early chips first", () => {
    const items = fromLiveLines(
      [{ id: 1, role: "assistant", text: "Hello", ts_ms: 0, created_at: at(10) }],
      [
        { tool_call_id: "b", tool_name: "verify_identity", code: "verified", created_at: at(20) },
        { tool_call_id: "a", tool_name: "lookup_customer", code: "needs_dob", created_at: at(15) },
        { tool_call_id: "z", tool_name: "lookup_customer", code: "not_found", created_at: at(5) },
      ],
    );
    expect(items.map((i) => (i.kind === "tool" ? i.code : "line"))).toEqual(["not_found", "line", "needs_dob", "verified"]);
  });

  it("renders chips alone before any line arrives", () => {
    const items = fromLiveLines([], [{ tool_call_id: "a", tool_name: "lookup_customer", code: "needs_dob", created_at: at(3) }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.stamp).toBe("00:00");
  });
});

describe("transcriptToText", () => {
  it("writes one line per bubble and chip", () => {
    const text = transcriptToText(
      fromStoredMessages([
        { role: "assistant", text: "Hello", t: 0, name: "Concierge" },
        { role: "user", text: "Hi", t: 2 },
        { role: "tool", tool: "lookup_customer", code: "needs_dob", t: 3 },
      ]),
    );
    expect(text).toBe("[00:00] Ava (Concierge): Hello\n[00:02] Caller: Hi\n[00:03] tool lookup_customer: needs_dob");
  });
});
