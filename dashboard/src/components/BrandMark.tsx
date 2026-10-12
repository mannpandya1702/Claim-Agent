import { cn } from "@/lib/utils";

/** Observe Insurance mark: a headset glyph on the primary tile. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M9 17.5c0-4.1 3.1-7.5 7-7.5s7 3.4 7 7.5" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
      <rect x="7.5" y="16" width="4" height="7" rx="2" fill="#fff" />
      <rect x="20.5" y="16" width="4" height="7" rx="2" fill="#fff" />
    </svg>
  );
}

export function BrandName({ className }: { className?: string }) {
  return (
    <span className={cn("flex flex-col leading-tight", className)}>
      <span className="text-sm font-semibold text-ink-1">Observe Insurance</span>
      <span className="text-xs text-ink-3">Claims assistant ops</span>
    </span>
  );
}
