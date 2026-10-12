import { DASH, formatCount, formatPercent } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, LegendSwatch } from "./ChartCard";
import type { SentimentMix as Mix } from "./metrics";

/*
 * Sentiment is an ordered scale, so it is a diverging stacked bar (negative pole, neutral gray,
 * positive pole) rather than categorical slices. One 100% bar, 24px thick, 4px rounded ends and
 * a 2px surface gap between segments. Calls without a sentiment yet are counted beside the bar,
 * never drawn in it, because their gray would read as "neutral".
 */

function Segment({ seg }: { seg: Mix["segments"][number] }) {
  const text = `${seg.label}: ${formatCount(seg.value)} ${seg.value === 1 ? "call" : "calls"}, ${formatPercent(seg.share)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={text}
          className="viz-mark h-full min-w-[3px] outline-none transition-[filter] first:rounded-l-[4px] last:rounded-r-[4px] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          style={{ flexGrow: seg.value, flexBasis: 0, backgroundColor: seg.color }}
          data-sentiment={seg.key}
        />
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

export function SentimentBar({ mix }: { mix: Mix }) {
  const present = mix.segments.filter((s) => s.value > 0);
  return (
    <figure className="space-y-4">
      <figcaption className="sr-only">
        {`Sentiment of ${formatCount(mix.rated)} rated calls: ` +
          mix.segments.map((s) => `${s.label.toLowerCase()} ${formatPercent(s.share)}`).join(", ") +
          "."}
      </figcaption>
      <TooltipProvider delayDuration={100}>
        <div className="flex h-6 w-full gap-[2px]">
          {present.map((s) => (
            <Segment key={s.key} seg={s} />
          ))}
        </div>
      </TooltipProvider>
      <ul className="grid grid-cols-3 gap-2" aria-label="Sentiment">
        {mix.segments.map((s) => (
          <li key={s.key} className="min-w-0 space-y-0.5">
            <span className="flex items-center gap-1.5 text-xs text-ink-2">
              <LegendSwatch color={s.color} />
              {s.label}
            </span>
            <span className="block text-lg font-semibold leading-tight text-ink-1">{formatPercent(s.share)}</span>
            <span className="block text-xs text-ink-3">
              {formatCount(s.value)} {s.value === 1 ? "call" : "calls"}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function SentimentTable({ mix }: { mix: Mix }) {
  return (
    <DataTable
      caption="Calls by sentiment"
      columns={[
        { key: "sentiment", label: "Sentiment" },
        { key: "calls", label: "Calls", numeric: true },
        { key: "share", label: "Share of rated", numeric: true },
      ]}
      rows={[
        ...mix.segments.map((s) => ({ key: s.key, cells: [s.label, formatCount(s.value), formatPercent(s.share)] })),
        { key: "unrated", cells: ["Not rated yet", formatCount(mix.unrated), DASH] },
      ]}
      footer={["All calls", formatCount(mix.rated + mix.unrated), ""]}
    />
  );
}

export function unratedNote(mix: Mix): string | null {
  if (mix.unrated === 0) return null;
  return `${formatCount(mix.unrated)} ${mix.unrated === 1 ? "call has" : "calls have"} no sentiment yet (in progress or awaiting analysis).`;
}
