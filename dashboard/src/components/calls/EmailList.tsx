import { Clock, Loader2, MailCheck, MailX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EMAIL_KIND_LABELS, EMAIL_STATUS_LABELS, formatDateTimeLong, formatTime } from "@/lib/format";
import type { EmailKind, EmailRow, EmailStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function emailKindLabel(kind: string): string {
  return EMAIL_KIND_LABELS[kind as EmailKind] ?? kind.replace(/_/g, " ");
}

/** Delivery state of one email: icon plus word; green only when Resend accepted it. */
export function EmailStatusBadge({ status, className }: { status: EmailStatus | string; className?: string }) {
  const label = EMAIL_STATUS_LABELS[status as EmailStatus] ?? status;
  if (status === "sent") {
    return (
      <Badge variant="good" className={className}>
        <MailCheck aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="critical" className={className}>
        <MailX aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="muted" className={className}>
      {status === "sending" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Clock aria-hidden="true" />}
      {label}
    </Badge>
  );
}

interface EmailListProps {
  emails: readonly EmailRow[];
  className?: string;
}

/**
 * Emails sent for a call, from the emails ledger. Only the masked recipient is stored, so the
 * full address never reaches the browser.
 */
export function EmailList({ emails, className }: EmailListProps) {
  return (
    <ul aria-label="Emails" className={cn("divide-y", className)}>
      {emails.map((e) => (
        <li key={e.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0" data-email-kind={e.kind}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink-1">{emailKindLabel(e.kind)}</span>
            <EmailStatusBadge status={e.status} />
          </div>
          <p className="flex flex-wrap gap-x-2 text-xs text-ink-2">
            <span>
              To <span className="font-mono">{e.to_masked}</span>
            </span>
            <span aria-hidden="true" className="text-ink-3">·</span>
            <time dateTime={e.created_at} title={formatDateTimeLong(e.created_at)} className="tabular">
              {formatTime(e.created_at)}
            </time>
          </p>
          {e.resend_id && (
            <p className="truncate text-xs text-ink-3">
              Resend id <span className="font-mono text-ink-2" title={e.resend_id}>{e.resend_id}</span>
            </p>
          )}
          {e.error && (
            <p className="break-words text-xs text-critical-ink">
              <span className="font-medium">Error:</span> {e.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
