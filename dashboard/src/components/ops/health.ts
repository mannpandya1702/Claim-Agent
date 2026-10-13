import type { StatusTone } from "@/components/KpiTile";
import type { DeliveryChannel, DeliveryGapRow, JobRun, OpsHealth } from "@/lib/types";

/*
 * Pure rules behind the Ops page, so the thresholds are testable with a fixed clock. Schedules
 * mirror 0004_automation.sql: sla every 10 minutes, reaper hourly at :07, digest daily at
 * 12:00 UTC (8 AM EDT, 7 AM EST), outbox every minute.
 */

export type JobName = "sla" | "digest" | "reaper" | "outbox";

export interface JobSpec {
  job: JobName;
  label: string;
  schedule: string;
  /** What the job does, in one line for the tile. */
  purpose: string;
  /** A last run at most this old is on schedule (one missed tick is tolerated). */
  okWithinMin: number;
  /** Older than ok but within this is late; beyond it the job has stopped. */
  lateWithinMin: number;
  healthKey: "last_sla_run" | "last_digest_run" | "last_reaper_run" | "last_outbox_run";
}

export const JOB_SPECS: readonly JobSpec[] = [
  {
    job: "sla",
    label: "SLA re-alert",
    schedule: "Every 10 minutes",
    purpose: "Re-pages escalations still open after 30 minutes",
    okWithinMin: 25,
    lateWithinMin: 60,
    healthKey: "last_sla_run",
  },
  {
    job: "reaper",
    label: "Reaper",
    schedule: "Hourly at :07",
    purpose: "Backfills or closes calls with no report after 2 hours",
    okWithinMin: 75,
    lateWithinMin: 180,
    healthKey: "last_reaper_run",
  },
  {
    job: "digest",
    label: "Daily digest",
    schedule: "Daily, 8 AM EDT / 7 AM EST",
    purpose: "Emails yesterday's numbers to the claims team",
    okWithinMin: 26 * 60,
    lateWithinMin: 50 * 60,
    healthKey: "last_digest_run",
  },
  {
    job: "outbox",
    label: "Outbox",
    schedule: "Every minute",
    purpose: "Delivers completed calls to the Airtable call log and GoHighLevel",
    okWithinMin: 5,
    lateWithinMin: 20,
    healthKey: "last_outbox_run",
  },
];

export const JOB_LABELS: Record<string, string> = Object.fromEntries(JOB_SPECS.map((s) => [s.job, s.label]));

export function jobLabel(job: string): string {
  return JOB_LABELS[job] ?? job;
}

export interface Health {
  tone: StatusTone;
  label: string;
}

function minutesSince(iso: string | null | undefined, now: Date): number | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 60_000);
}

/**
 * On schedule, late or stopped, from the last finished run. A job that never ran is a warning,
 * not critical: before the Vault secret is set nothing has broken yet, it was never started.
 */
export function jobHealth(lastRun: string | null | undefined, spec: JobSpec, now: Date): Health {
  const age = minutesSince(lastRun, now);
  if (age === null) return { tone: "warning", label: "No run recorded" };
  if (age <= spec.okWithinMin) return { tone: "good", label: "On schedule" };
  if (age <= spec.lateWithinMin) return { tone: "warning", label: "Running late" };
  return { tone: "critical", label: "Stopped: overdue" };
}

/** A count that should be zero: good at zero, `tone` with `label` above it. */
export function countHealth(n: number | null | undefined, tone: StatusTone, label: string, okLabel = "None"): Health {
  return (n ?? 0) > 0 ? { tone, label } : { tone: "good", label: okLabel };
}

export function toCount(n: unknown): number {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** bigint columns arrive as strings from PostgREST in some drivers; normalise once. */
export function normaliseHealth(h: OpsHealth): OpsHealth {
  return {
    ...h,
    open_escalations: toCount(h.open_escalations),
    sla_breaches: toCount(h.sla_breaches),
    alerts_failed_24h: toCount(h.alerts_failed_24h),
    emails_failed_24h: toCount(h.emails_failed_24h),
    emails_sent_24h: toCount(h.emails_sent_24h),
    stuck_calls: toCount(h.stuck_calls),
    analysis_missing_24h: toCount(h.analysis_missing_24h),
    // Present only once 0005_outbox.sql is applied; absent stays absent so the page can hide them.
    ...(h.outbox_pending !== undefined && {
      outbox_pending: toCount(h.outbox_pending),
      outbox_dead: toCount(h.outbox_dead),
      outbox_delivered_24h: toCount(h.outbox_delivered_24h),
    }),
    // GoHighLevel's counts arrive with 0008_ghl.sql, the same way.
    ...(h.ghl_pending !== undefined && {
      ghl_pending: toCount(h.ghl_pending),
      ghl_dead: toCount(h.ghl_dead),
      ghl_delivered_24h: toCount(h.ghl_delivered_24h),
    }),
  };
}

/** True when ops_health carries GoHighLevel's outbox columns (0008_ghl.sql). */
export function hasGhl(h: OpsHealth | null | undefined): h is OpsHealth & Required<Pick<OpsHealth, "ghl_pending" | "ghl_dead" | "ghl_delivered_24h">> {
  return !!h && h.ghl_pending !== undefined;
}

/** True when ops_health carries the outbox columns. */
export function hasOutbox(h: OpsHealth | null | undefined): h is OpsHealth & Required<Pick<OpsHealth, "outbox_pending" | "outbox_dead" | "outbox_delivered_24h">> {
  return !!h && h.outbox_pending !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Delivery gap (escalation_delivery_gap): alert rows are written before the transport hop, so
// owed minus delivered minus failed is what is still in flight.
// ---------------------------------------------------------------------------------------------

export type ChannelTone = "good" | "warning" | "critical" | "idle";

export interface ChannelHealth {
  channel: DeliveryChannel;
  label: string;
  owed: number;
  delivered: number;
  failed: number;
  pending: number;
  tone: ChannelTone;
  status: string;
  /** Owed something, delivered nothing, and at least one attempt failed: the channel is down. */
  dead: boolean;
}

export const CHANNEL_NAMES: Record<DeliveryChannel, string> = {
  telegram: "Telegram",
  email: "Email",
  airtable: "Airtable call log",
  ghl: "GoHighLevel CRM",
};

export const CHANNEL_FIX: Record<DeliveryChannel, string> = {
  telegram: "Check the bot token and chat id.",
  email: "Check the Resend key and the sender domain.",
  airtable: "Check the Airtable token, base id and table, and the outbox rows' last error.",
  ghl: "Check the GoHighLevel token and location id, and the outbox rows' last error.",
};

export function channelHealth(row: { channel: DeliveryChannel; owed: unknown; delivered: unknown; failed: unknown }): ChannelHealth {
  const owed = toCount(row.owed);
  const delivered = toCount(row.delivered);
  const failed = toCount(row.failed);
  const pending = Math.max(0, owed - delivered - failed);
  const base = { channel: row.channel, label: CHANNEL_NAMES[row.channel] ?? row.channel, owed, delivered, failed, pending };

  if (owed === 0) return { ...base, tone: "idle", status: "Nothing to deliver", dead: false };
  if (delivered === 0 && failed > 0) return { ...base, tone: "critical", status: "Channel down: nothing delivered", dead: true };
  if (failed > 0) return { ...base, tone: "critical", status: `${failed} failed`, dead: false };
  if (pending > 0) return { ...base, tone: "warning", status: `${pending} not delivered yet`, dead: false };
  return { ...base, tone: "good", status: "All delivered", dead: false };
}

/**
 * The Airtable call log from the outbox counts in ops_health: delivered in the last 24 hours,
 * still queued (pending), and given up after the attempt cap (failed). Queued and given-up rows
 * are counted whatever their age, since they are still owed.
 */
export function airtableChannel(h: OpsHealth | null | undefined): ChannelHealth | null {
  if (!hasOutbox(h)) return null;
  const delivered = toCount(h.outbox_delivered_24h);
  const failed = toCount(h.outbox_dead);
  const pending = toCount(h.outbox_pending);
  return channelHealth({ channel: "airtable", owed: delivered + failed + pending, delivered, failed });
}

/** GoHighLevel from its own outbox counts, counted the same way as the Airtable call log. */
export function ghlChannel(h: OpsHealth | null | undefined): ChannelHealth | null {
  if (!hasGhl(h)) return null;
  const delivered = toCount(h.ghl_delivered_24h);
  const failed = toCount(h.ghl_dead);
  const pending = toCount(h.ghl_pending);
  return channelHealth({ channel: "ghl", owed: delivered + failed + pending, delivered, failed });
}

/**
 * Telegram and email in a fixed order, so a channel with no row still shows as "nothing to
 * deliver", then each outbox destination once ops_health carries its counts.
 */
export function deliveryChannels(rows: readonly DeliveryGapRow[], health?: OpsHealth | null): ChannelHealth[] {
  const alerts = (["telegram", "email"] as const).map((channel) =>
    channelHealth(rows.find((r) => r.channel === channel) ?? { channel, owed: 0, delivered: 0, failed: 0 }),
  );
  const outbox = [airtableChannel(health), ghlChannel(health)].filter((c): c is ChannelHealth => c !== null);
  return [...alerts, ...outbox];
}

// ---------------------------------------------------------------------------------------------
// Job runs
// ---------------------------------------------------------------------------------------------

/** A run with no finished_at after this long did not finish (the Edge Function wall clock is far shorter). */
export const RUN_TIMEOUT_MIN = 15;

export type RunState = "finished" | "running" | "unfinished";

export function runState(run: Pick<JobRun, "started_at" | "finished_at">, now: Date): RunState {
  if (run.finished_at) return "finished";
  const age = minutesSince(run.started_at, now);
  return age !== null && age < RUN_TIMEOUT_MIN ? "running" : "unfinished";
}

/** Wall time of a finished run: "850 ms", "4.2 s", "3 min". */
export function runDuration(run: Pick<JobRun, "started_at" | "finished_at">): string | null {
  if (!run.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  return null;
}

/**
 * The first few scalar fields of a job result as "key value" pairs ("realerted 2 · skipped 0").
 * Results are the job's own counts (no caller data), shown as written.
 */
export function summariseResult(result: unknown, max = 4): { parts: string[]; more: boolean } {
  if (result === null || result === undefined) return { parts: [], more: false };
  if (typeof result !== "object" || Array.isArray(result)) {
    const s = scalar(result);
    return { parts: s ? [s] : [], more: s === null };
  }
  const entries = Object.entries(result as Record<string, unknown>);
  const parts: string[] = [];
  let skipped = 0;
  for (const [key, value] of entries) {
    const s = scalar(value);
    if (s === null) {
      skipped++;
      continue;
    }
    if (parts.length < max) parts.push(`${key.replace(/_/g, " ")} ${s}`);
    else skipped++;
  }
  return { parts, more: skipped > 0 };
}
