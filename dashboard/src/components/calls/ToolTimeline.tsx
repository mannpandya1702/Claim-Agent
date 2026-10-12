import { CircleCheck, CircleDashed, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { formatDateTimeLong, formatStamp } from "@/lib/format";
import type { Attempt, AttemptKind } from "@/lib/types";
import { cn } from "@/lib/utils";

type Tone = "good" | "warning" | "critical" | "neutral";

const KIND_LABELS: Record<AttemptKind, string | null> = {
  lookup_hit: "Phone matched a customer",
  lookup_miss: "No customer for that number",
  dob_ok: "Date of birth matched",
  dob_wrong: "Date of birth did not match",
  unreadable: "Input could not be read (not counted)",
  other: null,
};

const TONES: Record<Tone, { icon: LucideIcon; ink: string; dot: string }> = {
  good: { icon: CircleCheck, ink: "text-good-ink", dot: "bg-good" },
  warning: { icon: TriangleAlert, ink: "text-warning-ink", dot: "bg-warning" },
  critical: { icon: OctagonAlert, ink: "text-critical-ink", dot: "bg-critical" },
  neutral: { icon: CircleDashed, ink: "text-ink-3", dot: "bg-border-strong" },
};

/** Whether a result is good or bad news for the caller's path, from the ledger kind and code. */
export function attemptTone(a: Pick<Attempt, "kind" | "code">): Tone {
  const code = (a.code ?? "").toLowerCase();
  if (code === "locked" || code === "dob_give_up" || code === "not_found_final" || code.endsWith("error") || code === "failed") return "critical";
  if (a.kind === "lookup_hit" || a.kind === "dob_ok" || code === "verified" || code === "ok" || code === "sent") return "good";
  if (a.kind === "lookup_miss" || a.kind === "dob_wrong" || code === "auth_failed" || code === "not_found") return "warning";
  return "neutral";
}

/** Seconds from call start; falls back to the first attempt when the start time is not known yet. */
function offsetSeconds(at: string, origin: number): number {
  const t = Date.parse(at);
  return Number.isFinite(t) && Number.isFinite(origin) ? Math.max(0, (t - origin) / 1000) : 0;
}

interface ToolTimelineProps {
  attempts: readonly Attempt[];
  /** call_interactions.started_at, for mm:ss offsets that line up with the transcript. */
  startedAt?: string | null;
  className?: string;
}

/**
 * Every tool call in order, from the attempts ledger: name, result code and what it meant.
 * Arguments are never stored, so nothing the caller said appears here.
 */
export function ToolTimeline({ attempts, startedAt, className }: ToolTimelineProps) {
  const sorted = [...attempts].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const origin = startedAt ? Date.parse(startedAt) : sorted.length > 0 ? Date.parse(sorted[0]!.created_at) : Number.NaN;

  return (
    <ol aria-label="Tool timeline" className={cn("relative space-y-3", className)}>
      {sorted.map((a, i) => {
        const tone = TONES[attemptTone(a)];
        const meaning = a.kind ? KIND_LABELS[a.kind] : null;
        const last = i === sorted.length - 1;
        return (
          <li key={a.tool_call_id} className="relative grid grid-cols-[2.75rem_1fr] gap-x-3" data-tool={a.tool_name}>
            <time dateTime={a.created_at} title={formatDateTimeLong(a.created_at)} className="pt-0.5 text-right text-xs tabular text-ink-3">
              {formatStamp(offsetSeconds(a.created_at, origin))}
            </time>
            <div className="relative min-w-0 pb-0.5 pl-5">
              {!last && <span aria-hidden="true" className="absolute left-[3px] top-3 -bottom-3 w-px bg-border" />}
              <span aria-hidden="true" className={cn("absolute left-0 top-1.5 size-[7px] rounded-full", tone.dot)} />
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono text-xs font-medium text-ink-1">{a.tool_name}</span>
                {a.code && (
                  <span className="rounded border bg-muted px-1.5 font-mono text-[11px] leading-5 text-ink-2">{a.code}</span>
                )}
              </p>
              {meaning && (
                <p className={cn("mt-0.5 flex items-center gap-1 text-xs", tone.ink)}>
                  <tone.icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {meaning}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
