import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  /** Tighter padding for use inside a card or table. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({ title, description, icon: Icon = Inbox, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14", className)}>
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-ink-3">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-semibold text-ink-1">{title}</p>
        {description && <div className="text-sm text-ink-2">{description}</div>}
      </div>
      {action}
    </div>
  );
}
