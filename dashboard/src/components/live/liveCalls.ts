import type { CallSummary } from "@/lib/queries";
import type { Attempt, Escalation } from "@/lib/types";

/*
 * Pure rules for the Live page. Live is ended_at is null (never the generated status column);
 * a call that has been "live" for longer than the reaper's cut-off is shown apart as possibly
 * stuck, with no streaming subscriptions, because its end-of-call report is not coming.
 */

/** Same cut-off as the reaper and ops_health.stuck_calls. */
export const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

/** fetchLiveCalls returns at most this many rows. */
export const LIVE_LIST_CAP = 50;

export function callStart(call: Pick<CallSummary, "started_at" | "created_at">): string {
  return call.started_at ?? call.created_at;
}

export function isStuck(call: Pick<CallSummary, "created_at">, now: Date): boolean {
  const t = Date.parse(call.created_at);
  return Number.isFinite(t) && now.getTime() - t > STUCK_AFTER_MS;
}

export function splitLiveCalls<T extends Pick<CallSummary, "created_at" | "ended_at">>(
  calls: readonly T[],
  now: Date,
): { active: T[]; stuck: T[] } {
  const active: T[] = [];
  const stuck: T[] = [];
  for (const c of calls) {
    if (c.ended_at !== null && c.ended_at !== undefined) continue;
    (isStuck(c, now) ? stuck : active).push(c);
  }
  return { active, stuck };
}

/**
 * Calls present in the previous live list and gone from the next one: their end-of-call report
 * set ended_at (or the reaper closed them). A full list is skipped, because a row can also fall
 * off the end of a capped page without ending.
 */
export function endedSince<T extends Pick<CallSummary, "vapi_call_id">>(prev: readonly T[] | undefined, next: readonly T[]): T[] {
  if (!prev || next.length >= LIVE_LIST_CAP) return [];
  const still = new Set(next.map((c) => c.vapi_call_id));
  return prev.filter((c) => !still.has(c.vapi_call_id));
}

/** The newest tool result, which says where the conversation is ("verify_identity: verified"). */
export function lastAttempt(attempts: readonly Attempt[]): Attempt | null {
  let last: Attempt | null = null;
  for (const a of attempts) {
    if (!last || Date.parse(a.created_at) >= Date.parse(last.created_at)) last = a;
  }
  return last;
}

export type EscalationTone = "critical" | "warning" | "neutral" | "good";

export interface EscalationBadgeInfo {
  tone: EscalationTone;
  label: string;
  emergency: boolean;
}

const STATUS_WORDS: Record<Escalation["status"], string> = { open: "open", claimed: "claimed", done: "done" };

/** One badge for a call's escalations; an emergency outranks a representative request. */
export function escalationBadge(escalations: readonly Escalation[]): EscalationBadgeInfo | null {
  if (escalations.length === 0) return null;
  const emergency = escalations.find((e) => e.kind === "emergency");
  if (emergency) {
    return { tone: "critical", label: emergency.status === "open" ? "Emergency" : `Emergency, ${STATUS_WORDS[emergency.status]}`, emergency: true };
  }
  const e = escalations[0]!;
  if (e.status === "open") return { tone: "warning", label: "Escalation open", emergency: false };
  if (e.status === "claimed") return { tone: "neutral", label: e.claimed_by ? `Claimed by ${e.claimed_by}` : "Escalation claimed", emergency: false };
  return { tone: "good", label: "Escalation done", emergency: false };
}
