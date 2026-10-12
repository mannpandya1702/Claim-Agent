import { Hourglass, LifeBuoy, Timer, UserCheck } from "lucide-react";
import { SLA_MINUTES } from "@/components/calls/EscalationCard";
import { KpiTile } from "@/components/KpiTile";
import { formatCount, formatDateTime } from "@/lib/format";
import { formatWait, type OpenSummary } from "./queue";

interface QueueSummaryProps {
  summary: OpenSummary | null;
  claimed: number | null;
  loading?: boolean;
}

/** Headline numbers for the queue. Breaches use the same rule as the cards and the sla job. */
export function QueueSummary({ summary, claimed, loading = false }: QueueSummaryProps) {
  const s = summary;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <KpiTile
        label="Open"
        icon={LifeBuoy}
        loading={loading}
        value={formatCount(s?.open ?? null)}
        hint={s && s.emergencies > 0 ? `${s.emergencies} ${s.emergencies === 1 ? "emergency" : "emergencies"}` : "Waiting to be claimed"}
        status={s ? (s.open > 0 ? { tone: "warning", label: "Needs a callback" } : { tone: "good", label: "Queue clear" }) : undefined}
      />
      <KpiTile
        label="Past SLA"
        icon={Timer}
        loading={loading}
        value={formatCount(s?.breached ?? null)}
        hint={`Open longer than ${SLA_MINUTES} minutes`}
        status={
          s
            ? s.breached > 0
              ? { tone: "critical", label: "Claim these first" }
              : { tone: "good", label: `None over ${SLA_MINUTES} minutes` }
            : undefined
        }
      />
      <KpiTile
        label="Oldest open"
        icon={Hourglass}
        loading={loading}
        value={formatWait(s?.oldestMinutes)}
        hint={s?.oldestAt ? `Since ${formatDateTime(s.oldestAt)}` : "Nothing waiting"}
      />
      <KpiTile label="Claimed" icon={UserCheck} loading={loading} value={formatCount(claimed)} hint="Being called back" />
    </div>
  );
}
