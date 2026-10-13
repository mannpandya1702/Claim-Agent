import { useQuery } from "@tanstack/react-query";
import { Mic, Radio, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useNow } from "@/components/calls/hooks";
import { EmptyState } from "@/components/EmptyState";
import { errorMessage, ErrorState } from "@/components/ErrorState";
import { JustEnded, StuckCalls } from "@/components/live/EndedAndStuck";
import { LiveCallCard } from "@/components/live/LiveCallCard";
import { splitLiveCalls } from "@/components/live/liveCalls";
import { useJustEnded } from "@/components/live/useJustEnded";
import { LiveDot } from "@/components/LiveDot";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchLiveCalls, qk } from "@/lib/queries";
import { IN_PROGRESS_REFETCH_MS, useRealtimeRows } from "@/lib/realtime";

/*
 * Supervisor view: one card per call with ended_at is null. The list re-reads on any
 * call_interactions change (the stub row appears with the first transcript line; the
 * end-of-call report sets ended_at and the card closes). Each card subscribes to its own
 * call_key for transcript lines, tool attempts, identity level and escalations.
 */

function TalkToAvaLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/call" target="_blank" rel="noopener">
        <Mic aria-hidden="true" />
        Start a test call
        <span className="sr-only"> (opens in a new tab)</span>
      </Link>
    </Button>
  );
}

export default function Live({ now: fixedNow }: { now?: Date } = {}) {
  const liveQ = useQuery({
    queryKey: qk.liveCalls(),
    queryFn: fetchLiveCalls,
    // Belt and braces while anything is live; with nothing live, Realtime INSERTs wake the page.
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? IN_PROGRESS_REFETCH_MS : false),
  });
  useRealtimeRows("call_interactions", null, [qk.liveCalls()]);

  // Coarse clock for the stuck cut-off and "ended x ago"; each card runs its own 1 s timer.
  const ticking = useNow(30_000, !fixedNow);
  const now = fixedNow ?? ticking;

  const calls = liveQ.data;
  const { active, stuck } = useMemo(() => splitLiveCalls(calls ?? [], now), [calls, now]);
  const { ended, clear } = useJustEnded(calls);

  return (
    <>
      <PageHeader
        title="Live"
        description="Every call in progress, with its transcript as each turn ends, identity state and last tool result."
        actions={
          <>
            {active.length > 0 && (
              <Badge variant="good" data-testid="live-count">
                <LiveDot />
                {active.length === 1 ? "1 call in progress" : `${active.length} calls in progress`}
              </Badge>
            )}
            <TalkToAvaLink />
          </>
        }
      />

      <div className="space-y-6">
        {liveQ.isError && calls && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--status-warning)_14%,var(--card))] px-3 py-2 text-sm text-warning-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>Could not refresh the live list ({errorMessage(liveQ.error)}). Showing the last good read; retrying.</span>
          </p>
        )}

        <section aria-labelledby="live-active">
          <h2 id="live-active" className="sr-only">
            Calls in progress
          </h2>
          {liveQ.isPending ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" role="status" aria-label="Loading live calls">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-96 rounded-xl" />
              ))}
            </div>
          ) : liveQ.isError && !calls ? (
            <Card>
              <ErrorState title="Could not load live calls" error={liveQ.error} onRetry={() => void liveQ.refetch()} />
            </Card>
          ) : active.length === 0 ? (
            <Card>
              <EmptyState
                icon={Radio}
                title="No calls in progress"
                description="A card appears within seconds of Ava's greeting and closes when the end-of-call report arrives."
                action={<TalkToAvaLink />}
              />
            </Card>
          ) : (
            <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {active.map((call) => (
                <li key={call.vapi_call_id} className="min-w-0">
                  <LiveCallCard call={call} now={fixedNow} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <JustEnded ended={ended} now={now} onClear={clear} />
        <StuckCalls calls={stuck} now={now} />
      </div>
    </>
  );
}
