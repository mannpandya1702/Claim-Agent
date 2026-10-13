import { CircleCheck, Clock, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CLAIM_INTAKE_KIND_LABELS, CLAIM_TYPE_LABELS, formatCalendarDate, formatDateTimeLong, formatTime } from "@/lib/format";
import type { ClaimIntake } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ClaimIntakeCardProps {
  intake: ClaimIntake;
  /** The call is still going: an unconfirmed read-back may yet be confirmed. */
  live?: boolean;
  className?: string;
}

/**
 * The loss the caller reported on this call (claim_intakes). A verified customer's claim is filed
 * with a claim number once they confirm the read-back; a new caller's details are passed to the
 * claims team, who set the claim up on the callback, so it never has a number here. The
 * description is the caller's own words with personal details redacted before storage.
 */
export function ClaimIntakeCard({ intake: c, live = false, className }: ClaimIntakeCardProps) {
  const lead = c.kind === "lead_intake";
  return (
    <div className={cn("space-y-3", className)} data-intake-kind={c.kind} data-confirmed={c.confirmed}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-1">{CLAIM_INTAKE_KIND_LABELS[c.kind] ?? c.kind}</p>
          <p className="text-xs text-ink-2">
            Reported{" "}
            <time dateTime={c.created_at} title={formatDateTimeLong(c.created_at)}>
              {formatTime(c.created_at)}
            </time>
          </p>
        </div>
        <FilingBadge intake={c} />
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Claim type</dt>
          <dd className="mt-0.5 font-medium text-ink-1">{CLAIM_TYPE_LABELS[c.claim_type] ?? c.claim_type}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Loss date</dt>
          <dd className="mt-0.5 font-medium tabular text-ink-1">{formatCalendarDate(c.loss_date)}</dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-xs text-ink-3">Claim number</dt>
          <dd className="mt-0.5">
            {c.claim_number ? (
              <span className="font-mono text-[13px] font-medium text-ink-1">{c.claim_number}</span>
            ) : (
              <span className="text-ink-2">
                {lead ? "None: the claim is set up on the callback" : c.confirmed ? "Not recorded" : "Given when the caller confirms"}
              </span>
            )}
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-xs text-ink-3">Summary</dt>
          <dd className="mt-0.5 break-words text-ink-1">{c.summary}</dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-xs text-ink-3">What happened</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-ink-1">{c.description}</dd>
          <dd className="text-xs text-ink-3">The caller's words, personal details redacted</dd>
        </div>
      </dl>

      {!c.confirmed && (
        <p role="note" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-ink-2">
          <Info className="mt-px size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span>
            {live
              ? "Ava has read this back to the caller. Nothing is filed until they confirm it."
              : "The caller never confirmed this read-back, so nothing was filed."}
          </span>
        </p>
      )}
    </div>
  );
}

function FilingBadge({ intake: c }: { intake: ClaimIntake }) {
  const at = c.confirmed_at ? ` at ${formatDateTimeLong(c.confirmed_at)}` : "";
  if (c.confirmed && c.kind === "claim") {
    return (
      <Badge variant="good" title={`The caller confirmed the read-back and the claim was filed${at}`}>
        <CircleCheck aria-hidden="true" />
        Filed
      </Badge>
    );
  }
  if (c.confirmed) {
    return (
      <Badge variant="good" title={`The caller confirmed the details${at}; a claims specialist calls back to set up the claim`}>
        <CircleCheck aria-hidden="true" />
        Sent to claims team
      </Badge>
    );
  }
  return (
    <Badge variant="warning" title="Read back to the caller and not confirmed">
      <Clock aria-hidden="true" />
      Pending
    </Badge>
  );
}
