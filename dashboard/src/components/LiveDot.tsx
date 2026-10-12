import { cn } from "@/lib/utils";

/** Pulsing marker for a call that is still in progress (ended_at is null). Decorative: pair it with text. */
export function LiveDot({ className, color = "var(--status-good)" }: { className?: string; color?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative inline-flex size-2 shrink-0", className)}>
      <span className="viz-mark absolute inline-flex size-full animate-live-pulse rounded-full" style={{ backgroundColor: color }} />
      <span className="viz-mark relative inline-flex size-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}
