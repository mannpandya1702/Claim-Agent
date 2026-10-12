import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTestProvider } from "@/lib/auth";
import { ROUTER_FUTURE } from "@/lib/router";
import type { EmailRow, Escalation } from "@/lib/types";

const claimEscalation = vi.fn();
const closeEscalation = vi.fn();
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  claimEscalation: (...args: unknown[]) => claimEscalation(...args),
  closeEscalation: (...args: unknown[]) => closeEscalation(...args),
}));
const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() });
vi.mock("@/components/ui/sonner", () => ({ toast }));

const { EscalationCard, isSlaBreached } = await import("./EscalationCard");

const NOW = new Date("2026-10-12T15:00:00Z");

function esc(over: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc-1",
    call_key: "call-1",
    kind: "representative",
    reason: "representative_requested",
    details: "Caller wants to talk about the appeal.",
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
    created_at: "2026-10-12T14:50:00Z",
    updated_at: "2026-10-12T14:50:00Z",
    ...over,
  };
}

const EMAILS: EmailRow[] = [
  { id: "m1", call_key: "call-1", kind: "callback_request", to_masked: "c***@example.com", resend_id: "re_1", status: "sent", error: null, created_at: "2026-10-12T14:50:02Z" },
  { id: "m2", call_key: "call-1", kind: "document_checklist", to_masked: "t***@example.com", resend_id: "re_2", status: "sent", error: null, created_at: "2026-10-12T14:51:00Z" },
];

function renderCard(e: Escalation, email = "staff@example.com") {
  const client = new QueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AuthTestProvider value={{ email }}>
        <MemoryRouter future={ROUTER_FUTURE}>{children}</MemoryRouter>
      </AuthTestProvider>
    </QueryClientProvider>
  );
  return render(<EscalationCard escalation={e} emails={EMAILS} now={NOW} />, { wrapper: Wrapper });
}

beforeEach(() => {
  claimEscalation.mockReset();
  closeEscalation.mockReset();
  toast.success.mockReset();
  toast.info.mockReset();
});

describe("EscalationCard", () => {
  it("shows the callback number with its source, Telegram status and the escalation's own email", () => {
    renderCard(esc());
    expect(screen.getByRole("link", { name: "+1 602 555 0102" })).toHaveAttribute("href", "tel:+16025550102");
    expect(screen.getByText("Number on account")).toBeInTheDocument();
    const telegram = screen.getByText("Telegram alert").parentElement!;
    expect(within(telegram).getByText("Sent")).toBeInTheDocument();
    const email = screen.getByText("Email").parentElement!;
    expect(within(email).getByText("Callback request")).toBeInTheDocument();
    expect(within(email).queryByText("Document checklist")).not.toBeInTheDocument();
  });

  it("shows the delivery error when a channel failed", () => {
    renderCard(esc({ alert_status: "failed", delivery_error: "telegram: 401 Unauthorized" }));
    expect(screen.getByRole("note")).toHaveTextContent("Delivery error: telegram: 401 Unauthorized");
  });

  it("claims through claim_escalation and tells the second claimer who got there first", async () => {
    claimEscalation.mockResolvedValue(esc({ status: "claimed", claimed_by: "other@example.com", claimed_at: "2026-10-12T14:55:00Z" }));
    renderCard(esc());
    await userEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(claimEscalation).toHaveBeenCalledWith("esc-1");
    expect(toast.info).toHaveBeenCalledWith("Already claimed by other@example.com");
  });

  it("closes through close_escalation with the optional note", async () => {
    closeEscalation.mockResolvedValue(esc({ status: "done", closed_by: "staff@example.com", closed_at: "2026-10-12T15:00:00Z" }));
    renderCard(esc({ status: "claimed", claimed_by: "staff@example.com" }));
    expect(screen.queryByRole("button", { name: "Claim" })).not.toBeInTheDocument();
    expect(screen.getByText("you")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Called back.");
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(closeEscalation).toHaveBeenCalledWith("esc-1", "Called back.");
    expect(toast.success).toHaveBeenCalledWith("Escalation marked done");
  });

  it("flags an SLA breach once an open escalation is 30 minutes old", () => {
    expect(isSlaBreached(esc({ created_at: "2026-10-12T14:31:00Z" }), NOW)).toBe(false);
    expect(isSlaBreached(esc({ created_at: "2026-10-12T14:30:00Z" }), NOW)).toBe(true);
    expect(isSlaBreached(esc({ created_at: "2026-10-12T14:00:00Z", status: "claimed" }), NOW)).toBe(false);
    renderCard(esc({ created_at: "2026-10-12T14:18:00Z" }));
    expect(screen.getByText(/SLA breached · 42 min/)).toBeInTheDocument();
  });

  it("has no actions once done", () => {
    renderCard(esc({ status: "done", claimed_by: "a@example.com", closed_by: "a@example.com", close_note: "Resolved." }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Note: Resolved.")).toBeInTheDocument();
  });
});
