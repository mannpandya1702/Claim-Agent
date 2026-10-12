// Delivery of outbox_events to the Airtable call log (0005_outbox.sql). One loop serves both
// callers: the every-minute outbox job, which works through the queue, and the fast path the
// post-call writer starts off the request path right after it queues a completed call, which takes
// only that call's row and leaves the backlog to the job. Delivery is capped at-least-once: a claim
// spends an attempt before the request is made, Airtable merges on the call id so a repeat is an
// update, and the payload is read fresh from call_interactions at delivery time, so a re-armed row
// carries whatever the record holds by then. Every write to a row (a claim, a failed delivery, a
// re-arm) starts a lease (store_rules.ts): two runners never deliver one row at once, and a
// delivery that started before a re-arm has finished before the re-armed version is read.

import { airtableConfigured, interactionToFields, upsertCallRecord } from "./airtable.ts";
import { redactPII } from "./redact.ts";
import { OUTBOX_MAX_ATTEMPTS, outboxErrorText } from "./store_rules.ts";
import type { Deps, OutboxFinish, OutboxRef, OutboxRow } from "./types.ts";

/** Airtable's own timeout for one upsert; a delivery never gets more than the run has left. */
const AIRTABLE_TIMEOUT_MS = 5000;
/** A delivery is started only with at least this much of the run left. */
const MIN_DELIVERY_MS = 1500;
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
  skipped?: string;
  // Airtable refused the token, its scopes, or the base or table: the run stopped and the row's
  // attempt was given back, so nothing is lost while the setting is wrong.
  config_error?: string;
}

export interface DeliverOptions {
  deadlineMs: number;
  maxRows?: number;
  ref?: OutboxRef; // only this row: the fast path's own call
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

/** Queues the call's stored record for the call log (enqueue_outbox re-arms a delivered row).
 *  Never throws: a failed enqueue is logged and must not fail the request that wrote the record;
 *  the reaper's hourly sweep (jobs.ts) queues any ended call the outbox is missing. */
export async function enqueueInteraction(deps: Deps, callKey: string, source: string): Promise<boolean> {
  try {
    await deps.store.enqueueOutbox("interaction.completed", callKey, "airtable");
    return true;
  } catch (e) {
    safeLog(deps, { event: "outbox_enqueue_failed", call_key: callKey, source, error: errorText(e) });
    return false;
  }
}

type Delivery = "delivered" | "retried" | "dead" | "config" | "superseded";

async function deliverOne(
  deps: Deps,
  row: OutboxRow,
  timeoutMs: number,
): Promise<{ outcome: Delivery; error?: string }> {
  const { store } = deps;
  // The claim's attempts and write time guard every write: after a re-arm or a re-claim the newer
  // state wins over this delivery's outcome.
  const finish = async (result: Omit<OutboxFinish, "attempt" | "claimedAt">, outcome: Delivery) => ({
    outcome: await store.finishOutbox(row.id, { ...result, attempt: row.attempts, claimedAt: row.updated_at })
      ? outcome
      : "superseded" as const,
    error: result.error ?? undefined,
  });

  if (row.kind !== "interaction.completed" || row.destination !== "airtable") {
    return await finish({ delivered: false, error: "unsupported event", dead: true }, "dead");
  }
  const record = await store.getInteractionForMirror(row.ref_id);
  if (!record) return await finish({ delivered: false, error: "record missing", dead: true }, "dead");

  const res = await upsertCallRecord(deps, interactionToFields(record, deps.now(), deps.env.DASHBOARD_URL), timeoutMs);
  if (res.ok) return await finish({ delivered: true, externalId: res.recordId }, "delivered");
  if (res.config) return await finish({ delivered: false, error: res.error, refund: true }, "config");
  if (!res.retryable) return await finish({ delivered: false, error: res.error, dead: true }, "dead");
  // The claim already spent this attempt; with none left the row is as given up as a dead one.
  return await finish({ delivered: false, error: res.error }, row.attempts >= OUTBOX_MAX_ATTEMPTS ? "dead" : "retried");
}

/** Claims and delivers one row at a time until none is due, maxRows are done or the deadline
 *  (measured on deps.now) is near; with options.ref, only that row. Stops after the first failed
 *  delivery: the next row would most likely meet the same rate limit, outage or configuration
 *  error, and each claim spends an attempt. Throws only when the first claim fails. */
export async function deliverOutbox(deps: Deps, options: DeliverOptions): Promise<OutboxCounts> {
  const counts: OutboxCounts = { delivered: 0, retried: 0, dead: 0, errors: 0 };
  // Without the token and base the rows wait, unclaimed, with their attempts intact.
  if (!airtableConfigured(deps.env)) return { ...counts, skipped: "airtable not configured" };
  const deadline = deps.now().getTime() + options.deadlineMs;
  const maxRows = options.ref ? 1 : options.maxRows ?? JOB_MAX_ROWS;

  for (let done = 0; done < maxRows; done++) {
    const left = deadline - deps.now().getTime();
    if (left < MIN_DELIVERY_MS) break;
    let row: OutboxRow | undefined;
    try {
      [row] = await deps.store.claimOutbox(1, options.ref);
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
      delivery = await deliverOne(deps, row, Math.min(AIRTABLE_TIMEOUT_MS, left));
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
      safeLog(deps, { event: "outbox_paused", outbox_id: row.id, call_key: row.ref_id, error: counts.config_error });
      break;
    }
    counts[outcome]++;
    if (outcome !== "delivered") {
      safeLog(deps, { event: "outbox_failed", outbox_id: row.id, call_key: row.ref_id, outcome, attempts: row.attempts });
      break;
    }
  }
  return counts;
}

/** The post-call fast path: one try at the call's own row, off the request path. Never throws;
 *  the every-minute job retries whatever it leaves behind. */
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
