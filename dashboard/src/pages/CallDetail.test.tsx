import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTestProvider } from "@/lib/auth";
import { ROUTER_FUTURE } from "@/lib/router";
import type {
  Attempt,
  CallerContact,
  CallInteraction,
  CallSession,
  ClaimIntake,
  Escalation,
  OutboxEvent,
  TranscriptLineRow,
} from "@/lib/types";

const api = {
  fetchCall: vi.fn(),
  fetchCallSession: vi.fn(),
  fetchCallAttempts: vi.fn(),
  fetchTranscriptLines: vi.fn(),
  fetchCallEscalations: vi.fn(),
  fetchCallEmails: vi.fn(),
  fetchCallOutbox: vi.fn(),
  fetchCallContact: vi.fn(),
  fetchCallIntake: vi.fn(),
};
const invoke = vi.fn();
const buildEnv = vi.hoisted(() => ({ ghlLocationId: "Loc123abc" as string | null }));
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
  fetchCallOutbox: (id: string) => api.fetchCallOutbox(id),
  fetchCallContact: (id: string) => api.fetchCallContact(id),
  fetchCallIntake: (id: string) => api.fetchCallIntake(id),
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get ghlLocationId() {
        return buildEnv.ghlLocationId;
      },
    },
  };
});
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
    has_recording: true,
    cost: 0.1234,
    success_evaluation: "true",
    analysis_raw: null,
    messages: [
      { role: "assistant", text: "Hi, this is Ava.", t: 0.5 },
      { role: "tool", tool: "lookup_customer", code: "needs_dob", t: 9 },
      { role: "user", text: "My number is on file.", t: 4 },
    ],
    latency_avg_ms: 840,
    cost_breakdown: { stt: 0.01, llm: 0.05, tts: 0.03, vapi: 0.025, transport: 0.0084, total: 0.1234 },
    staff_notes: null,
    assistant_name: null,
    analysis_status: "ok",
    caller_type: "existing",
    caller_email: null,
    created_at: "2026-10-12T15:00:00Z",
    updated_at: "2026-10-12T15:03:10Z",
    ...over,
  };
}

function contact(over: Partial<CallerContact> = {}): CallerContact {
  return {
    call_key: ID,
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

function intake(over: Partial<ClaimIntake> = {}): ClaimIntake {
  return {
    call_key: ID,
    kind: "claim",
    claim_type: "auto",
    loss_date: "2026-10-10",
    summary: "cracked windshield",
    description: "A rock hit my windshield on the highway.",
    claim_number: "CLM-104472",
    confirmed: true,
    confirmed_at: "2026-10-12T15:02:30Z",
    created_at: "2026-10-12T15:02:00Z",
    updated_at: "2026-10-12T15:02:30Z",
    ...over,
  };
}

/** The header's caller type badge (the only CallerTypeBadge on the page). */
function headerCallerType(): Element | null {
  return document.querySelector("[data-caller-type]");
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
  api.fetchCallOutbox.mockResolvedValue([]);
  api.fetchCallContact.mockResolvedValue(null);
  api.fetchCallIntake.mockResolvedValue(null);
  buildEnv.ghlLocationId = "Loc123abc";
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
      callback_phone: "+16025550101", callback_phone_masked: "+1 602 ... 0101", channel: "webCall", verified: true, callback_source: "account",
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
    // the call page is where staff dial: the full number, as a tel: link
    expect(within(section).getByRole("link", { name: "+1 602 555 0101" })).toHaveAttribute("href", "tel:+16025550101");
  });

  it("lists the call's outbox deliveries with attempts and the last error", async () => {
    const base = { kind: "interaction.completed", ref_id: ID, destination: "airtable", created_at: "2026-10-12T15:03:10Z", updated_at: "2026-10-12T15:04:00Z" };
    const events: OutboxEvent[] = [
      { ...base, id: "o1", delivered_at: "2026-10-12T15:03:12Z", attempts: 1, last_error: null, external_id: "recAAA" },
      { ...base, id: "o2", delivered_at: null, attempts: 5, last_error: "airtable: 422 INVALID_VALUE_FOR_COLUMN", external_id: null },
    ];
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallOutbox.mockResolvedValue(events);
    renderDetail();
    const section = await screen.findByRole("region", { name: /Outbox events/ });
    const items = await within(section).findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Airtable call log");
    expect(items[0]).toHaveTextContent("Delivered");
    expect(items[0]).toHaveTextContent("1 of 5 attempts");
    expect(items[1]).toHaveTextContent("Gave up");
    expect(items[1]).toHaveTextContent("Last error: airtable: 422 INVALID_VALUE_FOR_COLUMN");
    expect(useRealtimeRows.mock.calls.map((c) => `${c[0]} ${c[1]}`)).toContain(`outbox_events ref_id=eq.${ID}`);
  });

  it("shows the reported claim, the call reason and the claim number the call filed", async () => {
    api.fetchCall.mockResolvedValue(call({ call_reason: "file_claim", call_reason_source: "server", claim_number: "CLM-104472" }));
    api.fetchCallIntake.mockResolvedValue(intake());
    renderDetail();

    const card = await screen.findByRole("region", { name: "Claim reported" });
    expect(within(card).getByText("Filed")).toBeInTheDocument();
    expect(within(card).getByText("CLM-104472")).toBeInTheDocument();
    expect(within(card).getByText("Sat, Oct 10, 2026")).toBeInTheDocument();
    expect(within(card).getByText("A rock hit my windshield on the highway.")).toBeInTheDocument();

    const badge = document.querySelector("[data-call-reason]");
    expect(badge).toHaveAttribute("data-call-reason", "file_claim");
    expect(badge).toHaveTextContent("File a claim");

    const facts = screen.getByRole("region", { name: "Call details" });
    expect(within(facts).getByText("File a claim (Server facts)")).toBeInTheDocument();
    expect(within(facts).getByText("Claim filed").nextElementSibling).toHaveTextContent("CLM-104472");

    expect(api.fetchCallIntake).toHaveBeenCalledWith(ID);
    const sub = useRealtimeRows.mock.calls.find((c) => c[0] === "claim_intakes")!;
    expect(sub[1]).toBe(`call_key=eq.${ID}`);
    expect(sub[2]).toEqual([["call", ID, "intake"]]);
  });

  it("shows no claim card for a call that reported no loss, and says it has no reason yet", async () => {
    api.fetchCall.mockResolvedValue(call({ call_reason: null, call_reason_source: null, claim_number: null }));
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: "Tobias Halvorsen" });
    await screen.findByRole("region", { name: "Caller contact" });
    expect(screen.queryByRole("region", { name: "Claim reported" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-call-reason]")).toBeNull();
    const facts = screen.getByRole("region", { name: "Call details" });
    expect(within(facts).getByText("Not tagged")).toBeInTheDocument();
    expect(within(facts).queryByText("Claim filed")).not.toBeInTheDocument();
  });

  it("says the reported claim could not be read instead of hiding it", async () => {
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallIntake.mockRejectedValue(new Error("claim_intakes: permission denied"));
    renderDetail();
    const card = await screen.findByRole("region", { name: "Claim reported" });
    expect(await within(card).findByText("Could not load the reported claim")).toBeInTheDocument();
  });

  it("links the GoHighLevel contact once its delivery recorded one", async () => {
    const base = { kind: "interaction.completed", ref_id: ID, created_at: "2026-10-12T15:03:10Z", updated_at: "2026-10-12T15:05:00Z" };
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallOutbox.mockResolvedValue([
      { ...base, id: "o1", destination: "airtable", delivered_at: "2026-10-12T15:03:12Z", attempts: 1, last_error: null, external_id: "recAAA" },
      { ...base, id: "o2", destination: "ghl", delivered_at: "2026-10-12T15:04:40Z", attempts: 1, last_error: null, external_id: "pXq7Contact01" },
    ] satisfies OutboxEvent[]);
    renderDetail();

    const link = await screen.findByRole("link", { name: /Open in GoHighLevel/ });
    expect(link).toHaveAttribute("href", "https://app.gohighlevel.com/v2/location/Loc123abc/contacts/detail/pXq7Contact01");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    const outbox = screen.getByRole("region", { name: /Outbox events/ });
    expect(within(outbox).getByText("GoHighLevel CRM")).toBeInTheDocument();
  });

  it("shows no GoHighLevel link before delivery or without a location id", async () => {
    const ghl: OutboxEvent = {
      id: "o2", kind: "interaction.completed", ref_id: ID, destination: "ghl", delivered_at: null, attempts: 0, last_error: null,
      external_id: null, created_at: "2026-10-12T15:03:10Z", updated_at: "2026-10-12T15:03:10Z",
    };
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallOutbox.mockResolvedValue([ghl]);
    const { unmount } = renderDetail();
    const outbox = await screen.findByRole("region", { name: /Outbox events/ });
    expect(await within(outbox).findByText("GoHighLevel CRM")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open in GoHighLevel/ })).not.toBeInTheDocument();
    unmount();

    buildEnv.ghlLocationId = null;
    api.fetchCallOutbox.mockResolvedValue([{ ...ghl, delivered_at: "2026-10-12T15:04:40Z", attempts: 1, external_id: "pXq7Contact01" }]);
    renderDetail();
    expect(await screen.findByText("GoHighLevel CRM")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open in GoHighLevel/ })).not.toBeInTheDocument();
  });

  it("shows a new caller's type in the header and their confirmed contact details in a card", async () => {
    api.fetchCall.mockResolvedValue(
      call({ caller_name: "Priya Raman", caller_type: "new", caller_email: "priya.raman42@gmail.com", outcome: "not_found" }),
    );
    api.fetchCallSession.mockResolvedValue({ ...session, level: "none" });
    api.fetchCallContact.mockResolvedValue(contact());
    renderDetail();

    expect(await screen.findByRole("heading", { level: 1, name: "Priya Raman" })).toBeInTheDocument();
    expect(headerCallerType()).toHaveAttribute("data-caller-type", "new");
    expect(headerCallerType()).toHaveTextContent("New");

    const card = screen.getByRole("region", { name: "Caller contact" });
    expect(await within(card).findByText("New customer")).toBeInTheDocument();
    expect(within(card).getByText("Priya Raman")).toBeInTheDocument();
    expect(within(card).getByText("Confirmed")).toBeInTheDocument();
    // the call page is the one place the full address and number appear
    expect(within(card).getByRole("link", { name: "priya.raman42@gmail.com" })).toHaveAttribute("href", "mailto:priya.raman42@gmail.com");
    expect(within(card).getByRole("link", { name: "+1 602 555 0188" })).toHaveAttribute("href", "tel:+16025550188");

    expect(api.fetchCallContact).toHaveBeenCalledWith(ID);
    expect(useRealtimeRows.mock.calls.map((c) => `${c[0]} ${c[1]}`)).toContain(`caller_contacts call_key=eq.${ID}`);
    const sub = useRealtimeRows.mock.calls.find((c) => c[0] === "caller_contacts")!;
    expect(sub[2]).toEqual([["call", ID, "contact"]]);
  });

  it("shows a pending email update request from a verified customer", async () => {
    api.fetchCall.mockResolvedValue(call({ caller_type: "existing" }));
    api.fetchCallContact.mockResolvedValue(contact({ kind: "email_update", confirmed: false, confirmed_at: null, first_name: "Teague", last_name: "Ashdown" }));
    renderDetail();
    const card = await screen.findByRole("region", { name: "Caller contact" });
    expect(await within(card).findByText("Email update request")).toBeInTheDocument();
    expect(within(card).getByText("Pending")).toBeInTheDocument();
    expect(headerCallerType()).toHaveTextContent("Existing");
  });

  it("says no contact details were taken when the call has none", async () => {
    api.fetchCall.mockResolvedValue(call());
    renderDetail();
    const card = await screen.findByRole("region", { name: "Caller contact" });
    expect(await within(card).findByText("No contact details were taken on this call.")).toBeInTheDocument();
  });

  it("says the contact read failed instead of claiming there was none", async () => {
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallContact.mockRejectedValue(new Error("caller_contacts: permission denied"));
    renderDetail();
    const card = await screen.findByRole("region", { name: "Caller contact" });
    expect(await within(card).findByText("Could not load the caller contact")).toBeInTheDocument();
    expect(within(card).queryByText(/No contact details/)).not.toBeInTheDocument();
  });

  it("shows a loading placeholder in the contact card while its read is pending", async () => {
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallContact.mockReturnValue(new Promise(() => {}));
    renderDetail();
    const card = await screen.findByRole("region", { name: "Caller contact" });
    expect(within(card).getByText("Loading")).toBeInTheDocument();
    expect(within(card).queryByText(/No contact details/)).not.toBeInTheDocument();
  });

  it("shows no caller type for a call recorded before caller types existed", async () => {
    api.fetchCall.mockResolvedValue(call({ caller_type: undefined, caller_email: undefined }));
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: "Tobias Halvorsen" });
    expect(headerCallerType()).toBeNull();
  });

  it("says a per-call read failed instead of claiming there was nothing", async () => {
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallAttempts.mockRejectedValue(new Error("attempts: permission denied"));
    api.fetchCallSession.mockRejectedValue(new Error("call_sessions: timeout"));
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: "Tobias Halvorsen" });
    const timeline = screen.getByRole("region", { name: /Tool timeline/ });
    expect(await within(timeline).findByText("Could not load tool calls")).toBeInTheDocument();
    expect(within(timeline).queryByText(/made no tool calls/)).not.toBeInTheDocument();
    const identity = screen.getByRole("region", { name: "Identity path" });
    expect(within(identity).getByText("Could not load the identity path")).toBeInTheDocument();
    // the header never claims "Not verified" from a failed read
    expect(screen.queryByText("Not verified")).not.toBeInTheDocument();
  });

  it("shows loading placeholders, not empty states, while per-call reads are pending", async () => {
    api.fetchCall.mockResolvedValue(call());
    api.fetchCallSession.mockReturnValue(new Promise(() => {}));
    api.fetchCallAttempts.mockReturnValue(new Promise(() => {}));
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: "Tobias Halvorsen" });
    expect(screen.queryByText("Not verified")).not.toBeInTheDocument();
    expect(screen.queryByText(/made no tool calls/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /Tool timeline/ })).getByText("Loading")).toBeInTheDocument();
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
    // the live stub's caller type is only the default, so the header does not state it
    expect(headerCallerType()).toBeNull();
    expect(within(screen.getByRole("region", { name: "Caller contact" })).getByText(/None yet/)).toBeInTheDocument();

    const subs = useRealtimeRows.mock.calls.map((c) => `${c[0]} ${c[1]}`);
    expect(subs).toEqual(
      expect.arrayContaining([
        `call_interactions vapi_call_id=eq.${ID}`,
        `transcript_lines call_key=eq.${ID}`,
        `attempts call_key=eq.${ID}`,
        `call_sessions call_key=eq.${ID}`,
        `escalations call_key=eq.${ID}`,
        `emails call_key=eq.${ID}`,
        `caller_contacts call_key=eq.${ID}`,
        `claim_intakes call_key=eq.${ID}`,
      ]),
    );
  });

  it("shows a transcript read failure on a live call instead of 'waiting for the first words'", async () => {
    api.fetchCall.mockResolvedValue(call({ ended_at: null, summary: null, sentiment: null, flags: [], messages: null, outcome: "in_progress" }));
    api.fetchTranscriptLines.mockRejectedValue(new Error("transcript_lines: 500"));
    renderDetail();
    const section = await screen.findByRole("region", { name: /Transcript/ });
    expect(await within(section).findByText("Could not load the transcript")).toBeInTheDocument();
    expect(within(section).queryByText(/Waiting for the first words/)).not.toBeInTheDocument();
  });

  it("does not call a stub 'no data yet' when a read failed", async () => {
    api.fetchCall.mockResolvedValue(null);
    api.fetchCallSession.mockResolvedValue(null);
    api.fetchCallAttempts.mockRejectedValue(new Error("attempts: 500"));
    renderDetail();
    expect(await screen.findByText("Could not load tool calls")).toBeInTheDocument();
    expect(screen.queryByText("No data for this call yet")).not.toBeInTheDocument();
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
