import { CalendarRange, Pencil } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { customCaption, isDayKey, MAX_CUSTOM_DAYS, parseCustomDays, RANGE_PRESETS, type CustomDays, type RangePreset } from "@/lib/dates";
import { etDayKey } from "@/lib/format";
import { cn } from "@/lib/utils";

const CUSTOM = "custom";

interface DateRangeSelectProps<V extends string> {
  /** The selected preset, or "custom" with its days in `custom`. */
  value: V | typeof CUSTOM;
  custom: CustomDays | null;
  onPreset: (value: V) => void;
  onCustom: (days: CustomDays) => void;
  /** Preset rows; defaults to Today / 7 / 30 / 90 days. */
  options?: readonly { value: V; label: string }[];
  /** Classes for the trigger (its width in the filter row). */
  className?: string;
  /** Classes for the wrapper around the trigger and the edit button (its place in a grid). */
  containerClassName?: string;
}

/**
 * Date range (Eastern days): preset rows, then "Custom range…" behind a separator, which opens
 * two day fields. Sits first in a page's single filter row. While a custom range is active the
 * trigger shows its days and a pencil button reopens the fields (choosing the already-selected
 * row of a select fires no change).
 */
export function DateRangeSelect<V extends string = RangePreset>({
  value,
  custom,
  onPreset,
  onCustom,
  options = RANGE_PRESETS as unknown as readonly { value: V; label: string }[],
  className,
  containerClassName,
}: DateRangeSelectProps<V>) {
  const [editing, setEditing] = useState(false);
  const isCustom = value === CUSTOM && custom !== null;

  return (
    <div className={cn("flex min-w-0 items-center gap-1", containerClassName)}>
      <Select
        value={isCustom ? CUSTOM : value}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            // After the select has closed and handed focus back, so the dialog keeps it.
            setTimeout(() => setEditing(true), 0);
          } else {
            onPreset(v as V);
          }
        }}
      >
        <SelectTrigger
          aria-label="Date range"
          title={isCustom ? customCaption(custom) : undefined}
          className={cn(
            "w-[11.5rem] min-w-0 justify-start [&>span]:flex-1 [&>span]:text-left",
            isCustom && "border-border-strong bg-accent-wash",
            className,
          )}
        >
          <CalendarRange className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <SelectValue>{isCustom ? customCaption(custom) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>Custom range…</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && (
        <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Edit custom range" onClick={() => setEditing(true)}>
          <Pencil aria-hidden="true" />
        </Button>
      )}
      <CustomRangeDialog
        open={editing}
        onOpenChange={setEditing}
        initial={custom}
        onApply={(days) => {
          setEditing(false);
          onCustom(days);
        }}
      />
    </div>
  );
}

function lastWeek(): CustomDays {
  const today = etDayKey(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d! - 6));
  return { from: start.toISOString().slice(0, 10), to: today };
}

function CustomRangeDialog({
  open,
  onOpenChange,
  initial,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: CustomDays | null;
  onApply: (days: CustomDays) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const today = etDayKey(new Date());

  // Each opening starts from the range in use (or the last 7 days), never a stale draft.
  useEffect(() => {
    if (!open) return;
    const start = initial ?? lastWeek();
    setFrom(start.from);
    setTo(start.to);
    setError(null);
  }, [open, initial]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isDayKey(from) || !isDayKey(to)) {
      setError("Enter both days.");
      return;
    }
    const days = parseCustomDays(from, to);
    if (!days) {
      setError(`Pick ${MAX_CUSTOM_DAYS} days or fewer.`);
      return;
    }
    onApply(days);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Custom date range</DialogTitle>
          <DialogDescription>Eastern days, both included. Up to {MAX_CUSTOM_DAYS} days.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4" aria-describedby={error ? errorId : undefined}>
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={fromId}>From</Label>
              <Input
                id={fromId}
                type="date"
                value={from}
                max={to && to < today ? to : today}
                onChange={(e) => setFrom(e.target.value)}
                aria-invalid={error !== null || undefined}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={toId}>To</Label>
              <Input
                id={toId}
                type="date"
                value={to}
                min={from || undefined}
                max={today}
                onChange={(e) => setTo(e.target.value)}
                aria-invalid={error !== null || undefined}
                required
              />
            </div>
          </div>
          {error && (
            <p id={errorId} role="alert" className="text-sm text-critical-ink">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
