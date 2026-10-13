// Scheduled jobs behind POST /jobs/<name> (pg_cron -> pg_net, 0004_automation.sql). Every run
// claims its (job, period_key) row in job_runs first, so a re-fire inside the same period is a
// no-op, and records a small result of counts when it finishes (no names, numbers or call keys).
//
//   sla     every 10 min  open escalations unclaimed after 30 min re-page once: the row is marked
//                         first, then Telegram, plus the sla_realert email through the at-most-once
//                         ledger (one per call)
//   digest  daily 12:00 UTC  the last 24 hours' counts to CLAIMS_TEAM_EMAIL, one email per Eastern
//                         date; a run that sent nothing gives its date back for a later run
//   reaper  hourly        calls with no report after 2 h: rebuilt from GET /call when VAPI has it,
//                         closed as abandoned when VAPI has no such call (or after a day of no
//                         answer); ended calls missing from the call log queued again; old live
//                         lines, captures and frequent job runs pruned. Never notifies.
//   outbox  every minute  undelivered outbox_events to the Airtable call log, then to GoHighLevel
//                         (each destination in its own loop, so one's outage never blocks the other)
//
// pg_net gives up on the request after 10 s, so each run works to an 8 s deadline (measured on
// deps.now) and leaves the rest to its next run rather than finishing after nobody is listening.

import { alertSinks, type EscalationAlert, sendAlert } from "./alert.ts";
import {
  digestEmail,
  loadEscalationContact,
  maskEmail,
  sendEmail,
  slaRealertEmail,
  type TeamCaller,
  writtenDate,
} from "./email.ts";
import { type Channel, CHANNELS, JOB_NAMES, type JobName, TIMEZONE } from "./enums.ts";
import { ghlConfigured } from "./ghl.ts";
import { deliverOutboxRun, enqueueGap, enqueueInteraction } from "./outbox.ts";
import { recoverFromCall } from "./post_call.ts";
import { redactPII } from "./redact.ts";
import type { Deps, StaleEscalation } from "./types.ts";

export const JOB_DEADLINE_MS = 8000;
export const SLA_MINUTES = 30;
export const STUCK_HOURS = 2;
// A stuck call VAPI cannot answer for (an outage, a rate limit, a call it says is still on) is
// asked again every hour, and closed as abandoned only once its row is this old.
export const STUCK_GIVE_UP_HOURS = 24;
export const RETENTION_DAYS = 7;
export const DIGEST_WINDOW_HOURS = 24;
// The reaper's call-log sweep: ended calls this recent that the outbox is missing are queued again.
export const REQUEUE_WINDOW_HOURS = 48;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Each re-alert channel gets this long, as in escalate; a row starts only with room for it.
const CHANNEL_BUDGET_MS = 2500;
// The re-alert email's caller name and callback number are read first; a slow read sends the
// re-alert without them rather than eating into the send's budget.
const CONTACT_READ_MS = 400;
const SLA_ROW_MS = 3000;
// The reaper's GET /call always gets REAPER_FETCH_MS: a row starts only with room for the fetch and
// the store work after it, and the loop stops early enough for the sweep and the pruning.
const REAPER_FETCH_MS = 3000;
const REAPER_DB_MS = 1000;
const REAPER_ROW_MS = REAPER_FETCH_MS + REAPER_DB_MS;
const REAPER_CLEANUP_RESERVE_MS = 2500;
const PRUNE_RESERVE_MS = 1000;
// A call that ended this recently is still in its own path (the report, then the backfill).
const REQUEUE_SETTLE_MS = 15 * MINUTE_MS;
const DIGEST_SEND_TIMEOUT_MS = 5000;
// The jobs that run more often than hourly: 1,584 job_runs rows a day between them, which the Ops
// page sorts by started_at. Their history older than the retention goes; the last run (what
// ops_health reads) is always recent, and the hourly and daily history stays.
const PRUNED_JOB_RUNS: JobName[] = ["sla", "outbox"];
const MAX_LOG_ERROR = 300;

export type JobResult = Record<string, string | number | boolean>;

// released: the run did nothing it cannot do again and gave its period back, so a later run of the
// same period (a manual one) may retry it.
export type JobOutcome =
  | { job: JobName; period_key: string; skipped: true }
  | { job: JobName; period_key: string; skipped: false; result: JobResult; released?: true };

// What a job hands back to runJob: its counts, and whether the period should be given back.
interface JobRun {
  result: JobResult;
  retry?: boolean;
}

const JOB_SET: ReadonlySet<string> = new Set(JOB_NAMES);

export function isJobName(value: unknown): value is JobName {
  return typeof value === "string" && JOB_SET.has(value);
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown";
  return redactPII(text.slice(0, 1000)).slice(0, MAX_LOG_ERROR);
}

function safeLog(deps: Deps, event: Record<string, unknown>): void {
  try {
    deps.log(event);
  } catch {
    // a logging fault must never change what a job does
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const msLeft = (deps: Deps, deadline: number) => deadline - deps.now().getTime();

// ---------------------------------------------------------------------------------------------
// Period keys.
// ---------------------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DDTHH:MMZ" of the instant floored to `stepMs`. */
function utcMinuteKey(now: Date, stepMs: number): string {
  const d = new Date(Math.floor(now.getTime() / stepMs) * stepMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${
    pad(d.getUTCMinutes())
  }Z`;
}

const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Wall-clock parts in America/New_York, read from formatToParts so no locale punctuation leaks in. */
function easternParts(at: Date): { date: string; time: string } {
  const parts: Record<string, string> = {};
  for (const p of eastern.formatToParts(at)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The job_runs period of a run starting at `now`: sla the UTC 10-minute slot, digest the Eastern
 *  date (pg_cron fires at 12:00 UTC, 08:00 EDT or 07:00 EST, and either way that is one Eastern
 *  day, so the DST change can never send two digests or skip one), reaper the UTC hour, outbox
 *  the UTC minute. */
export function periodKey(job: JobName, now: Date): string {
  switch (job) {
    case "sla":
      return utcMinuteKey(now, 10 * MINUTE_MS);
    case "digest":
      return easternParts(now).date;
    case "reaper":
      return utcMinuteKey(now, HOUR_MS);
    case "outbox":
      return utcMinuteKey(now, MINUTE_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// sla
// ---------------------------------------------------------------------------------------------
type ChannelResult = "sent" | "failed" | "skipped";

function channelOf(value: string): Channel {
  return (CHANNELS as readonly string[]).includes(value) ? value as Channel : "unknown";
}

async function realertTelegram(deps: Deps, row: StaleEscalation): Promise<ChannelResult> {
  const { env } = deps;
  if (!alertSinks(env).includes("telegram") || !str(env.TELEGRAM_BOT_TOKEN) || !str(env.TELEGRAM_CHAT_ID)) {
    return "skipped";
  }
  const alert: EscalationAlert = {
    kind: row.kind,
    reason: row.reason,
    callKey: row.call_key,
    channel: channelOf(row.channel),
    verified: row.verified === true,
    event: "sla_realert",
  };
  const result = await sendAlert(deps, alert);
  return result.ok ? "sent" : "failed";
}

/** Who to call back for the re-alert email (the caller's name, any address they confirmed, the
 *  escalation's callback number), or nothing when the read is slow. Never throws. */
async function realertContact(
  deps: Deps,
  row: StaleEscalation,
): Promise<{ caller: TeamCaller; callbackPhone: string | null } | Record<never, never>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<Record<never, never>>((resolve) => {
    timer = setTimeout(() => resolve({}), CONTACT_READ_MS);
  });
  try {
    return await Promise.race([loadEscalationContact(deps.store, row.call_key, row.kind), slow]);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** The sla_realert email through the ledger: one per call, so a second stale row of the same call
 *  (its emergency and its representative request) re-pages on Telegram only. The email names the
 *  caller and the callback number like the first alert; the Telegram card stays ids and enums. */
async function realertEmail(deps: Deps, row: StaleEscalation, now: Date): Promise<ChannelResult> {
  const { env, store } = deps;
  const to = str(env.CLAIMS_TEAM_EMAIL);
  // Not configured is not a failure, and must not leave a failed ledger row behind.
  if (!alertSinks(env).includes("email") || !to || !str(env.RESEND_API_KEY)) return "skipped";
  try {
    const contact = await realertContact(deps, row);
    // Rendered before the claim, so a template fault cannot strand a 'sending' row.
    const { subject, html } = slaRealertEmail({
      callKey: row.call_key,
      kind: row.kind,
      reason: row.reason,
      minutesOpen: (now.getTime() - Date.parse(row.created_at)) / MINUTE_MS,
      dashboardUrl: env.DASHBOARD_URL,
      ...contact,
    });
    const claim = await store.claimEmail(row.call_key, "sla_realert", maskEmail(to));
    if (!claim.claimed) return "skipped";
    const sent = await sendEmail(
      deps,
      { to, subject, html, idempotencyKey: `${row.call_key}:sla_realert` },
      CHANNEL_BUDGET_MS,
    );
    try {
      await store.finishEmail(
        row.call_key,
        "sla_realert",
        sent.ok ? "sent" : "failed",
        sent.ok ? sent.id : null,
        sent.ok ? null : sent.error,
      );
    } catch (e) {
      safeLog(deps, {
        event: "job_error",
        job: "sla",
        step: "finishEmail",
        call_key: row.call_key,
        error: errorText(e),
      });
    }
    return sent.ok ? "sent" : "failed";
  } catch (e) {
    safeLog(deps, { event: "job_error", job: "sla", step: "email", call_key: row.call_key, error: errorText(e) });
    return "failed";
  }
}

async function slaJob(deps: Deps, now: Date): Promise<JobRun> {
  const deadline = now.getTime() + JOB_DEADLINE_MS;
  const rows = await deps.store.listStaleEscalations(new Date(now.getTime() - SLA_MINUTES * MINUTE_MS).toISOString());
  const result = {
    stale: rows.length,
    realerted: 0,
    superseded: 0,
    telegram_sent: 0,
    telegram_failed: 0,
    telegram_skipped: 0,
    email_sent: 0,
    email_failed: 0,
    email_skipped: 0,
    deferred: 0,
    errors: 0,
  };
  for (const [i, row] of rows.entries()) {
    if (msLeft(deps, deadline) < SLA_ROW_MS) {
      result.deferred = rows.length - i;
      break;
    }
    // The mark is the re-alert's claim, taken before anyone is paged: a row staff claimed since
    // the list (or another run marked) is passed over, and a failed mark pages nobody now; the next
    // run lists the row again. Once marked, both channels are tried whatever they answer, and a
    // channel that failed is not retried: a row is re-paged at most once.
    let marked: boolean;
    try {
      marked = await deps.store.markRealerted(row.id);
    } catch (e) {
      result.errors++;
      safeLog(deps, {
        event: "job_error",
        job: "sla",
        step: "markRealerted",
        call_key: row.call_key,
        error: errorText(e),
      });
      continue;
    }
    if (!marked) {
      result.superseded++;
      continue;
    }
    result.realerted++;
    const [telegram, email] = await Promise.all([realertTelegram(deps, row), realertEmail(deps, row, now)]);
    result[`telegram_${telegram}`]++;
    result[`email_${email}`]++;
  }
  return { result };
}

// ---------------------------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------------------------
/** "October 11, 2026 at 08:00": the digest template redacts every string, and a bare
 *  "2026-10-11 08:00" reads to the redactor as a phone number. */
function windowEdge(at: Date): string {
  const { date, time } = easternParts(at);
  return `${writtenDate(date) ?? date} at ${time}`;
}

async function digestJob(deps: Deps, now: Date): Promise<JobRun> {
  const from = new Date(now.getTime() - DIGEST_WINDOW_HOURS * HOUR_MS);
  const date = periodKey("digest", now);
  const stats = await deps.store.digestStats(from.toISOString(), now.toISOString());
  const counts = {
    calls: stats.calls,
    completed: stats.completed,
    flagged: stats.flagged,
    emails_sent: stats.emails_sent,
  };

  const to = str(deps.env.CLAIMS_TEAM_EMAIL);
  if (!to || !str(deps.env.RESEND_API_KEY)) return { result: { ...counts, digest_email: "skipped" } };

  const { subject, html } = digestEmail({
    date,
    stats: {
      window: `${windowEdge(from)} to ${windowEdge(now)} Eastern`,
      calls: stats.calls,
      completed: stats.completed,
      outcomes: stats.outcomes,
      sentiments: stats.sentiments,
      flagged: stats.flagged,
      escalations_by_status: stats.escalations,
      emails_sent: stats.emails_sent,
      total_cost_usd: stats.total_cost,
    },
  });
  // job_runs keeps this to one sent digest per Eastern date; the key keeps a retry to one email,
  // even when the failure was only the answer to a send Resend had accepted.
  const sent = await sendEmail(deps, { to, subject, html, idempotencyKey: `digest:${date}` }, DIGEST_SEND_TIMEOUT_MS);
  if (!sent.ok) safeLog(deps, { event: "job_error", job: "digest", step: "sendEmail", error: sent.error });
  return { result: { ...counts, digest_email: sent.ok ? "sent" : "failed" }, retry: !sent.ok };
}

// ---------------------------------------------------------------------------------------------
// reaper
// ---------------------------------------------------------------------------------------------
async function reaperJob(deps: Deps, now: Date): Promise<JobRun> {
  const { store, env } = deps;
  const deadline = now.getTime() + JOB_DEADLINE_MS;
  const loopDeadline = deadline - REAPER_CLEANUP_RESERVE_MS;
  const stuck = await store.listStuckInteractions(new Date(now.getTime() - STUCK_HOURS * HOUR_MS).toISOString());
  const privateKey = str(env.VAPI_PRIVATE_KEY);
  const giveUpBefore = now.getTime() - STUCK_GIVE_UP_HOURS * HOUR_MS;
  const result = {
    stuck: stuck.length,
    backfilled: 0,
    reaped: 0,
    waiting: 0,
    superseded: 0,
    deferred: 0,
    errors: 0,
    requeued: 0,
    lines_deleted: 0,
    captures_deleted: 0,
    runs_deleted: 0,
  };

  for (const [i, row] of stuck.entries()) {
    if (msLeft(deps, loopDeadline) < (privateKey ? REAPER_ROW_MS : REAPER_DB_MS)) {
      result.deferred = stuck.length - i;
      break;
    }
    const callKey = row.vapi_call_id;
    try {
      // VAPI first: a report that never reached us is usually still there, analysis and all.
      const recovered = privateKey ? await recoverFromCall(deps, callKey, privateKey, REAPER_FETCH_MS) : null;
      if (recovered === "recovered") {
        result.backfilled++;
        continue;
      }
      if (recovered === "superseded") {
        result.superseded++;
        continue;
      }
      // An outage or a rate limit (often the same incident that lost the report) must not close a
      // call VAPI can still rebuild, so it waits for the next pass until its row is a day old. Only
      // VAPI's 404, or no key to ask with, closes it at once.
      const young = Date.parse(row.created_at) >= giveUpBefore;
      if ((recovered === "unavailable" || recovered === "not_ended") && young) {
        result.waiting++;
        continue;
      }
      if (await store.reapInteraction(callKey)) {
        result.reaped++;
        // The live lines stay: with no report they are the call's only transcript, and the
        // dashboard shows them until the 7-day sweep. The closed record goes to the call log.
        await enqueueInteraction(deps, callKey, "reaper");
      } else {
        result.superseded++;
      }
    } catch (e) {
      result.errors++;
      safeLog(deps, { event: "job_error", job: "reaper", step: "stuck", call_key: callKey, error: errorText(e) });
    }
  }

  // Ended calls missing from the call log: an enqueue that failed (the report still answered 200,
  // so VAPI never redelivers) or a re-arm that failed after a backfill. This is what makes the
  // outbox at-least-once from the record's side; calls that ended in the last minutes are left to
  // their own path.
  try {
    const gaps = await store.listOutboxGaps(
      new Date(now.getTime() - REQUEUE_WINDOW_HOURS * HOUR_MS).toISOString(),
      new Date(now.getTime() - REQUEUE_SETTLE_MS).toISOString(),
    );
    for (const callKey of gaps) {
      if (msLeft(deps, deadline) < PRUNE_RESERVE_MS) break;
      // A failed enqueue most likely means the store is failing; the rest wait for the next pass.
      if (!(await enqueueInteraction(deps, callKey, "sweep"))) {
        result.errors++;
        break;
      }
      result.requeued++;
    }
  } catch (e) {
    result.errors++;
    safeLog(deps, { event: "job_error", job: "reaper", step: "listOutboxGaps", error: errorText(e) });
  }

  // The same for GoHighLevel: its enqueue is a separate write, and when it alone failed the call log
  // has its row and the pass above finds nothing. Only a missing row counts (GHL never posts twice).
  if (ghlConfigured(env)) {
    try {
      const gaps = await store.listOutboxGaps(
        new Date(now.getTime() - REQUEUE_WINDOW_HOURS * HOUR_MS).toISOString(),
        new Date(now.getTime() - REQUEUE_SETTLE_MS).toISOString(),
        "ghl",
      );
      for (const callKey of gaps) {
        if (msLeft(deps, deadline) < PRUNE_RESERVE_MS) break;
        if (!(await enqueueGap(deps, callKey, "ghl"))) {
          result.errors++;
          break;
        }
        result.requeued++;
      }
    } catch (e) {
      result.errors++;
      safeLog(deps, {
        event: "job_error",
        job: "reaper",
        step: "listOutboxGaps",
        destination: "ghl",
        error: errorText(e),
      });
    }
  }

  // The pruning runs after the calls whatever happened to them, and a failure here is counted
  // instead of losing the record of the work above.
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  try {
    result.lines_deleted = await store.deleteOldTranscriptLines(cutoff);
  } catch (e) {
    result.errors++;
    safeLog(deps, { event: "job_error", job: "reaper", step: "deleteOldTranscriptLines", error: errorText(e) });
  }
  try {
    result.captures_deleted = await store.pruneWebhookCaptures(cutoff);
  } catch (e) {
    result.errors++;
    safeLog(deps, { event: "job_error", job: "reaper", step: "pruneWebhookCaptures", error: errorText(e) });
  }
  try {
    result.runs_deleted = await store.pruneJobRuns(PRUNED_JOB_RUNS, cutoff);
  } catch (e) {
    result.errors++;
    safeLog(deps, { event: "job_error", job: "reaper", step: "pruneJobRuns", error: errorText(e) });
  }
  return { result };
}

// ---------------------------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------------------------
// The call log's counts keep their plain keys; GoHighLevel's, present only when it is configured,
// carry a ghl_ prefix (job_runs.result stays one flat object of counts for the Ops page).
async function outboxJob(deps: Deps): Promise<JobRun> {
  const { airtable, ghl } = await deliverOutboxRun(deps, JOB_DEADLINE_MS);
  const result: JobResult = {};
  for (const [prefix, counts] of [["", airtable], ["ghl_", ghl]] as const) {
    if (!counts) continue;
    for (const [k, v] of Object.entries(counts)) if (v !== undefined) result[`${prefix}${k}`] = v;
  }
  return { result };
}

// ---------------------------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------------------------
const JOBS: Record<JobName, (deps: Deps, now: Date) => Promise<JobRun>> = {
  sla: slaJob,
  digest: digestJob,
  reaper: reaperJob,
  outbox: outboxJob,
};

// pg_cron fires the digest once a day, so a date it claimed but failed would lose that day's email
// for good: a failed digest gives its date back. The frequent jobs keep the unfinished run on the
// Ops page instead; their next period is minutes away.
const RETRY_IN_PERIOD: ReadonlySet<JobName> = new Set(["digest"]);

async function releasePeriod(deps: Deps, name: JobName, key: string): Promise<void> {
  try {
    await deps.store.releaseJobRun(name, key);
  } catch (e) {
    safeLog(deps, { event: "job_error", job: name, step: "releaseJobRun", period_key: key, error: errorText(e) });
  }
}

/** Claims the period, runs the job, records its counts. A period already claimed is skipped with
 *  no side effects. Throws when the claim, the job's first read or the finish fails; the run then
 *  stays unfinished in job_runs (the dashboard shows it), and the next period runs normally. The
 *  digest instead gives its period back when it throws or its email was not sent, so a later run
 *  of the same Eastern date (deno task jobs digest) can still send it. */
export async function runJob(name: JobName, deps: Deps): Promise<JobOutcome> {
  const now = deps.now();
  const key = periodKey(name, now);
  if (!(await deps.store.claimJobRun(name, key))) return { job: name, period_key: key, skipped: true };
  let run: JobRun;
  try {
    run = await JOBS[name](deps, now);
  } catch (e) {
    // Every job throws only from its first read, before any side effect, so a retry is safe.
    if (RETRY_IN_PERIOD.has(name)) await releasePeriod(deps, name, key);
    throw e;
  }
  const { result } = run;
  if (run.retry && RETRY_IN_PERIOD.has(name)) {
    await releasePeriod(deps, name, key);
    safeLog(deps, { event: "job_released", job: name, period_key: key, result });
    return { job: name, period_key: key, skipped: false, result, released: true };
  }
  await deps.store.finishJobRun(name, key, result);
  safeLog(deps, { event: "job_finished", job: name, period_key: key, result });
  return { job: name, period_key: key, skipped: false, result };
}
