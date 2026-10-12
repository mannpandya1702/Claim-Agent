import { Lock, Phone, ShieldCheck, ShieldQuestion, UserRound, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatTime, LEVEL_META } from "@/lib/format";
import type { Attempt, CallSession, Level } from "@/lib/types";
import { cn } from "@/lib/utils";

type StepState = "done" | "current" | "upcoming" | "verified" | "locked";

interface Step {
  key: string;
  label: string;
  icon: LucideIcon;
  state: StepState;
  at: string | null;
}

export interface IdentityFacts {
  level: Level;
  lookupMisses: number;
  dobMisses: number;
  phoneFoundAt: string | null;
  verifiedAt: string | null;
  lockedAt: string | null;
}

/** Level from call_sessions (the server's truth); counts and times from the attempts ledger. */
export function identityFacts(session: Pick<CallSession, "level"> | null | undefined, attempts: readonly Attempt[]): IdentityFacts {
  const first = (pred: (a: Attempt) => boolean) => attempts.find(pred)?.created_at ?? null;
  return {
    level: session?.level ?? "none",
    lookupMisses: attempts.filter((a) => a.kind === "lookup_miss").length,
    dobMisses: attempts.filter((a) => a.kind === "dob_wrong").length,
    phoneFoundAt: first((a) => a.kind === "lookup_hit"),
    verifiedAt: first((a) => a.kind === "dob_ok"),
    lockedAt: first((a) => a.kind === "dob_wrong" && a.code === "locked"),
  };
}

function stepsFor(f: IdentityFacts): Step[] {
  const { level } = f;
  const reachedPhone = level !== "none";
  return [
    { key: "none", label: "Not identified", icon: UserRound, state: level === "none" ? "current" : "done", at: null },
    {
      key: "phone_found",
      label: "Phone found",
      icon: Phone,
      state: level === "phone_found" ? "current" : reachedPhone ? "done" : "upcoming",
      at: f.phoneFoundAt,
    },
    level === "locked"
      ? { key: "locked", label: "Locked", icon: Lock, state: "locked", at: f.lockedAt }
      : { key: "verified", label: "Verified", icon: ShieldCheck, state: level === "verified" ? "verified" : "upcoming", at: f.verifiedAt },
  ];
}

const STATE_WORDS: Record<StepState, string> = {
  done: "done",
  current: "current step",
  upcoming: "not reached",
  verified: "reached",
  locked: "reached",
};

interface IdentityPathProps {
  session: Pick<CallSession, "level"> | null | undefined;
  attempts: readonly Attempt[];
  className?: string;
}

/**
 * none -> phone found -> verified (or locked). The level comes from call_sessions, so this shows
 * what the server decided, not what the model said.
 */
export function IdentityPath({ session, attempts, className }: IdentityPathProps) {
  const facts = identityFacts(session, attempts);
  const steps = stepsFor(facts);

  return (
    <div className={cn("space-y-3", className)} data-level={facts.level}>
      <ol aria-label="Identity path" className="grid grid-cols-3">
        {steps.map((step, i) => {
          const reached = step.state !== "upcoming";
          const nextReached = i < steps.length - 1 && steps[i + 1]!.state !== "upcoming";
          return (
            <li
              key={step.key}
              aria-current={step.state === "current" || step.state === "verified" || step.state === "locked" ? "step" : undefined}
              className="relative flex flex-col items-center gap-1.5 text-center"
              data-state={step.state}
            >
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn("absolute left-1/2 top-4 h-0.5 w-full -translate-y-1/2", nextReached ? "bg-primary" : "bg-border-strong")}
                />
              )}
              <StepNode step={step} />
              <span className={cn("px-1 text-xs font-medium leading-tight", reached ? "text-ink-1" : "text-ink-3", step.state === "verified" && "text-good-ink", step.state === "locked" && "text-critical-ink")}>
                {step.label}
                <span className="sr-only"> ({STATE_WORDS[step.state]})</span>
              </span>
              {step.at && <span className="text-[11px] tabular text-ink-3">{formatTime(step.at)}</span>}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-ink-2">
        {LEVEL_META[facts.level].description}.
        {facts.lookupMisses > 0 && ` ${facts.lookupMisses} phone ${facts.lookupMisses === 1 ? "lookup" : "lookups"} missed.`}
        {facts.dobMisses > 0 && ` ${facts.dobMisses} of 2 date-of-birth ${facts.dobMisses === 1 ? "miss" : "misses"}.`}
      </p>
    </div>
  );
}

function StepNode({ step }: { step: Step }) {
  const base = "relative z-10 flex size-8 items-center justify-center rounded-full";
  switch (step.state) {
    case "done":
      // The step's own icon, filled: a check beside "Not identified" would read as a contradiction.
      return (
        <span className={cn(base, "bg-primary text-primary-ink")}>
          <step.icon className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </span>
      );
    case "current":
      return (
        <span className={cn(base, "border-2 border-primary bg-card text-primary")}>
          <step.icon className="size-4" aria-hidden="true" />
        </span>
      );
    case "verified":
      return (
        <span className={cn(base, "bg-good text-white")}>
          <ShieldCheck className="size-4" aria-hidden="true" />
        </span>
      );
    case "locked":
      return (
        <span className={cn(base, "bg-critical text-white")}>
          <Lock className="size-4" aria-hidden="true" />
        </span>
      );
    default:
      return (
        <span className={cn(base, "border-2 border-border-strong bg-card text-ink-3")}>
          <step.icon className="size-4" aria-hidden="true" />
        </span>
      );
  }
}

/** Compact identity state for the call header: icon plus word, status color only for verified/locked. */
export function IdentityBadge({ level, className }: { level: Level | null | undefined; className?: string }) {
  const l = level ?? "none";
  if (l === "verified") {
    return (
      <Badge variant="good" className={className}>
        <ShieldCheck aria-hidden="true" />
        Verified
      </Badge>
    );
  }
  if (l === "locked") {
    return (
      <Badge variant="critical" className={className}>
        <Lock aria-hidden="true" />
        Locked
      </Badge>
    );
  }
  return (
    <Badge variant="muted" className={className}>
      <ShieldQuestion aria-hidden="true" />
      {l === "phone_found" ? "Phone found, not verified" : "Not verified"}
    </Badge>
  );
}
