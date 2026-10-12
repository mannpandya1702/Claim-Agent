import { useState } from "react";
import { formatMoney, formatPercent, NA } from "@/lib/format";
import type { CostBreakdown as CostBreakdownData } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * Part-to-whole: one thin stacked bar plus a table that is always visible. The parts take the
 * categorical slots in their validated order (adjacent pairs pass the CVD and normal-vision
 * checks in both modes); light-mode slots 3-5 sit under 3:1 on the card, which the visible
 * table covers. Text stays in ink; the swatch beside it carries identity.
 */
export const COST_PARTS = [
  { key: "stt", label: "Speech to text", color: "var(--series-1)" },
  { key: "llm", label: "Language model", color: "var(--series-2)" },
  { key: "tts", label: "Text to speech", color: "var(--series-3)" },
  { key: "vapi", label: "VAPI platform", color: "var(--series-4)" },
  { key: "transport", label: "Transport", color: "var(--series-5)" },
  { key: "analysis", label: "Post-call analysis", color: "var(--series-6)" },
] as const;

type PartKey = (typeof COST_PARTS)[number]["key"];

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export interface CostPart {
  key: PartKey;
  label: string;
  color: string;
  value: number | null;
}

/** Parts in slot order. Analysis is listed only when the report had it (it is optional). */
export function costParts(breakdown: CostBreakdownData | null | undefined): CostPart[] {
  if (!breakdown || typeof breakdown !== "object") return [];
  return COST_PARTS.filter((p) => p.key !== "analysis" || num(breakdown.analysis) !== null).map((p) => ({
    ...p,
    value: num(breakdown[p.key]),
  }));
}

interface CostBreakdownProps {
  /** call_interactions.cost (USD); null prints "n/a", never $0. */
  cost: number | string | null | undefined;
  breakdown: CostBreakdownData | null | undefined;
  className?: string;
}

export function CostBreakdown({ cost, breakdown, className }: CostBreakdownProps) {
  const [active, setActive] = useState<PartKey | null>(null);
  const parts = costParts(breakdown);
  const total = num(cost) ?? num(breakdown?.total);
  const drawn = parts.filter((p) => p.value !== null && p.value > 0);
  const sum = drawn.reduce((acc, p) => acc + (p.value ?? 0), 0);

  if (parts.length === 0 || parts.every((p) => p.value === null)) {
    return (
      <div className={cn("space-y-1", className)}>
        <p className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-ink-2">Total</span>
          <span className="font-medium tabular text-ink-1">{formatMoney(total)}</span>
        </p>
        <p className="text-xs text-ink-3">Split by STT, LLM, TTS, VAPI and transport: {NA}.</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)} onMouseLeave={() => setActive(null)}>
      {sum > 0 && (
        <div aria-hidden="true" className="flex h-2.5 w-full gap-[2px]">
          {drawn.map((p, i) => (
            <span
              key={p.key}
              onMouseEnter={() => setActive(p.key)}
              className={cn(
                "h-full min-w-[3px] transition-opacity",
                i === 0 && "rounded-l",
                i === drawn.length - 1 && "rounded-r",
                active && active !== p.key && "opacity-30",
              )}
              // Shares, not raw dollars: flex-grow values summing below 1 fill only that fraction.
              style={{ flexGrow: ((p.value ?? 0) / sum) * 100, flexBasis: 0, backgroundColor: p.color }}
            />
          ))}
        </div>
      )}
      <table className="w-full text-sm">
        <caption className="sr-only">Cost by component, in US dollars</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Component</th>
            <th scope="col">Cost</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr
              key={p.key}
              onMouseEnter={() => setActive(p.key)}
              className={cn("transition-colors", active === p.key && "bg-hover/60")}
              data-part={p.key}
            >
              <th scope="row" className="py-1 pr-2 text-left font-normal text-ink-2">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: p.color }} />
                  {p.label}
                </span>
              </th>
              <td className="py-1 text-right tabular text-ink-1">{p.value === null ? NA : formatMoney(p.value, { digits: 4 })}</td>
              <td className="w-14 py-1 pl-2 text-right text-xs tabular text-ink-3">
                {p.value !== null && sum > 0 ? formatPercent(p.value / sum) : ""}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t">
            <th scope="row" className="pt-2 text-left font-medium text-ink-1">
              Total
            </th>
            <td className="pt-2 text-right font-medium tabular text-ink-1">{formatMoney(total, { digits: 4 })}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
