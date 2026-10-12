import { isSlaBreached } from "@/components/calls/EscalationCard";
import { DASH, ESCALATION_STATUS_LABELS, minutesBetween } from "@/lib/format";
import type { EscalationKind, EscalationListRow, EscalationStatus } from "@/lib/types";

/*
 * Pure queue rules (tab and filter parsing, the open-queue summary). The SLA rule itself is
 * isSlaBreached from EscalationCard, so the badge on a card and the count above the list can
 * never disagree.
 */

export type QueueTab = EscalationStatus;
export type KindFilter = "all" | EscalationKind;

export const QUEUE_TABS: readonly { value: QueueTab; label: string }[] = (["open", "claimed", "done"] as const).map(
  (value) => ({ value, label: ESCALATION_STATUS_LABELS[value] }),
);

export function parseTab(value: string | null | undefined): QueueTab {
  return value === "claimed" || value === "done" ? value : "open";
}

export function parseKind(value: string | null | undefined): KindFilter {
  return value === "representative" || value === "emergency" ? value : "all";
}

export interface OpenSummary {
  open: number;
  breached: number;
  /** Minutes the oldest open escalation has waited; null when the queue is empty. */
  oldestMinutes: number | null;
  oldestAt: string | null;
  emergencies: number;
}

export function summariseOpen(rows: readonly EscalationListRow[], now: Date): OpenSummary {
  const open = rows.filter((r) => r.status === "open");
  let oldest: EscalationListRow | null = null;
  for (const r of open) {
    if (!oldest || Date.parse(r.created_at) < Date.parse(oldest.created_at)) oldest = r;
  }
  return {
    open: open.length,
    breached: open.filter((r) => isSlaBreached(r, now)).length,
    oldestMinutes: oldest ? minutesBetween(oldest.created_at, now) : null,
    oldestAt: oldest?.created_at ?? null,
    emergencies: open.filter((r) => r.kind === "emergency").length,
  };
}

/** 7 -> "7 min", 75 -> "1 h 15 min", 1500 -> "1 d 1 h". */
export function formatWait(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return DASH;
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** Rows for the current tab and kind. Status is re-checked client-side, so a row a Claim just moved leaves at once. */
export function visibleRows<T extends EscalationListRow>(rows: readonly T[], tab: QueueTab, kind: KindFilter): T[] {
  return rows.filter((r) => r.status === tab && (kind === "all" || r.kind === kind));
}

/** Sorted, de-duplicated call keys: a stable query key for the emails of the rows on screen. */
export function callKeysOf(rows: readonly Pick<EscalationListRow, "call_key">[]): string[] {
  return [...new Set(rows.map((r) => r.call_key))].sort();
}
