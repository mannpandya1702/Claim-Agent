import { TriangleAlert } from "lucide-react";
import { badgeVariants } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { flagMeta } from "@/lib/format";
import { cn } from "@/lib/utils";

interface FlagChipProps {
  flag: string;
  /** Icon only (tables); the label moves into the tooltip and the accessible name. */
  compact?: boolean;
  className?: string;
}

/** A post-call flag: warning icon plus label, with the plain-English explanation on hover and focus. */
export function FlagChip({ flag, compact = false, className }: FlagChipProps) {
  const meta = flagMeta(flag);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="note"
            aria-label={`Flag: ${meta.label}. ${meta.explanation}`}
            className={cn(
              badgeVariants({ variant: "warning" }),
              "cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring",
              compact && "px-1.5",
              className,
            )}
            data-flag={flag}
          >
            <TriangleAlert aria-hidden="true" />
            {!compact && <span className="truncate">{meta.label}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-semibold">{meta.label}</p>
          <p className="mt-0.5 opacity-90">{meta.explanation}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
