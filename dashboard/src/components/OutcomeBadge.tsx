import { Badge } from "@/components/ui/badge";
import { LiveDot } from "@/components/LiveDot";
import { OUTCOME_META, outcomeMeta } from "@/lib/format";
import { cn } from "@/lib/utils";

interface OutcomeBadgeProps {
  outcome: string | null | undefined;
  /** True while the call has no ended_at: shows "In progress" with a pulsing dot, whatever the outcome column says. */
  live?: boolean;
  className?: string;
}

/** Outcome as a word with its categorical color as a dot beside it (the text stays in ink). */
export function OutcomeBadge({ outcome, live = false, className }: OutcomeBadgeProps) {
  const meta = live ? OUTCOME_META.in_progress : outcomeMeta(outcome);
  return (
    <Badge variant="neutral" className={cn("font-medium", className)} title={meta.description}>
      {/* Live is a state, so it pulses in the live color rather than an outcome's. */}
      {live ? (
        <LiveDot />
      ) : (
        <span aria-hidden="true" className="viz-mark size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
      )}
      <span>{meta.label}</span>
    </Badge>
  );
}
