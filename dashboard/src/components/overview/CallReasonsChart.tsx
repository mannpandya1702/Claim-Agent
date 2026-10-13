import { DASH, formatCount, formatPercent } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable } from "./ChartCard";
import type { ReasonMix, ReasonRow } from "./metrics";

/*
 * Top call reasons as horizontal bars: one measure across named categories, so one hue (the
 * accent, series 1) and no legend box; the title names the measure. Bars are 16px thick, square
 * at the baseline and rounded 4px at the data end, all growing from one hairline baseline and
 * scaled to the largest reason. Every count and share is printed beside its bar, so the bar
 * never carries a value alone; the whole track is the hover and focus target, wider than the mark.
 */

const BAR = "var(--series-1)";
/** A non-zero bar never shrinks below this, so a single call is still a visible mark. */
const MIN_BAR_PX = 3;

function callsWord(n: number): string {
  return n === 1 ? "call" : "calls";
}

function ReasonBar({ row, max }: { row: ReasonRow; max: number }) {
  const text = `${row.label}: ${formatCount(row.value)} ${callsWord(row.value)}, ${formatPercent(row.share)} of tagged calls`;
  const width = max > 0 ? (row.value / max) * 100 : 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={text}
          className="flex h-6 min-w-0 items-center border-l border-[var(--chart-axis)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          <span
            className="viz-mark block h-4 rounded-r-[4px] transition-[width,filter] duration-300 hover:brightness-110"
            style={{ width: `${width}%`, minWidth: MIN_BAR_PX, backgroundColor: BAR }}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">{text}</p>
        <p className="opacity-80">{row.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function CallReasonBars({ mix }: { mix: ReasonMix }) {
  const max = mix.rows.reduce((m, r) => Math.max(m, r.value), 0);
  const summary =
    `Top call reasons of ${formatCount(mix.tagged)} tagged ${callsWord(mix.tagged)}: ` +
    mix.rows.map((r) => `${r.label} ${formatCount(r.value)} (${formatPercent(r.share)})`).join(", ") +
    ".";
  return (
    <figure className="space-y-3">
      <figcaption className="sr-only">{summary}</figcaption>
      <TooltipProvider delayDuration={100}>
        <ul className="space-y-1.5" aria-label="Call reasons">
          {mix.rows.map((r) => (
            <li
              key={r.key}
              className="grid grid-cols-[minmax(5.5rem,9rem)_minmax(0,1fr)_4.75rem] items-center gap-x-3 text-sm"
              data-call-reason={r.key}
            >
              <span className="truncate text-ink-2" title={r.description}>
                {r.label}
              </span>
              <ReasonBar row={r} max={max} />
              <span className="flex items-baseline justify-end gap-1.5">
                <span className="tabular font-medium text-ink-1">{formatCount(r.value)}</span>
                <span className="tabular w-9 text-right text-xs text-ink-3">{formatPercent(r.share)}</span>
              </span>
            </li>
          ))}
        </ul>
      </TooltipProvider>
      {mix.untagged !== null && mix.untagged > 0 && (
        <p className="text-xs text-ink-3">
          {formatCount(mix.untagged)} {mix.untagged === 1 ? "call has" : "calls have"} no reason yet (in progress or not tagged).
        </p>
      )}
    </figure>
  );
}

/** Every reason with its count and share, plus the calls still without one. */
export function CallReasonTable({ mix }: { mix: ReasonMix }) {
  const rows = mix.rows.map((r) => ({ key: r.key, cells: [r.label, formatCount(r.value), formatPercent(r.share)] }));
  if (mix.untagged !== null) rows.push({ key: "untagged", cells: ["No reason yet", formatCount(mix.untagged), DASH] });
  return (
    <DataTable
      caption="Calls by reason"
      columns={[
        { key: "reason", label: "Reason" },
        { key: "calls", label: "Calls", numeric: true },
        { key: "share", label: "Share of tagged", numeric: true },
      ]}
      rows={rows}
      footer={mix.untagged !== null ? ["All calls", formatCount(mix.tagged + mix.untagged), ""] : ["Tagged calls", formatCount(mix.tagged), ""]}
    />
  );
}
