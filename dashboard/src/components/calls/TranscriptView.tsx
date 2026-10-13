import { ArrowDown, Wrench } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { Bubble, ToolChip, TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

interface TranscriptViewProps {
  items: readonly TranscriptItem[];
  /** Live calls follow new lines (unless the reader scrolled up) and announce them politely. */
  live?: boolean;
  /** Shown when there are no items. */
  empty?: ReactNode;
  /** The log scrolls inside this height so the cards below it stay in view during a call. */
  maxHeightClass?: string;
  className?: string;
}

// Within this distance of the bottom the reader counts as "following" the conversation.
const STICK_PX = 72;

/** "lookup_customer: needs_dob", or just the tool name when the result had no code. */
export function chipLabel(chip: Pick<ToolChip, "tool" | "code">): string {
  return chip.code ? `${chip.tool}: ${chip.code}` : chip.tool;
}

/**
 * The conversation as chat bubbles with mm:ss stamps, and tool results as chips in between.
 * Ava sits on the left, the caller on the right. The same view renders live transcript_lines
 * and the stored messages; the page decides which source it passes in.
 */
export function TranscriptView({ items, live = false, empty, maxHeightClass = "max-h-[34rem]", className }: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    return atEnd;
  }, []);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else el.scrollTop = el.scrollHeight;
    following.current = true;
    setShowJump(false);
  }, []);

  // Start a live call at the newest line; a finished call opens at the greeting.
  useLayoutEffect(() => {
    if (live) scrollToEnd(false);
    // Only when the mode flips: new lines are handled below.
  }, [live, scrollToEnd]);

  // Live lines from one speaker less than 3 s apart merge into the last bubble, which then grows
  // without the item count changing, so follow on a content signature, not the length.
  const last = items[items.length - 1];
  const contentSig = `${items.length}:${last && last.kind === "bubble" ? last.text.length : 0}`;
  useEffect(() => {
    if (live) {
      if (following.current) scrollToEnd(false);
      else setShowJump(true);
    }
    measure();
  }, [contentSig, live, scrollToEnd, measure]);

  const onScroll = () => {
    const atEnd = measure();
    following.current = atEnd;
    if (atEnd) setShowJump(false);
  };

  if (items.length === 0) {
    return <div className={className}>{empty}</div>;
  }

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        role={live ? "log" : "region"}
        aria-label={live ? "Live transcript" : "Conversation"}
        aria-live={live ? "polite" : undefined}
        aria-relevant={live ? "additions text" : undefined}
        className={cn("overflow-y-auto overscroll-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring", maxHeightClass)}
      >
        <ol className="flex flex-col gap-3 px-1 py-2 sm:px-2">
          {items.map((item) => (item.kind === "tool" ? <ChipRow key={item.key} chip={item} /> : <BubbleRow key={item.key} bubble={item} />))}
        </ol>
      </div>
      {/* A fade says the log continues below its fold; the scrollbar alone is hidden on many systems. */}
      {moreBelow && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-lg bg-linear-to-t from-card to-transparent" />}
      {live && showJump && (
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

function BubbleRow({ bubble }: { bubble: Bubble }) {
  const agent = bubble.speaker === "agent";
  const who = agent ? (bubble.name ? `Ava · ${bubble.name}` : "Ava") : "Caller";
  return (
    <li
      className={cn("flex flex-col gap-1", agent ? "items-start pr-6 sm:pr-12" : "items-end pl-6 sm:pl-12")}
      data-kind="bubble"
      data-speaker={bubble.speaker}
    >
      <p className={cn("flex items-baseline gap-2 px-1 text-xs", agent ? "flex-row" : "flex-row-reverse")}>
        <span className="font-medium text-ink-2">{who}</span>
        <time className="tabular text-ink-3">
          {bubble.stamp}
        </time>
      </p>
      <p
        className={cn(
          "max-w-full whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed text-ink-1",
          agent ? "rounded-tl-md bg-muted" : "rounded-tr-md bg-accent-wash",
        )}
      >
        {bubble.text}
      </p>
    </li>
  );
}

function ChipRow({ chip }: { chip: ToolChip }) {
  return (
    <li className="flex items-center justify-center gap-2" data-kind="tool" data-tool={chip.tool}>
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 font-mono text-xs text-ink-2">
        <Wrench className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="sr-only">Tool result </span>
        <span className="truncate">{chipLabel(chip)}</span>
      </span>
      <time className="text-xs tabular text-ink-3">
        {chip.stamp}
      </time>
    </li>
  );
}
