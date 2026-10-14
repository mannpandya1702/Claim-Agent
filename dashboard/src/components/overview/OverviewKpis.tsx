import {
  CheckCheck,
  CircleDollarSign,
  Clock,
  Flag,
  Gauge,
  Headset,
  LifeBuoy,
  Mail,
  PhoneCall,
  ShieldCheck,
  ShieldX,
  Timer,
  UserRoundSearch,
} from "lucide-react";
import { useId } from "react";
import { KpiTile, type KpiTileProps } from "@/components/KpiTile";
import { formatCount, formatDuration, formatLatency, formatMoney, formatPercent } from "@/lib/format";
import type { DashboardMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";
import { normalizeMetrics, ratio } from "./metrics";

export interface KpiDef extends KpiTileProps {
  id: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * Tiles that need someone to act. Open escalations and SLA breaches are the live queue (any
 * date, as dashboard_metrics counts them); flagged calls follow the selected range.
 */
export function attentionTiles(m: DashboardMetrics, rangeQuery: string): KpiDef[] {
  return [
    {
      id: "open_escalations",
      label: "Open escalations",
      value: formatCount(m.open_escalations),
      icon: Headset,
      hint: "Right now, across all dates",
      status:
        m.open_escalations > 0
          ? { tone: "warning", label: "Waiting for a callback" }
          : { tone: "good", label: "Queue is clear" },
      to: "/escalations",
    },
    {
      id: "sla_breaches",
      label: "SLA breaches",
      value: formatCount(m.sla_breaches),
      icon: Clock,
      hint: "Open escalations past 30 minutes",
      status:
        m.sla_breaches > 0
          ? { tone: "critical", label: "Callback overdue" }
          : { tone: "good", label: "None overdue" },
      to: "/escalations",
    },
    {
      id: "flagged",
      label: "Flagged calls",
      value: formatCount(m.flagged),
      icon: Flag,
      hint: "Calls in range with a post-call flag",
      // Red whenever anything is flagged: each flag is a promise or a disclosure to check.
      status: m.flagged > 0 ? { tone: "critical", label: "Needs review" } : { tone: "good", label: "No flags raised" },
      to: `/calls?flagged=1&${rangeQuery}`,
    },
  ];
}

/** Range-scoped performance tiles, in display order. */
export function performanceTiles(m: DashboardMetrics, rangeQuery: string): KpiDef[] {
  const authShare = ratio(m.auth_failed, m.completed);
  const notFoundShare = ratio(m.not_found, m.completed);
  return [
    {
      id: "calls",
      label: "Calls",
      value: formatCount(m.calls),
      icon: PhoneCall,
      hint:
        m.in_progress > 0
          ? `${formatCount(m.completed)} completed, ${formatCount(m.in_progress)} in progress`
          : `${formatCount(m.completed)} completed`,
      to: `/calls?${rangeQuery}`,
    },
    {
      id: "containment",
      label: "Containment",
      value: formatPercent(m.containment_rate),
      icon: CheckCheck,
      hint: m.completed > 0 ? `Resolved without escalation, of ${plural(m.completed, "completed call")}` : "Resolved without escalation",
    },
    {
      id: "verification",
      label: "Verification success",
      value: formatPercent(ratio(m.verification_success, m.verification_attempted)),
      icon: ShieldCheck,
      hint:
        m.verification_attempted > 0
          ? `${formatCount(m.verification_success)} of ${plural(m.verification_attempted, "identified caller")} verified`
          : "Phone and date of birth matched",
    },
    {
      id: "auth_failed",
      label: "Auth failed",
      value: formatCount(m.auth_failed),
      icon: ShieldX,
      hint: authShare === null ? "Date of birth did not match" : `${formatPercent(authShare)} of completed calls`,
    },
    {
      id: "not_found",
      label: "Not found",
      value: formatCount(m.not_found),
      icon: UserRoundSearch,
      hint: notFoundShare === null ? "No customer for the phone number" : `${formatPercent(notFoundShare)} of completed calls`,
    },
    {
      id: "escalation_rate",
      label: "Escalation rate",
      value: formatPercent(m.escalation_rate),
      icon: LifeBuoy,
      hint:
        m.emergencies > 0
          ? `${plural(m.escalated, "call")} escalated, ${formatCount(m.emergencies)} emergency`
          : `${plural(m.escalated, "call")} escalated`,
    },
    {
      id: "handle_time",
      label: "Average handle time",
      value: formatDuration(m.avg_handle_seconds),
      icon: Timer,
      hint: "Minutes and seconds per call",
    },
    {
      id: "cost",
      label: "Average cost",
      value: formatMoney(m.avg_cost),
      icon: CircleDollarSign,
      hint: "Per call, in USD",
    },
    {
      id: "latency",
      label: "Avg turn latency",
      value: formatLatency(m.avg_latency_ms),
      icon: Gauge,
      hint: "Caller stops talking to Ava replying",
    },
    {
      id: "emails",
      label: "Emails sent",
      value: formatCount(m.emails_sent),
      icon: Mail,
      hint: "Checklists, summaries and alerts",
    },
  ];
}

interface OverviewKpisProps {
  metrics: DashboardMetrics | undefined;
  /** The selected range as Calls URL parameters ("range=7d"), for the tiles that link to the list. */
  rangeQuery: string;
  /** Previous range's numbers shown while the new range loads. */
  stale?: boolean;
}

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="mb-2.5 text-sm font-semibold text-ink-2">
      {children}
    </h2>
  );
}

export function OverviewKpis({ metrics, rangeQuery, stale = false }: OverviewKpisProps) {
  const attentionId = useId();
  const perfId = useId();
  const loading = metrics === undefined;
  const m = metrics ?? normalizeMetrics({});
  // While loading, tiles keep their labels but drop status and links: a skeleton must not claim
  // "Queue is clear" before the numbers arrive.
  const shape = (def: KpiDef): KpiDef => (loading ? { ...def, status: undefined, to: undefined, loading: true } : def);

  return (
    <div className={cn("space-y-6 transition-opacity", stale && "opacity-60")} aria-busy={loading || stale || undefined}>
      <section aria-labelledby={attentionId}>
        <SectionHeading id={attentionId}>Needs attention</SectionHeading>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          {attentionTiles(m, rangeQuery).map(shape).map(({ id, ...tile }) => (
            <KpiTile key={id} {...tile} />
          ))}
        </div>
      </section>
      <section aria-labelledby={perfId}>
        <SectionHeading id={perfId}>Calls in range</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-5">
          {performanceTiles(m, rangeQuery).map(shape).map(({ id, ...tile }) => (
            <KpiTile key={id} {...tile} />
          ))}
        </div>
      </section>
    </div>
  );
}
