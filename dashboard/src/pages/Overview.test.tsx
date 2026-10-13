import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayKeysInRange, presetRange } from "@/lib/dates";
import { ROUTER_FUTURE } from "@/lib/router";
import Overview from "./Overview";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));

// The page's realtime wiring is covered by realtime.test.ts; here it must not open a socket.
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  useRealtimeRows: vi.fn(() => ({ status: "SUBSCRIBED", isLive: true })),
}));

// jsdom has no layout, so ResponsiveContainer would measure 0x0 and draw nothing; give the
// chart a fixed size so its marks and custom shapes actually render.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children) ? cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 720, height: 260 }) : null,
  };
});

const METRICS = {
  calls: 42,
  completed: 40,
  in_progress: 2,
  resolved: 29,
  containment_rate: 0.724,
  verification_attempted: 41,
  verification_success: 38,
  auth_failed: 3,
  not_found: 2,
  escalated: 7,
  emergencies: 1,
  escalation_rate: 0.18,
  avg_handle_seconds: 205,
  avg_cost: 0.1423,
  avg_latency_ms: 1180,
  flagged: 3,
  outcomes: { resolved: 29, escalated: 6, auth_failed: 3, not_found: 2, in_progress: 2 },
  sentiments: { positive: 24, neutral: 10, negative: 4, unknown: 4 },
  emails_sent: 11,
  open_escalations: 2,
  sla_breaches: 1,
  escalations_in_range: 7,
};

function daysFor(preset: "7d" | "30d") {
  const days = dayKeysInRange(presetRange(preset));
  return [
    { day: days[days.length - 1], outcome: "resolved", n: "5" },
    { day: days[days.length - 1], outcome: "escalated", n: "2" },
    { day: days[days.length - 3], outcome: "resolved", n: "3" },
  ];
}

const REASONS = [
  { call_reason: "claim_status", calls: "18" },
  { call_reason: "file_claim", calls: "9" },
  { call_reason: "speak_to_agent", calls: "6" },
  { call_reason: "documents", calls: "4" },
  { call_reason: "emergency", calls: "1" },
];

function mockRpc(metrics: unknown = METRICS, days: unknown = daysFor("7d"), reasons: unknown = REASONS) {
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "dashboard_metrics") return { data: metrics, error: null };
    if (fn === "calls_by_day") return { data: days, error: null };
    if (fn === "call_reason_counts") return { data: reasons, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
}

function renderOverview(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The value cell of the KPI tile with this label. */
function tileValue(label: string): string {
  const dt = screen.getByText(label, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

function tileTone(label: string): string | null {
  return screen.getByText(label, { selector: "dt" }).closest("[data-tone]")?.getAttribute("data-tone") ?? null;
}

beforeEach(() => {
  rpc.mockReset();
});

describe("Overview", () => {
  it("renders every KPI tile from the dashboard_metrics response", async () => {
    mockRpc();
    renderOverview();

    await waitFor(() => expect(tileValue("Calls")).toBe("42"));
    expect(tileValue("Containment")).toBe("72%");
    expect(tileValue("Verification success")).toBe("93%");
    expect(tileValue("Auth failed")).toBe("3");
    expect(tileValue("Not found")).toBe("2");
    expect(tileValue("Escalation rate")).toBe("18%");
    expect(tileValue("Average handle time")).toBe("3:25");
    expect(tileValue("Average cost")).toBe("$0.142");
    expect(tileValue("Avg turn latency")).toBe("1.2 s");
    expect(tileValue("Emails sent")).toBe("11");
    expect(tileValue("Open escalations")).toBe("2");
    expect(tileValue("SLA breaches")).toBe("1");
    expect(tileValue("Flagged calls")).toBe("3");

    expect(screen.getByText("40 completed, 2 in progress")).toBeInTheDocument();
    expect(screen.getByText("38 of 41 identified callers verified")).toBeInTheDocument();

    const range = presetRange("7d");
    expect(rpc).toHaveBeenCalledWith("dashboard_metrics", { p_from: range.from, p_to: range.to });
    expect(rpc).toHaveBeenCalledWith("calls_by_day", { p_from: range.from, p_to: range.to });
    expect(rpc).toHaveBeenCalledWith("call_reason_counts", { p_from: range.from, p_to: range.to });
  });

  it("turns flagged calls and SLA breaches red with words, not color alone", async () => {
    mockRpc();
    renderOverview();

    await waitFor(() => expect(tileValue("Flagged calls")).toBe("3"));
    expect(tileTone("Flagged calls")).toBe("critical");
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(tileTone("SLA breaches")).toBe("critical");
    expect(tileTone("Open escalations")).toBe("warning");
    expect(screen.getByText("Flagged calls", { selector: "dt" }).closest("a")).toHaveAttribute("href", "/calls?flagged=1&range=7d");
  });

  it("shows a clear queue and no flags as good news when everything is zero", async () => {
    mockRpc({ ...METRICS, flagged: 0, open_escalations: 0, sla_breaches: 0 });
    renderOverview();

    await waitFor(() => expect(tileValue("Flagged calls")).toBe("0"));
    expect(tileTone("Flagged calls")).toBe("good");
    expect(screen.getByText("No flags raised")).toBeInTheDocument();
    expect(screen.getByText("Queue is clear")).toBeInTheDocument();
  });

  it("renders the outcome legend, sentiment shares and the busiest-day label", async () => {
    mockRpc();
    renderOverview();

    const outcome = await screen.findByRole("region", { name: "Outcome mix" });
    await waitFor(() => expect(within(outcome).getByRole("list", { name: "Outcomes" })).toBeInTheDocument());
    expect(within(outcome).getByText("Resolved")).toBeInTheDocument();
    expect(within(outcome).getByText("69%")).toBeInTheDocument();

    const sentiment = screen.getByRole("region", { name: "Sentiment mix" });
    expect(within(sentiment).getByText("Share of 38 rated calls")).toBeInTheDocument();
    expect(within(sentiment).getByRole("img", { name: "Positive: 24 calls, 63%" })).toBeInTheDocument();
    expect(within(sentiment).getByText(/4 calls have no sentiment yet/)).toBeInTheDocument();

    const daily = screen.getByRole("region", { name: "Calls per day" });
    await waitFor(() => expect(daily.querySelector("svg [data-peak-label]")?.textContent).toBe("7"));
  });

  it("draws the top call reasons as ranked bars with words, counts and shares", async () => {
    mockRpc();
    renderOverview();

    const card = await screen.findByRole("region", { name: "Top call reasons" });
    const list = await within(card).findByRole("list", { name: "Call reasons" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-call-reason"))).toEqual(["claim_status", "file_claim", "speak_to_agent", "documents", "emergency"]);
    expect(rows[0]).toHaveTextContent("Claim status");
    expect(rows[2]).toHaveTextContent("Speak to an agent");
    expect(within(rows[0]!).getByRole("img", { name: "Claim status: 18 calls, 47% of tagged calls" })).toBeInTheDocument();
    expect(within(card).getByText("Main reason for 38 tagged calls")).toBeInTheDocument();
    // 42 calls in range, 38 tagged
    expect(within(card).getByText(/4 calls have no reason yet/)).toBeInTheDocument();

    // one hue for every bar (one measure across categories), scaled to the largest reason
    const bars = Array.from(card.querySelectorAll<HTMLElement>("[role='img'] > .viz-mark"));
    expect(new Set(bars.map((b) => b.style.backgroundColor))).toEqual(new Set(["var(--series-1)"]));
    expect(bars[0]!.style.width).toBe("100%");
    expect(bars[1]!.style.width).toBe("50%");

    await userEvent.click(within(card).getByRole("tab", { name: /Table/ }));
    const table = within(card).getByRole("table", { name: "Calls by reason" });
    const cells = within(table).getAllByRole("row").map((r) => r.textContent);
    expect(cells).toContain("No reason yet4—");
    expect(cells[cells.length - 1]).toBe("All calls42");
  });

  it("says so when calls in range have no reason yet", async () => {
    mockRpc(METRICS, daysFor("7d"), []);
    renderOverview();
    const card = await screen.findByRole("region", { name: "Top call reasons" });
    expect(await within(card).findByText("No call reasons yet")).toBeInTheDocument();
    expect(within(card).queryByRole("list", { name: "Call reasons" })).not.toBeInTheDocument();
  });

  it("shows a reasons read failure in its card, with a retry", async () => {
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "call_reason_counts") return { data: null, error: { message: "function call_reason_counts does not exist" } };
      if (fn === "dashboard_metrics") return { data: METRICS, error: null };
      return { data: daysFor("7d"), error: null };
    });
    renderOverview();
    const card = await screen.findByRole("region", { name: "Top call reasons" });
    expect(await within(card).findByText("Could not load call reasons")).toBeInTheDocument();
    expect(within(card).getByText(/call_reason_counts does not exist/)).toBeInTheDocument();
  });

  it("switches a chart to its table view", async () => {
    mockRpc();
    renderOverview();

    const daily = await screen.findByRole("region", { name: "Calls per day" });
    await waitFor(() => expect(within(daily).getByRole("tab", { name: /Table/ })).toBeInTheDocument());
    await userEvent.click(within(daily).getByRole("tab", { name: /Table/ }));

    const table = within(daily).getByRole("table", { name: "Calls per Eastern day by outcome" });
    const rows = within(table).getAllByRole("row");
    // Header, seven days, footer.
    expect(rows).toHaveLength(9);
    expect(within(rows[8]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["8", "2", "10"]);
  });

  it("reads the range from the URL", async () => {
    mockRpc(METRICS, daysFor("30d"));
    renderOverview("/?range=30d");

    const range = presetRange("30d");
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("dashboard_metrics", { p_from: range.from, p_to: range.to }));
    expect(screen.getByRole("combobox", { name: "Date range" })).toHaveTextContent("Last 30 days");
  });

  it("explains a one-day range instead of drawing a single column", async () => {
    mockRpc(METRICS, []);
    renderOverview("/?range=today");

    expect(await screen.findByText("The daily trend needs more than one day")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show last 7 days/ })).toBeInTheDocument();
  });

  it("shows empty states when the range has no calls", async () => {
    mockRpc({ calls: 0, completed: 0, outcomes: {}, sentiments: {} }, []);
    renderOverview();

    await waitFor(() => expect(tileValue("Calls")).toBe("0"));
    expect(tileValue("Containment")).toBe("n/a");
    expect(tileValue("Average cost")).toBe("n/a");
    expect(await screen.findAllByText("No calls in this range")).toHaveLength(4);
  });

  it("shows an error with a working retry when the metrics call fails", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "dashboard_metrics" ? { data: null, error: { message: "permission denied for function dashboard_metrics" } } : { data: [], error: null },
    );
    renderOverview();

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent("Could not load the metrics");
    expect(alerts[0]).toHaveTextContent("permission denied");

    mockRpc();
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    await waitFor(() => expect(tileValue("Calls")).toBe("42"));
  });
});
