import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTestProvider } from "@/lib/auth";
import { ROUTER_FUTURE } from "@/lib/router";
import type { EmailRow, Escalation, EscalationStatus } from "@/lib/types";

const { fetchEscalations, claimEscalation, closeEscalation, fetchEscalationCounts, fetchEscalationEmails } = vi.hoisted(() => ({
  fetchEscalations: vi.fn(),
  claimEscalation: vi.fn(),
  closeEscalation: vi.fn(),
  fetchEscalationCounts: vi.fn(),
  fetchEscalationEmails: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: {}, supabaseConfigured: true }));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  fetchEscalations: (...args: unknown[]) => fetchEscalations(...args),
  claimEscalation: (...args: unknown[]) => claimEscalation(...args),
  closeEscalation: (...args: unknown[]) => closeEscalation(...args),
}));
vi.mock("@/components/escalations/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/escalations/data")>()),
  fetchEscalationCounts: () => fetchEscalationCounts(),
  fetchEscalationEmails: (...args: unknown[]) => fetchEscalationEmails(...args),
}));
// Realtime wiring is covered by realtime.test.ts; here it must not open a socket.
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  useRealtimeRows: vi.fn(() => ({ status: "SUBSCRIBED", isLive: true })),
}));
const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() });
vi.mock("@/components/ui/sonner", () => ({ toast }));

const { default: Escalations } = await import("./Escalations");

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (min: number, from = NOW) => new Date(from.getTime() - min * 60_000).toISOString();

function esc(over: Partial<Escalation>): Escalation {
  return {
    id: "esc",
    call_key: "call",
    kind: "representative",
    reason: "representative_requested",
    details: null,
    callback_phone: "+16025550102",
    channel: "webCall",
    verified: true,
    callback_source: "account",
    alert_status: "sent",
    delivery_error: null,
    status: "open",
    claimed_by: null,
    claimed_at: null,
    closed_by: null,
    closed_at: null,
    close_note: null,
    realerted_at: null,
    created_at: ago(5),
    updated_at: ago(5),
    ...over,
  };
}

const OPEN = [
  esc({ id: "esc-old", call_key: "call-old", created_at: ago(42), details: "Wants to discuss the appeal." }),
  esc({
    id: "esc-new",
    call_key: "call-new",
    kind: "emergency",
    reason: "emergency",
    created_at: ago(10),
    alert_status: "failed",
    delivery_error: "telegram: 401 Unauthorized",
    callback_source: "caller_id",
  }),
];
const CLAIMED = [esc({ id: "esc-claimed", call_key: "call-c", status: "claimed", claimed_by: "ana@example.com", claimed_at: ago(3), created_at: ago(20) })];
const EMAILS: EmailRow[] = [
  { id: "m1", call_key: "call-old", kind: "callback_request", to_masked: "c***@example.com", resend_id: "re_1", status: "sent", error: null, created_at: ago(41) },
];

function mockData(open: Escalation[] = OPEN) {
  const lists: Record<EscalationStatus, Escalation[]> = { open, claimed: CLAIMED, done: [] };
  fetchEscalations.mockImplementation(async (status: EscalationStatus) => lists[status]);
  fetchEscalationCounts.mockResolvedValue({ open: open.length, claimed: CLAIMED.length, done: 0 });
  fetchEscalationEmails.mockResolvedValue(EMAILS);
}

function renderPage(now: Date = NOW, path = "/escalations") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AuthTestProvider value={{ email: "staff@example.com" }}>
        <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
          {children}
        </MemoryRouter>
      </AuthTestProvider>
    </QueryClientProvider>
  );
  return render(<Escalations now={now} />, { wrapper: Wrapper });
}

function tileValue(label: string): string {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "";
}

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-escalation-id="${id}"]`);
  if (!el) throw new Error(`no card ${id}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockData();
});

describe("Escalations", () => {
  it("shows the SLA badge only on open escalations past 30 minutes, by the injected clock", async () => {
    renderPage(NOW);
    await screen.findByRole("list", { name: "Open escalations, oldest first" });

    expect(within(card("esc-old")).getByText(/SLA breached/)).toHaveTextContent("42 min");
    expect(within(card("esc-new")).queryByText(/SLA breached/)).not.toBeInTheDocument();
    expect(tileValue("Past SLA")).toBe("1");
    expect(tileValue("Oldest open")).toBe("42 min");
    expect(tileValue("Open")).toBe("2");
  });

  it("puts the second escalation past SLA when the clock moves 25 minutes on", async () => {
    renderPage(new Date(NOW.getTime() + 25 * 60_000));
    await screen.findByRole("list", { name: "Open escalations, oldest first" });

    expect(within(card("esc-old")).getByText(/SLA breached/)).toHaveTextContent("67 min");
    expect(within(card("esc-new")).getByText(/SLA breached/)).toHaveTextContent("35 min");
    expect(tileValue("Past SLA")).toBe("2");
    expect(tileValue("Oldest open")).toBe("1 h 7 min");
  });

  it("shows Telegram and email delivery per row, the delivery error and the callback source", async () => {
    renderPage();
    await screen.findByRole("list", { name: "Open escalations, oldest first" });

    const old = card("esc-old");
    await waitFor(() => expect(within(old).getByText("Callback request")).toBeInTheDocument());
    expect(within(old).getByText("Number on account")).toBeInTheDocument();
    expect(within(old).getByRole("link", { name: "+1 602 ... 0102" })).toHaveAttribute("href", "tel:+16025550102");
    expect(fetchEscalationEmails).toHaveBeenCalledWith(["call-new", "call-old"]);

    const fresh = card("esc-new");
    expect(within(fresh).getByRole("note")).toHaveTextContent("Delivery error: telegram: 401 Unauthorized");
    expect(within(fresh).getByText("Caller ID")).toBeInTheDocument();
    expect(within(fresh).getByRole("link", { name: /Open call/ })).toHaveAttribute("href", "/calls/call-new");
  });

  it("claims through claim_escalation", async () => {
    claimEscalation.mockResolvedValue({ ...OPEN[0], status: "claimed", claimed_by: "staff@example.com" });
    renderPage();
    await screen.findByRole("list", { name: "Open escalations, oldest first" });

    await userEvent.click(within(card("esc-old")).getByRole("button", { name: "Claim" }));
    expect(claimEscalation).toHaveBeenCalledWith("esc-old");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Escalation claimed", expect.anything()));
  });

  it("switches to the claimed tab with its count", async () => {
    renderPage();
    const claimedTab = await screen.findByRole("tab", { name: /Claimed/ });
    await waitFor(() => expect(claimedTab).toHaveTextContent("1"));

    await userEvent.click(claimedTab);
    await screen.findByRole("list", { name: "Claimed escalations, newest first" });
    expect(fetchEscalations).toHaveBeenCalledWith("claimed");
    expect(within(card("esc-claimed")).queryByRole("button", { name: "Claim" })).not.toBeInTheDocument();
    expect(within(card("esc-claimed")).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("filters by kind and explains when the filter hides everything", async () => {
    mockData([OPEN[0]!]);
    renderPage();
    await screen.findByRole("list", { name: "Open escalations, oldest first" });

    await userEvent.click(screen.getByRole("button", { name: "Emergency" }));
    expect(await screen.findByText("No emergency escalations here")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all kinds" }));
    expect(await screen.findByRole("list", { name: "Open escalations, oldest first" })).toBeInTheDocument();
  });

  it("shows a clear queue as an empty state with good-news tiles", async () => {
    mockData([]);
    renderPage();
    expect(await screen.findByText("No open escalations")).toBeInTheDocument();
    expect(tileValue("Past SLA")).toBe("0");
    expect(screen.getByText("Queue clear")).toBeInTheDocument();
  });
});
