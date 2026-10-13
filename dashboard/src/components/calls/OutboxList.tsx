import { CircleCheck, Clock, OctagonAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTimeLong, formatTime } from "@/lib/format";
import { OUTBOX_MAX_ATTEMPTS, type OutboxEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = { "interaction.completed": "Call record" };
const DESTINATION_LABELS: Record<string, string> = { airtable: "Airtable call log", ghl: "GoHighLevel CRM" };

export type OutboxState = "delivered" | "pending" | "dead";

/** Delivered once delivered_at is set; the job stops trying after OUTBOX_MAX_ATTEMPTS. */
export function outboxState(e: Pick<OutboxEvent, "delivered_at" | "attempts">): OutboxState {
  if (e.delivered_at) return "delivered";
  return e.attempts >= OUTBOX_MAX_ATTEMPTS ? "dead" : "pending";
}

function StateBadge({ event }: { event: OutboxEvent }) {
  const state = outboxState(event);
  if (state === "delivered") {
    return (
      <Badge variant="good">
        <CircleCheck aria-hidden="true" />
        Delivered
      </Badge>
    );
  }
  if (state === "dead") {
    return (
      <Badge variant="critical">
        <OctagonAlert aria-hidden="true" />
        Gave up
      </Badge>
    );
  }
  return (
    <Badge variant="muted">
      <Clock aria-hidden="true" />
      Pending
    </Badge>
  );
}

/**
 * Post-call deliveries for one call (outbox_events keyed by the call id): where it goes (the
 * Airtable call log, GoHighLevel), whether it arrived, how many attempts it took and the last
 * error. The payload is never stored here; the job reads the current call record at delivery time.
 */
export function OutboxList({ events, className }: { events: readonly OutboxEvent[]; className?: string }) {
  return (
    <ul aria-label="Outbox events" className={cn("divide-y", className)}>
      {events.map((e) => {
        const state = outboxState(e);
        return (
          <li key={e.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0" data-outbox-state={state}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink-1">{DESTINATION_LABELS[e.destination] ?? e.destination}</span>
              <StateBadge event={e} />
            </div>
            <p className="flex flex-wrap gap-x-2 text-xs text-ink-2">
              <span>{KIND_LABELS[e.kind] ?? e.kind}</span>
              <span aria-hidden="true" className="text-ink-3">·</span>
              <span className="tabular">
                {e.attempts} of {OUTBOX_MAX_ATTEMPTS} attempts
              </span>
              {e.delivered_at && (
                <>
                  <span aria-hidden="true" className="text-ink-3">·</span>
                  <span>
                    Delivered{" "}
                    <time dateTime={e.delivered_at} title={formatDateTimeLong(e.delivered_at)} className="tabular">
                      {formatTime(e.delivered_at)}
                    </time>
                  </span>
                </>
              )}
            </p>
            {e.last_error && state !== "delivered" && (
              <p className="break-words text-xs text-critical-ink">
                <span className="font-medium">Last error:</span> {e.last_error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
