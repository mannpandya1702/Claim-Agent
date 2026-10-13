import type Vapi from "@vapi-ai/web";
import { useSyncExternalStore } from "react";
import { env } from "./env";

/*
 * One Vapi instance for the whole app, created lazily on the first start, with every listener
 * attached exactly once at creation. Call state lives in this module (read through
 * useSyncExternalStore), so unmounts, route changes and StrictMode double effects can neither
 * duplicate listeners nor drop an active call. start() is only ever called from a click handler
 * (browsers require a user gesture for the microphone).
 *
 * The SDK (with its WebRTC transport) is imported dynamically so staff pages do not download it;
 * the call page calls preloadVapi() on mount so the import is warm before the first click.
 */

export type CallMode = "solo" | "core" | "squad";
export type CallStatus = "idle" | "starting" | "active" | "ending" | "ended" | "error";

export interface CallerLine {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** ms since the call started (client clock), for ordering only. */
  at: number;
}

export interface VapiCallState {
  status: CallStatus;
  mode: CallMode | null;
  /** The VAPI call id; equals call_key in every table, so it links to #/calls/<id>. */
  callId: string | null;
  error: string | null;
  assistantSpeaking: boolean;
  /** Committed final transcript lines. */
  finals: CallerLine[];
  /** One replaceable partial line per role. */
  partial: { user: string | null; assistant: string | null };
  startedAt: number | null;
}

export interface CallModeInfo {
  mode: CallMode;
  label: string;
  description: string;
  /** The assistant or squad id, or null before the VAPI sync has filled it in. */
  targetId: string | null;
}

export const CALL_MODES: CallModeInfo[] = [
  {
    mode: "solo",
    label: "Web assistant",
    description: "Ava with the FAQ knowledge base. The default.",
    targetId: env.assistantSoloId,
  },
  {
    mode: "core",
    label: "Core",
    description: "The frozen graded assistant, kept as the demo fallback.",
    targetId: env.assistantCoreId,
  },
  {
    mode: "squad",
    label: "Squad",
    description: "Concierge with a Knowledge specialist it hands policy questions to.",
    targetId: env.squadId,
  },
];

export function modeInfo(mode: CallMode): CallModeInfo {
  return CALL_MODES.find((m) => m.mode === mode) ?? CALL_MODES[0]!;
}

/** `?mode=` value -> mode; anything unknown falls back to the default web assistant. */
export function parseMode(value: string | null | undefined): CallMode {
  return value === "core" || value === "squad" ? value : "solo";
}

const INITIAL: VapiCallState = {
  status: "idle",
  mode: null,
  callId: null,
  error: null,
  assistantSpeaking: false,
  finals: [],
  partial: { user: null, assistant: null },
  startedAt: null,
};

let state: VapiCallState = INITIAL;
const listeners = new Set<() => void>();

function setState(patch: Partial<VapiCallState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function getCallState(): VapiCallState {
  return state;
}

export function subscribeCallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCallState(): VapiCallState {
  return useSyncExternalStore(subscribeCallState, getCallState, getCallState);
}

/** True while there is a call to end (the End button shows on every route). */
export function isCallActive(s: VapiCallState = state): boolean {
  return s.status === "starting" || s.status === "active" || s.status === "ending";
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function flatten(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return `${e.name} ${e.message}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Daily reports a normal hang-up by the assistant as an error; it is not one. */
export function isBenignEnd(e: unknown): boolean {
  return /meeting has ended|meeting ended|ejected/i.test(flatten(e));
}

/** The SDK's error payloads vary by stage; this maps them to one sentence the caller can act on. */
export function describeVapiError(e: unknown): string {
  const s = flatten(e);
  if (/notallowederror|permission denied|permission dismissed|microphone|getusermedia/i.test(s)) {
    return "Microphone access is blocked. Allow the microphone for this site, then try again.";
  }
  if (/\b402\b|wallet|insufficient|credit|balance/i.test(s)) {
    return "The voice account is out of credit, so the call could not start.";
  }
  if (/\b403\b|origin|forbidden|not allowed/i.test(s)) {
    return "This site is not on the voice key's allowed list, so the call was refused.";
  }
  if (/\b404\b|not found/i.test(s)) {
    return "The configured assistant was not found. The VAPI ids may be out of date.";
  }
  if (/network|failed to fetch|timeout|timed out/i.test(s)) {
    return "Network problem while starting the call. Check the connection and try again.";
  }
  return "The call could not start. Try again.";
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

let lineSeq = 0;

/** Folds one SDK `message` event into the caller-side transcript. Pure apart from the id counter. */
export function applyMessage(s: VapiCallState, message: unknown, now: number = Date.now()): VapiCallState {
  if (!message || typeof message !== "object") return s;
  const m = message as Record<string, unknown>;
  const type = typeof m.type === "string" ? m.type : "";
  if (type !== "transcript" && !type.startsWith("transcript[")) return s;
  const role = m.role === "user" || m.role === "assistant" ? m.role : null;
  const text = typeof m.transcript === "string" ? m.transcript.trim() : "";
  if (!role) return s;
  const isFinal = m.transcriptType === "final" || type.includes('"final"');
  if (isFinal) {
    if (!text) return { ...s, partial: { ...s.partial, [role]: null } };
    const at = s.startedAt ? now - s.startedAt : 0;
    return {
      ...s,
      finals: [...s.finals, { id: ++lineSeq, role, text, at }],
      partial: { ...s.partial, [role]: null },
    };
  }
  return { ...s, partial: { ...s.partial, [role]: text || null } };
}

// ---------------------------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------------------------

let instance: Vapi | null = null;
let creating: Promise<Vapi | null> | null = null;

function attachListeners(vapi: Vapi): void {
  vapi.on("call-start", () => {
    setState({ status: "active", startedAt: state.startedAt ?? Date.now(), error: null });
  });
  vapi.on("call-end", () => {
    setState({
      status: state.status === "error" ? "error" : "ended",
      assistantSpeaking: false,
      partial: { user: null, assistant: null },
    });
  });
  vapi.on("speech-start", () => setState({ assistantSpeaking: true }));
  vapi.on("speech-end", () => setState({ assistantSpeaking: false }));
  vapi.on("message", (message: unknown) => {
    const next = applyMessage(state, message);
    if (next !== state) setState(next);
  });
  vapi.on("error", (e: unknown) => {
    if (isBenignEnd(e)) return;
    // Mid-call errors (for example audio processing) do not end the call; show them and carry on.
    if (state.status === "active") setState({ error: describeVapiError(e) });
    else setState({ status: "error", error: describeVapiError(e) });
  });
}

type VapiCtor = new (publicKey: string) => Vapi;

/**
 * The SDK ships CommonJS (`exports.default = Vapi`). Depending on the bundler's interop the
 * dynamic import yields the class at `default` or at `default.default`; accept either.
 */
export function resolveVapiCtor(mod: unknown): VapiCtor {
  const m = mod as { default?: unknown } | null;
  const first = m?.default;
  if (typeof first === "function") return first as VapiCtor;
  const nested = (first as { default?: unknown } | undefined)?.default;
  if (typeof nested === "function") return nested as VapiCtor;
  if (typeof mod === "function") return mod as VapiCtor;
  throw new Error("Voice SDK did not load (no Vapi constructor)");
}

/** Warms the SDK import without creating anything. */
export function preloadVapi(): void {
  if (env.vapiPublicKey) void import("@vapi-ai/web").catch(() => undefined);
}

/** The shared instance, created (with its listeners) on first use; null without a public key. */
export function getVapi(): Promise<Vapi | null> {
  if (instance) return Promise.resolve(instance);
  if (!env.vapiPublicKey) return Promise.resolve(null);
  const key = env.vapiPublicKey;
  creating ??= import("@vapi-ai/web").then((mod) => {
    if (instance) return instance;
    const VapiClass = resolveVapiCtor(mod);
    const created = new VapiClass(key);
    attachListeners(created);
    if (typeof window !== "undefined") {
      // Closing or navigating away from the tab must hang up, or the call keeps billing.
      window.addEventListener("pagehide", () => {
        void stop();
      });
    }
    instance = created;
    return created;
  });
  // A failed chunk load (flaky network, a deploy replaced the hashed file) must not poison every
  // later click: forget the rejected promise so the next start retries the import.
  creating.catch(() => {
    creating = null;
  });
  return creating;
}

/**
 * Starts a web call. Call only from a click handler. Resolves to the call id, or null when the
 * call did not start (already active, not configured, refused); the reason is in state.error.
 */
export async function start(mode: CallMode): Promise<string | null> {
  if (isCallActive()) return null;

  const info = modeInfo(mode);
  if (!info.targetId) {
    setState({ ...INITIAL, status: "error", mode, error: `The ${info.label} mode is not configured in this build yet.` });
    return null;
  }
  if (!env.vapiPublicKey) {
    setState({ ...INITIAL, status: "error", mode, error: "Voice calling is not configured in this build (no VAPI public key)." });
    return null;
  }

  // Claim the slot synchronously so a double click cannot start two calls.
  setState({ ...INITIAL, status: "starting", mode });
  try {
    const vapi = await getVapi();
    if (!vapi) throw new Error("Voice SDK unavailable");
    if (state.status !== "starting") return null; // stopped while the SDK was loading
    // The SDK takes a squad as the third argument (a string id is sent as squadId).
    const call = mode === "squad" ? await vapi.start(undefined, undefined, info.targetId) : await vapi.start(info.targetId);
    if (!call) {
      if (state.status === "starting") {
        setState({ status: "error", error: state.error ?? "The call could not start. Try again." });
      }
      return null;
    }
    const id = typeof call.id === "string" && call.id ? call.id : null;
    setState({ callId: id });
    return id;
  } catch (e) {
    if (state.status === "starting") setState({ status: "error", error: describeVapiError(e) });
    return null;
  }
}

/** Hangs up. Safe to call at any time, including during start and from pagehide. */
export async function stop(): Promise<void> {
  if (!instance) {
    // Still loading the SDK: start() sees the status change and abandons the attempt.
    if (state.status === "starting") setState({ status: "ended" });
    return;
  }
  if (state.status === "starting" || state.status === "active") setState({ status: "ending" });
  try {
    await instance.stop();
  } catch {
    // stop() tears down the transport; a failure there still means the call is over for us.
  }
  if (state.status === "ending") setState({ status: "ended", assistantSpeaking: false, partial: { user: null, assistant: null } });
}

/** Back to idle after an ended or failed call, keeping nothing from it. */
export function resetCall(): void {
  if (isCallActive()) return;
  setState(INITIAL);
}
