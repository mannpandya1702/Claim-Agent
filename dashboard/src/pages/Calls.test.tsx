import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTER_FUTURE } from "@/lib/router";
import type { CallListRow, SearchCallsParams } from "@/lib/types";

const searchCalls = vi.fn();
const useRealtimeRows = vi.fn((..._args: unknown[]) => ({ status: "SUBSCRIBED", isLive: true }));
vi.mock("@/lib/supabase", () => ({ supabase: {}, supabaseConfigured: true }));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  searchCalls: (p: SearchCallsParams) => searchCalls(p),
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  useRealtimeRows: (...args: unknown[]) => useRealtimeRows(...args),
}));

const { default: Calls } = await import("./Calls");

const ID = "7c1e2d3f-0000-4a4a-9b9b-0123456789ab";

function listRow(over: Partial<CallListRow> = {}): CallListRow {
  return {
    id: "row-1",
    vapi_call_id: ID,
    channel: "webCall",
    caller_name: "Ronan Quintero",
    caller_phone_masked: "+1 602 ... 0102",
    outcome: "escalated",
    sentiment: "neutral",
    escalated: true,
    emergency: false,
    emailed: false,
    flags: [],
    started_at: "2026-10-12T14:00:00Z",
    ended_at: "2026-10-12T14:02:00Z",
    duration_seconds: 120,
    cost: 0.21,
    latency_avg_ms: 900,
    summary: "Asked for a representative.",
    assistant_name: null,
    created_at: "2026-10-12T14:00:00Z",
    total: 1,
    ...over,
  };
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
        <Routes>
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<p>detail page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Calls page", () => {
  it("pre-fills the search from the #/calls?q=<call id> deep link and searches all time", async () => {
    searchCalls.mockResolvedValue({ rows: [listRow()], total: 1 });
    renderAt(`/calls?q=${ID}`);

    expect(screen.getByRole("searchbox", { name: "Search calls" })).toHaveValue(ID);
    await waitFor(() => expect(searchCalls).toHaveBeenCalled());
    expect(searchCalls.mock.calls[0]![0]).toMatchObject({ p_q: ID, p_from: null, p_to: null, p_limit: 25, p_offset: 0 });
    expect(await screen.findByRole("link", { name: "Open call" })).toHaveAttribute("href", `/calls/${ID}`);
    expect(screen.getByRole("link", { name: "Ronan Quintero" })).toBeInTheDocument();
  });

  it("subscribes to call_interactions and invalidates every list", () => {
    searchCalls.mockResolvedValue({ rows: [], total: null });
    renderAt("/calls");
    expect(useRealtimeRows).toHaveBeenCalledWith("call_interactions", null, [["calls"]]);
  });

  it("sends the URL filters to search_calls with server pagination", async () => {
    searchCalls.mockResolvedValue({ rows: [listRow({ total: 60 })], total: 60 });
    renderAt("/calls?range=30d&outcome=escalated&flagged=1&page=2");
    await waitFor(() => expect(searchCalls).toHaveBeenCalled());
    const p = searchCalls.mock.calls[0]![0] as SearchCallsParams;
    expect(p).toMatchObject({ p_outcome: "escalated", p_flagged: true, p_escalated: null, p_offset: 25, p_limit: 25 });
    expect(p.p_from).toEqual(expect.any(String));
    expect(await screen.findByText(/Showing 26–26 of 60/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("goes back to the first page when a later page comes back empty", async () => {
    searchCalls.mockImplementation(async (p: SearchCallsParams) =>
      (p.p_offset ?? 0) > 0 ? { rows: [], total: null } : { rows: [listRow()], total: 1 },
    );
    renderAt("/calls?page=4");
    await waitFor(() => expect(searchCalls).toHaveBeenCalledWith(expect.objectContaining({ p_offset: 0 })));
    expect(await screen.findByRole("link", { name: "Ronan Quintero" })).toBeInTheDocument();
  });

  it("keeps the pager buttons enabled while the next page loads, so keyboard focus stays put", async () => {
    searchCalls.mockImplementation((p: SearchCallsParams) =>
      (p.p_offset ?? 0) === 0 ? Promise.resolve({ rows: [listRow({ total: 60 })], total: 60 }) : new Promise(() => {}),
    );
    renderAt("/calls");
    const next = await screen.findByRole("button", { name: "Next page" });
    next.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(searchCalls).toHaveBeenCalledWith(expect.objectContaining({ p_offset: 25 })));
    // page 2 is still loading (placeholder rows on screen); the pressed button keeps focus
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("sends a custom range of Eastern days from the URL", async () => {
    searchCalls.mockResolvedValue({ rows: [listRow()], total: 1 });
    renderAt("/calls?range=custom&from=2026-10-01&to=2026-10-05");
    await waitFor(() => expect(searchCalls).toHaveBeenCalled());
    expect(searchCalls.mock.calls[0]![0]).toMatchObject({ p_from: "2026-10-01T04:00:00.000Z", p_to: "2026-10-06T04:00:00.000Z" });
    expect(screen.getByRole("combobox", { name: "Date range" })).toHaveTextContent("Oct 1 – Oct 5");
    expect(await screen.findByText(/Oct 1 – Oct 5/, { selector: "span" })).toBeInTheDocument();
  });

  it("explains an empty search and offers a way out", async () => {
    searchCalls.mockResolvedValue({ rows: [], total: null });
    renderAt("/calls?q=nothing-like-this&range=7d");
    expect(await screen.findByText("No calls match “nothing-like-this”")).toBeInTheDocument();
    // One in the filter row, one beside the empty state where the eye already is.
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show all time" })).toBeInTheDocument();
  });
});

describe("Calls page across Eastern midnight", () => {
  afterEach(() => vi.useRealTimers());

  it("moves Today's bounds when the Eastern day changes, as the Overview tiles do", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-13T03:58:00Z")); // 11:58 PM Oct 12, Eastern
    searchCalls.mockReset();
    searchCalls.mockResolvedValue({ rows: [listRow()], total: 1 });
    renderAt("/calls?range=today");
    await waitFor(() => expect(searchCalls).toHaveBeenCalledWith(expect.objectContaining({ p_from: "2026-10-12T04:00:00.000Z" })));

    vi.setSystemTime(new Date("2026-10-13T04:01:00Z")); // 12:01 AM Oct 13
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(searchCalls).toHaveBeenCalledWith(
        expect.objectContaining({ p_from: "2026-10-13T04:00:00.000Z", p_to: "2026-10-14T04:00:00.000Z" }),
      ),
    );
  });
});
