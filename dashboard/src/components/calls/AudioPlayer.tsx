import { Loader2, Play, RotateCw, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/*
 * The stored recording fields are private identifiers, not playable links. The staff-only
 * recording-url Edge Function trades the call id for a presigned link that lives for minutes,
 * so the link is requested only when Play is pressed, never stored, and requested again once
 * if the audio element reports an error (the usual cause is an expired link).
 */

export const RECORDING_UNAVAILABLE = "Recording unavailable";

/** Asks recording-url for a short-lived link. Throws with the function's own error text. */
export async function requestRecordingUrl(callId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>("recording-url", {
    body: { call_id: callId },
  });
  if (error) {
    let message = error.message || "Recording link failed";
    // FunctionsHttpError carries the Response; its JSON body has the reason ("Recording no longer available").
    const ctx = (error as { context?: unknown }).context;
    if (typeof Response !== "undefined" && ctx instanceof Response) {
      const body = (await ctx.clone().json().catch(() => null)) as { error?: string } | null;
      if (body?.error) message = body.error;
    }
    throw new Error(message);
  }
  if (!data || typeof data.url !== "string" || data.url.length === 0) throw new Error("No recording link was returned");
  return data.url;
}

type State = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; url: string } | { kind: "error"; message: string };

interface AudioPlayerProps {
  callId: string;
  /** The end-of-call report stored a recording reference. */
  hasRecording: boolean;
  /** The call has not ended: there is nothing to play yet. */
  live?: boolean;
  className?: string;
}

export function AudioPlayer({ callId, hasRecording, live = false, className }: AudioPlayerProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const retried = useRef(false);
  const seq = useRef(0);
  // The control that had focus (Play, Try again, the player) is replaced when the state changes;
  // remember whether focus was inside so it can move to whatever control replaces it.
  const keepFocus = useRef(false);

  // A different call on the same mounted page starts from scratch.
  useEffect(() => {
    seq.current++;
    retried.current = false;
    setState({ kind: "idle" });
  }, [callId]);

  const load = async () => {
    const mine = ++seq.current;
    keepFocus.current = !!rootRef.current && rootRef.current.contains(document.activeElement);
    setState({ kind: "loading" });
    try {
      const url = await requestRecordingUrl(callId);
      if (mine === seq.current) setState({ kind: "ready", url });
    } catch (e) {
      if (mine === seq.current) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Play as soon as the link arrives; the press that asked for it counts as the user gesture.
  useEffect(() => {
    // Try again swaps the error box for the loading button: hold focus there until the outcome.
    if (state.kind === "loading" && keepFocus.current && document.activeElement !== playRef.current) {
      playRef.current?.focus();
      return;
    }
    if (state.kind === "error" && keepFocus.current) {
      keepFocus.current = false;
      retryRef.current?.focus();
      return;
    }
    if (state.kind !== "ready") return;
    const el = audioRef.current;
    if (!el) return;
    if (keepFocus.current) {
      keepFocus.current = false;
      el.focus();
    }
    if (typeof el.play !== "function") return;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, [state]);

  const onAudioError = () => {
    if (!retried.current) {
      retried.current = true;
      void load();
      return;
    }
    keepFocus.current = !!rootRef.current && rootRef.current.contains(document.activeElement);
    setState({ kind: "error", message: "The audio could not be played." });
  };

  if (live) {
    return <p className={cn("text-sm text-ink-2", className)}>The recording is available after the call ends.</p>;
  }

  return (
    <div ref={rootRef} className={cn("space-y-2", className)}>
      {state.kind === "ready" ? (
        <audio
          ref={audioRef}
          src={state.url}
          controls
          preload="auto"
          onError={onAudioError}
          className="h-10 w-full"
          aria-label="Call recording"
        />
      ) : state.kind === "error" ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
          <p className="flex items-start gap-2 text-sm">
            <VolumeX className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden="true" />
            <span>
              <span className="font-medium text-ink-1">{RECORDING_UNAVAILABLE}</span>
              {state.message && <span className="block text-xs text-ink-2">{state.message}</span>}
            </span>
          </p>
          <Button
            ref={retryRef}
            size="sm"
            variant="outline"
            onClick={() => {
              retried.current = false;
              void load();
            }}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {/* aria-disabled, not disabled, while loading: a disabled button drops keyboard focus. */}
          <Button
            ref={playRef}
            size="sm"
            variant={hasRecording ? "default" : "outline"}
            onClick={() => {
              if (state.kind !== "loading") void load();
            }}
            aria-disabled={state.kind === "loading" || undefined}
          >
            {state.kind === "loading" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
            {state.kind === "loading" ? "Loading recording" : hasRecording ? "Play recording" : "Try to load recording"}
          </Button>
          <p className="text-xs text-ink-3">
            {hasRecording
              ? "Fetched on demand through a staff-only link that expires in minutes."
              : "The end-of-call report did not include a recording."}
          </p>
        </div>
      )}
    </div>
  );
}
