import { cn } from "@/lib/utils";

interface SpeakingIndicatorProps {
  who: string;
  speaking: boolean;
  /** Word shown while not speaking ("Listening" for Ava, "Quiet" for the caller). */
  idleWord: string;
  /** False when there is no live call: the row reads "Idle" behind a dashed edge. */
  connected: boolean;
  className?: string;
}

// Bar heights at rest and the stagger of the animation, so the bars move out of phase.
const BARS = [
  { rest: "h-1", delay: "0ms" },
  { rest: "h-1.5", delay: "160ms" },
  { rest: "h-1", delay: "320ms" },
  { rest: "h-1.5", delay: "80ms" },
];

/**
 * Who is talking right now. Ava's state comes from the SDK's speech-start/speech-end events;
 * the caller's from an open partial transcript. The word carries the meaning; the bars only
 * reinforce it (and stop moving under prefers-reduced-motion).
 */
export function SpeakingIndicator({ who, speaking, idleWord, connected, className }: SpeakingIndicatorProps) {
  const word = !connected ? "Idle" : speaking ? "Speaking" : idleWord;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors",
        speaking && connected ? "border-primary/40 bg-accent-wash" : "bg-card",
        // Dimmed by a dashed edge, not opacity, so the words keep their contrast.
        !connected && "border-dashed",
        className,
      )}
      data-speaking={speaking && connected ? "true" : "false"}
    >
      <span aria-hidden="true" className="flex h-4 w-5 shrink-0 items-center justify-center gap-[3px]">
        {BARS.map((bar, i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] rounded-full transition-[height,background-color] duration-200",
              speaking && connected ? "animate-[speaking-bar_900ms_ease-in-out_infinite] bg-primary" : cn(bar.rest, "bg-border-strong"),
            )}
            style={speaking && connected ? { animationDelay: bar.delay, height: "0.875rem" } : undefined}
          />
        ))}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-xs text-ink-3">{who}</span>
        <span className={cn("truncate text-sm", speaking && connected ? "font-semibold text-ink-1" : "text-ink-2")}>{word}</span>
      </span>
    </div>
  );
}

// Defined here rather than in index.css, which belongs to the shared scaffold.
const SPEAKING_KEYFRAMES = `@keyframes speaking-bar { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }`;

interface SpeakingPairProps {
  assistantSpeaking: boolean;
  callerSpeaking: boolean;
  connected: boolean;
  className?: string;
}

/** Ava and the caller side by side, with the bar keyframes emitted once. */
export function SpeakingPair({ assistantSpeaking, callerSpeaking, connected, className }: SpeakingPairProps) {
  return (
    <div role="group" aria-label="Who is speaking" className={cn("grid grid-cols-2 gap-2", className)}>
      <style>{SPEAKING_KEYFRAMES}</style>
      <SpeakingIndicator who="Ava" speaking={assistantSpeaking} idleWord="Listening" connected={connected} />
      <SpeakingIndicator who="You" speaking={callerSpeaking} idleWord="Quiet" connected={connected} />
    </div>
  );
}
