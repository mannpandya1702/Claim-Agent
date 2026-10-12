import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTestProvider } from "@/lib/auth";
import { ROUTER_FUTURE } from "@/lib/router";
import type { Attempt, CallInteraction, CallSession, Escalation, TranscriptLineRow } from "@/lib/types";

const api = {
  fetchCall: vi.fn(),
  fetchCallSession: vi.fn(),
  fetchCallAttempts: vi.fn(),
  fetchTranscriptLines: vi.fn(),
  fetchCallEscalations: vi.fn(),
  fetchCallEmails: vi.fn(),
};
const invoke = vi.fn();
const useRealtimeRows = vi.fn((..._args: unknown[]) => ({ status: "SUBSCRIBED", isLive: true }));

vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } }, supabaseConfigured: true }));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  fetchCall: (id: string) => api.fetchCall(id),
  fetchCallSession: (id: string) => api.fetchCallSession(id),
  fetchCallAttempts: (id: string) => api.fetchCallAttempts(id),
  fetchTranscriptLines: (id: string) => api.fetchTranscriptLines(id),
  fetchCallEscalations: (id: string) => api.fetchCallEscalations(id),
  fetchCallEmails: (id: string) => api.fetchCallEmails(id),
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  useRealtimeRows: (...args: unknown[]) => useRealtimeRows(...args),
}));

const { default: CallDetail, successMeta } = await import("./CallDetail");

const ID = "call-abc-123";

function call(over: Partial<CallInteraction> = {}): CallInteraction {
  return {
    id: "row-1",
    vapi_call_id: ID,
    channel: "webCall",
    customer_id: null,
    caller_name: "Tobias Halvorsen",
    caller_phone: "+16025550101",
    summary: "Tobias verified and heard his claim status.",
    sentiment: "positive",
    sentiment_source: "vapi",
    outcome: "resolved",
    escalated: false,
    emergency: false,
    flags: ["email_promised_without_send"],
    started_at: "2026-10-12T15:00:00Z",
    ended_at: "2026-10-12T15:03:00Z",
    duration_seconds: 180,
    ended_reason: "customer-ended-call",
    transcript: null,
    recording_url: "rec-ref",
    cost: 0.1234,
    success_evaluation: "true",
    analysis_raw: null,
    messages: [
      { role: "assistant", text: "Hi, this is Tessa.", t: 0.5 },
      { role: "tool", tool: "lookup_customer", code: "needs_dob", t: 9 },
      { role: "user", text: "My number is on file.", t: 4 },
    ],
    latency_avg_ms: 840,
    cost_breakdown: { stt: 0.01, llm: 0.05, tts: 0.03, vapi: 0.025, transport: 0.0084, total: 0.1234 },
    staff_notes: null,
    assistant_name: null,
    analysis_status: "ok",
    created_at: "2026-10-12T15:00:00Z",
    updated_at: "2026-10-12T15:03:10Z",
    ...over,
  };
}

const session: CallSession = {
  call_key: ID,
  channel: "webCall",
  caller_number: null,
  level: "verified",
  candidate_customer_id: null,
  verified_customer_id: null,
  created_at: "2026-10-12T15:00:00Z",
  updated_at: "2026-10-12T15:00:40Z",
};

const attempts: Attempt[] = [
  { call_key: ID, tool_call_id: "t1", tool_name: "lookup_customer", kind: "lookup_hit", code: "needs_dob", created_at: "2026-10-12T15:00:09Z" },
];

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthTestProvider value={{ email: "staff@example.com" }}>
        <MemoryRouter future={ROUTER_FUTURE} initialEntries={[`/calls/${ID}`]}>
          <Routes>
            <Route path="/calls/:id" element={<CallDetail />} />
          </Routes>
        </MemoryRouter>
      </AuthTestProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.fetchCallSession.mockResolvedValue(session);
  api.fetchCallAttempts.mockResolvedValue(attempts);
  api.fetchTranscriptLines.mockResolvedValue([]);
  api.fetchCallEscalations.mockResolvedValue([]);
  api.fetchCallEmails.mockResolvedValue([]);
});

describe("CallDetail after hangup", () => {
  it("shows the header, stored transcript, summary, flags, cost split and identity", async () => {
    api.fetchCall.mockResolvedValue(call());
    renderDetail();

    expect(await screen.findByRole("heading", { level: 1, name: "Tobias Halvorsen" })).toBeInTheDocument();
    expect(screen.getAllByText("Verified").length).toBeGreaterThan(0);
    expect(screen.getByText("Success: Pass")).toBeInTheDocument();
    expect(screen.getByText("Tobias verified and heard his claim status.")).toBeInTheDocument();
    expect(screen.getByText("Email promised, not sent")).toBeInTheDocument();
    expect(screen.getByText(/no email was sent for this call/)).toBeInTheDocument();
    expect(screen.getByText("840 ms")).toBeInTheDocument();

    const transcript = screen.getByRole("region", { name: "Conversation" });
    const kinds = Array.from(transcript.querySelectorAll<HTMLElement>("li[data-kind]")).map((li) => li.dataset.speaker ?? li.dataset.kind);
    expect(kinds).toEqual(["agent", "caller", "tool"]);
    expect(within(transcript).getByText("lookup_customer: needs_dob")).toBeInTheDocument();

    const cost = screen.getByRole("region", { name: "Cost" });
    expect(within(cost).getByText("Speech to text")).toBeInTheDocument();
    expect(within(cost).getByText("$0.0500")).toBeInTheDocument();
    expect(api.fetchTranscriptLines).not.toHaveBeenCalled();
  });

  it("does not ask for a recording link until Play is pressed", async () => {
    api.fetchCall.mockResolvedValue(call());
    renderDetail();
    expect(await screen.findByRole("button", { name: "Play recording" })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("prints n/a for a cost without a split, never $0", async () => {
    api.fetchCall.mockResolvedValue(call({ cost: null, cost_breakdown: null, latency_avg_ms: null }));
    renderDetail();
    const cost = await screen.findByRole("region", { name: "Cost" });
    expect(within(cost).getAllByText(/n\/a/).length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("lists this call's escalations with their Claim action", async () => {
    const esc: Escalation = {
      id: "e1", call_key: ID, kind: "representative", reason: "representative_requested", details: null,
      callback_phone: "+16025550101", channel: "webCall", verified: true, callback_source: "account",
      alert_status: "sent", delivery_error: null, status: "open", claimed_by: null, claimed_at: null,
      closed_by: null, closed_at: null, close_note: null, realerted_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    api.fetchCall.mockResolvedValue(call({ escalated: true, outcome: "escalated" }));
    api.fetchCallEscalations.mockResolvedValue([esc]);
    renderDetail();
    const section = await screen.findByRole("region", { name: /Escalations/ });
    expect(await within(section).findByRole("button", { name: "Claim" })).toBeInTheDocument();
    expect(within(section).getByText("Number on account")).toBeInTheDocument();
  });
});

describe("CallDetail while live", () => {
  it("streams transcript_lines with attempts chips and subscribes per call key", async () => {
    const lines: TranscriptLineRow[] = [
      { id: 1, call_key: ID, role: "assistant", text: "What number are you calling from?", ts_ms: 1000, created_at: "2026-10-12T15:00:01Z" },
      { id: 2, call_key: ID, role: "user", text: "It is on my account.", ts_ms: 5000, created_at: "2026-10-12T15:00:05Z" },
    ];
    api.fetchCall.mockResolvedValue(call({ ended_at: null, summary: null, sentiment: null, flags: [], messages: null, outcome: "in_progress" }));
    api.fetchTranscriptLines.mockResolvedValue(lines);
    renderDetail();

    const log = await screen.findByRole("log", { name: "Live transcript" });
    expect(await within(log).findByText("What number are you calling from?")).toBeInTheDocument();
    expect(within(log).getByText("lookup_customer: needs_dob")).toBeInTheDocument();
    expect(screen.getByText("This call is live.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play recording" })).not.toBeInTheDocument();

    const subs = useRealtimeRows.mock.calls.map((c) => `${c[0]} ${c[1]}`);
    expect(subs).toEqual(
      expect.arrayContaining([
        `call_interactions vapi_call_id=eq.${ID}`,
        `transcript_lines call_key=eq.${ID}`,
        `attempts call_key=eq.${ID}`,
        `call_sessions call_key=eq.${ID}`,
        `escalations call_key=eq.${ID}`,
        `emails call_key=eq.${ID}`,
      ]),
    );
  });

  it("waits politely when no row exists yet", async () => {
    api.fetchCall.mockResolvedValue(null);
    api.fetchCallSession.mockResolvedValue(null);
    api.fetchCallAttempts.mockResolvedValue([]);
    renderDetail();
    expect(await screen.findByText("No data for this call yet")).toBeInTheDocument();
  });
});

describe("successMeta", () => {
  it("normalises VAPI success evaluations", () => {
    expect(successMeta("true")).toEqual({ label: "Pass", tone: "good" });
    expect(successMeta("false")).toEqual({ label: "Fail", tone: "critical" });
    expect(successMeta("8")).toEqual({ label: "8", tone: "neutral" });
    expect(successMeta(null)).toBeNull();
  });
});
