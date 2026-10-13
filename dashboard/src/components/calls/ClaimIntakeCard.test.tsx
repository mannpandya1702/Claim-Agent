import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CALL_REASONS, type ClaimIntake } from "@/lib/types";
import { CallReasonBadge } from "./CallReasonBadge";
import { ClaimIntakeCard } from "./ClaimIntakeCard";

function intake(over: Partial<ClaimIntake> = {}): ClaimIntake {
  return {
    call_key: "call-1",
    kind: "claim",
    claim_type: "auto",
    loss_date: "2026-10-10",
    summary: "cracked windshield",
    description: "A rock hit my windshield on the highway and it cracked across. Call me on [phone].",
    claim_number: "CLM-104472",
    confirmed: true,
    confirmed_at: "2026-10-12T15:02:30Z",
    created_at: "2026-10-12T15:02:00Z",
    updated_at: "2026-10-12T15:02:30Z",
    ...over,
  };
}

describe("CallReasonBadge", () => {
  it("names every reason in words with an icon, never color alone", () => {
    const labels: string[] = [];
    for (const reason of CALL_REASONS) {
      const { unmount } = render(<CallReasonBadge reason={reason} />);
      const badge = document.querySelector("[data-call-reason]")!;
      expect(badge).toHaveAttribute("data-call-reason", reason);
      expect(badge.querySelector("svg")).not.toBeNull();
      expect(screen.getByText("Call reason:")).toHaveClass("sr-only");
      labels.push(badge.textContent!.replace("Call reason: ", ""));
      unmount();
    }
    expect(labels).toEqual([
      "Claim status",
      "File a claim",
      "Documents",
      "General question",
      "Speak to an agent",
      "Update details",
      "Emergency",
      "Other",
    ]);
  });

  it("says where the reason came from in its tooltip", () => {
    render(<CallReasonBadge reason="file_claim" source="server" />);
    expect(document.querySelector("[data-call-reason]")).toHaveAttribute("title", "Reporting a new loss or starting a claim (Server facts)");
  });

  it("renders nothing for a call with no reason yet, and words a value it does not know", () => {
    const { container, rerender } = render(<CallReasonBadge reason={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CallReasonBadge reason={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CallReasonBadge reason="billing_dispute" />);
    expect(screen.getByText("Billing dispute")).toBeInTheDocument();
  });
});

describe("ClaimIntakeCard", () => {
  it("shows a verified customer's filed claim with its number, type, loss date and the caller's words", () => {
    render(<ClaimIntakeCard intake={intake()} />);
    expect(screen.getByText("Claim by a verified customer")).toBeInTheDocument();
    expect(screen.getByText("Filed")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.getByText("CLM-104472")).toBeInTheDocument();
    expect(screen.getByText("Auto")).toBeInTheDocument();
    // a calendar date, printed as written (no timezone shift to the 9th)
    expect(screen.getByText("Sat, Oct 10, 2026")).toBeInTheDocument();
    expect(screen.getByText("cracked windshield")).toBeInTheDocument();
    expect(screen.getByText(/A rock hit my windshield/)).toBeInTheDocument();
    expect(screen.getByText("The caller's words, personal details redacted")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("marks a new caller's confirmed intake as sent to the claims team, with no claim number", () => {
    render(<ClaimIntakeCard intake={intake({ kind: "lead_intake", claim_type: "home", claim_number: null })} />);
    expect(screen.getByText("Claim details from a new caller")).toBeInTheDocument();
    expect(screen.getByText("Sent to claims team")).toBeInTheDocument();
    expect(screen.queryByText("Filed")).not.toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("None: the claim is set up on the callback")).toBeInTheDocument();
  });

  it("says an unconfirmed read-back is pending while live, and was never filed once the call ended", () => {
    const pending = intake({ confirmed: false, confirmed_at: null, claim_number: null, claim_type: "property" });
    const { rerender } = render(<ClaimIntakeCard intake={pending} live />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Given when the caller confirms")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Nothing is filed until they confirm it.");

    rerender(<ClaimIntakeCard intake={pending} />);
    expect(screen.getByRole("note")).toHaveTextContent("The caller never confirmed this read-back, so nothing was filed.");
  });
});
