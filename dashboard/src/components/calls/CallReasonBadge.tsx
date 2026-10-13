import {
  CircleEllipsis,
  CircleQuestionMark,
  FilePlus,
  FileSearch,
  Files,
  Headset,
  Siren,
  UserPen,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CALL_REASON_SOURCE_LABELS, callReasonMeta } from "@/lib/format";
import type { CallReason, CallReasonSource } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICONS: Record<CallReason, LucideIcon> = {
  claim_status: FileSearch,
  file_claim: FilePlus,
  documents: Files,
  general_question: CircleQuestionMark,
  speak_to_agent: Headset,
  update_details: UserPen,
  emergency: Siren,
  other: CircleEllipsis,
};

/**
 * Why the caller called (call_interactions.call_reason): icon plus words, never color alone, and
 * neutral for every reason so it never competes with the outcome and emergency badges. Renders
 * nothing when the call has no reason yet; the caller decides what to show in its place.
 */
export function CallReasonBadge({
  reason,
  source,
  className,
}: {
  reason: string | null | undefined;
  source?: CallReasonSource | string | null;
  className?: string;
}) {
  const meta = callReasonMeta(reason);
  if (!meta) return null;
  const Icon = ICONS[meta.reason as CallReason] ?? CircleEllipsis;
  const from = source ? CALL_REASON_SOURCE_LABELS[source as CallReasonSource] : undefined;
  return (
    <Badge variant="neutral" className={cn(className)} title={from ? `${meta.description} (${from})` : meta.description} data-call-reason={meta.reason}>
      <Icon aria-hidden="true" />
      <span>
        <span className="sr-only">Call reason: </span>
        {meta.label}
      </span>
    </Badge>
  );
}
