import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk, type CallSummary } from "@/lib/queries";
import { ROUTER_FUTURE } from "@/lib/router";
import type { Attempt, CallSession, Escalation, TranscriptLineRow } from "@/lib/types";

const m = vi.hoisted(() => ({
  fetchLiveCalls: vi.fn(),
  fetchTranscriptLines: vi.fn(),
  fetchCallAttempts: vi.fn(),
  fetchCallLevel: vi.fn(),
  fetchCallEscalations: vi.fn(),
  useRealtimeRows: vi.fn(() => ({ status: "SUBSCRIBED", isLive: true })),
}));

vi.mock("@/lib/supabase", () => ({ supabase: {}, supabaseConfigured: true }));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  fetchLiveCalls: () => m.fetchLiveCalls(),
  fetchTranscriptLines: (id: string) => m.fetchTranscriptLines(id),
  fetchCallAttempts: (id: string) => m.fetchCallAttempts(id),
  fetchCallLevel: (id: string) => m.fetchCallLevel(id),
  fetchCallEscalations: (id: string) => m.fetchCallEscalations(id),
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  useRealtimeRows: m.useRealtimeRows,
}));

const { default: Live } = await import("./Live");

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();

function call(over: Partial<CallSummary>): CallSummary {
  return {
    id: "row",
    vapi_call_id: "call-1",
    channel: "webCall",
    caller_name: null,
    caller_phone_masked: null,
    outcome: "in_progress",
    sentiment: null,
    escalated: false,
    emergency: false,
    flags: [],
    started_at: ago(125),
    ended_at: null,
    duration_seconds: null,
    assistant_name: "Ava",
    created_at: ago(125),
    updated_at: ago(10),
    ...over,
  };
}

const LINES: TranscriptLineRow[] = [
  { id: 1, call_key: "call-1", role: "assistant", text: "Hi, this is Ava with Observe Insurance.", ts_ms: 1000, created_at: ago(120) },
  { id: 2, call_key: "call-1", role: "user", text: "I want to check my claim.", ts_ms: 6000, created_at: ago(115) },
];
const ATTEMPTS: Attempt[] = [
  { call_key: "call-1", tool_call_id: "t1", tool_name: "lookup_customer", kind: "lookup_hit", code: "needs_dob", created_at: ago(100) },
  { call_key: "call-1", tool_call_id: "t2", tool_name: "verify_identity", kind: "dob_ok", code: "verified", created_at: ago(80) },
];
// Live cards read the level alone, never the session's caller number.
const SESSION: Pick<CallSession, "call_key" | "level"> = { call_key: "call-1", level: "verified" };
const ESCALATION = { id: "e1", call_key: "call-1", kind: "representative", status: "open", claimed_by: null } as Escalation;

function renderLive(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={["/live"]}>
        <Live now={NOW} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.fetchLiveCalls.mockResolvedValue([call({ caller_name: "Tobias Halvorsen" })]);
  m.fetchTranscriptLines.mockResolvedValue(LINES);
  m.fetchCallAttempts.mockResolvedValue(ATTEMPTS);
  m.fetchCallLevel.mockResolvedValue(SESSION);
  m.fetchCallEscalations.mockResolvedValue([ESCALATION]);
});

describe("Live", () => {
  it("shows each call in progress with its transcript, identity, last tool code and escalation", async () => {
    m.fetchLiveCalls.mockResolvedValue([call({ caller_name: "Tobias Halvorsen", caller_phone_masked: "+1 602 ... 0101" })]);
    renderLive();
    const card = await screen.findByRole("article", { name: /Tobias Halvorsen/ });

    await waitFor(() => expect(within(card).getByText("Hi, this is Ava with Observe Insurance.")).toBeInTheDocument());
    expect(within(card).getByText("I want to check my claim.")).toBeInTheDocument();
    expect(within(card).getByText("Verified")).toBeInTheDocument();
    expect(within(card).getByTitle("Last tool result: verify_identity: verified")).toBeInTheDocument();
    expect(within(card).getByText("Escalation open")).toBeInTheDocument();
    expect(within(card).getByText("2:05")).toBeInTheDocument();
    expect(within(card).getByText("+1 602 ... 0101")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Open call/ })).toHaveAttribute("href", "/calls/call-1");
    expect(screen.getByTestId("live-count")).toHaveTextContent("1 call in progress");
  });

  it("subscribes per call_key to the four streaming tables and to call_interactions for the list", async () => {
    renderLive();
    await screen.findByRole("article", { name: /Tobias Halvorsen/ });
    const subs = m.useRealtimeRows.mock.calls.map((c) => {
      const [table, filter] = c as unknown as [string, string | null];
      return `${table}|${filter ?? ""}`;
    });
    expect(subs).toEqual(
      expect.arrayContaining([
        "call_interactions|",
        "transcript_lines|call_key=eq.call-1",
        "attempts|call_key=eq.call-1",
        "call_sessions|call_key=eq.call-1",
        "escalations|call_key=eq.call-1",
      ]),
    );
  });

  it("closes the card when ended_at is set and lists the call under ended", async () => {
    const client = renderLive();
    await screen.findByRole("article", { name: /Tobias Halvorsen/ });

    m.fetchLiveCalls.mockResolvedValue([]);
    await act(() => client.invalidateQueries({ queryKey: qk.liveCalls() }));

    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    const ended = screen.getByRole("region", { name: "Ended while you watched" });
    expect(within(ended).getByText("Tobias Halvorsen")).toBeInTheDocument();
    expect(within(ended).getByRole("link", { name: /Open call/ })).toHaveAttribute("href", "/calls/call-1");
    expect(screen.getByText("No calls in progress")).toBeInTheDocument();
  });

  it("keeps calls older than 2 hours out of the live grid as possibly stuck", async () => {
    m.fetchLiveCalls.mockResolvedValue([call({ vapi_call_id: "old", caller_name: null, created_at: ago(3 * 3600), started_at: ago(3 * 3600) })]);
    renderLive();
    const stuck = await screen.findByRole("region", { name: /Possibly stuck/ });
    expect(within(stuck).getByText("Unknown caller")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(m.fetchTranscriptLines).not.toHaveBeenCalled();
  });

  it("says a card's transcript or escalations failed to load instead of 'waiting for the first words'", async () => {
    m.fetchTranscriptLines.mockRejectedValue(new Error("transcript_lines: 500"));
    m.fetchCallEscalations.mockRejectedValue(new Error("escalations: 500"));
    renderLive();
    const card = await screen.findByRole("article", { name: /Tobias Halvorsen/ });
    expect(await within(card).findByText("Could not load the transcript")).toBeInTheDocument();
    expect(within(card).queryByText(/Waiting for the first words/)).not.toBeInTheDocument();
    expect(await within(card).findByText("Escalations unavailable")).toBeInTheDocument();
  });

  it("shows an empty state that points at the call page", async () => {
    m.fetchLiveCalls.mockResolvedValue([]);
    renderLive();
    expect(await screen.findByText("No calls in progress")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Start a test call/ })[0]).toHaveAttribute("href", "/call");
  });
});
