import type { CallStatus } from "@/lib/vapi";

export type CallErrorKind = "microphone" | "credit" | "origin" | "config" | "assistant" | "network" | "other";

export interface CallErrorView {
  kind: CallErrorKind;
  title: string;
  /** A second sentence with the fix, when the store's message alone does not say where to act. */
  hint: string | null;
}

/**
 * Titles the store's one-sentence errors (src/lib/vapi.ts describeVapiError). Matching on its
 * wording keeps the store the single owner of the sentence; an unmatched message still renders.
 */
export function describeCallError(message: string, status: CallStatus, origin: string | null = currentOrigin()): CallErrorView {
  const m = message.toLowerCase();
  if (m.includes("microphone")) return { kind: "microphone", title: "Microphone blocked", hint: null };
  if (m.includes("credit")) {
    return { kind: "credit", title: "Voice account out of credit", hint: "Top up the VAPI wallet, then start again." };
  }
  if (m.includes("allowed list")) {
    return {
      kind: "origin",
      title: "This site is not allowed",
      hint: origin ? `Add ${origin} to the public key's allowed origins in VAPI, then start again.` : null,
    };
  }
  if (m.includes("not configured")) return { kind: "config", title: "Not configured", hint: null };
  if (m.includes("not found")) {
    return { kind: "assistant", title: "Assistant not found", hint: "Re-run the VAPI sync and redeploy so the ids match." };
  }
  if (m.includes("network")) return { kind: "network", title: "Network problem", hint: null };
  // Mid-call problems leave the call running; anything else means it never connected.
  return { kind: "other", title: status === "active" ? "Problem during the call" : "The call did not start", hint: null };
}

function currentOrigin(): string | null {
  return typeof window !== "undefined" && window.location ? window.location.origin : null;
}
