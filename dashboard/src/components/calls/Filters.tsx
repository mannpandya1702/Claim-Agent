import { LifeBuoy, Search, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DateRangeSelect } from "@/components/DateRangeSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { channelLabel, OUTCOME_META, SENTIMENT_META } from "@/lib/format";
import { OUTCOMES, SENTIMENTS, type Outcome, type Sentiment } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CHANNEL_FILTERS, hasActiveFilters, RANGE_OPTIONS, type CallFilters } from "./callFilters";
import { useDebouncedCallback } from "./hooks";

export const SEARCH_DEBOUNCE_MS = 300;

// Radix Select reserves the empty string, so "no filter" travels as this sentinel.
const ANY = "any";

interface FiltersProps {
  value: CallFilters;
  /** Every change resets to the first page; the caller merges the patch into the URL. */
  onChange: (patch: Partial<CallFilters>) => void;
  onReset: () => void;
  className?: string;
}

/**
 * One filter row above the table: search (debounced), then date range first among the filters,
 * then outcome, sentiment, channel and the two toggles. Wraps to a two-column grid on phones.
 */
export function Filters({ value, onChange, onReset, className }: FiltersProps) {
  return (
    <div role="search" aria-label="Filter calls" className={cn("grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center", className)}>
      <SearchBox value={value.q} onSearch={(q) => onChange({ q })} />
      <DateRangeSelect
        value={value.range}
        custom={value.custom}
        options={RANGE_OPTIONS}
        onPreset={(range) => onChange({ range, custom: null })}
        onCustom={(custom) => onChange({ range: "custom", custom })}
        className="w-auto flex-1 sm:w-[11.5rem] sm:flex-none"
        // A full row on phones, so a custom range's two days are readable.
        containerClassName="col-span-2 sm:col-span-1"
      />
      <FilterSelect<Outcome>
        label="Outcome"
        value={value.outcome}
        anyLabel="All outcomes"
        onChange={(outcome) => onChange({ outcome })}
        options={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_META[o].label, swatch: OUTCOME_META[o].color }))}
        className="sm:w-[9.5rem]"
      />
      <FilterSelect<Sentiment>
        label="Sentiment"
        value={value.sentiment}
        anyLabel="All sentiment"
        onChange={(sentiment) => onChange({ sentiment })}
        options={SENTIMENTS.map((s) => ({ value: s, label: SENTIMENT_META[s].label, swatch: SENTIMENT_META[s].color }))}
        className="sm:w-[9rem]"
      />
      <FilterSelect<string>
        label="Channel"
        value={value.channel}
        anyLabel="All channels"
        onChange={(channel) => onChange({ channel })}
        options={CHANNEL_FILTERS.map((c) => ({ value: c, label: channelLabel(c) }))}
        className="sm:w-[9rem]"
      />
      <ToggleChip icon={TriangleAlert} pressed={value.flagged} onToggle={() => onChange({ flagged: !value.flagged })}>
        Flagged only
      </ToggleChip>
      <ToggleChip icon={LifeBuoy} pressed={value.escalated} onToggle={() => onChange({ escalated: !value.escalated })}>
        Escalated only
      </ToggleChip>
      {hasActiveFilters(value) && (
        <Button variant="ghost" size="sm" onClick={onReset} className="col-span-2 h-9 justify-self-start sm:col-span-1">
          <X aria-hidden="true" />
          Clear filters
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(value);
  // The last value this box sent, so a URL change made elsewhere (a deep link, Clear filters)
  // refills the box while our own echo does not clobber what the user is still typing.
  const emitted = useRef(value);
  const debounced = useDebouncedCallback((q: string) => {
    emitted.current = q;
    onSearch(q);
  }, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      debounced.cancel();
      setText(value);
    }
  }, [value, debounced]);

  const flush = (q: string) => {
    debounced.cancel();
    emitted.current = q.trim();
    onSearch(q.trim());
  };

  return (
    <div className="relative col-span-2 w-full sm:w-80 sm:shrink-0">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
      <Input
        type="search"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          debounced.run(e.target.value.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") flush(text);
          if (e.key === "Escape" && text) {
            e.preventDefault();
            setText("");
            flush("");
          }
        }}
        placeholder="Search transcripts, names, call id"
        aria-label="Search calls"
        className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
        autoComplete="off"
        spellCheck={false}
      />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText("");
            flush("");
          }}
          className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 outline-none hover:bg-hover hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Clear search"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

interface Option<T extends string> {
  value: T;
  label: string;
  /** Identity dot beside the label (the label itself stays in ink). */
  swatch?: string;
}

interface FilterSelectProps<T extends string> {
  label: string;
  value: T | null;
  onChange: (value: T | null) => void;
  options: Option<T>[];
  /** Adds an "any" row; omit when one of the options is always selected. */
  anyLabel?: string;
  className?: string;
}

function FilterSelect<T extends string>({ label, value, onChange, options, anyLabel, className }: FilterSelectProps<T>) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? null : (v as T))}>
      <SelectTrigger
        aria-label={label}
        className={cn("w-full justify-start [&>span]:flex-1 [&>span]:text-left", value !== null && anyLabel && "border-border-strong bg-accent-wash", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {anyLabel && <SelectItem value={ANY}>{anyLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="flex items-center gap-2">
              {o.swatch && <span aria-hidden="true" className="viz-mark size-2 shrink-0 rounded-full" style={{ backgroundColor: o.swatch }} />}
              {o.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ToggleChip({ pressed, onToggle, icon: Icon, children }: { pressed: boolean; onToggle: () => void; icon: LucideIcon; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-page",
        pressed ? "border-primary bg-accent-wash text-ink-1" : "border-input bg-card text-ink-2 hover:bg-hover hover:text-ink-1",
      )}
    >
      <Icon className={cn("size-4 shrink-0", pressed ? "text-primary" : "text-ink-3")} aria-hidden="true" />
      {children}
    </button>
  );
}
