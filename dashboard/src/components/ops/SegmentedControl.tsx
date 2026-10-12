import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Optional count shown after the label. */
  count?: number | null;
}

interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group ("Filter by job"). */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * A row of toggle buttons for one filter dimension (aria-pressed marks the choice). Used where a
 * select would hide three or four short options behind a click.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-muted p-1", className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-card text-ink-1 shadow-card" : "text-ink-2 hover:text-ink-1",
            )}
          >
            {opt.label}
            {opt.count !== undefined && opt.count !== null && <span className="tabular text-ink-3">{opt.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
