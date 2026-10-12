import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("keeps following a live bubble that grows when same-speaker lines merge", () => {
    const scrollTo = vi.fn();
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      const line = (id: number, text: string, ts: number) => ({
        id,
        role: "assistant",
        text,
        ts_ms: ts,
        created_at: new Date(Date.UTC(2026, 9, 12, 15, 0, ts / 1000)).toISOString(),
      });
      const first = fromLiveLines([line(1, "Thanks, Tobias.", 1000)], []);
      const { rerender } = render(<TranscriptView items={first} live />);
      scrollTo.mockClear();

      // a second final 1.5 s later merges into the same bubble: one item, longer text
      const merged = fromLiveLines([line(1, "Thanks, Tobias.", 1000), line(2, "Your claim is approved.", 2500)], []);
      expect(merged).toHaveLength(1);
      rerender(<TranscriptView items={merged} live />);
      expect(scrollTo).toHaveBeenCalled();

      // a reader who scrolled up is not yanked down; the jump button appears instead
      const log = screen.getByRole("log", { name: "Live transcript" });
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 300 });
      log.scrollTop = 100;
      fireEvent.scroll(log);
      scrollTo.mockClear();
      const longer = fromLiveLines(
        [line(1, "Thanks, Tobias.", 1000), line(2, "Your claim is approved.", 2500), line(3, "The payment is on its way.", 4000)],
        [],
      );
      rerender(<TranscriptView items={longer} live />);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
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
