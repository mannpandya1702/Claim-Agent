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
      {live ? (
        <LiveDot color={meta.color} />
      ) : (
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
      )}
      <span>{meta.label}</span>
    </Badge>
  );
}
