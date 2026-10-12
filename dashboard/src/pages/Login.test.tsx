import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ROUTER_FUTURE } from "@/lib/router";
import { AuthTestProvider, describeSignInError, type AuthStatus } from "@/lib/auth";
import Login, { safeNext } from "./Login";

// The test mode loads no .env file; pretend the build is configured unless a test says otherwise.
vi.mock("@/lib/supabase", () => ({ supabaseConfigured: true }));

function renderLogin(status: AuthStatus, signIn = vi.fn(async () => ({ error: null as string | null })), path = "/login") {
  render(
    <AuthTestProvider value={{ status, signIn }}>
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<p>overview</p>} />
          <Route path="/calls/:id" element={<p>call detail</p>} />
        </Routes>
      </MemoryRouter>
    </AuthTestProvider>,
  );
  return signIn;
}

describe("Login", () => {
  it("has labelled fields and signs in with them", async () => {
    const signIn = renderLogin("signed-out");
    await userEvent.type(screen.getByLabelText("Email"), "staff@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signIn).toHaveBeenCalledWith("staff@example.com", "hunter22");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks for both fields before calling Supabase", async () => {
    const signIn = renderLogin("signed-out");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your email and password.");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("shows the sign-in error and clears the password", async () => {
    renderLogin("signed-out", vi.fn(async () => ({ error: "Email or password is incorrect." })));
    await userEvent.type(screen.getByLabelText("Email"), "staff@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("goes to the requested page once signed in", () => {
    renderLogin("staff", undefined, `/login?next=${encodeURIComponent("/calls/abc")}`);
    expect(screen.getByText("call detail")).toBeInTheDocument();
  });

  it("only follows same-app next paths", () => {
    expect(safeNext("/calls/abc")).toBe("/calls/abc");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/login?next=/")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });

  it("maps Supabase errors to actionable sentences", () => {
    expect(describeSignInError("Invalid login credentials", 400)).toBe("Email or password is incorrect.");
    expect(describeSignInError("Email not confirmed", 400)).toMatch(/not been confirmed/);
    expect(describeSignInError("Request rate limit reached", 429)).toMatch(/Too many attempts/);
    expect(describeSignInError("Failed to fetch")).toMatch(/Cannot reach/);
  });

  it("warns when the build has no Supabase configuration", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase", () => ({ supabaseConfigured: false }));
    const { default: UnconfiguredLogin } = await import("./Login");
    const { AuthTestProvider: Provider } = await import("@/lib/auth");
    render(
      <Provider value={{ status: "signed-out" }}>
        <MemoryRouter future={ROUTER_FUTURE} initialEntries={["/login"]}>
          <UnconfiguredLogin />
        </MemoryRouter>
      </Provider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("VITE_SUPABASE_URL");
    vi.doUnmock("@/lib/supabase");
  });
});
