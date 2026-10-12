import { CircleDot, Loader2, Mic, OctagonAlert, Phone, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNow } from "@/components/calls/hooks";
import { LiveDot } from "@/components/LiveDot";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatStamp } from "@/lib/format";
import { isCallActive, type CallMode, type CallModeInfo, type CallStatus, type VapiCallState } from "@/lib/vapi";
import { cn } from "@/lib/utils";
import { describeCallError } from "./callErrors";
import { CallerTranscript } from "./CallerTranscript";
import { CallNotice } from "./CallNotice";
import { MIC_PROBLEM_COPY, type MicPermission, type MicProblem } from "./microphone";
import { ModeSwitch } from "./ModeSwitch";
import { SpeakingPair } from "./SpeakingIndicator";

/** The build variable behind each mode, so the configuration message says exactly what to set. */
export const MODE_ENV_VAR: Record<CallMode, string> = {
  solo: "VITE_ASSISTANT_SOLO_ID",
  core: "VITE_ASSISTANT_CORE_ID",
  squad: "VITE_SQUAD_ID",
};

export interface CallPanelProps {
  call: VapiCallState;
  /** The selected mode (the live call's mode while one is in progress). */
  mode: CallMode;
  modes: readonly CallModeInfo[];
  onModeChange: (mode: CallMode) => void;
  onStart: () => void;
  onStop: () => void;
  /** True while the microphone check before start() runs. */
  preparing: boolean;
  micProblem: MicProblem | null;
  micPermission: MicPermission;
  /** False when the build has no VAPI public key. */
  voiceConfigured: boolean;
  className?: string;
}

export function CallPanel(props: CallPanelProps) {
  const { call, mode, modes, onModeChange, onStart, onStop, preparing, micProblem, micPermission, voiceConfigured, className } = props;
  const busy = isCallActive(call);
  const info = modes.find((m) => m.mode === mode) ?? modes[0]!;
  const modeConfigured = Boolean(info.targetId);
  const canStart = voiceConfigured && modeConfigured && !busy && !preparing;
  const connected = call.status === "active";
  const callerSpeaking = connected && Boolean(call.partial.user);
  const seconds = useCallSeconds(call);

  const startLabel = preparing
    ? "Checking microphone"
    : call.status === "ended"
      ? "Start a new call"
      : call.status === "error"
        ? "Try again"
        : "Start call";

  const errorView = call.error ? describeCallError(call.error, call.status) : null;
  const midCall = call.status === "active" && errorView !== null;

  return (
    <Card role="region" aria-labelledby="call-panel-title" className={cn("flex min-w-0 flex-col", className)} data-status={call.status}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0 space-y-0.5">
          <h2 id="call-panel-title" className="text-base font-semibold text-ink-1">
            Web call
          </h2>
          <p className="text-xs text-ink-2">
            Tessa · <span className="font-medium text-ink-1">{info.label}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {seconds !== null && (
            <p className="text-right leading-tight">
              <span className="block text-[11px] text-ink-3">{connected ? "Elapsed" : "Duration"}</span>
              <span className="block text-sm font-semibold tabular text-ink-1">{formatStamp(seconds)}</span>
            </p>
          )}
          <CallStatusBadge status={call.status} preparing={preparing} />
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <ModeSwitch modes={modes} value={info.mode} onChange={onModeChange} locked={busy || preparing} />

        <div className="space-y-2 empty:hidden">
          {!voiceConfigured && (
            <CallNotice tone="warning" title="Voice calling is not configured">
              This build has no VAPI public key. Set <Code>VITE_VAPI_PUBLIC_KEY</Code> and redeploy.
            </CallNotice>
          )}
          {voiceConfigured && !modeConfigured && !busy && (
            <CallNotice tone="warning" title={`${info.label} is not configured`}>
              This build has no id for this mode yet. Set <Code>{MODE_ENV_VAR[info.mode]}</Code> as a repository variable and redeploy, or
              pick another mode.
            </CallNotice>
          )}
          {micProblem && (
            <CallNotice tone="critical" role="alert" title={MIC_PROBLEM_COPY[micProblem].title}>
              {MIC_PROBLEM_COPY[micProblem].body}
            </CallNotice>
          )}
          {!micProblem && errorView && call.error && (
            <CallNotice tone={midCall ? "warning" : "critical"} role="alert" title={errorView.title}>
              {call.error}
              {errorView.hint && <span className="mt-1 block text-ink-2">{errorView.hint}</span>}
            </CallNotice>
          )}
          {!micProblem && !busy && micPermission === "denied" && !call.error && (
            <CallNotice tone="warning" title="Microphone blocked for this site">
              Allow the microphone in the site settings (the icon at the left of the address bar), then start the call.
            </CallNotice>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {busy ? (
            <Button variant="destructive" size="lg" onClick={onStop} disabled={call.status === "ending"} className="w-full sm:w-auto">
              {call.status === "ending" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <PhoneOff aria-hidden="true" />}
              {call.status === "ending" ? "Ending call" : "End call"}
            </Button>
          ) : (
            <Button size="lg" onClick={onStart} disabled={!canStart} className="w-full sm:w-auto" aria-describedby="start-hint">
              {preparing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Phone aria-hidden="true" />}
              {startLabel}
            </Button>
          )}
          <p id="start-hint" className="text-xs text-ink-2">
            <StartHint status={call.status} busy={busy} preparing={preparing} canStart={canStart} micPermission={micPermission} />
          </p>
        </div>

        <SpeakingPair assistantSpeaking={connected && call.assistantSpeaking} callerSpeaking={callerSpeaking} connected={connected} />

        <section aria-labelledby="caller-transcript-title" className="space-y-2">
          <h3 id="caller-transcript-title" className="text-xs font-medium text-ink-2">
            What this browser heard
          </h3>
          <CallerTranscript
            finals={call.finals}
            partial={call.partial}
            emptyText={emptyText(call.status, preparing)}
            expanded={busy || preparing}
          />
        </section>
      </div>
    </Card>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-card px-1 py-0.5 font-mono text-xs text-ink-1">{children}</code>;
}

function StartHint({
  status,
  busy,
  preparing,
  canStart,
  micPermission,
}: {
  status: CallStatus;
  busy: boolean;
  preparing: boolean;
  canStart: boolean;
  micPermission: MicPermission;
}) {
  if (preparing) return <>Allow the microphone if the browser asks.</>;
  if (status === "starting") return <>Connecting to Tessa. You can end it at any time.</>;
  if (busy) return <>Closing this tab also ends the call.</>;
  if (!canStart) return <>Starting is off until this build is configured.</>;
  if (micPermission === "granted") return <>Microphone allowed. Use headphones to avoid echo.</>;
  return (
    <span className="inline-flex items-center gap-1">
      <Mic className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
      The browser asks for the microphone on the first call.
    </span>
  );
}

function emptyText(status: CallStatus, preparing: boolean): string {
  if (preparing || status === "starting") return "Connecting to Tessa…";
  if (status === "active") return "Connected. Tessa speaks first.";
  if (status === "error") return "The call did not connect, so there is nothing to show.";
  if (status === "ended" || status === "ending") return "No words were exchanged on this call.";
  return "Start the call and the conversation appears here as you talk.";
}

const STATUS_BADGE: Record<CallStatus, { label: string; variant: BadgeProps["variant"] }> = {
  idle: { label: "Ready", variant: "muted" },
  starting: { label: "Connecting", variant: "muted" },
  active: { label: "Live", variant: "good" },
  ending: { label: "Ending", variant: "muted" },
  ended: { label: "Ended", variant: "muted" },
  error: { label: "Not connected", variant: "critical" },
};

export function CallStatusBadge({ status, preparing = false }: { status: CallStatus; preparing?: boolean }) {
  const meta = preparing ? { label: "Checking microphone", variant: "muted" as const } : STATUS_BADGE[status];
  const spinning = preparing || status === "starting" || status === "ending";
  return (
    <Badge variant={meta.variant} role="status" aria-live="polite" data-status={preparing ? "preparing" : status}>
      {spinning ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : status === "active" ? (
        <LiveDot />
      ) : status === "error" ? (
        <OctagonAlert aria-hidden="true" />
      ) : status === "ended" ? (
        <PhoneOff aria-hidden="true" />
      ) : (
        <CircleDot aria-hidden="true" />
      )}
      <span>
        <span className="sr-only">Call status: </span>
        {meta.label}
      </span>
    </Badge>
  );
}

/**
 * Seconds on the call: ticking while live, frozen at hang-up. The store keeps the start time
 * only, so the end is captured here on the transition out of "active".
 */
function useCallSeconds(call: VapiCallState): number | null {
  const live = call.status === "active" || call.status === "ending";
  const now = useNow(1000, live);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const prevLive = useRef(live);

  useEffect(() => {
    if (prevLive.current && !live) setEndedAt(Date.now());
    if (live) setEndedAt(null);
    prevLive.current = live;
  }, [live]);

  if (!call.startedAt) return null;
  if (live) return Math.max(0, (now.getTime() - call.startedAt) / 1000);
  if (endedAt) return Math.max(0, (endedAt - call.startedAt) / 1000);
  return null;
}
