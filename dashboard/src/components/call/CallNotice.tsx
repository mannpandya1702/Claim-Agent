import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NoticeTone = "critical" | "warning" | "info";

const TONES: Record<NoticeTone, { icon: LucideIcon; box: string; ink: string }> = {
  critical: {
    icon: OctagonAlert,
    box: "bg-[color-mix(in_oklab,var(--status-critical)_10%,var(--card))] border-[color-mix(in_oklab,var(--status-critical)_35%,var(--card))]",
    ink: "text-critical-ink",
  },
  warning: {
    icon: TriangleAlert,
    box: "bg-[color-mix(in_oklab,var(--status-warning)_14%,var(--card))] border-[color-mix(in_oklab,var(--status-warning)_45%,var(--card))]",
    ink: "text-warning-ink",
  },
  info: { icon: Info, box: "bg-muted border-border", ink: "text-ink-2" },
};

interface CallNoticeProps {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  /** "alert" interrupts (failures after a click); "status" is announced politely (config, hints). */
  role?: "alert" | "status";
  action?: ReactNode;
  className?: string;
}

/** Inline message inside the call card. Status color always comes with an icon and a title. */
export function CallNotice({ tone, title, children, role = "status", action, className }: CallNoticeProps) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div role={role} className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm", t.box, className)} data-tone={tone}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", t.ink)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className={cn("font-semibold", t.ink)}>{title}</p>
        {children && <div className="break-words text-ink-1">{children}</div>}
        {action && <div className="pt-1.5">{action}</div>}
      </div>
    </div>
  );
}
