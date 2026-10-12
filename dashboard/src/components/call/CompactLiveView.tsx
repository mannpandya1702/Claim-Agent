import { useQuery } from "@tanstack/react-query";
import { CircleCheck, LifeBuoy, MessageSquareDashed, Siren, UserCheck, UserRound, Wrench } from "lucide-react";
import { useMemo } from "react";
import { IdentityBadge } from "@/components/calls/IdentityPath";
import { TranscriptView } from "@/components/calls/TranscriptView";
import { ErrorState } from "@/components/ErrorState";
import { escalationBadge, lastAttempt } from "@/components/live/liveCalls";
import { LiveBadge } from "@/components/LiveBadge";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { callerLabel } from "@/lib/format";
import {
  fetchCall,
  fetchCallAttempts,
  fetchCallEscalations,
  fetchCallLevel,
  fetchTranscriptLines,
  qk,
} from "@/lib/queries";
import { IN_PROGRESS_REFETCH_MS, useRealtimeRows } from "@/lib/realtime";
import { fromLiveLines, fromStoredMessages } from "@/lib/transcript";

/**
 * The server's side of the call for a signed-in staff viewer: identity level, tool results and
 * the redacted transcript as the webhook writes them. It reads the same query keys as the call
 * detail page, re-reads on Realtime signals, and polls every 5 s until ended_at is set. After
 * hang-up the end-of-call writer stores `messages` and deletes the live lines, so the view
 * switches to the stored transcript once it is there.
 */
export function CompactLiveView({ callId }: { callId: string }) {
  const rowQ = useQuery({
    queryKey: qk.callRow(callId),
    queryFn: () => fetchCall(callId),
    refetchInterval: (q) => (q.state.data?.ended_at ? false : IN_PROGRESS_REFETCH_MS),
  });
  // No row yet (the stub lands with the first transcript line) counts as live.
  const live = !rowQ.data?.ended_at;
  const poll = live ? IN_PROGRESS_REFETCH_MS : false;

  const linesQ = useQuery({ queryKey: qk.callTranscript(callId), queryFn: () => fetchTranscriptLines(callId), refetchInterval: poll });
  const attemptsQ = useQuery({ queryKey: qk.callAttempts(callId), queryFn: () => fetchCallAttempts(callId), refetchInterval: poll });
  const sessionQ = useQuery({ queryKey: qk.callLevel(callId), queryFn: () => fetchCallLevel(callId), refetchInterval: poll });
  const escalationsQ = useQuery({
    queryKey: qk.callEscalations(callId),
    queryFn: () => fetchCallEscalations(callId),
    refetchInterval: poll,
  });

  const byKey = `call_key=eq.${callId}`;
  useRealtimeRows("call_interactions", `vapi_call_id=eq.${callId}`, [qk.callRow(callId)]);
  useRealtimeRows("transcript_lines", byKey, [qk.callTranscript(callId)]);
  useRealtimeRows("attempts", byKey, [qk.callAttempts(callId)]);
  useRealtimeRows("call_sessions", byKey, [qk.callLevel(callId)]);
  useRealtimeRows("escalations", byKey, [qk.callEscalations(callId)]);

  const attempts = useMemo(() => attemptsQ.data ?? [], [attemptsQ.data]);
  const liveItems = useMemo(() => fromLiveLines(linesQ.data ?? [], attempts), [linesQ.data, attempts]);
  const storedItems = useMemo(() => fromStoredMessages(rowQ.data?.messages), [rowQ.data?.messages]);
  const showStored = !live && storedItems.length > 0;
  const items = showStored ? storedItems : liveItems;

  const failed = [rowQ, linesQ, attemptsQ, sessionQ, escalationsQ].find((q) => q.isError);
  const last = lastAttempt(attempts);
  const escalation = escalationBadge(escalationsQ.data ?? []);
  const row = rowQ.data;

  if (failed) {
    return (
      <ErrorState
        compact
        title="Could not load this call"
        error={failed.error}
        onRetry={() => {
          for (const q of [rowQ, linesQ, attemptsQ, sessionQ, escalationsQ]) void q.refetch();
        }}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="compact-live-view" data-live={live ? "true" : "false"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-sm">
          <UserRound className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="sr-only">Caller: </span>
          <span className="truncate font-medium text-ink-1">{rowQ.isPending ? "Loading caller" : callerLabel(row?.caller_name)}</span>
        </p>
        <LiveBadge />
      </div>

      <div role="group" aria-label="Call state" className="flex flex-wrap items-center gap-1.5">
        {rowQ.isPending ? <Skeleton className="h-6 w-24" /> : <OutcomeBadge outcome={row?.outcome} live={live} />}
        {sessionQ.isPending ? <Skeleton className="h-6 w-28" /> : <IdentityBadge level={sessionQ.data?.level ?? "none"} />}
        {attemptsQ.isPending ? (
          <Skeleton className="h-6 w-36" />
        ) : last ? (
          <Badge variant="outline" className="min-w-0 font-mono" title={`Last tool result: ${last.tool_name}${last.code ? `: ${last.code}` : ""}`}>
            <Wrench aria-hidden="true" />
            <span className="sr-only">Last tool result </span>
            <span className="truncate">{last.code ? `${last.tool_name}: ${last.code}` : last.tool_name}</span>
          </Badge>
        ) : (
          <Badge variant="muted">
            <Wrench aria-hidden="true" />
            No tool calls yet
          </Badge>
        )}
        {escalation && (
          <Badge variant={escalation.tone} className="min-w-0">
            {escalation.emergency ? (
              <Siren aria-hidden="true" />
            ) : escalation.tone === "good" ? (
              <CircleCheck aria-hidden="true" />
            ) : escalation.tone === "neutral" ? (
              <UserCheck aria-hidden="true" />
            ) : (
              <LifeBuoy aria-hidden="true" />
            )}
            <span className="truncate">{escalation.label}</span>
          </Badge>
        )}
      </div>

      {linesQ.isPending && rowQ.isPending ? (
        <div className="space-y-3 py-2" aria-hidden="true">
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="ml-auto h-10 w-2/3" />
          <Skeleton className="h-10 w-1/2" />
        </div>
      ) : (
        <TranscriptView
          items={items}
          live={live}
          maxHeightClass="max-h-96"
          className="rounded-lg border"
          empty={
            <p className="flex items-center gap-2 px-3 py-6 text-sm text-ink-2">
              <MessageSquareDashed className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
              {live
                ? "Waiting for the first final line. The server writes each turn when it ends."
                : "Call ended. Waiting for the end-of-call report to store the transcript."}
            </p>
          }
        />
      )}
      <p className="text-xs text-ink-3">
        {showStored
          ? "Stored transcript from the end-of-call report, redacted."
          : "Final lines as the server stores them, redacted; dates of birth and phone answers are masked."}
      </p>
    </div>
  );
}
