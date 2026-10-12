import { ArrowDownRight, ArrowRight, ArrowUpRight, CircleCheck, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type StatusTone = "good" | "warning" | "serious" | "critical";

export interface KpiDelta {
  /** Preformatted, signed ("+12%", "-3"). */
  value: string;
  direction: "up" | "down" | "flat";
  /** Whether this direction is good news for this metric (up is bad for escalations). */
  good: boolean;
  /** What it is compared with ("vs previous 7 days"). */
  period: string;
}

export interface KpiTileProps {
  /** Sentence case, no trailing colon. */
  label: string;
  /** Preformatted value ("1,284", "72%", "$0.142", "n/a"). */
  value: ReactNode;
  /** Secondary line under the value ("of 42 completed calls"). */
  hint?: ReactNode;
  delta?: KpiDelta;
  /** Status callout with icon and words; color is never the only signal. */
  status?: { tone: StatusTone; label: string };
  icon?: LucideIcon;
  loading?: boolean;
  /** Makes the whole tile a link (for example to a filtered list). */
  to?: string;
  className?: string;
}

const STATUS_STYLE: Record<StatusTone, { icon: LucideIcon; ink: string; accent: string }> = {
  good: { icon: CircleCheck, ink: "text-good-ink", accent: "var(--status-good)" },
  warning: { icon: TriangleAlert, ink: "text-warning-ink", accent: "var(--status-warning)" },
  serious: { icon: TriangleAlert, ink: "text-serious-ink", accent: "var(--status-serious)" },
  critical: { icon: OctagonAlert, ink: "text-critical-ink", accent: "var(--status-critical)" },
};

/**
 * Stat tile: label, value, optional delta and status. The value keeps proportional figures and
 * primary ink; meaning carried by color always comes with an icon and a word.
 */
export function KpiTile({ label, value, hint, delta, status, icon: Icon, loading = false, to, className }: KpiTileProps) {
  const statusStyle = status ? STATUS_STYLE[status.tone] : null;

  // One dt/dd group wrapped in a single div keeps the description list valid HTML while the
  // flex column lays it out.
  const body = (
    <dl className="h-full">
      <div className="flex h-full flex-col gap-1">
        <dt className="flex items-start justify-between gap-2 text-sm font-medium text-ink-2">
          {label}
          {Icon && <Icon className="size-4 shrink-0 text-ink-3" aria-hidden="true" />}
        </dt>
        <dd className="text-2xl font-semibold leading-tight tracking-tight text-ink-1">
          {loading ? <Skeleton className="mt-1 h-7 w-20" /> : value}
        </dd>
        {hint && !loading && <dd className="text-xs text-ink-3">{hint}</dd>}
        {delta && !loading && (
          <dd className="flex items-center gap-1 text-xs">
            <DeltaIcon direction={delta.direction} className={delta.direction === "flat" ? "text-ink-3" : delta.good ? "text-good-ink" : "text-critical-ink"} />
            <span className={cn("font-medium", delta.direction === "flat" ? "text-ink-2" : delta.good ? "text-good-ink" : "text-critical-ink")}>
              {delta.value}
            </span>
            <span className="text-ink-3">{delta.period}</span>
          </dd>
        )}
        {status && statusStyle && !loading && (
          <dd className={cn("mt-auto flex items-center gap-1 pt-1 text-xs font-medium", statusStyle.ink)}>
            <statusStyle.icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{status.label}</span>
          </dd>
        )}
      </div>
    </dl>
  );

  const shell = cn(
    "relative block h-full overflow-hidden rounded-xl bg-card p-4 shadow-card",
    to && "transition-colors hover:bg-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  const accent = statusStyle ? (
    <span aria-hidden="true" className="viz-mark absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: statusStyle.accent }} />
  ) : null;

  if (to) {
    return (
      <Link to={to} className={shell} data-tone={status?.tone}>
        {accent}
        {body}
      </Link>
    );
  }
  return (
    <div className={shell} data-tone={status?.tone} aria-busy={loading || undefined}>
      {accent}
      {body}
    </div>
  );
}

function DeltaIcon({ direction, className }: { direction: KpiDelta["direction"]; className?: string }) {
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-label={direction === "flat" ? "No change" : direction === "up" ? "Up" : "Down"} />;
}
