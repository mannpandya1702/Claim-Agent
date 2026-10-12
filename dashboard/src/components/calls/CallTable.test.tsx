import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ROUTER_FUTURE } from "@/lib/router";
import type { CallListRow } from "@/lib/types";
import { CallTable, elapsedSeconds } from "./CallTable";

function row(over: Partial<CallListRow>): CallListRow {
  return {
    id: "row-id",
    vapi_call_id: "call-1",
    channel: "webCall",
    caller_name: "Tobias Halvorsen",
    caller_phone_masked: "+1 602 ... 0101",
    outcome: "resolved",
    sentiment: "positive",
    escalated: false,
    emergency: false,
    emailed: false,
    flags: [],
    started_at: "2026-10-12T14:00:00Z",
    ended_at: "2026-10-12T14:03:05Z",
    duration_seconds: 185,
    cost: 0.142,
    latency_avg_ms: 820,
    summary: "Caller checked claim status.",
    assistant_name: null,
    created_at: "2026-10-12T14:00:00Z",
    total: 3,
    ...over,
  };
}

const ROWS: CallListRow[] = [
  row({ vapi_call_id: "live-1", caller_name: null, caller_phone_masked: null, ended_at: null, outcome: "in_progress", duration_seconds: null, cost: null, sentiment: null, started_at: "2026-10-12T15:00:00Z", created_at: "2026-10-12T15:00:00Z" }),
  row({ vapi_call_id: "flagged-1", flags: ["promised_callback_without_escalation", "tool_markup_spoken"], escalated: true, emergency: true, emailed: true, outcome: "escalated", sentiment: "negative" }),
  row({ vapi_call_id: "clean-1", cost: null }),
];

function renderTable(rows = ROWS) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE} initialEntries={["/calls"]}>
      <Routes>
        <Route path="/calls" element={<CallTable rows={rows} now={new Date("2026-10-12T15:01:05Z")} />} />
        <Route path="/calls/:id" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function rowFor(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`tr[data-call-id="${id}"]`);
  if (!el) throw new Error(`row ${id} not rendered`);
  return el;
}

describe("CallTable", () => {
  it("renders a pulsing dot and running clock for rows whose ended_at is null", () => {
    renderTable();
    const live = rowFor("live-1");
    expect(live).toHaveAttribute("data-live", "true");
    expect(live.querySelector(".animate-live-pulse")).not.toBeNull();
    expect(within(live).getByText("In progress")).toBeInTheDocument();
    expect(within(live).getByText("1:05")).toBeInTheDocument();

    for (const id of ["flagged-1", "clean-1"]) {
      expect(rowFor(id)).not.toHaveAttribute("data-live");
      expect(rowFor(id).querySelector(".animate-live-pulse")).toBeNull();
    }
  });

  it("decides live from ended_at, not from the outcome column", () => {
    renderTable([row({ vapi_call_id: "stub", outcome: "resolved", ended_at: null })]);
    expect(rowFor("stub").querySelector(".animate-live-pulse")).not.toBeNull();
    expect(within(rowFor("stub")).queryByText("Resolved")).not.toBeInTheDocument();
  });

  it("renders a flag chip per flag with its plain-English explanation", () => {
    renderTable();
    const chips = within(rowFor("flagged-1")).getAllByRole("note");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-flag", "promised_callback_without_escalation");
    expect(chips[0]).toHaveAccessibleName(/Callback promised, none queued/);
    expect(chips[1]).toHaveAccessibleName(/Tool markup spoken/);
    expect(within(rowFor("clean-1")).queryAllByRole("note")).toHaveLength(0);
  });

  it("shows escalation, emergency and email icons with accessible names", () => {
    renderTable();
    const flagged = within(rowFor("flagged-1"));
    expect(flagged.getByRole("img", { name: "Escalated" })).toBeInTheDocument();
    expect(flagged.getByRole("img", { name: "Emergency" })).toBeInTheDocument();
    expect(flagged.getByRole("img", { name: "Email sent" })).toBeInTheDocument();
    expect(within(rowFor("clean-1")).queryByRole("img", { name: "Escalated" })).not.toBeInTheDocument();
    expect(within(rowFor("clean-1")).queryByRole("img", { name: "Email sent" })).not.toBeInTheDocument();
  });

  it("names unknown callers, masks phones and prints n/a for a missing cost", () => {
    renderTable();
    expect(within(rowFor("live-1")).getByRole("link", { name: "Unknown caller" })).toHaveAttribute("href", "/calls/live-1");
    const clean = within(rowFor("clean-1"));
    expect(clean.getByText("+1 602 ... 0101")).toBeInTheDocument();
    expect(clean.queryByText("+1 602 555 0101")).not.toBeInTheDocument();
    expect(clean.getByText("n/a")).toBeInTheDocument();
    expect(within(rowFor("flagged-1")).getByText("$0.142")).toBeInTheDocument();
  });

  it("opens the call when a row is clicked", async () => {
    renderTable();
    await userEvent.click(within(rowFor("clean-1")).getByText("3:05"));
    expect(screen.getByText("detail page")).toBeInTheDocument();
  });

  it("measures elapsed time from started_at, falling back to created_at", () => {
    const now = new Date("2026-10-12T15:00:30Z");
    expect(elapsedSeconds({ started_at: "2026-10-12T15:00:00Z", created_at: "2026-10-12T14:00:00Z" }, now)).toBe(30);
    expect(elapsedSeconds({ started_at: null, created_at: "2026-10-12T14:59:00Z" }, now)).toBe(90);
  });
});
