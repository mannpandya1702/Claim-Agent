import { TriangleAlert } from "lucide-react";
import { useId } from "react";
import type { CallMode, CallModeInfo } from "@/lib/vapi";
import { cn } from "@/lib/utils";

interface ModeSwitchProps {
  modes: readonly CallModeInfo[];
  value: CallMode;
  onChange: (mode: CallMode) => void;
  /** True while a call is connecting or live: the mode is fixed for that call. */
  locked: boolean;
  className?: string;
}

/**
 * Native radios styled as a segmented control, so arrow keys, focus and the checked state come
 * from the browser. The choice lives in ?mode= (the page owns the URL), which makes a mode
 * shareable as a link.
 */
export function ModeSwitch({ modes, value, onChange, locked, className }: ModeSwitchProps) {
  const name = useId();
  const descriptionId = useId();
  const selected = modes.find((m) => m.mode === value) ?? modes[0];

  return (
    <fieldset disabled={locked} className={cn("min-w-0 space-y-2", className)} aria-describedby={descriptionId}>
      <legend className="mb-2 text-xs font-medium text-ink-2">
        Assistant
        {locked && <span className="font-normal text-ink-3"> (fixed until this call ends)</span>}
      </legend>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {modes.map((m) => {
          const checked = m.mode === value;
          return (
            <label
              key={m.mode}
              className={cn(
                "relative flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-center text-[13px] font-medium leading-tight transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-muted",
                checked ? "bg-card text-ink-1 shadow-card" : "text-ink-2 hover:bg-hover hover:text-ink-1",
                locked && "cursor-not-allowed",
                locked && !checked && "text-ink-3 hover:bg-transparent hover:text-ink-3",
              )}
              data-mode={m.mode}
            >
              <input
                type="radio"
                name={name}
                value={m.mode}
                checked={checked}
                onChange={() => onChange(m.mode)}
                className="sr-only"
              />
              <span>{m.label}</span>
              {!m.targetId && (
                <>
                  <TriangleAlert className="size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
                  <span className="sr-only">(not configured)</span>
                </>
              )}
            </label>
          );
        })}
      </div>
      {selected && (
        <p id={descriptionId} className="text-xs text-ink-2">
          <span className="font-medium text-ink-1">{selected.label}:</span> {selected.description}{" "}
          <span className="font-mono text-[11px] text-ink-3">?mode={selected.mode}</span>
        </p>
      )}
    </fieldset>
  );
}
