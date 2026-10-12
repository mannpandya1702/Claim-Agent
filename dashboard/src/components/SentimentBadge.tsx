import { Badge } from "@/components/ui/badge";
import { sentimentMeta } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Sentiment as a word with its diverging-scale dot; a missing value reads "n/a", never a guess. */
export function SentimentBadge({ sentiment, className }: { sentiment: string | null | undefined; className?: string }) {
  const meta = sentimentMeta(sentiment);
  const missing = !sentiment || meta.label === "n/a";
  return (
    <Badge variant={missing ? "muted" : "neutral"} className={cn(className)} aria-label={`Sentiment: ${meta.label}`}>
      {!missing && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />}
      <span>{meta.label}</span>
    </Badge>
  );
}
