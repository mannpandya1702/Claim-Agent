import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTestProvider, type AuthStatus } from "@/lib/auth";
import { ROUTER_FUTURE } from "@/lib/router";
import { getCallState, resetCall, stop } from "@/lib/vapi";
import TalkToTessa from "./TalkToTessa";

/*
 * The page against the real call store with a fake SDK. The build here has the web and core
 * assistants but no squad id, and a backup phone number, so one file covers both the
 * configured and the "not configured" paths.
 */

type Listener = (...args: unknown[]) => void;

interface FakeInstance {
  emit: (event: string, ...args: unknown[]) => void;
}

const sdk = vi.hoisted(() => ({
  instances: [] as FakeInstance[],
  startCalls: [] as unknown[][],
  stopCalls: 0,
  /** Replaces the default start (resolves to call-abc) for one test. */
  startImpl: null as null | ((inst: FakeInstance) => Promise<unknown>),
}));

vi.mock("@/lib/env", () => ({
  env: {
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon",
    vapiPublicKey: "public-key",
    assistantCoreId: "asst-core",
    assistantSoloId: "asst-solo",
    squadId: null,
    phoneNumber: "+16025550100",
    buildSha: "0123456789abcdef",
  },
  shortSha: () => "0123456",
}));

vi.mock("@vapi-ai/web", () => {
  class FakeVapi {
    listeners = new Map<string, Listener[]>();
    constructor() {
      sdk.instances.push(this);
    }
    async start(...args: unknown[]) {
      sdk.startCalls.push(args);
      return sdk.startImpl ? sdk.startImpl(this) : { id: "call-abc" };
    }
    async stop() {
      sdk.stopCalls++;
      this.emit("call-end");
    }
    on(event: string, cb: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
  }
  return { default: FakeVapi };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(path = "/call", status: AuthStatus = "signed-out") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthTestProvider value={{ status, email: status === "signed-out" ? null : "someone@example.com" }}>
        <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
          <Routes>
            <Route
              path="/call"
              element={
                <>
                  <TalkToTessa />
                  <LocationProbe />
                </>
              }
            />
            <Route path="/calls/:id" element={<p>call detail</p>} />
          </Routes>
        </MemoryRouter>
      </AuthTestProvider>
    </QueryClientProvider>,
  );
}

function setMicrophone(getUserMedia: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(getUserMedia) } });
}

const grantedStream = () => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] });

beforeEach(() => {
  sdk.startImpl = null;
  sdk.startCalls.length = 0;
  sdk.stopCalls = 0;
  setMicrophone(grantedStream);
});

afterEach(async () => {
  await act(async () => {
    await stop();
    resetCall();
  });
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("Talk to Tessa", () => {
  it("renders the mode switch with the web assistant selected by default", () => {
    renderPage();
    const group = screen.getByRole("group", { name: /assistant/i });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: /web assistant/i })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /core/i })).not.toBeChecked();
    expect(within(group).getByRole("radio", { name: /squad \(not configured\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start call" })).toBeEnabled();
  });

  it("reads the mode from ?mode= and writes a switch back to the URL", async () => {
    renderPage("/call?mode=core");
    expect(screen.getByRole("radio", { name: /core/i })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /web assistant/i }));
    expect(screen.getByRole("radio", { name: /web assistant/i })).toBeChecked();
    expect(screen.getByTestId("location")).toHaveTextContent("/call?mode=solo");
  });

  it("disables start and says what to set when the mode has no id", () => {
    renderPage("/call?mode=squad");
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    expect(screen.getByText("Squad is not configured")).toBeInTheDocument();
    expect(screen.getByText("VITE_SQUAD_ID")).toBeInTheDocument();
  });

  it("shows the seeded identities with copyable numbers and the backup phone line", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPage();

    const sheet = screen.getByRole("region", { name: "Demo identities" });
    for (const name of ["Tobias Halvorsen", "Ronan Quintero", "Sloane Marchetti", "Teague Ashdown", "Ines Lindqvist"]) {
      expect(within(sheet).getByText(name)).toBeInTheDocument();
    }
    expect(within(sheet).getByText("March 14, 1986")).toBeInTheDocument();
    expect(within(sheet).getByText("+1 602 555 0199")).toBeInTheDocument();
    expect(within(sheet).getByText(/no customer has this number/i)).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole("button", { name: /copy tobias halvorsen phone number/i }));
    expect(writeText).toHaveBeenCalledWith("+16025550101");
    expect(await within(sheet).findByText("Copied Tobias Halvorsen phone number +1 602 555 0101")).toBeInTheDocument();

    const backup = within(sheet).getByRole("link", { name: "+1 602 555 0100" });
    expect(backup).toHaveAttribute("href", "tel:+16025550100");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("stops at the microphone check when access is denied, without starting a call", async () => {
    setMicrophone(() => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Start call" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/microphone blocked/i);
    expect(sdk.startCalls).toHaveLength(0);
    expect(getCallState().status).toBe("idle");
  });

  it("runs a call: link to the detail page, live transcript, speaking state and End", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Start call" }));

    // start() resolved the call id: the right pane links to it and asks a signed-out viewer to sign in.
    const pane = screen.getByRole("region", { name: "Watch this call" });
    const detail = await within(pane).findByRole("link", { name: /open call detail/i });
    expect(detail).toHaveAttribute("href", "/calls/call-abc");
    expect(detail).toHaveAttribute("target", "_blank");
    expect(within(pane).getByText("Sign in to watch this call")).toBeInTheDocument();
    expect(within(pane).getByRole("link", { name: /staff sign in/i })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent("/calls/call-abc")}`,
    );

    const inst = sdk.instances.at(-1)!;
    expect(sdk.startCalls.at(-1)).toEqual(["asst-solo"]);
    act(() => {
      inst.emit("call-start");
      inst.emit("speech-start");
      inst.emit("message", { type: "transcript", role: "assistant", transcriptType: "final", transcript: "Hi, this is Tessa." });
      inst.emit("message", { type: "transcript", role: "user", transcriptType: "partial", transcript: "my phone is" });
    });

    const panel = screen.getByRole("region", { name: "Web call" });
    expect(within(panel).getByText("Call status:", { exact: false }).parentElement).toHaveTextContent("Live");
    expect(within(panel).getByRole("radio", { name: /web assistant/i })).toBeDisabled();
    const log = within(panel).getByRole("log", { name: "Your call transcript" });
    expect(within(log).getByText("Hi, this is Tessa.")).toBeInTheDocument();
    expect(within(log).getByText("my phone is")).toBeInTheDocument();
    const speakers = within(panel).getByRole("group", { name: "Who is speaking" });
    expect(speakers.querySelectorAll('[data-speaking="true"]')).toHaveLength(2);

    // End is reachable in the card and in the sticky header.
    const ends = screen.getAllByRole("button", { name: /end call/i });
    expect(ends.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(within(panel).getByRole("button", { name: /end call/i }));
    await waitFor(() => expect(getCallState().status).toBe("ended"));
    expect(sdk.stopCalls).toBeGreaterThan(0);
    expect(within(panel).getByRole("button", { name: "Start a new call" })).toBeEnabled();
    // The link to the finished call stays so the presenter can open its report.
    expect(within(pane).getByRole("link", { name: /open call detail/i })).toBeInTheDocument();
  });

  it("renders a wallet refusal from the SDK inline", async () => {
    sdk.startImpl = async (inst) => {
      inst.emit("error", { type: "start-method-error", error: { message: "Wallet balance is insufficient", statusCode: 402 } });
      return null;
    };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Start call" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/out of credit/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("names the origin to allow when the public key refuses this site", async () => {
    sdk.startImpl = async (inst) => {
      inst.emit("error", { type: "start-method-error", error: { message: "Origin not allowed", statusCode: 403 } });
      return null;
    };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Start call" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This site is not allowed");
    expect(alert).toHaveTextContent(window.location.origin);
  });
});
