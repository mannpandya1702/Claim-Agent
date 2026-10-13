import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CallerContact } from "@/lib/types";
import { CallerContactCard } from "./CallerContactCard";
import { CallerTypeBadge } from "./CallerTypeBadge";

function contact(over: Partial<CallerContact> = {}): CallerContact {
  return {
    call_key: "call-1",
    kind: "new_customer",
    first_name: "Priya",
    last_name: "Raman",
    email: "priya.raman42@gmail.com",
    callback_phone: "+16025550188",
    callback_source: "argument",
    confirmed: true,
    confirmed_at: "2026-10-12T15:01:30Z",
    created_at: "2026-10-12T15:01:10Z",
    updated_at: "2026-10-12T15:01:30Z",
    ...over,
  };
}

describe("CallerTypeBadge", () => {
  it("names each caller type in words with an icon, never color alone", () => {
    const { rerender } = render(<CallerTypeBadge type="existing" />);
    expect(screen.getByText("Existing")).toBeInTheDocument();
    expect(screen.getByText("Caller type:")).toHaveClass("sr-only");
    expect(screen.getByText("Existing").closest("[data-caller-type]")).toHaveAttribute("data-caller-type", "existing");
    expect(screen.getByText("Existing").closest("[data-caller-type]")!.querySelector("svg")).not.toBeNull();

    rerender(<CallerTypeBadge type="new" />);
    expect(screen.getByText("New").closest("[data-caller-type]")).toHaveAttribute("data-caller-type", "new");
    expect(screen.getByText("New").closest("[data-caller-type]")).toHaveAttribute("title", expect.stringMatching(/no account/i));
  });

  it("reads a missing or unexpected value as Unknown", () => {
    const { rerender } = render(<CallerTypeBadge type={null} />);
    expect(screen.getByText("Unknown").closest("[data-caller-type]")).toHaveAttribute("data-caller-type", "unknown");
    rerender(<CallerTypeBadge type="vip" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});

describe("CallerContactCard", () => {
  it("shows a confirmed new customer with the full email and a dialable callback number", () => {
    render(<CallerContactCard contact={contact()} />);
    expect(screen.getByText("New customer")).toBeInTheDocument();
    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "priya.raman42@gmail.com" })).toHaveAttribute("href", "mailto:priya.raman42@gmail.com");
    expect(screen.getByText("Caller-provided, unverified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+1 602 555 0188" })).toHaveAttribute("href", "tel:+16025550188");
    expect(screen.getByText("Given by caller")).toBeInTheDocument();
    // the staff note is for email update requests only
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("marks an unconfirmed email update request as pending, with the staff note", () => {
    render(
      <CallerContactCard
        contact={contact({ kind: "email_update", confirmed: false, confirmed_at: null, callback_phone: "+16025550104", callback_source: "caller_id" })}
      />,
    );
    expect(screen.getByText("Email update request")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.queryByText("Confirmed")).not.toBeInTheDocument();
    expect(screen.getByText("Caller ID")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/not on the account until staff check it and add it/);
  });

  it("says when no email or callback number was given", () => {
    render(<CallerContactCard contact={contact({ email: null, callback_phone: null, callback_source: "none" })} />);
    expect(screen.getByText("No email given")).toBeInTheDocument();
    expect(screen.getByText("No number given")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
