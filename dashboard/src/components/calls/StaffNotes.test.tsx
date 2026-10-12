import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const saveStaffNotes = vi.fn();
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  saveStaffNotes: (...args: unknown[]) => saveStaffNotes(...args),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { StaffNotes } = await import("./StaffNotes");
const { qk } = await import("@/lib/queries");

function wrap(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// restoreMocks (vitest config) resets these between tests.
describe("StaffNotes", () => {
  it("saves, then shows only the value the server confirmed", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.callRow("call-1"), { vapi_call_id: "call-1", staff_notes: null });
    saveStaffNotes.mockResolvedValue("Called back at 3pm.");
    render(<StaffNotes callId="call-1" notes={null} />, { wrapper: wrap(client) });

    const save = screen.getByRole("button", { name: "Save notes" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Staff notes"), "Called back at 3pm.");
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
    await userEvent.click(save);

    expect(saveStaffNotes).toHaveBeenCalledWith("call-1", "Called back at 3pm.");
    expect(await screen.findByText(/Saved at/)).toBeInTheDocument();
    expect(client.getQueryData<{ staff_notes: string }>(qk.callRow("call-1"))?.staff_notes).toBe("Called back at 3pm.");
  });

  it("reports a save that did not apply instead of pretending it worked", async () => {
    const client = new QueryClient();
    saveStaffNotes.mockRejectedValue(new Error("Notes were not saved (no permission to update this call)."));
    render(<StaffNotes callId="call-1" notes="old" />, { wrapper: wrap(client) });
    await userEvent.type(screen.getByLabelText("Staff notes"), " plus more");
    await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
    expect(await screen.findByText(/Not saved: Notes were not saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("Staff notes")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Staff notes")).toHaveValue("old plus more");
  });

  it("takes a new server value when untouched, and keeps a draft in progress", async () => {
    const client = new QueryClient();
    const { rerender } = render(<StaffNotes callId="call-1" notes="first" />, { wrapper: wrap(client) });
    rerender(<StaffNotes callId="call-1" notes="second" />);
    expect(screen.getByLabelText("Staff notes")).toHaveValue("second");

    await userEvent.type(screen.getByLabelText("Staff notes"), "!");
    rerender(<StaffNotes callId="call-1" notes="third" />);
    expect(screen.getByLabelText("Staff notes")).toHaveValue("second!");
    expect(screen.getByText(/Someone else saved new notes/)).toBeInTheDocument();
  });
});
