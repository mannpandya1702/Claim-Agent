import { CalendarRange } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RANGE_PRESETS, type RangePreset } from "@/lib/dates";
import { cn } from "@/lib/utils";

interface DateRangeSelectProps {
  value: RangePreset;
  onChange: (value: RangePreset) => void;
  className?: string;
}

/** Preset date range (Eastern days). Sits first in a page's single filter row. */
export function DateRangeSelect({ value, onChange, className }: DateRangeSelectProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as RangePreset)}>
      <SelectTrigger className={cn("w-[11.5rem]", className)} aria-label="Date range">
        {/* flex! because the trigger's [&>span]:line-clamp-1 (display: -webkit-box) outranks plain flex. */}
        <span className="flex! items-center gap-2">
          <CalendarRange className="size-4 text-ink-3" aria-hidden="true" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {RANGE_PRESETS.map((p) => (
          <SelectItem key={p.value} value={p.value}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
