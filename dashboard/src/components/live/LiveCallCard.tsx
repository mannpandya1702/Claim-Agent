import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CircleCheck, LifeBuoy, MessageSquareDashed, Siren, UserCheck, Wrench } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { callHref, ChannelLabel, elapsedSeconds } from "@/components/calls/CallTable";
import { IdentityBadge } from "@/components/calls/IdentityPath";
import { TranscriptView } from "@/components/calls/TranscriptView";
import { useNow } from "@/components/calls/hooks";
import { LiveDot } from "@/components/LiveDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { callerLabel, formatDateTimeLong, formatDuration, formatTime, maskPhone } from "@/lib/format";
import {
  fetchCallAttempts,
  fetchCallEscalations,
  fetchCallSession,
  fetchTranscriptLines,
  qk,
  type CallSummary,
} from "@/lib/queries";
import { IN_PROGRESS_REFETCH_MS, useRealtimeRows } from "@/lib/realtime";
import { fromLiveLines } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { callStart, escalationBadge, lastAttempt, type EscalationBadgeInfo } from "./liveCalls";

interface LiveCallCardProps {
  call: CallSummary;
  /** Injectable clock for the elapsed timer (tests). */
  now?: Date;
}

/**
 * One call in progress. It reads the same per-call queries as the call page (so opening the
 * call is instant), subscribes per call_key, and polls every 5 s as a backstop while the card
 * is mounted. The card is unmounted when the live list no longer has the call (ended_at set).
 */
export function LiveCallCard({ call, now: fixedNow }: LiveCallCardProps) {
  const id = call.vapi_call_id;
  const poll = IN_PROGRESS_REFETCH_MS;

  const linesQ = useQuery({ queryKey: qk.callTranscript(id), queryFn: () => fetchTranscriptLines(id), refetchInterval: poll });
  const attemptsQ = useQuery({ queryKey: qk.callAttempts(id), queryFn: () => fetchCallAttempts(id), refetchInterval: poll });
  const sessionQ = useQuery({ queryKey: qk.callSession(id), queryFn: () => fetchCallSession(id), refetchInterval: poll });
  const escalationsQ = useQuery({ queryKey: qk.callEscalations(id), queryFn: () => fetchCallEscalations(id), refetchInterval: poll });

  const filter = `call_key=eq.${id}`;
  useRealtimeRows("transcript_lines", filter, [qk.callTranscript(id)]);
  useRealtimeRows("attempts", filter, [qk.callAttempts(id)]);
  useRealtimeRows("call_sessions", filter, [qk.callSession(id)]);
  useRealtimeRows("escalations", filter, [qk.callEscalations(id)]);

  const attempts = useMemo(() => attemptsQ.data ?? [], [attemptsQ.data]);
  const items = useMemo(() => fromLiveLines(linesQ.data ?? [], attempts), [linesQ.data, attempts]);
  const last = lastAttempt(attempts);
  const escalation = escalationBadge(escalationsQ.data ?? []);
  const titleId = `live-${id}`;
  const phone = call.caller_phone ? maskPhone(call.caller_phone) : null;

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "flex h-full min-w-0 flex-col rounded-xl bg-card shadow-card",
        escalation?.emergency && "border-l-[3px] border-l-critical",
      )}
      data-call-id={id}
    >
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <h3 id={titleId} className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink-1">
            <LiveDot />
            <span className="truncate">{callerLabel(call.caller_name)}</span>
            <span className="sr-only">, call in progress</span>
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-2">
            <ChannelLabel channel={call.channel} />
            {phone && <span className="tabular">{phone}</span>}
            {call.assistant_name && <span className="truncate">{call.assistant_name}</span>}
            <span>
              Started{" "}
              <time dateTime={callStart(call)} title={formatDateTimeLong(callStart(call))}>
                {formatTime(callStart(call))}
              </time>
            </span>
          </p>
        </div>
        <Elapsed call={call} now={fixedNow} />
      </header>

      <div role="group" aria-label="Call state" className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        {sessionQ.isPending ? <Skeleton className="h-6 w-28" /> : <IdentityBadge level={sessionQ.data?.level ?? "none"} />}
        <LastTool tool={last?.tool_name ?? null} code={last?.code ?? null} loading={attemptsQ.isPending} />
        {escalation && <EscalationStateBadge info={escalation} />}
      </div>

      <div className="min-h-0 flex-1 px-2 pb-2 pt-1 sm:px-3">
        {linesQ.isPending ? (
          <div className="space-y-3 px-2 py-3" aria-hidden="true">
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="ml-auto h-10 w-2/3" />
            <Skeleton className="h-10 w-1/2" />
          </div>
        ) : (
          <TranscriptView
            items={items}
            live
            maxHeightClass="max-h-80"
            empty={
              <p className="flex items-center gap-2 px-2 py-6 text-sm text-ink-2">
                <MessageSquareDashed className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                Waiting for the first words. Final lines appear as each turn ends.
              </p>
            }
          />
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
        <span className="truncate font-mono text-[11px] text-ink-3" title={id}>
          {id}
        </span>
        <Button asChild size="sm" variant="ghost" className="shrink-0">
          <Link to={callHref(id)} aria-label={`Open call with ${callerLabel(call.caller_name)}`}>
            Open call
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </footer>
    </article>
  );
}

/** Ticks on its own so only the timer re-renders each second, not the transcript. */
function Elapsed({ call, now: fixedNow }: { call: CallSummary; now?: Date }) {
  const ticking = useNow(1000, !fixedNow);
  const now = fixedNow ?? ticking;
  const seconds = elapsedSeconds(call, now);
  return (
    <p className="shrink-0 text-right">
      <span className="block text-[11px] text-ink-3">Elapsed</span>
      <span className="block text-sm font-semibold tabular text-ink-1">
        {formatDuration(seconds)}
      </span>
    </p>
  );
}

function LastTool({ tool, code, loading }: { tool: string | null; code: string | null; loading: boolean }) {
  if (loading) return <Skeleton className="h-6 w-36" />;
  if (!tool) {
    return (
      <Badge variant="muted" title="No tool calls yet">
        <Wrench aria-hidden="true" />
        No tool calls yet
      </Badge>
    );
  }
  const label = code ? `${tool}: ${code}` : tool;
  return (
    <Badge variant="outline" className="min-w-0 font-mono" title={`Last tool result: ${label}`}>
      <Wrench aria-hidden="true" />
      <span className="sr-only">Last tool result </span>
      <span className="truncate">{label}</span>
    </Badge>
  );
}

function EscalationStateBadge({ info }: { info: EscalationBadgeInfo }) {
  const Icon = info.emergency ? Siren : info.tone === "good" ? CircleCheck : info.tone === "neutral" ? UserCheck : LifeBuoy;
  return (
    <Badge variant={info.tone} className="min-w-0">
      <Icon aria-hidden="true" />
      <span className="truncate">{info.label}</span>
    </Badge>
  );
}
