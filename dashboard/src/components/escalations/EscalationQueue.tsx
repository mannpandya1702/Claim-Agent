import { ChevronDown } from "lucide-react";
import { EscalationCard } from "@/components/calls/EscalationCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmailRow, Escalation } from "@/lib/types";
import { cn } from "@/lib/utils";

interface EscalationQueueProps {
  rows: readonly Escalation[];
  emails: readonly EmailRow[];
  now: Date;
  /** How many rows are rendered; the rest sit behind "Show more". */
  limit: number;
  onShowMore: () => void;
  loading?: boolean;
  /** Refetch with rows on screen: hold the frame at reduced opacity instead of flashing. */
  fetching?: boolean;
  /** Accessible name of the list ("Open escalations, oldest first"). */
  label: string;
}

export const QUEUE_PAGE_SIZE = 20;

/**
 * The queue as escalation cards: callback number with its source, Telegram and email delivery,
 * delivery error, Claim and Done, and a link to the call. Lists mask the callback number; the
 * call page shows it whole.
 */
export function EscalationQueue({ rows, emails, now, limit, onShowMore, loading = false, fetching = false, label }: EscalationQueueProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" role="status" aria-label="Loading escalations">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-lg" />
        ))}
      </div>
    );
  }

  const shown = rows.slice(0, limit);
  const remaining = rows.length - shown.length;

  return (
    <div className={cn("space-y-4 transition-opacity", fetching && "opacity-60")} aria-busy={fetching || undefined}>
      <ul aria-label={label} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {shown.map((e) => (
          <li key={e.id} className="min-w-0">
            <EscalationCard escalation={e} emails={emails} now={now} showCallLink maskCallback className="h-full" />
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onShowMore}>
            <ChevronDown aria-hidden="true" />
            Show {Math.min(remaining, QUEUE_PAGE_SIZE)} more
            <span className="text-ink-3">({remaining} not shown)</span>
          </Button>
        </div>
      )}
    </div>
  );
}
