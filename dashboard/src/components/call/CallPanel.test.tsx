import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CallModeInfo, VapiCallState } from "@/lib/vapi";
import { CallPanel, type CallPanelProps } from "./CallPanel";
import { CheatSheet } from "./CheatSheet";

const MODES: CallModeInfo[] = [
  { mode: "solo", label: "Web assistant", description: "Ava with the FAQ knowledge base.", targetId: "asst-solo" },
  { mode: "core", label: "Core", description: "The frozen assistant.", targetId: null },
  { mode: "squad", label: "Squad", description: "Concierge and Knowledge.", targetId: "squad-1" },
];

const IDLE: VapiCallState = {
  status: "idle",
  mode: null,
  callId: null,
  error: null,
  assistantSpeaking: false,
  finals: [],
  partial: { user: null, assistant: null },
  startedAt: null,
};

function renderPanel(overrides: Partial<CallPanelProps> = {}, call: Partial<VapiCallState> = {}) {
  const props: CallPanelProps = {
    call: { ...IDLE, ...call },
    mode: "solo",
    modes: MODES,
    onModeChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    preparing: false,
    micProblem: null,
    micPermission: "prompt",
    voiceConfigured: true,
    ...overrides,
  };
  render(<CallPanel {...props} />);
  return props;
}

describe("CallPanel", () => {
  it("starts from the button and switches modes from the radios", async () => {
    const props = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Start call" }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("radio", { name: /squad/i }));
    expect(props.onModeChange).toHaveBeenCalledWith("squad");
  });

  it("disables start with a configuration message when the selected mode has no id", () => {
    renderPanel({ mode: "core" });
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    expect(screen.getByText("Core is not configured")).toBeInTheDocument();
    expect(screen.getByText("VITE_ASSISTANT_CORE_ID")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /core \(not configured\)/i })).toBeChecked();
  });

  it("disables start when the build has no public key", () => {
    renderPanel({ voiceConfigured: false });
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    expect(screen.getByText("Voice calling is not configured")).toBeInTheDocument();
  });

  it("warns before the first click when the microphone is blocked for the site", () => {
    renderPanel({ micPermission: "denied" });
    expect(screen.getByText("Microphone blocked for this site")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start call" })).toBeEnabled();
  });

  it("explains a failed microphone check as an alert", () => {
    renderPanel({ micProblem: "busy" });
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone in use");
  });

  it("titles store errors and keeps a mid-call problem as a warning", () => {
    renderPanel({}, { status: "error", error: "This site is not on the voice key's allowed list, so the call was refused." });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This site is not allowed");
    expect(alert).toHaveAttribute("data-tone", "critical");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("keeps a mid-call error as a warning while the call runs", () => {
    renderPanel({}, { status: "active", startedAt: Date.now(), error: "Network problem while starting the call." });
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "warning");
  });

  it("shows End while connecting and live, and disables it while ending", async () => {
    const props = renderPanel({}, { status: "starting", mode: "solo" });
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: /web assistant/i })).toBeDisabled();
  });

  it("disables End while the hang-up is in flight", () => {
    renderPanel({}, { status: "ending", startedAt: Date.now() });
    expect(screen.getByRole("button", { name: "Ending call" })).toBeDisabled();
  });

  it("shows who is speaking and the caller-side transcript with one partial per role", () => {
    renderPanel(
      {},
      {
        status: "active",
        startedAt: Date.now() - 5000,
        assistantSpeaking: true,
        finals: [
          { id: 1, role: "assistant", text: "Hi, this is Ava.", at: 1200 },
          { id: 2, role: "user", text: "I want my claim status.", at: 4100 },
        ],
        partial: { user: "my number is", assistant: "Sure, can" },
      },
    );
    const speakers = screen.getByRole("group", { name: "Who is speaking" });
    expect(within(speakers).getAllByText("Speaking")).toHaveLength(2);

    const log = screen.getByRole("log", { name: "Your call transcript" });
    const items = within(log).getAllByRole("listitem", { hidden: true });
    expect(items.map((li) => li.getAttribute("data-role"))).toEqual(["assistant", "user", "assistant", "user"]);
    expect(items.filter((li) => li.dataset.partial === "true")).toHaveLength(2);
    expect(within(log).getByText("00:01")).toBeInTheDocument();
    expect(within(log).getByText("00:04")).toBeInTheDocument();
  });

  it("says Listening and Quiet when nobody talks on a live call", () => {
    renderPanel({}, { status: "active", startedAt: Date.now() });
    const speakers = screen.getByRole("group", { name: "Who is speaking" });
    expect(within(speakers).getByText("Listening")).toBeInTheDocument();
    expect(within(speakers).getByText("Quiet")).toBeInTheDocument();
  });
});

describe("CheatSheet", () => {
  it("hides the backup phone line when no number is configured", () => {
    render(<CheatSheet phoneNumber={null} />);
    expect(screen.queryByText(/backup/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^copy .* phone number/i })).toHaveLength(6);
  });
});
