import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCheck,
  CircleCheck,
  CircleDot,
  Clock,
  ExternalLink,
  Hand,
  LifeBuoy,
  Loader2,
  OctagonAlert,
  Phone,
  Send,
  Siren,
  Timer,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  ALERT_STATUS_LABELS,
  CALLBACK_SOURCE_LABELS,
  channelLabel,
  ESCALATION_REASON_LABELS,
  formatDateTimeLong,
  formatPhone,
  formatRelative,
  formatTime,
  isAsSaid,
  isDialable,
  maskPhone,
  minutesBetween,
} from "@/lib/format";
import { claimEscalation, closeEscalation, qk } from "@/lib/queries";
import type { AlertStatus, EmailKind, EmailRow, Escalation, EscalationListRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { callHref } from "./CallTable";
import { EmailStatusBadge, emailKindLabel } from "./EmailList";
import { useNow } from "./hooks";

/** Same rule as the sla job: an escalation still open after this many minutes is a breach. */
export const SLA_MINUTES = 30;

/** Emails an escalation triggers: its own alert plus any SLA re-alert for the call. */
const EMAIL_KINDS: Record<Escalation["kind"], EmailKind[]> = {
  representative: ["callback_request", "sla_realert"],
  emergency: ["emergency_alert", "sla_realert"],
};

export function isSlaBreached(e: Pick<Escalation, "status" | "created_at">, now: Date): boolean {
  return e.status === "open" && minutesBetween(e.created_at, now) >= SLA_MINUTES;
}

interface EscalationCardProps {
  /** A full row on the call page; a queue row (masked callback number only) in lists. */
  escalation: Escalation | EscalationListRow;
  /** Emails for the same call; the card shows the ones this escalation sent. */
  emails?: readonly EmailRow[];
  /** Adds a link to the call (for lists outside the call page). */
  showCallLink?: boolean;
  /**
   * Lists: the callback number shows masked, as plain text with no tel: link (a link would put
   * the whole number in the DOM, the status bar and copied links). Staff dial from the call page,
   * one click away through "Open call".
   */
  maskCallback?: boolean;
  /** The emails query has not answered yet, or failed: say so instead of "None sent". */
  emailsState?: "loading" | "error";
  /** Injectable clock for the age and SLA badge (tests). */
  now?: Date;
  className?: string;
}

/**
 * One escalation: state, Telegram and email delivery, the callback number with where it came
 * from, and the Claim / Done transitions. The transitions go through claim_escalation and
 * close_escalation, the only write path, which return the row (a second claim returns the
 * first claimer instead of failing).
 */
export function EscalationCard({
  escalation: e,
  emails = [],
  showCallLink = false,
  maskCallback = false,
  emailsState,
  now: fixedNow,
  className,
}: EscalationCardProps) {
  const ticking = useNow(30_000, !fixedNow && e.status === "open");
  const now = fixedNow ?? ticking;
  const { email: me } = useAuth();
  const queryClient = useQueryClient();
  const [closeOpen, setCloseOpen] = useState(false);
  const [note, setNote] = useState("");

  const applyRow = (row: Escalation) => {
    const swapIn = (next: Escalation | EscalationListRow) => (old: unknown) =>
      Array.isArray(old) ? old.map((r: Escalation | EscalationListRow) => (r.id === next.id ? next : r)) : old;
    // The transition functions return the whole row; the queue's cache keeps its masked shape.
    const listRow: EscalationListRow = { ...row, callback_phone: undefined };
    queryClient.setQueryData(qk.callEscalations(row.call_key), swapIn(row));
    queryClient.setQueriesData({ queryKey: qk.escalations() }, swapIn(listRow));
    void queryClient.invalidateQueries({ queryKey: qk.escalations() });
    void queryClient.invalidateQueries({ queryKey: qk.callEscalations(row.call_key) });
  };

  const isMe = (actor: string | null) => !!actor && !!me && actor.toLowerCase() === me.toLowerCase();

  const claim = useMutation({
    mutationFn: () => claimEscalation(e.id),
    onSuccess: (row) => {
      applyRow(row);
      if (row.status === "done") toast.info("Already closed", { description: row.closed_by ? `Closed by ${row.closed_by}.` : undefined });
      else if (row.claimed_by && !isMe(row.claimed_by)) toast.info(`Already claimed by ${row.claimed_by}`);
      else toast.success("Escalation claimed", { description: "It is yours to call back." });
    },
    onError: (err) => toast.error("Could not claim this escalation", { description: errorMessage(err) }),
  });

  const close = useMutation({
    mutationFn: (text: string) => closeEscalation(e.id, text),
    onSuccess: (row) => {
      applyRow(row);
      setCloseOpen(false);
      setNote("");
      if (row.closed_by && !isMe(row.closed_by)) toast.info(`Already closed by ${row.closed_by}`);
      else toast.success("Escalation marked done");
    },
    onError: (err) => toast.error("Could not close this escalation", { description: errorMessage(err) }),
  });

  const emergency = e.kind === "emergency";
  const KindIcon = emergency ? Siren : LifeBuoy;
  const related = emails.filter((m) => m.call_key === e.call_key && EMAIL_KINDS[e.kind].includes(m.kind));
  const breached = isSlaBreached(e, now);
  const busy = claim.isPending || close.isPending;
  const fullCallback = e.callback_phone ?? null;
  const callbackShown = maskCallback
    ? (e.callback_phone_masked ?? (fullCallback ? maskPhone(fullCallback) : null))
    : fullCallback
      ? formatPhone(fullCallback)
      : (e.callback_phone_masked ?? null);
  // A tel: link only for a number with its country code: one noted as said would be dialled as a local
  // number wherever the phone is, so it shows as text with a note that the country is still to be found.
  const dialable = !maskCallback && isDialable(fullCallback);
  const asSaid = !maskCallback && isAsSaid(fullCallback);

  return (
    <article
      aria-label={`${emergency ? "Emergency" : "Representative"} escalation, ${e.status}`}
      className={cn("@container rounded-lg border bg-card p-3.5 sm:p-4", breached && "border-l-[3px] border-l-critical", className)}
      data-status={e.status}
      data-escalation-id={e.id}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
              emergency ? "bg-[color-mix(in_oklab,var(--status-critical)_14%,var(--card))] text-critical-ink" : "bg-muted text-ink-2",
            )}
          >
            <KindIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink-1">{emergency ? "Emergency" : "Representative request"}</h3>
            <p className="text-xs text-ink-2">
              {ESCALATION_REASON_LABELS[e.reason] ?? e.reason} · {channelLabel(e.channel)} ·{" "}
              <time dateTime={e.created_at} title={formatDateTimeLong(e.created_at)}>
                {formatRelative(e.created_at, now)}
              </time>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {breached && (
            <Badge variant="critical">
              <Timer aria-hidden="true" />
              SLA breached · {minutesBetween(e.created_at, now)} min
            </Badge>
          )}
          <StatusBadge status={e.status} />
        </div>
      </header>

      {e.details && <p className="mt-3 border-l-2 pl-3 text-sm text-ink-2">{e.details}</p>}

      {/* Sized by the card, not the viewport: it sits in a narrow column on the call page. */}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm @[17rem]:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Callback number</dt>
          <dd className="mt-0.5">
            {callbackShown ? (
              <>
                {!dialable ? (
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium tabular text-ink-1">
                    <Phone className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                    {callbackShown}
                  </span>
                ) : (
                  <a
                    href={`tel:${e.callback_phone}`}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm font-medium tabular text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Phone className="size-3.5 shrink-0" aria-hidden="true" />
                    {callbackShown}
                  </a>
                )}
                <span className="block text-xs text-ink-3">
                  {CALLBACK_SOURCE_LABELS[e.callback_source ?? "none"]}
                  {asSaid && " · as said, no country code"}
                </span>
              </>
            ) : (
              <span className="text-ink-2">No number{e.callback_source === "none" ? " given" : ""}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Caller identity</dt>
          <dd className="mt-0.5 text-ink-1">{e.verified ? "Verified" : "Not verified"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Telegram alert</dt>
          <dd className="mt-1">
            <AlertBadge status={e.alert_status} />
            {e.realerted_at && <span className="ml-2 text-xs text-ink-3">Re-alerted {formatTime(e.realerted_at)}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Email</dt>
          <dd className="mt-1">
            {emailsState === "error" && related.length === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <TriangleAlert className="size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
                Could not load
              </span>
            ) : emailsState === "loading" && related.length === 0 ? (
              <>
                <span className="sr-only">Loading emails</span>
                <Skeleton className="h-5 w-24" />
              </>
            ) : related.length === 0 ? (
              <span className="text-ink-2">None sent</span>
            ) : (
              <ul className="space-y-1">
                {related.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                    <EmailStatusBadge status={m.status} />
                    <span>{emailKindLabel(m.kind)}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {e.delivery_error && (
        <p role="note" className="mt-3 flex items-start gap-2 rounded-md bg-[color-mix(in_oklab,var(--status-critical)_10%,var(--card))] px-3 py-2 text-xs text-critical-ink">
          <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span className="break-words">
            <span className="font-semibold">Delivery error:</span> {e.delivery_error}
          </span>
        </p>
      )}

      {(e.claimed_by || e.closed_by) && (
        <p className="mt-3 text-xs text-ink-2">
          {e.claimed_by && (
            <>
              Claimed by <span className="font-medium text-ink-1">{isMe(e.claimed_by) ? "you" : e.claimed_by}</span>
              {e.claimed_at && <> at {formatTime(e.claimed_at)}</>}.
            </>
          )}
          {e.closed_by && (
            <>
              {" "}
              Closed by <span className="font-medium text-ink-1">{isMe(e.closed_by) ? "you" : e.closed_by}</span>
              {e.closed_at && <> at {formatTime(e.closed_at)}</>}.
            </>
          )}
          {e.close_note && <span className="mt-1 block text-ink-2">Note: {e.close_note}</span>}
        </p>
      )}

      {(e.status !== "done" || showCallLink) && (
        <footer className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          {e.status === "open" && (
            <Button size="sm" onClick={() => claim.mutate()} disabled={busy}>
              {claim.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Hand aria-hidden="true" />}
              Claim
            </Button>
          )}
          {e.status !== "done" && (
            <Button size="sm" variant="outline" onClick={() => setCloseOpen(true)} disabled={busy}>
              <CheckCheck aria-hidden="true" />
              Done
            </Button>
          )}
          {showCallLink && (
            <Button asChild size="sm" variant="ghost" className="ml-auto">
              <Link to={callHref(e.call_key)}>
                Open call
                <ExternalLink aria-hidden="true" />
              </Link>
            </Button>
          )}
        </footer>
      )}

      <Dialog open={closeOpen} onOpenChange={(open) => !close.isPending && setCloseOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this escalation done?</DialogTitle>
            <DialogDescription>
              Close it once the caller has been called back. The note is kept with the escalation.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(ev) => {
              ev.preventDefault();
              close.mutate(note);
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor={`close-note-${e.id}`}>Note (optional)</Label>
              <Textarea
                id={`close-note-${e.id}`}
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                maxLength={1000}
                placeholder="Called back, claim question answered."
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCloseOpen(false)} disabled={close.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={close.isPending}>
                {close.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CheckCheck aria-hidden="true" />}
                Mark done
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </article>
  );
}

function StatusBadge({ status }: { status: Escalation["status"] }) {
  if (status === "open") {
    return (
      <Badge variant="warning">
        <CircleDot aria-hidden="true" />
        Open
      </Badge>
    );
  }
  if (status === "claimed") {
    return (
      <Badge variant="neutral">
        <UserCheck aria-hidden="true" />
        Claimed
      </Badge>
    );
  }
  return (
    <Badge variant="good">
      <CircleCheck aria-hidden="true" />
      Done
    </Badge>
  );
}

function AlertBadge({ status }: { status: AlertStatus }) {
  const variant = status === "sent" ? "good" : status === "failed" ? "critical" : "muted";
  return (
    <Badge variant={variant}>
      {status === "pending" ? <Clock aria-hidden="true" /> : <Send aria-hidden="true" />}
      {ALERT_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
