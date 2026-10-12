import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { formatCount, formatDayKey, OUTCOME_META } from "@/lib/format";
import { DataTable, LegendSwatch } from "./ChartCard";
import type { DailySeries, DayRow, OutcomeKey } from "./metrics";

/*
 * Calls per Eastern day, stacked by outcome. Mark specs from the dataviz method: columns at most
 * 24px, a 4px rounded data-end on the top segment only (square at the baseline), a 2px surface
 * gap between stacked segments, hairline solid grid, one axis. Segments stack in OUTCOME_ORDER
 * so each outcome keeps its slot color whatever the range contains; when an outcome is missing,
 * non-adjacent slots touch, so the gap, legend, tooltip and table carry identity, not hue alone.
 */

const SEGMENT_GAP = 2;
const DATA_END_RADIUS = 4;
const CHART_HEIGHT = 260;

interface SegmentProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: DayRow;
}

function segmentShape(outcome: OutcomeKey, peakDay: string | null) {
  return function Segment({ x = 0, y = 0, width = 0, height = 0, fill, payload }: SegmentProps) {
    if (!payload || height <= 0 || width <= 0) return <g />;
    const isTop = payload.top === outcome;
    const isBottom = payload.bottom === outcome;
    // The gap sits under every segment except the one on the baseline.
    const h = isBottom ? height : height - SEGMENT_GAP;
    if (h <= 0) return <g />;
    const r = isTop ? Math.min(DATA_END_RADIUS, width / 2, h) : 0;
    const d =
      r > 0
        ? `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + width - r}A${r},${r} 0 0 1 ${x + width},${y + r}V${y + h}Z`
        : `M${x},${y + h}V${y}H${x + width}V${y + h}Z`;
    return (
      <g>
        <path d={d} fill={fill} />
        {isTop && payload.day === peakDay && (
          // Selective direct label: only the busiest day carries its total on the cap.
          <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ink-2)" data-peak-label="">
            {formatCount(payload.total)}
          </text>
        )}
      </g>
    );
  };
}

function DayTooltip({ active, payload, label, outcomes }: TooltipProps<number, string> & { outcomes: OutcomeKey[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as DayRow | undefined;
  if (!row) return null;
  return (
    <div className="min-w-40 rounded-md bg-card px-3 py-2 text-xs shadow-pop">
      <p className="mb-1.5 font-medium text-ink-2">{formatDayKey(String(label ?? row.day))}</p>
      <ul className="space-y-1">
        {/* Top of the stack first, so the readout reads in the same order as the column. */}
        {[...outcomes].reverse().map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: OUTCOME_META[k].color }} />
            <span className={row[k] > 0 ? "tabular font-semibold text-ink-1" : "tabular text-ink-3"}>{formatCount(row[k])}</span>
            <span className="text-ink-2">{OUTCOME_META[k].label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 flex items-center gap-2 border-t pt-1.5">
        <span className="tabular font-semibold text-ink-1">{formatCount(row.total)}</span>
        <span className="text-ink-2">{row.total === 1 ? "call" : "calls"}</span>
      </p>
    </div>
  );
}

export function CallsPerDayLegend({ series }: { series: DailySeries }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Outcomes">
      {series.outcomes.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <LegendSwatch color={OUTCOME_META[k].color} />
          <span className="text-ink-2">{OUTCOME_META[k].label}</span>
          <span className="tabular font-medium text-ink-1">{formatCount(series.totals[k])}</span>
        </li>
      ))}
    </ul>
  );
}

export function CallsPerDayChart({ series }: { series: DailySeries }) {
  const peakDay = series.peak?.day ?? null;
  const first = series.rows[0]?.day;
  const last = series.rows[series.rows.length - 1]?.day;
  const summary =
    `Calls per day from ${first ? formatDayKey(first) : ""} to ${last ? formatDayKey(last) : ""}: ` +
    `${formatCount(series.total)} in total` +
    (series.peak ? `, busiest ${formatDayKey(series.peak.day)} with ${formatCount(series.peak.total)}.` : ".") +
    " The table view lists every day.";

  return (
    <figure className="space-y-3">
      <figcaption className="sr-only">{summary}</figcaption>
      <CallsPerDayLegend series={series} />
      <div style={{ height: CHART_HEIGHT }} className="min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series.rows} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%" accessibilityLayer>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
            <XAxis
              dataKey="day"
              tickFormatter={(d: string) => formatDayKey(d)}
              tickLine={false}
              axisLine={{ stroke: "var(--chart-axis)" }}
              tick={{ fill: "var(--chart-label)", fontSize: 12 }}
              interval="preserveStartEnd"
              minTickGap={16}
              tickMargin={8}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={36}
              tick={{ fill: "var(--chart-label)", fontSize: 12, className: "tabular" }}
              tickFormatter={(v: number) => formatCount(v)}
            />
            <Tooltip
              cursor={{ fill: "var(--hover)", opacity: 0.7 }}
              content={<DayTooltip outcomes={series.outcomes} />}
              isAnimationActive={false}
              wrapperStyle={{ outline: "none", zIndex: 10 }}
            />
            {series.outcomes.map((k) => (
              <Bar
                key={k}
                dataKey={k}
                name={OUTCOME_META[k].label}
                stackId="calls"
                fill={OUTCOME_META[k].color}
                maxBarSize={24}
                isAnimationActive={false}
                shape={segmentShape(k, peakDay)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function CallsPerDayTable({ series }: { series: DailySeries }) {
  return (
    <DataTable
      caption="Calls per Eastern day by outcome"
      columns={[
        { key: "day", label: "Day (ET)" },
        ...series.outcomes.map((k) => ({ key: k, label: OUTCOME_META[k].label, numeric: true })),
        { key: "total", label: "Total", numeric: true },
      ]}
      // Newest first: the day a supervisor checks most is today.
      rows={[...series.rows].reverse().map((r) => ({
        key: r.day,
        cells: [formatDayKey(r.day), ...series.outcomes.map((k) => formatCount(r[k])), formatCount(r.total)],
      }))}
      footer={["All days", ...series.outcomes.map((k) => formatCount(series.totals[k])), formatCount(series.total)]}
    />
  );
}
