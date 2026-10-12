import { Cell, Pie, PieChart, Tooltip, type TooltipProps } from "recharts";
import { formatCount, formatPercent } from "@/lib/format";
import { DataTable, LegendSwatch } from "./ChartCard";
import type { Slice } from "./metrics";

/*
 * Outcome mix as a donut: part-to-whole at a glance, capped at six segments (the smallest fold
 * into Other). Slices run clockwise from twelve o'clock in OUTCOME_ORDER, separated by a 2px
 * surface gap. The legend beside it carries every count and share as text, so no value depends
 * on hover or on telling two hues apart.
 */

const SIZE = 176;

function SliceTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const slice = payload[0]?.payload as Slice | undefined;
  if (!slice) return null;
  return (
    <div className="max-w-56 rounded-md bg-card px-3 py-2 text-xs shadow-pop">
      <p className="flex items-center gap-2">
        <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
        <span className="tabular font-semibold text-ink-1">{formatCount(slice.value)}</span>
        <span className="text-ink-3">{formatPercent(slice.share)}</span>
      </p>
      <p className="mt-0.5 font-medium text-ink-1">{slice.label}</p>
      <p className="text-ink-3">{slice.description}</p>
    </div>
  );
}

export function OutcomeDonut({ slices, total }: { slices: Slice[]; total: number }) {
  const summary = `Outcome mix of ${formatCount(total)} calls: ${slices
    .map((s) => `${s.label} ${formatCount(s.value)} (${formatPercent(s.share)})`)
    .join(", ")}.`;

  return (
    <figure className="flex flex-col items-center gap-5 sm:flex-row">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <PieChart width={SIZE} height={SIZE}>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={SIZE * 0.34}
            outerRadius={SIZE * 0.48}
            startAngle={90}
            endAngle={-270}
            stroke="var(--chart-surface)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
          <Tooltip content={<SliceTooltip />} isAnimationActive={false} wrapperStyle={{ outline: "none", zIndex: 10 }} />
        </PieChart>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold leading-none tracking-tight text-ink-1">{formatCount(total)}</span>
          <span className="mt-1 text-xs text-ink-3">{total === 1 ? "call" : "calls"}</span>
        </div>
      </div>
      <ul className="grid w-full min-w-0 gap-1.5 text-sm sm:max-w-xs" aria-label="Outcomes">
        {slices.map((s) => (
          <li key={s.key} className="flex min-w-0 items-center gap-2" title={s.description}>
            <LegendSwatch color={s.color} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{s.label}</span>
            <span className="tabular font-medium text-ink-1">{formatCount(s.value)}</span>
            <span className="tabular w-10 text-right text-xs text-ink-3">{formatPercent(s.share)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function OutcomeTable({ slices, total }: { slices: Slice[]; total: number }) {
  return (
    <DataTable
      caption="Calls by outcome"
      columns={[
        { key: "outcome", label: "Outcome" },
        { key: "calls", label: "Calls", numeric: true },
        { key: "share", label: "Share", numeric: true },
      ]}
      rows={slices.map((s) => ({
        key: s.key,
        cells: [s.key === "other" ? `Other (${s.description})` : s.label, formatCount(s.value), formatPercent(s.share)],
      }))}
      footer={["All outcomes", formatCount(total), total > 0 ? "100%" : formatPercent(null)]}
    />
  );
}
