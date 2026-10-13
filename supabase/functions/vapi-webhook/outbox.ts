// Delivery of outbox_events to the Airtable call log (0005_outbox.sql) and to GoHighLevel
// (0008_ghl.sql, ghl.ts). Each destination has its own loop. The every-minute outbox job runs
// Airtable first with its share of the run, then GoHighLevel with the rest, each stopping at its own
// first failure, so an outage or a refused token at one never holds up the other. The fast path the
// post-call writer starts off the request path right after it queues a completed call takes only
// that call's Airtable row and leaves the backlog to the job; GoHighLevel's row waits 90 s first.
// Delivery is capped at-least-once: a claim spends an attempt before the request is made, Airtable
// merges on the call id so a repeat is an update, GoHighLevel records each step in the row's progress
// so a repeat redoes only what is missing, and the payload is read fresh at delivery time, so a
// re-armed row carries whatever the record holds by then. Every write to a row (a claim, a progress
// save, a failed delivery, a re-arm) starts a lease (store_rules.ts): two runners never deliver one
// row at once, and a delivery that started before a re-arm has finished before the re-armed version
// is read. A destination without its configuration never has a row claimed.

import { airtableConfigured, interactionToFields, upsertCallRecord } from "./airtable.ts";
import type { OutboxDestination } from "./enums.ts";
import { deliverGhl, GHL_DELAY_S, ghlConfigured } from "./ghl.ts";
import { redactPII } from "./redact.ts";
import { OUTBOX_MAX_ATTEMPTS, outboxErrorText } from "./store_rules.ts";
import type { Deps, Env, OutboxFinish, OutboxRef, OutboxRow } from "./types.ts";

/** Airtable's own timeout for one upsert; a delivery never gets more than the run has left. */
const AIRTABLE_TIMEOUT_MS = 5000;
/** A delivery is started only with at least this much of the run left: one Airtable upsert, or the
 *  first few GoHighLevel steps (a GoHighLevel delivery cut short pauses and resumes next run). */
const MIN_DELIVERY_MS: Readonly<Record<OutboxDestination, number>> = { airtable: 1500, ghl: 2500 };
/** Airtable's part of the job's run when GoHighLevel is on too; GoHighLevel gets the rest. */
const AIRTABLE_SHARE = 0.5;
/** The fast path after an end-of-call report: one row, well inside the isolate's lifetime. */
export const FAST_PATH_DEADLINE_MS = 4000;
/** Upper bound for one job run even when every delivery is instant. */
const JOB_MAX_ROWS = 50;
const MAX_LOG_ERROR = 300;

export interface OutboxCounts {
  delivered: number;
  retried: number; // a retryable failure with attempts left: the row stays pending
  dead: number; // given up: not retryable, the record is gone, or the last attempt failed
  errors: number; // a store read or write failed mid-delivery; the row stays pending
  paused?: number; // GoHighLevel: the run's deadline came between steps; the attempt was given back
  skipped?: string;
  // The destination refused the token, its scopes, or (Airtable) the base or table: the run stopped
  // and the row's attempt was given back, so nothing is lost while the setting is wrong.
  config_error?: string;
}

export interface DeliverOptions {
  deadlineMs: number;
  maxRows?: number;
  ref?: OutboxRef; // only this row: the fast path's own call
  destination?: OutboxDestination; // without a ref: whose rows (default airtable)
}

/** Whether the destination has what its delivery needs; without it its rows wait, unclaimed. */
export function destinationConfigured(env: Env, destination: OutboxDestination): boolean {
  return destination === "ghl" ? ghlConfigured(env) : airtableConfigured(env);
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown";
  return redactPII(text.slice(0, 1000)).slice(0, MAX_LOG_ERROR);
}

function safeLog(deps: Deps, event: Record<string, unknown>): void {
  try {
    deps.log(event);
  } catch {
    // a logging fault must never change what is delivered
  }
}

async function enqueueTo(
  deps: Deps,
  callKey: string,
  destination: OutboxDestination,
  delayS: number,
  source: string,
): Promise<boolean> {
  try {
    await deps.store.enqueueOutbox("interaction.completed", callKey, destination, delayS);
    return true;
  } catch (e) {
    safeLog(deps, { event: "outbox_enqueue_failed", call_key: callKey, destination, source, error: errorText(e) });
    return false;
  }
}

/** Queues the call's stored record for the call log (enqueue_outbox re-arms a delivered row), and,
 *  when GoHighLevel is configured, for GoHighLevel 90 s out (a re-arm moves that wait again and
 *  keeps the row's progress, so a re-delivery adds nothing GHL already has). Returns whether the
 *  call-log row is queued. Never throws: a failed enqueue is logged and must not fail the request
 *  that wrote the record; the reaper's hourly sweep (jobs.ts) queues any ended call the call log is
 *  missing (and GoHighLevel any it has no row for), and the backfill's re-arm gives GoHighLevel's row a
 *  second chance. */
export async function enqueueInteraction(deps: Deps, callKey: string, source: string): Promise<boolean> {
  const queued = await enqueueTo(deps, callKey, "airtable", 0, source);
  if (ghlConfigured(deps.env)) await enqueueTo(deps, callKey, "ghl", GHL_DELAY_S, source);
  return queued;
}

/** The reaper's sweep for a call one destination is missing: queues that destination's row only (the
 *  other already has its own), GoHighLevel with its usual delay. Returns whether it is queued. */
export async function enqueueGap(deps: Deps, callKey: string, destination: OutboxDestination): Promise<boolean> {
  return await enqueueTo(deps, callKey, destination, destination === "ghl" ? GHL_DELAY_S : 0, "sweep");
}

type Delivery = "delivered" | "retried" | "dead" | "config" | "paused" | "superseded";

async function deliverOne(
  deps: Deps,
  row: OutboxRow,
  deadline: number,
): Promise<{ outcome: Delivery; error?: string }> {
  const { store } = deps;
  // The claim's attempts and write time guard every write: after a re-arm or a re-claim the newer
  // state wins over this delivery's outcome. A GoHighLevel delivery's progress saves move the write
  // time, so it hands back the time of its last save.
  const finish = async (
    result: Omit<OutboxFinish, "attempt" | "claimedAt">,
    outcome: Delivery,
    claimedAt = row.updated_at,
  ) => ({
    outcome: await store.finishOutbox(row.id, { ...result, attempt: row.attempts, claimedAt })
      ? outcome
      : "superseded" as const,
    error: result.error ?? undefined,
  });
  // The claim already spent this attempt; with none left the row is as given up as a dead one.
  const spent = (): Delivery => row.attempts >= OUTBOX_MAX_ATTEMPTS ? "dead" : "retried";

  if (row.kind !== "interaction.completed" || !(row.destination === "airtable" || row.destination === "ghl")) {
    return await finish({ delivered: false, error: "unsupported event", dead: true }, "dead");
  }
  if (row.destination === "ghl") {
    const { result: r, claimedAt } = await deliverGhl(deps, row, deadline);
    switch (r.outcome) {
      case "delivered":
        return await finish({ delivered: true, externalId: r.externalId }, "delivered", claimedAt);
      case "retry":
        return await finish({ delivered: false, error: r.error, retryAfterS: r.retryAfterS }, spent(), claimedAt);
      case "dead":
        return await finish({ delivered: false, error: r.error, dead: true }, "dead", claimedAt);
      case "config":
        return await finish({ delivered: false, error: r.error, refund: true }, "config", claimedAt);
      case "paused":
        return await finish({ delivered: false, error: r.error, refund: true }, "paused", claimedAt);
      case "superseded":
        return { outcome: "superseded" };
    }
  }
  const timeoutMs = Math.max(Math.min(AIRTABLE_TIMEOUT_MS, deadline - deps.now().getTime()), 1);
  const record = await store.getInteractionForMirror(row.ref_id);
  if (!record) return await finish({ delivered: false, error: "record missing", dead: true }, "dead");

  const res = await upsertCallRecord(deps, interactionToFields(record, deps.now(), deps.env.DASHBOARD_URL), timeoutMs);
  if (res.ok) return await finish({ delivered: true, externalId: res.recordId }, "delivered");
  if (res.config) return await finish({ delivered: false, error: res.error, refund: true }, "config");
  if (!res.retryable) return await finish({ delivered: false, error: res.error, dead: true }, "dead");
  return await finish({ delivered: false, error: res.error }, spent());
}

/** Claims and delivers one row of one destination at a time until none is due, maxRows are done
 *  or the deadline (measured on deps.now) is near; with options.ref, only that row. Stops after the
 *  first delivery that did not finish: the next row would most likely meet the same rate limit,
 *  outage or configuration error, and each claim spends an attempt. Throws only when the first
 *  claim fails. */
export async function deliverOutbox(deps: Deps, options: DeliverOptions): Promise<OutboxCounts> {
  const counts: OutboxCounts = { delivered: 0, retried: 0, dead: 0, errors: 0 };
  const destination = options.ref?.destination ?? options.destination ?? "airtable";
  // Without its configuration the destination's rows wait, unclaimed, with their attempts intact.
  if (!destinationConfigured(deps.env, destination)) return { ...counts, skipped: `${destination} not configured` };
  const deadline = deps.now().getTime() + options.deadlineMs;
  const maxRows = options.ref ? 1 : options.maxRows ?? JOB_MAX_ROWS;

  for (let done = 0; done < maxRows; done++) {
    const left = deadline - deps.now().getTime();
    if (left < MIN_DELIVERY_MS[destination]) break;
    let row: OutboxRow | undefined;
    try {
      [row] = await deps.store.claimOutbox(1, options.ref, destination);
    } catch (e) {
      // Nothing done yet: the run itself failed. Later on, the deliveries already made are kept.
      if (done === 0) throw e;
      counts.errors++;
      safeLog(deps, { event: "outbox_error", step: "claimOutbox", error: errorText(e) });
      break;
    }
    if (!row) break;
    let delivery: { outcome: Delivery; error?: string };
    try {
      delivery = await deliverOne(deps, row, deadline);
    } catch (e) {
      // The attempt is spent and the row stays pending; the claim's lease holds it until then.
      counts.errors++;
      safeLog(deps, { event: "outbox_error", outbox_id: row.id, call_key: row.ref_id, error: errorText(e) });
      break;
    }
    const { outcome } = delivery;
    if (outcome === "superseded") {
      // A re-arm (or a claim after the lease) came in between: the row is another runner's now.
      safeLog(deps, { event: "outbox_superseded", outbox_id: row.id, call_key: row.ref_id });
      break;
    }
    if (outcome === "config") {
      // Masked like last_error: the run's result is stored in job_runs, which staff can read.
      counts.config_error = outboxErrorText(delivery.error);
      safeLog(deps, {
        event: "outbox_paused",
        outbox_id: row.id,
        call_key: row.ref_id,
        destination,
        error: counts.config_error,
      });
      break;
    }
    if (outcome === "paused") {
      // The run's time is up; the row resumes at its next step on the next run.
      counts.paused = (counts.paused ?? 0) + 1;
      break;
    }
    counts[outcome]++;
    if (outcome !== "delivered") {
      safeLog(deps, {
        event: "outbox_failed",
        outbox_id: row.id,
        call_key: row.ref_id,
        outcome,
        attempts: row.attempts,
      });
      break;
    }
  }
  return counts;
}

export interface OutboxRun {
  airtable: OutboxCounts;
  ghl?: OutboxCounts; // only when GoHighLevel is configured
}

/** The every-minute job's run: Airtable's loop first, with its share of the deadline when
 *  GoHighLevel is on, then GoHighLevel's loop until the deadline. A loop whose first claim fails is
 *  counted as an error and the other still runs; the run throws only when every loop that ran
 *  failed that way (nothing was done at all). */
export async function deliverOutboxRun(deps: Deps, deadlineMs: number): Promise<OutboxRun> {
  const start = deps.now().getTime();
  const ghlOn = ghlConfigured(deps.env);
  const failures: unknown[] = [];
  let ran = 0;
  const loop = async (destination: OutboxDestination, ms: number): Promise<OutboxCounts> => {
    try {
      const counts = await deliverOutbox(deps, { deadlineMs: ms, destination });
      if (!counts.skipped) ran++;
      return counts;
    } catch (e) {
      ran++;
      failures.push(e);
      safeLog(deps, { event: "outbox_error", destination, step: "claimOutbox", error: errorText(e) });
      return { delivered: 0, retried: 0, dead: 0, errors: 1 };
    }
  };
  const airtable = await loop("airtable", ghlOn ? Math.round(deadlineMs * AIRTABLE_SHARE) : deadlineMs);
  const ghl = ghlOn ? await loop("ghl", start + deadlineMs - deps.now().getTime()) : undefined;
  if (ran > 0 && failures.length === ran) throw failures[0];
  return ghl ? { airtable, ghl } : { airtable };
}

/** The post-call fast path: one try at the call's own Airtable row, off the request path. Never
 *  throws; the every-minute job retries whatever it leaves behind. */
export async function deliverSoon(deps: Deps, callKey: string): Promise<void> {
  try {
    const counts = await deliverOutbox(deps, {
      deadlineMs: FAST_PATH_DEADLINE_MS,
      ref: { kind: "interaction.completed", refId: callKey, destination: "airtable" },
    });
    safeLog(deps, { event: "outbox_fast_path", call_key: callKey, ...counts });
  } catch (e) {
    safeLog(deps, { event: "outbox_fast_path_failed", call_key: callKey, error: errorText(e) });
  }
}
