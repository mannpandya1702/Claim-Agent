import { CircleCheck, Hourglass, TriangleAlert } from "lucide-react";
import { flagMeta } from "@/lib/format";
import { cn } from "@/lib/utils";

interface FlagExplainProps {
  flags: readonly string[] | null | undefined;
  /** Flags are computed by the end-of-call writer, so a live call has none yet. */
  live?: boolean;
  className?: string;
}

/**
 * Post-call flags in words a supervisor can act on. Each flag is evidence-first (computed from
 * the transcript and the attempts ledger), so the explanation says what was observed.
 */
export function FlagExplain({ flags, live = false, className }: FlagExplainProps) {
  if (live) {
    return (
      <p className={cn("flex items-center gap-2 text-sm text-ink-2", className)}>
        <Hourglass className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
        Flags are checked after the call ends.
      </p>
    );
  }
  if (!flags || flags.length === 0) {
    return (
      <p className={cn("flex items-center gap-2 text-sm text-good-ink", className)}>
        <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
        No flags raised. The post-call checks found nothing to review.
      </p>
    );
  }
  return (
    <ul aria-label="Flags" className={cn("space-y-2", className)}>
      {flags.map((flag) => {
        const meta = flagMeta(flag);
        return (
          <li
            key={flag}
            data-flag={flag}
            className="flex items-start gap-2.5 rounded-md bg-[color-mix(in_oklab,var(--status-warning)_12%,var(--card))] px-3 py-2"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink-1">
                <span className="sr-only">Flag: </span>
                {meta.label}
              </p>
              <p className="text-sm text-ink-2">{meta.explanation}</p>
              <p className="mt-0.5 font-mono text-[11px] text-ink-3">{flag}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
