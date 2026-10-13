import { UserCheck, UserPlus, UserRound, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { callerTypeMeta } from "@/lib/format";
import type { CallerType } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICONS: Record<CallerType, LucideIcon> = {
  existing: UserCheck,
  new: UserPlus,
  unknown: UserRound,
};

/**
 * Existing / New / Unknown, from call_interactions.caller_type (decided by the end-of-call writer:
 * an account match is existing, a new_customer contact is new). Icon plus word, never color
 * alone; unknown is muted so the two answers stand out.
 */
export function CallerTypeBadge({ type, className }: { type: string | null | undefined; className?: string }) {
  const meta = callerTypeMeta(type);
  const Icon = ICONS[meta.type];
  return (
    <Badge variant={meta.type === "unknown" ? "muted" : "neutral"} className={cn(className)} title={meta.description} data-caller-type={meta.type}>
      <Icon aria-hidden="true" />
      <span>
        <span className="sr-only">Caller type: </span>
        {meta.label}
      </span>
    </Badge>
  );
}
