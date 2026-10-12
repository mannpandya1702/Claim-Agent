import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ROUTER_FUTURE } from "@/lib/router";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { FlagChip } from "./FlagChip";
import { KpiTile } from "./KpiTile";
import { LiveBadge } from "./LiveBadge";
import { OutcomeBadge } from "./OutcomeBadge";
import { PageHeader } from "./PageHeader";
import { SentimentBadge } from "./SentimentBadge";

describe("LiveBadge", () => {
  it("reads Live when connected and Reconnecting when not", () => {
    const { rerender } = render(<LiveBadge status="live" />);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "live");
    rerender(<LiveBadge status="reconnecting" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  });
});

describe("badges", () => {
  it("OutcomeBadge shows the word, and In progress while live", () => {
    const { rerender } = render(<OutcomeBadge outcome="auth_failed" />);
    expect(screen.getByText("Auth failed")).toBeInTheDocument();
    rerender(<OutcomeBadge outcome="resolved" live />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    rerender(<OutcomeBadge outcome={null} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("SentimentBadge says n/a when missing", () => {
    render(<SentimentBadge sentiment={null} />);
    expect(screen.getByLabelText("Sentiment: n/a")).toBeInTheDocument();
  });

  it("FlagChip is focusable and explains itself", async () => {
    render(<FlagChip flag="email_promised_without_send" />);
    const chip = screen.getByRole("note");
    expect(chip).toHaveTextContent("Email promised, not sent");
    expect(chip).toHaveAccessibleName(/no email was sent/i);
    await userEvent.tab();
    expect(chip).toHaveFocus();
  });

  it("compact FlagChip keeps the label in its accessible name", () => {
    render(<FlagChip flag="tool_markup_spoken" compact />);
    expect(screen.getByRole("note")).toHaveAccessibleName(/Tool markup spoken/);
    expect(screen.getByRole("note")).not.toHaveTextContent("Tool markup spoken");
  });
});

describe("KpiTile", () => {
  it("renders label and value as a description list with a status callout", () => {
    render(<KpiTile label="Flagged calls" value="3" status={{ tone: "critical", label: "Needs review" }} />);
    expect(screen.getByText("Flagged calls").tagName).toBe("DT");
    expect(screen.getByText("3").tagName).toBe("DD");
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("links the whole tile when given a destination", () => {
    render(
      <MemoryRouter future={ROUTER_FUTURE}>
        <KpiTile label="Open escalations" value="2" to="/escalations" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/escalations");
  });

  it("shows a delta with direction words for assistive tech", () => {
    render(<KpiTile label="Calls" value="12" delta={{ value: "+20%", direction: "up", good: true, period: "vs previous 7 days" }} />);
    expect(screen.getByLabelText("Up")).toBeInTheDocument();
    expect(screen.getByText("vs previous 7 days")).toBeInTheDocument();
  });
});

describe("states and header", () => {
  it("ErrorState announces and retries", async () => {
    const retry = vi.fn();
    render(<ErrorState error={new Error("permission denied for table call_interactions")} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });

  it("EmptyState renders its title and action", () => {
    render(<EmptyState title="No calls yet" action={<button type="button">Start one</button>} />);
    expect(screen.getByText("No calls yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start one" })).toBeInTheDocument();
  });

  it("PageHeader sets the heading and the document title", () => {
    render(
      <MemoryRouter future={ROUTER_FUTURE}>
        <PageHeader title="Escalations" back={{ to: "/", label: "Overview" }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Escalations" })).toBeInTheDocument();
    expect(document.title).toBe("Escalations · Observe Claims Ops");
  });
});
