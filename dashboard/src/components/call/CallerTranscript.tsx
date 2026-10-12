import { ArrowDown, MessageSquareDashed } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/format";
import type { CallerLine, VapiCallState } from "@/lib/vapi";
import { cn } from "@/lib/utils";

interface CallerTranscriptProps {
  finals: readonly CallerLine[];
  partial: VapiCallState["partial"];
  /** Shown when there is nothing yet. */
  emptyText: string;
  /** Keeps the full height while a call runs, so the first lines do not shift the page. */
  expanded?: boolean;
  className?: string;
}

// Within this distance of the bottom the reader counts as following the conversation.
const STICK_PX = 64;

/**
 * What this browser heard: committed final lines, then at most one in-progress line per role
 * that is replaced as the speech recognizer revises it. Only finals are announced to screen
 * readers; announcing every partial revision would be noise.
 */
export function CallerTranscript({ finals, partial, emptyText, expanded = false, className }: CallerTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else el.scrollTop = el.scrollHeight;
    following.current = true;
    setShowJump(false);
  }, []);

  const partialKey = `${partial.assistant ?? ""}|${partial.user ?? ""}`;
  useEffect(() => {
    if (following.current) scrollToEnd(false);
    else setShowJump(true);
  }, [finals.length, partialKey, scrollToEnd]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    following.current = atEnd;
    if (atEnd) setShowJump(false);
  };

  const partials = (["assistant", "user"] as const).filter((role) => partial[role]);
  const empty = finals.length === 0 && partials.length === 0;

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Your call transcript"
        aria-live="polite"
        aria-relevant="additions"
        className={cn(
          "overflow-y-auto overscroll-contain rounded-lg border bg-page outline-none focus-visible:ring-2 focus-visible:ring-ring",
          empty && !expanded ? "h-32" : "h-72 sm:h-80",
        )}
      >
        {empty ? (
          <p className="flex h-full items-center justify-center gap-2 px-6 text-center text-sm text-ink-2">
            <MessageSquareDashed className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
            {emptyText}
          </p>
        ) : (
          <ol className="flex flex-col gap-3 p-3">
            {finals.map((line) => (
              <Line key={line.id} role={line.role} text={line.text} stamp={formatStamp(line.at / 1000)} />
            ))}
            {partials.map((role) => (
              <Line key={`partial-${role}`} role={role} text={partial[role] ?? ""} stamp={null} partial />
            ))}
          </ol>
        )}
      </div>
      {showJump && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button size="sm" variant="secondary" className="pointer-events-auto shadow-pop" onClick={() => scrollToEnd(true)}>
            <ArrowDown aria-hidden="true" />
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

interface LineProps {
  role: "user" | "assistant";
  text: string;
  stamp: string | null;
  partial?: boolean;
}

function Line({ role, text, stamp, partial = false }: LineProps) {
  const agent = role === "assistant";
  return (
    <li
      className={cn("flex flex-col gap-1", agent ? "items-start pr-6 sm:pr-10" : "items-end pl-6 sm:pl-10")}
      data-role={role}
      data-partial={partial ? "true" : undefined}
      // A partial is replaced word by word; screen readers get the final line instead.
      aria-hidden={partial || undefined}
    >
      <p className={cn("flex items-baseline gap-2 px-1 text-xs", agent ? "flex-row" : "flex-row-reverse")}>
        <span className="font-medium text-ink-2">{agent ? "Tessa" : "You"}</span>
        {stamp ? <time className="tabular text-ink-3">{stamp}</time> : <span className="text-ink-3">speaking</span>}
      </p>
      <p
        className={cn(
          "max-w-full whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
          agent ? "rounded-tl-md bg-muted" : "rounded-tr-md bg-accent-wash",
          partial ? "border border-dashed border-border-strong text-ink-2" : "text-ink-1",
        )}
      >
        {text}
        {partial && <span className="ml-0.5 text-ink-3">…</span>}
      </p>
    </li>
  );
}
