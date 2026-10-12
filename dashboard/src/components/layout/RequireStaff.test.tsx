import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ROUTER_FUTURE } from "@/lib/router";
import { AuthTestProvider, type AuthStatus } from "@/lib/auth";
import { RequireStaff } from "./RequireStaff";

function renderGate(status: AuthStatus, extra: Parameters<typeof AuthTestProvider>[0]["value"] = {}, path = "/calls?q=abc") {
  return render(
    <AuthTestProvider value={{ status, ...extra }}>
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<p>login page</p>} />
          <Route path="/call" element={<p>call page</p>} />
          <Route element={<RequireStaff />}>
            <Route path="/calls" element={<p>calls table</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthTestProvider>,
  );
}

describe("RequireStaff", () => {
  it("renders the page for staff", () => {
    renderGate("staff");
    expect(screen.getByText("calls table")).toBeInTheDocument();
  });

  it("sends a signed-out visitor to sign in", () => {
    renderGate("signed-out");
    expect(screen.getByText("login page")).toBeInTheDocument();
  });

  it("shows 'Not on the staff list' instead of empty tables for a non-staff account", async () => {
    const signOut = vi.fn(async () => {});
    renderGate("not-staff", { email: "visitor@example.com", signOut });
    expect(screen.getByRole("heading", { name: "Not on the staff list" })).toBeInTheDocument();
    expect(screen.getByText("visitor@example.com")).toBeInTheDocument();
    expect(screen.queryByText("calls table")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the staff check itself failed", async () => {
    const recheck = vi.fn();
    renderGate("error", { error: "fetch failed", recheck });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check staff access");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("shows a status spinner while loading", () => {
    renderGate("loading");
    expect(screen.getByRole("status")).toHaveTextContent("Checking access");
  });
});
