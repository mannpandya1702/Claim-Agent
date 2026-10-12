import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Attempt } from "@/lib/types";
import { IdentityBadge, identityFacts, IdentityPath } from "./IdentityPath";
import { attemptTone, ToolTimeline } from "./ToolTimeline";

function attempt(id: string, tool: string, kind: Attempt["kind"], code: string, at: string): Attempt {
  return { call_key: "call-1", tool_call_id: id, tool_name: tool, kind, code, created_at: at };
}

const LOCKED: Attempt[] = [
  attempt("t1", "lookup_customer", "lookup_hit", "needs_dob", "2026-10-12T15:00:10Z"),
  attempt("t2", "verify_identity", "dob_wrong", "auth_failed", "2026-10-12T15:00:30Z"),
  attempt("t3", "verify_identity", "dob_wrong", "locked", "2026-10-12T15:00:50Z"),
];

function steps() {
  return within(screen.getByRole("list", { name: "Identity path" }))
    .getAllByRole("listitem")
    .map((li) => `${li.dataset.state}`);
}

describe("IdentityPath", () => {
  it("walks none -> phone found -> verified", () => {
    const { rerender } = render(<IdentityPath session={null} attempts={[]} />);
    expect(steps()).toEqual(["current", "upcoming", "upcoming"]);
    rerender(<IdentityPath session={{ level: "phone_found" }} attempts={LOCKED.slice(0, 1)} />);
    expect(steps()).toEqual(["done", "current", "upcoming"]);
    rerender(<IdentityPath session={{ level: "verified" }} attempts={[...LOCKED.slice(0, 1), attempt("t9", "verify_identity", "dob_ok", "verified", "2026-10-12T15:00:40Z")]} />);
    expect(steps()).toEqual(["done", "done", "verified"]);
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("ends in Locked after two date-of-birth misses and says so in words", () => {
    render(<IdentityPath session={{ level: "locked" }} attempts={LOCKED} />);
    expect(steps()).toEqual(["done", "done", "locked"]);
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 date-of-birth misses/)).toBeInTheDocument();
  });

  it("derives counts and times from the attempts ledger", () => {
    const f = identityFacts({ level: "locked" }, LOCKED);
    expect(f).toMatchObject({ dobMisses: 2, lookupMisses: 0, phoneFoundAt: "2026-10-12T15:00:10Z", lockedAt: "2026-10-12T15:00:50Z" });
  });

  it("badges the header with an icon and a word", () => {
    const { rerender } = render(<IdentityBadge level="verified" />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    rerender(<IdentityBadge level={null} />);
    expect(screen.getByText("Not verified")).toBeInTheDocument();
  });
});

describe("ToolTimeline", () => {
  it("lists tool calls in order with offsets from the call start and their meaning", () => {
    render(<ToolTimeline attempts={[...LOCKED].reverse()} startedAt="2026-10-12T15:00:00Z" />);
    const items = within(screen.getByRole("list", { name: "Tool timeline" })).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.tool)).toEqual(["lookup_customer", "verify_identity", "verify_identity"]);
    expect(items[0]).toHaveTextContent("00:10");
    expect(items[0]).toHaveTextContent("needs_dob");
    expect(items[0]).toHaveTextContent("Phone matched a customer");
    expect(items[2]).toHaveTextContent("00:50");
    expect(items[2]).toHaveTextContent("locked");
  });

  it("grades results: matches good, misses a warning, a lock critical", () => {
    expect(attemptTone(LOCKED[0]!)).toBe("good");
    expect(attemptTone(LOCKED[1]!)).toBe("warning");
    expect(attemptTone(LOCKED[2]!)).toBe("critical");
    expect(attemptTone({ kind: "other", code: "queued" })).toBe("neutral");
  });
});
