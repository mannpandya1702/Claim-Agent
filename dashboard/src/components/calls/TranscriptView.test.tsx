import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fromLiveLines, fromStoredMessages } from "@/lib/transcript";
import { chipLabel, TranscriptView } from "./TranscriptView";

function rendered(): { kind: string; text: string }[] {
  return Array.from(document.querySelectorAll<HTMLElement>("li[data-kind]")).map((li) => ({
    kind: li.dataset.kind === "tool" ? "tool" : (li.dataset.speaker ?? ""),
    text: li.textContent ?? "",
  }));
}

describe("TranscriptView", () => {
  it("renders stored bubbles and tool chips in time order with mm:ss stamps", () => {
    const items = fromStoredMessages([
      { role: "assistant", text: "Hi, this is Tessa with Observe Insurance.", t: 0.4 },
      { role: "user", text: "I want to check my claim.", t: 4 },
      { role: "tool", tool: "verify_identity", code: "verified", t: 31 },
      { role: "tool", tool: "lookup_customer", code: "needs_dob", t: 12 },
      { role: "assistant", text: "Thank you, Tobias, you're verified.", t: 32 },
    ]);
    render(<TranscriptView items={items} />);

    const list = rendered();
    expect(list.map((i) => i.kind)).toEqual(["agent", "caller", "tool", "tool", "agent"]);
    expect(list[2]!.text).toContain("lookup_customer: needs_dob");
    expect(list[3]!.text).toContain("verify_identity: verified");
    expect(list[0]!.text).toContain("00:00");
    expect(list[1]!.text).toContain("00:04");
    expect(list[4]!.text).toContain("00:32");
    expect(screen.getByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("labels the speakers: Tessa (with squad member) on one side, the caller on the other", () => {
    const items = fromStoredMessages([
      { role: "assistant", text: "Our policy covers that.", t: 1, name: "Knowledge" },
      { role: "user", text: "Thanks.", t: 3 },
    ]);
    render(<TranscriptView items={items} />);
    expect(screen.getByText("Tessa · Knowledge")).toBeInTheDocument();
    expect(screen.getByText("Caller")).toBeInTheDocument();
  });

  it("renders live lines with attempts chips placed by created_at, as a polite log", () => {
    const items = fromLiveLines(
      [
        { id: 1, role: "assistant", text: "What number are you calling from?", ts_ms: 1000, created_at: "2026-10-12T15:00:01.000Z" },
        { id: 2, role: "user", text: "Six oh two, five five five, oh one oh one.", ts_ms: 6000, created_at: "2026-10-12T15:00:06.000Z" },
        { id: 3, role: "assistant", text: "Thanks. And your date of birth?", ts_ms: 9000, created_at: "2026-10-12T15:00:09.000Z" },
      ],
      [{ tool_call_id: "t1", tool_name: "lookup_customer", code: "needs_dob", created_at: "2026-10-12T15:00:07.500Z" }],
    );
    render(<TranscriptView items={items} live />);

    expect(rendered().map((i) => i.kind)).toEqual(["agent", "caller", "tool", "agent"]);
    expect(screen.getByRole("log", { name: "Live transcript" })).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("lookup_customer: needs_dob")).toBeInTheDocument();
  });

  it("shows the empty slot when there is nothing yet", () => {
    render(<TranscriptView items={[]} empty={<p>Waiting for the first words.</p>} />);
    expect(screen.getByText("Waiting for the first words.")).toBeInTheDocument();
    expect(document.querySelectorAll("li[data-kind]")).toHaveLength(0);
  });

  it("prints a chip as tool: code, or the tool alone without a code", () => {
    expect(chipLabel({ tool: "lookup_customer", code: "needs_dob" })).toBe("lookup_customer: needs_dob");
    expect(chipLabel({ tool: "endCall", code: null })).toBe("endCall");
  });
});
