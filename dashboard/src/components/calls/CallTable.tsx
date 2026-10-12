import { Globe, LifeBuoy, Mail, MessageSquare, Phone, PhoneOutgoing, Siren, type LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FlagChip } from "@/components/FlagChip";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { SentimentBadge } from "@/components/SentimentBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  callerLabel,
  channelLabel,
  DASH,
  formatDateTime,
  formatDateTimeLong,
  formatDuration,
  formatMoney,
  isInProgress,
} from "@/lib/format";
import type { CallListRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMediaQuery, useNow } from "./hooks";

interface CallTableProps {
  rows: CallListRow[];
  /** First load: skeleton rows in place of data. */
  loading?: boolean;
  /** Refetch with data on screen: hold the frame at reduced opacity instead of flashing. */
  fetching?: boolean;
  /** Injectable clock for the elapsed time of live calls (tests). */
  now?: Date;
  className?: string;
}

const CHANNEL_ICONS: Record<string, LucideIcon> = {
  webCall: Globe,
  inboundPhoneCall: Phone,
  outboundPhoneCall: PhoneOutgoing,
  chat: MessageSquare,
};

export function callHref(id: string): string {
  return `/calls/${encodeURIComponent(id)}`;
}

/** Seconds a live call has been running, from started_at (or the stub row's created_at). */
export function elapsedSeconds(row: Pick<CallListRow, "started_at" | "created_at">, now: Date): number | null {
  const start = Date.parse(row.started_at ?? row.created_at);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
}

/**
 * The calls list. In-progress rows (ended_at is null, never the generated status column) show a
 * pulsing dot and a running clock. Phones arrive already masked from search_calls; only the
 * detail page reads them whole.
 */
export function CallTable({ rows, loading = false, fetching = false, now: fixedNow, className }: CallTableProps) {
  const compact = useMediaQuery("(max-width: 767px)");
  const anyLive = rows.some(isInProgress);
  const ticking = useNow(1000, anyLive && !fixedNow);
  const now = fixedNow ?? ticking;

  if (compact) return <CallList rows={rows} loading={loading} fetching={fetching} now={now} className={className} />;

  return (
    <div className={cn("transition-opacity", fetching && "opacity-60", className)} aria-busy={loading || fetching || undefined}>
      <Table>
        <TableCaption className="sr-only">Calls, newest first. Times are Eastern.</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="pl-4 sm:pl-5">Started</TableHead>
            <TableHead scope="col">Caller</TableHead>
            <TableHead scope="col">Channel</TableHead>
            <TableHead scope="col">Outcome</TableHead>
            <TableHead scope="col">Sentiment</TableHead>
            <TableHead scope="col" className="text-right">Duration</TableHead>
            <TableHead scope="col" className="text-right">Cost</TableHead>
            <TableHead scope="col">Flags</TableHead>
            <TableHead scope="col" className="pr-4 sm:pr-5">Alerts</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} />)
            : rows.map((row) => <CallRow key={row.vapi_call_id} row={row} now={now} />)}
        </TableBody>
      </Table>
    </div>
  );
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button, [role='note'], input, select, textarea") !== null;
}

function CallRow({ row, now }: { row: CallListRow; now: Date }) {
  const navigate = useNavigate();
  const live = isInProgress(row);
  const href = callHref(row.vapi_call_id);

  // The caller link is the keyboard and screen-reader path; the row click is a mouse shortcut.
  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (e.defaultPrevented || isInteractive(e.target)) return;
    if (window.getSelection()?.toString()) return;
    navigate(href);
  };

  return (
    <TableRow onClick={onClick} className="cursor-pointer" data-live={live || undefined} data-call-id={row.vapi_call_id}>
      <TableCell className="whitespace-nowrap pl-4 tabular text-ink-2 sm:pl-5" title={formatDateTimeLong(row.started_at ?? row.created_at)}>
        {formatDateTime(row.started_at ?? row.created_at)}
      </TableCell>
      <TableCell className="max-w-[16rem]">
        <Link
          to={href}
          className="block truncate rounded-sm font-medium text-ink-1 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {callerLabel(row.caller_name)}
        </Link>
        {row.caller_phone_masked && <span className="block truncate text-xs tabular text-ink-3">{row.caller_phone_masked}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <ChannelLabel channel={row.channel} />
      </TableCell>
      <TableCell>
        <OutcomeBadge outcome={row.outcome} live={live} />
      </TableCell>
      <TableCell>{live ? <span className="text-ink-3">{DASH}</span> : <SentimentBadge sentiment={row.sentiment} />}</TableCell>
      <TableCell className="whitespace-nowrap text-right tabular">
        {live ? (
          <span className="text-ink-2" title="Running time so far">
            {formatDuration(elapsedSeconds(row, now))}
          </span>
        ) : (
          formatDuration(row.duration_seconds)
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right tabular">
        {live ? <span className="text-ink-3">{DASH}</span> : <span className={row.cost == null ? "text-ink-3" : undefined}>{formatMoney(row.cost)}</span>}
      </TableCell>
      <TableCell>
        <FlagList flags={row.flags} />
      </TableCell>
      <TableCell className="pr-4 sm:pr-5">
        <AlertIcons escalated={row.escalated} emergency={row.emergency} emailed={row.emailed} />
      </TableCell>
    </TableRow>
  );
}

function SkeletonRow() {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="pl-4 sm:pl-5"><Skeleton className="h-4 w-24" /></TableCell>
      <TableCell><Skeleton className="h-4 w-32" /><Skeleton className="mt-1.5 h-3 w-20" /></TableCell>
      <TableCell><Skeleton className="h-4 w-14" /></TableCell>
      <TableCell><Skeleton className="h-5 w-20" /></TableCell>
      <TableCell><Skeleton className="h-5 w-16" /></TableCell>
      <TableCell><Skeleton className="ml-auto h-4 w-10" /></TableCell>
      <TableCell><Skeleton className="ml-auto h-4 w-12" /></TableCell>
      <TableCell><Skeleton className="h-5 w-8" /></TableCell>
      <TableCell className="pr-4 sm:pr-5"><Skeleton className="h-4 w-6" /></TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared cell pieces
// ---------------------------------------------------------------------------------------------

export function ChannelLabel({ channel, className }: { channel: string | null | undefined; className?: string }) {
  const Icon = (channel && CHANNEL_ICONS[channel]) || Globe;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ink-2", className)}>
      <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
      {channelLabel(channel)}
    </span>
  );
}

function FlagList({ flags }: { flags: string[] | null | undefined }) {
  if (!flags || flags.length === 0) return <span className="sr-only">No flags</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <FlagChip key={flag} flag={flag} compact />
      ))}
    </span>
  );
}

/** Emergency, escalation and email markers: icon shape plus an accessible name, never color alone. */
export function AlertIcons({ escalated, emergency, emailed = false }: { escalated: boolean; emergency: boolean; emailed?: boolean }) {
  if (!escalated && !emergency && !emailed) return <span className="sr-only">None</span>;
  return (
    <span className="flex items-center gap-2">
      {emergency && (
        <span role="img" aria-label="Emergency" title="Emergency reported" className="inline-flex text-critical-ink">
          <Siren className="size-4" aria-hidden="true" />
        </span>
      )}
      {escalated && (
        <span role="img" aria-label="Escalated" title="Escalated to a representative" className="inline-flex text-ink-2">
          <LifeBuoy className="size-4" aria-hidden="true" />
        </span>
      )}
      {emailed && (
        <span role="img" aria-label="Email sent" title="At least one email was sent for this call" className="inline-flex text-ink-2">
          <Mail className="size-4" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Phone layout: one card per call, the whole card is the link
// ---------------------------------------------------------------------------------------------

function CallList({ rows, loading, fetching, now, className }: Required<Omit<CallTableProps, "className" | "now">> & { now: Date; className?: string }) {
  if (loading) {
    return (
      <ul className={cn("divide-y", className)} aria-busy="true" aria-label="Loading calls">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="space-y-2 px-4 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className={cn("divide-y transition-opacity", fetching && "opacity-60", className)} aria-label="Calls, newest first">
      {rows.map((row) => {
        const live = isInProgress(row);
        const duration = live ? formatDuration(elapsedSeconds(row, now)) : formatDuration(row.duration_seconds);
        return (
          <li key={row.vapi_call_id} className="relative px-4 py-3 hover:bg-hover/60" data-live={live || undefined} data-call-id={row.vapi_call_id}>
            <div className="flex items-start justify-between gap-3">
              <Link
                to={callHref(row.vapi_call_id)}
                className="min-w-0 truncate rounded-sm font-medium text-ink-1 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
              >
                {callerLabel(row.caller_name)}
              </Link>
              <OutcomeBadge outcome={row.outcome} live={live} className="shrink-0" />
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-xs text-ink-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate tabular">{formatDateTime(row.started_at ?? row.created_at)}</span>
                <ChannelLabel channel={row.channel} className="shrink-0 text-ink-3" />
              </span>
              <span className="shrink-0 tabular">
                {duration}
                {!live && <> · {formatMoney(row.cost)}</>}
              </span>
            </div>
            {row.summary && !live && <p className="mt-1.5 line-clamp-2 text-xs text-ink-2">{row.summary}</p>}
            {(row.flags.length > 0 || row.escalated || row.emergency || row.emailed || (!live && row.sentiment)) && (
              <div className="relative z-10 mt-2 flex w-fit flex-wrap items-center gap-1.5">
                {!live && row.sentiment && <SentimentBadge sentiment={row.sentiment} />}
                <FlagList flags={row.flags} />
                <AlertIcons escalated={row.escalated} emergency={row.emergency} emailed={row.emailed} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
