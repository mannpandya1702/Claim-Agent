import { CircleCheck, Clock, Info, Mail, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CALLBACK_SOURCE_LABELS, CONTACT_KIND_LABELS, formatDateTimeLong, formatPhone, formatTime } from "@/lib/format";
import type { CallerContact } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CallerContactCardProps {
  contact: CallerContact;
  className?: string;
}

/**
 * The name, email and callback number the caller gave on this call (caller_contacts), with
 * whether they confirmed the read-back. The call page is the only place the full address and
 * number appear; lists carry the masked copies. Every address here was spoken by the caller,
 * so it is labelled unverified.
 */
export function CallerContactCard({ contact: c, className }: CallerContactCardProps) {
  const name = `${c.first_name} ${c.last_name}`.replace(/\s+/g, " ").trim();
  const emailUpdate = c.kind === "email_update";
  return (
    <div className={cn("space-y-3", className)} data-contact-kind={c.kind} data-confirmed={c.confirmed}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-1">{CONTACT_KIND_LABELS[c.kind] ?? c.kind}</p>
          <p className="text-xs text-ink-2">
            Captured{" "}
            <time dateTime={c.created_at} title={formatDateTimeLong(c.created_at)}>
              {formatTime(c.created_at)}
            </time>
          </p>
        </div>
        <ConfirmationBadge confirmed={c.confirmed} confirmedAt={c.confirmed_at} />
      </div>

      <dl className="grid gap-y-2.5 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Name</dt>
          <dd className="mt-0.5 break-words font-medium text-ink-1">{name}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Email</dt>
          <dd className="mt-0.5">
            {c.email ? (
              <>
                <a
                  href={`mailto:${c.email}`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-sm font-mono text-[13px] text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Mail className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-all">{c.email}</span>
                </a>
                <span className="block text-xs text-ink-3">Caller-provided, unverified</span>
              </>
            ) : (
              <span className="text-ink-2">No email given</span>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Callback number</dt>
          <dd className="mt-0.5">
            {c.callback_phone ? (
              <>
                <a
                  href={`tel:${c.callback_phone}`}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm font-medium tabular text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Phone className="size-3.5 shrink-0" aria-hidden="true" />
                  {formatPhone(c.callback_phone)}
                </a>
                <span className="block text-xs text-ink-3">{CALLBACK_SOURCE_LABELS[c.callback_source] ?? c.callback_source}</span>
              </>
            ) : (
              <span className="text-ink-2">No number given</span>
            )}
          </dd>
        </div>
      </dl>

      {emailUpdate && (
        <p role="note" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-ink-2">
          <Info className="mt-px size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span>
            A verified customer with no email on file asked for this one to be added. It is not on the account until staff
            check it and add it, and nothing is sent to it.
          </span>
        </p>
      )}
    </div>
  );
}

function ConfirmationBadge({ confirmed, confirmedAt }: { confirmed: boolean; confirmedAt: string | null }) {
  if (confirmed) {
    return (
      <Badge variant="good" title={confirmedAt ? `Caller confirmed the read-back at ${formatDateTimeLong(confirmedAt)}` : "Caller confirmed the read-back"}>
        <CircleCheck aria-hidden="true" />
        Confirmed
      </Badge>
    );
  }
  return (
    <Badge variant="warning" title="The caller has not confirmed the read-back">
      <Clock aria-hidden="true" />
      Pending
    </Badge>
  );
}
