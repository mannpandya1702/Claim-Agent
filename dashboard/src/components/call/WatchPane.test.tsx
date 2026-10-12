import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTestProvider, type AuthStatus } from "@/lib/auth";
import { ROUTER_FUTURE } from "@/lib/router";
import type { Attempt, CallInteraction, CallSession, TranscriptLineRow } from "@/lib/types";
import type { CallStatus } from "@/lib/vapi";
import { WatchPane } from "./WatchPane";

/*
 * Data access is mocked at the query functions; the realtime hook is a no-op that records which
 * tables and filters the live view subscribes to.
 */

const data = vi.hoisted(() => ({
  row: null as Partial<CallInteraction> | null,
  lines: [] as TranscriptLineRow[],
  attempts: [] as Attempt[],
  session: null as Partial<CallSession> | null,
  subscriptions: [] as Array<{ table: string; filter: string | null | undefined }>,
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    fetchCall: vi.fn(async () => data.row),
    fetchTranscriptLines: vi.fn(async () => data.lines),
    fetchCallAttempts: vi.fn(async () => data.attempts),
    fetchCallSession: vi.fn(async () => data.session),
    fetchCallEscalations: vi.fn(async () => []),
  };
});

vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    useRealtimeRows: (table: string, filter: string | null | undefined) => {
      data.subscriptions.push({ table, filter });
      return { status: "SUBSCRIBED", isLive: true };
    },
  };
});

function renderPane(callId: string | null, status: AuthStatus, callStatus: CallStatus = "active") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthTestProvider value={{ status, email: "visitor@example.com" }}>
        <MemoryRouter future={ROUTER_FUTURE} initialEntries={["/call"]}>
          <WatchPane callId={callId} status={callStatus} returnTo="/call?mode=solo" />
        </MemoryRouter>
      </AuthTestProvider>
    </QueryClientProvider>,
  );
}

const T0 = "2026-10-12T15:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

beforeEach(() => {
  data.row = { vapi_call_id: "call-1", caller_name: null, outcome: null, ended_at: null, messages: null };
  data.lines = [];
  data.attempts = [];
  data.session = { call_key: "call-1", level: "none" };
  data.subscriptions = [];
});

describe("WatchPane", () => {
  it("explains what will appear before there is a call, with a sign-in link back to this mode", () => {
    renderPane(null, "signed-out", "idle");
    expect(screen.getByText(/a link to its detail page appears here/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /staff sign in/i })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent("/call?mode=solo")}`,
    );
  });

  it("links to the call and asks a signed-out viewer to sign in", () => {
    renderPane("call-1", "signed-out");
    expect(screen.getByTestId("call-id")).toHaveTextContent("call-1");
    expect(screen.getByRole("link", { name: /open call detail/i })).toHaveAttribute("href", "/calls/call-1");
    expect(screen.getByRole("heading", { name: "Sign in to watch this call" })).toBeInTheDocument();
    expect(screen.queryByTestId("compact-live-view")).not.toBeInTheDocument();
    expect(data.subscriptions).toHaveLength(0);
  });

  it("tells a signed-in non-staff account why there is no live view", () => {
    renderPane("call-1", "not-staff");
    expect(screen.getByRole("heading", { name: "Not on the staff list" })).toBeInTheDocument();
    expect(screen.getByText("visitor@example.com")).toBeInTheDocument();
    expect(screen.queryByTestId("compact-live-view")).not.toBeInTheDocument();
  });

  it("streams the server's lines and tool chips for staff, subscribed per call", async () => {
    data.session = { call_key: "call-1", level: "verified" };
    data.lines = [
      { id: 1, call_key: "call-1", role: "assistant", text: "Thanks for calling Observe Insurance.", ts_ms: 1000, created_at: at(1) },
      { id: 2, call_key: "call-1", role: "user", text: "Six oh two five five five oh one oh one.", ts_ms: 6000, created_at: at(6) },
    ];
    data.attempts = [
      { call_key: "call-1", tool_call_id: "t1", tool_name: "lookup_customer", kind: "lookup_hit", code: "needs_dob", created_at: at(7) },
    ];
    renderPane("call-1", "staff");

    const view = await screen.findByTestId("compact-live-view");
    expect(view).toHaveAttribute("data-live", "true");
    expect(await within(view).findByText("Thanks for calling Observe Insurance.")).toBeInTheDocument();
    expect(within(view).getAllByText("lookup_customer: needs_dob").length).toBeGreaterThan(0);
    expect(await within(view).findByText("Verified")).toBeInTheDocument();
    expect(within(view).getByText("In progress")).toBeInTheDocument();

    const tables = data.subscriptions.map((s) => `${s.table} ${s.filter}`);
    expect(tables).toEqual(
      expect.arrayContaining([
        "call_interactions vapi_call_id=eq.call-1",
        "transcript_lines call_key=eq.call-1",
        "attempts call_key=eq.call-1",
        "call_sessions call_key=eq.call-1",
        "escalations call_key=eq.call-1",
      ]),
    );
  });

  it("switches to the stored transcript once the end-of-call report is in", async () => {
    data.row = {
      vapi_call_id: "call-1",
      caller_name: "Tobias Halvorsen",
      outcome: "resolved",
      ended_at: at(90),
      messages: [
        { role: "assistant", text: "Your claim is approved.", t: 40 },
        { role: "tool", tool: "get_claim_status", code: "ok", t: 38 },
      ],
    };
    data.lines = [];
    renderPane("call-1", "staff", "ended");

    const view = await screen.findByTestId("compact-live-view");
    expect(await within(view).findByText("Your claim is approved.")).toBeInTheDocument();
    expect(view).toHaveAttribute("data-live", "false");
    expect(within(view).getByText("Tobias Halvorsen")).toBeInTheDocument();
    expect(within(view).getByText("Resolved")).toBeInTheDocument();
    expect(within(view).getByText(/stored transcript/i)).toBeInTheDocument();
  });
});
