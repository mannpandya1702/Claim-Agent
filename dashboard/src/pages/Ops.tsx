import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  Eraser,
  FileQuestion,
  Hourglass,
  Inbox,
  LifeBuoy,
  ListChecks,
  Mail,
  OctagonX,
  RotateCw,
  Send,
  Table2,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNow } from "@/components/calls/hooks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { KpiTile } from "@/components/KpiTile";
import { PageHeader } from "@/components/PageHeader";
import { ChannelDownBanner, ChannelRow, DeliveryGapSkeleton } from "@/components/ops/DeliveryGap";
import {
  countHealth,
  deliveryChannels,
  hasGhl,
  hasOutbox,
  JOB_SPECS,
  jobHealth,
  normaliseHealth,
  type JobName,
} from "@/components/ops/health";
import { JobRunsTable } from "@/components/ops/JobRunsTable";
import { Section } from "@/components/ops/Section";
import { SegmentedControl, type SegmentOption } from "@/components/ops/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatCount, formatDateTime, formatRelative, formatTime } from "@/lib/format";
import { fetchDeliveryGap, fetchJobRuns, fetchOpsHealth, qk } from "@/lib/queries";
import { useRealtimeRows } from "@/lib/realtime";

/*
 * Automation health. ops_health and escalation_delivery_gap are computed in SQL (security
 * invoker, so RLS applies); this page only reads and labels them. job_runs is not in the
 * Realtime publication, so the page polls; escalations, emails, call_interactions and
 * outbox_events changes refresh the counts sooner.
 */

const OPS_POLL_MS = 30_000;
const GAP_HOURS = 24;
const JOB_ICONS: Record<JobName, LucideIcon> = { sla: Timer, reaper: Eraser, digest: CalendarClock, outbox: Table2 };

type JobFilter = "all" | JobName;

export default function Ops({ now: fixedNow }: { now?: Date } = {}) {
  const healthQ = useQuery({ queryKey: qk.opsHealth(), queryFn: fetchOpsHealth, refetchInterval: OPS_POLL_MS });
  const gapQ = useQuery({ queryKey: qk.deliveryGap(GAP_HOURS), queryFn: () => fetchDeliveryGap(GAP_HOURS), refetchInterval: OPS_POLL_MS });
  const jobsQ = useQuery({ queryKey: qk.jobRuns(), queryFn: () => fetchJobRuns(50), refetchInterval: OPS_POLL_MS });

  useRealtimeRows("escalations", null, [qk.opsHealth(), qk.deliveryGap(GAP_HOURS)]);
  useRealtimeRows("emails", null, [qk.opsHealth(), qk.deliveryGap(GAP_HOURS)]);
  useRealtimeRows("call_interactions", null, [qk.opsHealth()]);
  useRealtimeRows("outbox_events", null, [qk.opsHealth()]);

  const ticking = useNow(30_000, !fixedNow);
  const now = fixedNow ?? ticking;
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");

  const health = useMemo(() => (healthQ.data ? normaliseHealth(healthQ.data) : null), [healthQ.data]);
  const channels = useMemo(() => deliveryChannels(gapQ.data ?? [], health), [gapQ.data, health]);
  const runs = useMemo(() => jobsQ.data ?? [], [jobsQ.data]);
  const visibleRuns = jobFilter === "all" ? runs : runs.filter((r) => r.job === jobFilter);

  const updatedAt = Math.max(healthQ.dataUpdatedAt, gapQ.dataUpdatedAt, jobsQ.dataUpdatedAt);
  const refreshing = healthQ.isFetching || gapQ.isFetching || jobsQ.isFetching;
  const refresh = () => {
    void healthQ.refetch();
    void gapQ.refetch();
    void jobsQ.refetch();
  };

  const jobOptions: SegmentOption<JobFilter>[] = [
    { value: "all", label: "All", count: runs.length },
    ...JOB_SPECS.map((s) => ({ value: s.job, label: s.label, count: runs.filter((r) => r.job === s.job).length })),
  ];

  const healthLoading = healthQ.isPending;

  return (
    <>
      <PageHeader
        title="Ops"
        description="Automation health: scheduled jobs, alert delivery and what is stuck."
        actions={
          <>
            {updatedAt > 0 && (
              <span className="text-xs text-ink-3" aria-live="polite">
                Updated <time dateTime={new Date(updatedAt).toISOString()}>{formatTime(updatedAt)}</time>
              </span>
            )}
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
              <RotateCw className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />

      <ChannelDownBanner channels={channels} />

      <div className="space-y-8">
        <Section id="ops-jobs" title="Scheduled jobs" description="Last finished run of each pg_cron job.">
          {healthQ.isError && !health ? (
            <Card>
              <ErrorState compact title="Could not load automation health" error={healthQ.error} onRetry={() => void healthQ.refetch()} />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:gap-4 xl:grid-cols-4">
              {JOB_SPECS.map((spec) => {
                const last = health?.[spec.healthKey] ?? null;
                return (
                  <KpiTile
                    key={spec.job}
                    label={spec.label}
                    icon={JOB_ICONS[spec.job]}
                    loading={healthLoading}
                    value={last ? formatRelative(last, now) : "Never"}
                    hint={
                      <>
                        {spec.schedule}
                        {last && (
                          <>
                            {" "}
                            · <time dateTime={last}>{formatDateTime(last)}</time>
                          </>
                        )}
                      </>
                    }
                    status={healthLoading ? undefined : jobHealth(last, spec, now)}
                  />
                );
              })}
            </div>
          )}
        </Section>

        <Section id="ops-queues" title="Queues and failures" description="Counts that should be zero. Failure counts cover the last 24 hours.">
          {healthQ.isError && !health ? null : !healthLoading && !health ? (
            <Card>
              <EmptyState compact icon={ListChecks} title="No health row" description="The ops_health view returned nothing for this session." />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:gap-4 lg:grid-cols-3">
              <KpiTile
                label="Open escalations"
                icon={LifeBuoy}
                loading={healthLoading}
                value={formatCount(health?.open_escalations)}
                hint="Callback requests and emergencies"
                status={health ? countHealth(health.open_escalations, "warning", "Waiting for a callback", "Queue clear") : undefined}
                to="/escalations"
              />
              <KpiTile
                label="SLA breaches"
                icon={Timer}
                loading={healthLoading}
                value={formatCount(health?.sla_breaches)}
                hint="Open longer than 30 minutes"
                status={health ? countHealth(health.sla_breaches, "critical", "Unclaimed past the SLA") : undefined}
                to="/escalations"
              />
              <KpiTile
                label="Stuck calls"
                icon={Hourglass}
                loading={healthLoading}
                value={formatCount(health?.stuck_calls)}
                hint="No end-of-call report after 2 hours"
                status={health ? countHealth(health.stuck_calls, "serious", "Reaper closes these hourly") : undefined}
                to="/live"
              />
              <KpiTile
                label="Telegram alerts failed"
                icon={Send}
                loading={healthLoading}
                value={formatCount(health?.alerts_failed_24h)}
                hint="Last 24 hours"
                status={health ? countHealth(health.alerts_failed_24h, "critical", "See delivery errors") : undefined}
              />
              <KpiTile
                label="Emails failed"
                icon={Mail}
                loading={healthLoading}
                value={formatCount(health?.emails_failed_24h)}
                hint={health ? `${formatCount(health.emails_sent_24h)} sent in the last 24 hours` : "Last 24 hours"}
                status={health ? countHealth(health.emails_failed_24h, "critical", "Check the Resend log") : undefined}
              />
              <KpiTile
                label="Analysis missing"
                icon={FileQuestion}
                loading={healthLoading}
                value={formatCount(health?.analysis_missing_24h)}
                hint="Calls in 24 hours with no summary after backfill"
                status={health ? countHealth(health.analysis_missing_24h, "warning", "Summary never arrived") : undefined}
              />
              {hasOutbox(health) && (
                <>
                  <KpiTile
                    label="Outbox backlog"
                    icon={Inbox}
                    value={formatCount(health.outbox_pending)}
                    hint="Completed calls waiting for the Airtable call log"
                    status={countHealth(health.outbox_pending, "warning", "Delivering, retried every minute", "Nothing waiting")}
                  />
                  <KpiTile
                    label="Outbox failures"
                    icon={OctagonX}
                    value={formatCount(health.outbox_dead)}
                    hint="Gave up after 5 attempts; each call shows the last error"
                    status={countHealth(health.outbox_dead, "critical", "Not in Airtable")}
                  />
                </>
              )}
              {hasGhl(health) && (
                <>
                  <KpiTile
                    label="GoHighLevel backlog"
                    icon={Inbox}
                    value={formatCount(health.ghl_pending)}
                    hint="Completed calls waiting for the CRM (queued 90 s after hangup)"
                    status={countHealth(health.ghl_pending, "warning", "Delivering, retried every minute", "Nothing waiting")}
                  />
                  <KpiTile
                    label="GoHighLevel failures"
                    icon={OctagonX}
                    value={formatCount(health.ghl_dead)}
                    hint="Gave up after 5 attempts; each call shows the last error"
                    status={countHealth(health.ghl_dead, "critical", "Not in GoHighLevel")}
                  />
                </>
              )}
            </div>
          )}
        </Section>

        <Section
          id="ops-delivery"
          title="Delivery by channel"
          description="Last 24 hours. Alert rows are written before the send, so owed minus delivered is what never arrived; the Airtable call log and GoHighLevel also count calls still queued."
        >
          <Card>
            <CardContent className="pt-4 sm:pt-5">
              {gapQ.isError && !gapQ.data ? (
                <ErrorState compact title="Could not load delivery counts" error={gapQ.error} onRetry={() => void gapQ.refetch()} />
              ) : gapQ.isPending ? (
                <DeliveryGapSkeleton />
              ) : (
                <div className="space-y-5">
                  {channels.map((c, i) => (
                    <div key={c.channel} className="space-y-5">
                      {i > 0 && <Separator />}
                      <ChannelRow channel={c} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section
          id="ops-runs"
          title="Recent job runs"
          description="One row per job and period; a re-fire inside the same period is a no-op."
          actions={runs.length > 0 ? <SegmentedControl label="Filter runs by job" options={jobOptions} value={jobFilter} onChange={setJobFilter} /> : undefined}
        >
          <Card className="overflow-hidden">
            {jobsQ.isError && !jobsQ.data ? (
              <ErrorState compact title="Could not load job runs" error={jobsQ.error} onRetry={() => void jobsQ.refetch()} />
            ) : !jobsQ.isPending && visibleRuns.length === 0 ? (
              <EmptyState
                compact
                icon={CalendarClock}
                title={runs.length === 0 ? "No job runs yet" : "No runs for this job"}
                description={
                  runs.length === 0
                    ? "Runs appear once pg_cron starts calling the jobs: SLA every 10 minutes, the reaper hourly, the digest daily, the outbox every minute."
                    : "It has not run within the 50 most recent runs."
                }
              />
            ) : (
              <JobRunsTable runs={visibleRuns} now={now} loading={jobsQ.isPending} fetching={jobsQ.isFetching && !jobsQ.isPending} />
            )}
          </Card>
        </Section>
      </div>
    </>
  );
}
