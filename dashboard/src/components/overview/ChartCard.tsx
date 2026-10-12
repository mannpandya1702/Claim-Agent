import { ChartColumn, Table2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

interface ChartCardProps {
  title: string;
  description?: ReactNode;
  /** The chart, legend included. */
  chart: ReactNode;
  /** The table twin of the chart: every value without hovering or seeing color. */
  table: ReactNode;
  /** Replaces both views (loading, empty, error); the view toggle hides while it shows. */
  state?: ReactNode;
  /** Previous data shown while a new range loads: hold the frame, dim it, no skeleton flash. */
  stale?: boolean;
  className?: string;
}

/** A titled card that holds one chart and its table view behind a Chart / Table toggle. */
export function ChartCard({ title, description, chart, table, state, stale = false, className }: ChartCardProps) {
  const headingId = useId();
  const [view, setView] = useState<"chart" | "table">("chart");

  return (
    <Card className={cn("flex min-w-0 flex-col", className)}>
      <section aria-labelledby={headingId} className="flex min-w-0 flex-1 flex-col">
        <Tabs value={view} onValueChange={(v) => setView(v as "chart" | "table")} className="flex flex-1 flex-col">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4 pb-0 sm:p-5 sm:pb-0">
            <div className="min-w-0 space-y-0.5">
              <h2 id={headingId} className="text-sm font-semibold leading-tight text-ink-1">
                {title}
              </h2>
              {description && <div className="text-xs text-ink-3">{description}</div>}
            </div>
            {!state && (
              <TabsList aria-label={`${title}: view as`} className="h-8">
                <TabsTrigger value="chart" className="px-2 py-0.5 text-xs">
                  <ChartColumn aria-hidden="true" />
                  Chart
                </TabsTrigger>
                <TabsTrigger value="table" className="px-2 py-0.5 text-xs">
                  <Table2 aria-hidden="true" />
                  Table
                </TabsTrigger>
              </TabsList>
            )}
          </div>
          <div
            className={cn("flex min-w-0 flex-1 flex-col p-4 pt-3 transition-opacity sm:p-5 sm:pt-4", stale && "opacity-60")}
            aria-busy={stale || undefined}
          >
            {state ?? (
              <>
                <TabsContent value="chart" className="mt-0 min-w-0 flex-1">
                  {chart}
                </TabsContent>
                <TabsContent value="table" className="mt-0 min-w-0 flex-1">
                  {table}
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>
      </section>
    </Card>
  );
}

/** Shared markup for the chart tables: compact, numbers right-aligned in tabular figures. */
export function DataTable({
  caption,
  columns,
  rows,
  footer,
}: {
  caption: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: { key: string; cells: ReactNode[] }[];
  footer?: ReactNode[];
}) {
  return (
    // Focusable because it can scroll: keyboard users need to reach the rows past the fold.
    <div className="max-h-80 overflow-auto rounded-lg border" tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-muted text-xs text-ink-2">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn("px-3 py-2 font-medium whitespace-nowrap", c.numeric ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t">
              {r.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap text-ink-1">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn("px-3 py-1.5 whitespace-nowrap", columns[i]?.numeric ? "tabular text-right text-ink-1" : "text-ink-2")}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot className="border-t-2 border-border-strong font-medium">
            <tr>
              {footer.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-3 py-1.5 text-left text-ink-1">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn("px-3 py-1.5", columns[i]?.numeric ? "tabular text-right text-ink-1" : "text-ink-2")}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Legend row item: a swatch shaped like the mark (rect for bars and slices) and a label in ink. */
export function LegendSwatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn("viz-mark inline-block size-2.5 shrink-0 rounded-[3px]", className)} style={{ backgroundColor: color }} />;
}
