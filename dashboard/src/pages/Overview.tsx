import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarRange, ChartBarBig, ChartColumn, ChartPie, Loader2, RotateCw, Smile } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { DateRangeSelect } from "@/components/DateRangeSelect";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, errorMessage } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { CallReasonBars, CallReasonTable } from "@/components/overview/CallReasonsChart";
import { CallsPerDayChart, CallsPerDayTable } from "@/components/overview/CallsPerDayChart";
import { ChartCard } from "@/components/overview/ChartCard";
import { OutcomeDonut, OutcomeTable } from "@/components/overview/OutcomeDonut";
import { OverviewKpis } from "@/components/overview/OverviewKpis";
import { SentimentBar, SentimentTable, unratedNote } from "@/components/overview/SentimentMix";
import {
  buildDailySeries,
  buildOutcomeRows,
  buildOutcomeSlices,
  buildReasonMix,
  buildSentimentMix,
  normalizeMetrics,
  rangeCaption,
  rangeDays,
} from "@/components/overview/metrics";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { customRange, DEFAULT_RANGE, parseCustomDays, presetRange, RANGE_PRESETS, type CustomDays, type RangePreset } from "@/lib/dates";
import { formatCount, formatTime } from "@/lib/format";
import { fetchCallReasonCounts, fetchCallsByDay, fetchMetrics, qk } from "@/lib/queries";
import { useRealtimeRows } from "@/lib/realtime";
import { useEasternToday } from "@/lib/useEasternToday";

// Realtime events re-read the aggregates (prefix keys, debounced in realtime.ts). A call row
// moves every tile, the daily chart and the reasons; an escalation moves the open and SLA tiles.
const CALL_KEYS = [["metrics"], ["calls-by-day"], ["call-reasons"]] as const;
const ESCALATION_KEYS = [["metrics"]] as const;

// SLA breaches become true with time alone (open longer than 30 minutes, no row change), so the
// metrics also refresh on a slow clock.
const METRICS_REFRESH_MS = 60_000;

type RangeChoice = { preset: RangePreset; custom: null } | { preset: "custom"; custom: CustomDays };

/** ?range=30d, or ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD; anything broken is the default. */
function parseRange(params: URLSearchParams): RangeChoice {
  const value = params.get("range");
  if (value === "custom") {
    const custom = parseCustomDays(params.get("from"), params.get("to"));
    if (custom) return { preset: "custom", custom };
  }
  const preset = RANGE_PRESETS.some((p) => p.value === value) ? (value as RangePreset) : DEFAULT_RANGE;
  return { preset, custom: null };
}

/** The same range as Calls URL parameters, so a tile opens the list on the days it counted. */
function rangeQuery(choice: RangeChoice): string {
  const p = new URLSearchParams({ range: choice.preset });
  if (choice.custom) {
    p.set("from", choice.custom.from);
    p.set("to", choice.custom.to);
  }
  return p.toString();
}

function ChartSkeleton({ height = 300 }: { height?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading chart</span>
      <Skeleton className="w-full rounded-lg" style={{ height }} />
    </div>
  );
}

export default function Overview() {
  const [params, setParams] = useSearchParams();
  const choice = parseRange(params);
  const { preset, custom } = choice;
  const today = useEasternToday();
  // `today` is a dependency on purpose: the preset's edges move when the Eastern day changes.
  const range = useMemo(
    () => (custom ? customRange(custom.from, custom.to) : presetRange(preset as RangePreset)),
    [preset, custom?.from, custom?.to, today],
  );

  const setRange = (next: RangePreset | CustomDays) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete("from");
        p.delete("to");
        if (typeof next !== "string") {
          p.set("range", "custom");
          p.set("from", next.from);
          p.set("to", next.to);
        } else if (next === DEFAULT_RANGE) p.delete("range");
        else p.set("range", next);
        return p;
      },
      { replace: true },
    );
  };
  const setPreset = (next: RangePreset) => setRange(next);

  const metricsQ = useQuery({
    queryKey: qk.metrics(range),
    queryFn: () => fetchMetrics(range),
    select: normalizeMetrics,
    placeholderData: keepPreviousData,
    refetchInterval: METRICS_REFRESH_MS,
  });
  const daysQ = useQuery({
    queryKey: qk.callsByDay(range),
    queryFn: () => fetchCallsByDay(range),
    placeholderData: keepPreviousData,
  });
  const reasonsQ = useQuery({
    queryKey: qk.callReasons(range),
    queryFn: () => fetchCallReasonCounts(range),
    placeholderData: keepPreviousData,
  });

  useRealtimeRows("call_interactions", null, CALL_KEYS);
  useRealtimeRows("escalations", null, ESCALATION_KEYS);

  const metrics = metricsQ.data;
  const series = useMemo(() => (daysQ.data ? buildDailySeries(daysQ.data, range) : null), [daysQ.data, range]);
  const slices = useMemo(() => (metrics ? buildOutcomeSlices(metrics.outcomes) : []), [metrics]);
  const outcomeRows = useMemo(() => (metrics ? buildOutcomeRows(metrics.outcomes) : []), [metrics]);
  const sentiment = useMemo(() => (metrics ? buildSentimentMix(metrics.sentiments) : null), [metrics]);

  const metricsStale = metricsQ.isPlaceholderData;
  const daysStale = daysQ.isPlaceholderData;
  const reasonsStale = reasonsQ.isPlaceholderData;
  // The untagged count needs both reads for the same range; a placeholder of either leaves it out.
  const reasons = useMemo(
    () => (reasonsQ.data ? buildReasonMix(reasonsQ.data, metrics && !metricsStale && !reasonsStale ? metrics.calls : null) : null),
    [reasonsQ.data, metrics, metricsStale, reasonsStale],
  );
  const refreshing = metricsQ.isFetching || daysQ.isFetching || reasonsQ.isFetching;
  const updatedAt = Math.max(metricsQ.dataUpdatedAt, daysQ.dataUpdatedAt, reasonsQ.dataUpdatedAt);
  const noCalls = metrics !== undefined && !metricsStale && metrics.calls === 0;
  const singleDay = rangeDays(range) <= 1;

  const widenAction =
    preset === "today" || preset === "7d" ? (
      <Button variant="outline" size="sm" onClick={() => setPreset(preset === "today" ? "7d" : "30d")}>
        <CalendarRange aria-hidden="true" />
        Show {preset === "today" ? "last 7 days" : "last 30 days"}
      </Button>
    ) : undefined;

  // --- Calls per day ---------------------------------------------------------------------------
  let dailyState: ReactNode = null;
  if (daysQ.isError && !daysQ.data) {
    dailyState = <ErrorState compact title="Could not load calls per day" error={daysQ.error} onRetry={() => void daysQ.refetch()} />;
  } else if (!series) {
    dailyState = <ChartSkeleton />;
  } else if (singleDay) {
    dailyState = (
      <EmptyState
        compact
        icon={ChartColumn}
        title="The daily trend needs more than one day"
        description={`${formatCount(series.total)} ${series.total === 1 ? "call" : "calls"} today. Pick a longer range to compare days.`}
        action={widenAction}
      />
    );
  } else if (series.total === 0 && !daysStale) {
    dailyState = (
      <EmptyState compact icon={ChartColumn} title="No calls in this range" description="Calls appear here as soon as they start." action={widenAction} />
    );
  }

  // --- Outcome mix and sentiment ---------------------------------------------------------------
  const metricsErrorState =
    metricsQ.isError && !metrics ? (
      <ErrorState compact title="Could not load the metrics" error={metricsQ.error} onRetry={() => void metricsQ.refetch()} />
    ) : null;

  let outcomeState: ReactNode = metricsErrorState;
  if (!outcomeState && !metrics) outcomeState = <ChartSkeleton height={176} />;
  else if (!outcomeState && noCalls) outcomeState = <EmptyState compact icon={ChartPie} title="No calls in this range" />;

  let sentimentState: ReactNode = metricsErrorState;
  if (!sentimentState && !sentiment) sentimentState = <ChartSkeleton height={120} />;
  else if (!sentimentState && noCalls) sentimentState = <EmptyState compact icon={Smile} title="No calls in this range" />;
  else if (!sentimentState && sentiment && sentiment.rated === 0 && !metricsStale) {
    sentimentState = (
      <EmptyState compact icon={Smile} title="No sentiment yet" description="Sentiment arrives with each call's post-call analysis." />
    );
  }

  // --- Top call reasons --------------------------------------------------------------------------
  let reasonsState: ReactNode = null;
  if (reasonsQ.isError && !reasonsQ.data) {
    reasonsState = <ErrorState compact title="Could not load call reasons" error={reasonsQ.error} onRetry={() => void reasonsQ.refetch()} />;
  } else if (!reasons) {
    reasonsState = <ChartSkeleton height={176} />;
  } else if (noCalls) {
    reasonsState = <EmptyState compact icon={ChartBarBig} title="No calls in this range" />;
  } else if (reasons.tagged === 0 && !reasonsStale) {
    reasonsState = (
      <EmptyState compact icon={ChartBarBig} title="No call reasons yet" description="Each call is tagged with why the caller called once it ends." />
    );
  }

  const note = sentiment ? unratedNote(sentiment) : null;

  return (
    <>
      <PageHeader title="Overview" description="How Ava is handling calls, and what needs a person." />

      <div role="group" aria-label="Filters" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
        <DateRangeSelect value={preset} custom={custom} onPreset={setPreset} onCustom={setRange} />
        <span className="text-sm text-ink-2">
          {rangeCaption(range)}
          <span className="text-ink-3"> · Eastern time</span>
        </span>
        <span className="flex min-h-5 items-center gap-1.5 text-xs text-ink-3 sm:ml-auto" aria-live="polite">
          {refreshing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Updating
            </>
          ) : updatedAt > 0 ? (
            `Updated ${formatTime(updatedAt)}`
          ) : null}
        </span>
      </div>

      {metricsQ.isError && metrics && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-[color-mix(in_oklab,var(--status-critical)_10%,var(--card))] px-3 py-2 text-sm text-ink-1"
        >
          <span className="min-w-0 flex-1">
            Could not refresh the numbers ({errorMessage(metricsQ.error)}). Showing the last values loaded.
          </span>
          <Button variant="outline" size="sm" onClick={() => void metricsQ.refetch()}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {metricsQ.isError && !metrics ? (
        <Card>
          <ErrorState title="Could not load the metrics" error={metricsQ.error} onRetry={() => void metricsQ.refetch()} />
        </Card>
      ) : (
        <OverviewKpis metrics={metrics} rangeQuery={rangeQuery(choice)} stale={metricsStale} />
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <ChartCard
          className="lg:col-span-2"
          title="Calls per day"
          description="Stacked by outcome, Eastern days"
          state={dailyState}
          stale={daysStale}
          chart={series ? <CallsPerDayChart series={series} /> : null}
          table={series ? <CallsPerDayTable series={series} /> : null}
        />
        <ChartCard
          title="Outcome mix"
          description={metrics ? `Share of ${formatCount(metrics.calls)} ${metrics.calls === 1 ? "call" : "calls"} in range` : "Share of calls in range"}
          state={outcomeState}
          stale={metricsStale}
          chart={metrics ? <OutcomeDonut slices={slices} total={metrics.calls} /> : null}
          table={metrics ? <OutcomeTable rows={outcomeRows} total={metrics.calls} /> : null}
        />
        <ChartCard
          title="Top call reasons"
          description={
            reasons && reasons.tagged > 0
              ? `Main reason for ${formatCount(reasons.tagged)} tagged ${reasons.tagged === 1 ? "call" : "calls"}`
              : "Main reason for each call in range"
          }
          state={reasonsState}
          stale={reasonsStale}
          chart={reasons ? <CallReasonBars mix={reasons} /> : null}
          table={reasons ? <CallReasonTable mix={reasons} /> : null}
        />
        <ChartCard
          className="lg:col-span-2"
          title="Sentiment mix"
          description={sentiment ? `Share of ${formatCount(sentiment.rated)} rated ${sentiment.rated === 1 ? "call" : "calls"}` : "Share of rated calls"}
          state={sentimentState}
          stale={metricsStale}
          chart={
            sentiment ? (
              <div className="space-y-3">
                <SentimentBar mix={sentiment} />
                {note && <p className="text-xs text-ink-3">{note}</p>}
              </div>
            ) : null
          }
          table={sentiment ? <SentimentTable mix={sentiment} /> : null}
        />
      </div>
    </>
  );
}
