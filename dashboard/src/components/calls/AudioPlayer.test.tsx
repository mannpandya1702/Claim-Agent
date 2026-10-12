import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));

const { AudioPlayer, RECORDING_UNAVAILABLE, requestRecordingUrl } = await import("./AudioPlayer");

beforeEach(() => {
  invoke.mockReset();
  // jsdom has no media playback.
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

describe("AudioPlayer", () => {
  it("asks recording-url for a link only when Play is pressed", async () => {
    invoke.mockResolvedValue({ data: { url: "https://storage.example/rec.wav?sig=1" }, error: null });
    render(<AudioPlayer callId="call-1" hasRecording />);
    expect(invoke).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Play recording" }));
    expect(invoke).toHaveBeenCalledWith("recording-url", { body: { call_id: "call-1" } });
    const audio = await screen.findByLabelText("Call recording");
    expect(audio).toHaveAttribute("src", "https://storage.example/rec.wav?sig=1");
  });

  it("shows Recording unavailable with the function's reason when the link fails", async () => {
    const context = new Response(JSON.stringify({ error: "Recording no longer available" }), { status: 404 });
    invoke.mockResolvedValue({ data: null, error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context }) });
    render(<AudioPlayer callId="call-1" hasRecording />);
    await userEvent.click(screen.getByRole("button", { name: "Play recording" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(RECORDING_UNAVAILABLE);
    expect(alert).toHaveTextContent("Recording no longer available");
  });

  it("fetches a fresh link once on an audio error, then gives up", async () => {
    invoke
      .mockResolvedValueOnce({ data: { url: "https://storage.example/old" }, error: null })
      .mockResolvedValueOnce({ data: { url: "https://storage.example/new" }, error: null });
    render(<AudioPlayer callId="call-1" hasRecording />);
    await userEvent.click(screen.getByRole("button", { name: "Play recording" }));

    fireEvent.error(await screen.findByLabelText("Call recording"));
    await waitFor(() => expect(screen.getByLabelText("Call recording")).toHaveAttribute("src", "https://storage.example/new"));
    expect(invoke).toHaveBeenCalledTimes(2);

    fireEvent.error(screen.getByLabelText("Call recording"));
    expect(await screen.findByRole("alert")).toHaveTextContent(RECORDING_UNAVAILABLE);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("says the recording comes after the call while it is live", () => {
    render(<AudioPlayer callId="call-1" hasRecording={false} live />);
    expect(screen.getByText(/available after the call ends/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("rejects an answer without a link", async () => {
    invoke.mockResolvedValue({ data: {}, error: null });
    await expect(requestRecordingUrl("call-1")).rejects.toThrow(/No recording link/);
  });
});
