// Store over supabase-js with the service-role key: the only path from the Edge Function to
// Postgres. The counted identity steps and the merges run inside the SQL functions of
// 0001_init.sql, so this file stays a thin mapping. Every call is bounded at 5 s and every error
// throws; callers turn that into system_error, never into a business answer such as not_found.

// Pinned in place (same version as the deno.json import map) so the deploy never depends on
// import-map resolution; the function directory has no deno.json of its own.
// deno-lint-ignore no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { type InteractionForMirror, MIRROR_COLUMNS } from "./airtable.ts";
import type { AlertStatus, Code, EmailKind, EmailStatus } from "./enums.ts";
import { GHL_COLUMNS, type InteractionForGhl } from "./ghl.ts";
import {
  type DigestCallRow,
  digestFromRows,
  JOB_LIST_LIMIT,
  OUTBOX_DUE_SLACK_MS,
  OUTBOX_MAX_ATTEMPTS,
  outboxClaimable,
  outboxErrorText,
  outboxGap,
} from "./store_rules.ts";
import type {
  AttemptRow,
  CallerContact,
  Claim,
  ClaimIntake,
  Customer,
  EmailRow,
  EscalationRow,
  InteractionRow,
  OutboxRef,
  OutboxRow,
  PriorInteraction,
  Session,
  StaleEscalation,
  Store,
  StuckInteraction,
  TranscriptLine,
} from "./types.ts";

const TIMEOUT_MS = 5000;
/** How long a captured webhook body is kept (0001_init.sql: webhook_captures). */
export const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Reads beyond the Store contract. Both stores implement them; callers check for the method, so a
 *  stand-in store without them still works (and gets the conservative answer). */
export interface StoreExtras {
  // call_interactions.analysis_status for the call, or null when there is no row yet
  storedAnalysisStatus(callKey: string): Promise<string | null>;
  // true when the call's row exists and has ended_at
  interactionEnded(callKey: string): Promise<boolean>;
}

// date_of_birth is deliberately absent: no tool needs it, the SQL function compares it in place.
const CUSTOMER_COLUMNS = "id, phone_e164, first_name, last_name, policy_number, email";
const CLAIM_COLUMNS = "id, customer_id, claim_number, claim_type, status, status_detail, documents_required, " +
  "documents_due, adjuster_name, filed_on, updated_on, amount_approved";
const SESSION_COLUMNS = "call_key, channel, caller_number, level, candidate_customer_id, verified_customer_id";
const ATTEMPT_COLUMNS = "call_key, tool_call_id, tool_name, kind, code, created_at";
const ESCALATION_COLUMNS = "id, call_key, kind, reason, details, callback_phone, channel, verified, callback_source, " +
  "alert_status, delivery_error, status, created_at";
const EMAIL_COLUMNS = "call_key, kind, to_masked, resend_id, status, error";
const CONTACT_COLUMNS = "call_key, kind, first_name, last_name, email, callback_phone, callback_source, customer_id, " +
  "confirmed, confirmed_at";
const INTAKE_COLUMNS = "call_key, kind, claim_type, loss_date, summary, description, customer_id, claim_id, " +
  "claim_number, confirmed, confirmed_at";
const STALE_COLUMNS = "id, call_key, kind, reason, channel, verified, created_at";
const DIGEST_COLUMNS = "outcome, sentiment, flags, cost, ended_at";
const OUTBOX_COLUMNS = "id, kind, ref_id, destination, attempts, delivered_at, last_error, external_id, progress, " +
  "next_attempt_at, created_at, updated_at";
// Rows one claim reads from the head of the queue; only the few inside a lease are passed over.
const OUTBOX_CANDIDATES = 50;
// PostgREST answers at most this many rows per request (the Supabase default max-rows), so the
// digest and the call-log sweep read in pages of it.
const PAGE = 1000;
// Bounds one digest or sweep: 50 pages is 50k rows, far beyond two days of calls.
const MAX_PAGES = 50;
// Call keys per in() filter: keeps the request line far below proxy limits.
const KEYS_PER_FILTER = 100;

interface DbError {
  message?: string;
  code?: string;
}

// Message and SQLSTATE only: PostgREST's details can quote key values (a phone number inside a
// unique-violation detail), and this text ends up in the function logs.
function fail(op: string, error: DbError): never {
  const code = error.code ? `${error.code} ` : "";
  throw new Error(`store.${op}: ${code}${error.message ?? "database error"}`);
}

function firstRow<T>(op: string, data: unknown): T {
  if (!Array.isArray(data) || data.length === 0) throw new Error(`store.${op}: no row returned`);
  return data[0] as T;
}

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : []) as T[];
}

function signal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function toOutboxRow(row: any): OutboxRow {
  return {
    id: row.id,
    kind: row.kind,
    ref_id: row.ref_id,
    destination: row.destination,
    attempts: Number(row.attempts),
    delivered_at: row.delivered_at ?? null,
    last_error: row.last_error ?? null,
    external_id: row.external_id ?? null,
    progress: row.progress !== null && typeof row.progress === "object" && !Array.isArray(row.progress)
      ? row.progress
      : {},
    next_attempt_at: row.next_attempt_at ?? row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A caller_contacts row (the functions return every column) as the Store contract's shape. */
function toContact(row: any): CallerContact {
  return {
    call_key: row.call_key,
    kind: row.kind,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email ?? null,
    callback_phone: row.callback_phone ?? null,
    callback_source: row.callback_source,
    customer_id: row.customer_id ?? null,
    confirmed: row.confirmed === true,
    confirmed_at: row.confirmed_at ?? null,
  };
}

/** A claim_intakes row (the functions return every column) as the Store contract's shape. */
function toIntake(row: any): ClaimIntake {
  return {
    call_key: row.call_key,
    kind: row.kind,
    claim_type: row.claim_type,
    loss_date: row.loss_date,
    summary: row.summary,
    description: row.description,
    customer_id: row.customer_id ?? null,
    claim_id: row.claim_id ?? null,
    claim_number: row.claim_number ?? null,
    confirmed: row.confirmed === true,
    confirmed_at: row.confirmed_at ?? null,
  };
}

function toClaim(row: any): Claim {
  return {
    ...row,
    documents_required: Array.isArray(row.documents_required) ? row.documents_required : [],
    // numeric arrives as a JSON number from PostgREST today; coercing keeps a string form safe too
    amount_approved: row.amount_approved === null || row.amount_approved === undefined
      ? null
      : Number(row.amount_approved),
  };
}

/** Store over supabase-js with the service role key. Throws on any DB error. */
export function createStore(supabaseUrl: string, serviceRoleKey: string): Store {
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Every page of a filtered read, in a stable order, up to MAX_PAGES. build() starts a fresh query
  // per page because a supabase-js builder runs once.
  async function readPages<T>(op: string, build: () => any): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await build().range(page * PAGE, page * PAGE + PAGE - 1).abortSignal(signal());
      if (error) fail(op, error);
      const got = rows<T>(data);
      out.push(...got);
      if (got.length < PAGE) break;
    }
    return out;
  }

  const store: Store & StoreExtras = {
    async lookupCustomerAttempt(p) {
      const { data, error } = await db.rpc("lookup_customer_attempt", {
        p_call_key: p.callKey,
        p_channel: p.channel,
        p_phone_e164: p.phoneE164,
        p_tool_call_id: p.toolCallId,
        p_caller_number: p.callerNumber,
      }).abortSignal(signal());
      if (error) fail("lookupCustomerAttempt", error);
      const row = firstRow<{ code: string; misses: number }>("lookupCustomerAttempt", data);
      return { code: row.code as Code, misses: Number(row.misses) };
    },

    async verifyDobAttempt(p) {
      const { data, error } = await db.rpc("verify_dob_attempt", {
        p_call_key: p.callKey,
        p_y: p.year,
        p_m: p.month,
        p_d: p.day,
        p_tool_call_id: p.toolCallId,
      }).abortSignal(signal());
      if (error) fail("verifyDobAttempt", error);
      const row = firstRow<{ code: string; first_name: string | null; attempts: number; customer_id: string | null }>(
        "verifyDobAttempt",
        data,
      );
      return {
        code: row.code as Code,
        firstName: row.first_name ?? null,
        attempts: Number(row.attempts),
        customerId: row.customer_id ?? null,
      };
    },

    async getSession(callKey) {
      const { data, error } = await db.from("call_sessions").select(SESSION_COLUMNS).eq("call_key", callKey)
        .abortSignal(signal()).maybeSingle();
      if (error) fail("getSession", error);
      return (data as Session | null) ?? null;
    },

    async ensureSession(callKey, channel, callerNumber) {
      const { error } = await db.from("call_sessions")
        .upsert({ call_key: callKey, channel, caller_number: callerNumber }, {
          onConflict: "call_key",
          ignoreDuplicates: true,
        })
        .abortSignal(signal());
      if (error) fail("ensureSession", error);
    },

    async getCustomer(id) {
      const { data, error } = await db.from("customers").select(CUSTOMER_COLUMNS).eq("id", id)
        .abortSignal(signal()).maybeSingle();
      if (error) fail("getCustomer", error);
      return (data as Customer | null) ?? null;
    },

    async getClaims(customerId) {
      const { data, error } = await db.from("claims").select(CLAIM_COLUMNS).eq("customer_id", customerId)
        .order("filed_on", { ascending: true })
        .order("claim_number", { ascending: true })
        .abortSignal(signal());
      if (error) fail("getClaims", error);
      return rows<any>(data).map(toClaim);
    },

    async claimAttempt(callKey, toolCallId, toolName) {
      // insert ... on conflict do nothing returning: an empty return is the only reliable sign that
      // an earlier delivery of this toolCallId already holds the row.
      const { data, error } = await db.from("attempts")
        .upsert({ call_key: callKey, tool_call_id: toolCallId, tool_name: toolName, kind: "other" }, {
          onConflict: "call_key,tool_call_id",
          ignoreDuplicates: true,
        })
        .select("tool_call_id")
        .abortSignal(signal());
      if (error) fail("claimAttempt", error);
      if (rows(data).length > 0) return null;

      const prior = await db.from("attempts").select("code").eq("call_key", callKey).eq("tool_call_id", toolCallId)
        .abortSignal(signal()).maybeSingle();
      if (prior.error) fail("claimAttempt", prior.error);
      // A row without a code means the first delivery has not finished; running again is safe
      // because every side effect behind it is itself keyed (escalation and email ledgers).
      return (prior.data as { code: string | null } | null)?.code ?? null;
    },

    async setAttemptCode(callKey, toolCallId, code) {
      const { error } = await db.from("attempts").update({ code }).eq("call_key", callKey)
        .eq("tool_call_id", toolCallId).abortSignal(signal());
      if (error) fail("setAttemptCode", error);
    },

    async listAttempts(callKey) {
      const { data, error } = await db.from("attempts").select(ATTEMPT_COLUMNS).eq("call_key", callKey)
        .order("created_at", { ascending: true })
        .order("tool_call_id", { ascending: true })
        .abortSignal(signal());
      if (error) fail("listAttempts", error);
      return rows<AttemptRow>(data);
    },

    async upsertEscalation(p) {
      const { data, error } = await db.rpc("upsert_escalation", {
        p_call_key: p.callKey,
        p_kind: p.kind,
        p_reason: p.reason,
        p_details: p.details,
        p_callback_phone: p.callbackPhone,
        p_callback_source: p.callbackSource,
        p_channel: p.channel,
        p_verified: p.verified,
      }).abortSignal(signal());
      if (error) fail("upsertEscalation", error);
      const row = firstRow<{ id: string; inserted: boolean; callback_phone: string | null; alert_status: string }>(
        "upsertEscalation",
        data,
      );
      return {
        id: row.id,
        inserted: row.inserted === true,
        callbackPhone: row.callback_phone ?? null,
        alertStatus: row.alert_status as AlertStatus,
      };
    },

    async setEscalationDelivery(id, alertStatus, deliveryError) {
      const { error } = await db.from("escalations")
        .update({ alert_status: alertStatus, delivery_error: deliveryError })
        .eq("id", id)
        .abortSignal(signal());
      if (error) fail("setEscalationDelivery", error);
    },

    async listEscalations(callKey) {
      const { data, error } = await db.from("escalations").select(ESCALATION_COLUMNS).eq("call_key", callKey)
        .order("created_at", { ascending: true })
        .abortSignal(signal());
      if (error) fail("listEscalations", error);
      return rows<EscalationRow>(data);
    },

    async claimEmail(callKey: string, kind: EmailKind, toMasked: string) {
      const { data, error } = await db.from("emails")
        .upsert({ call_key: callKey, kind, to_masked: toMasked, status: "sending" }, {
          onConflict: "call_key,kind",
          ignoreDuplicates: true,
        })
        .select("id")
        .abortSignal(signal());
      if (error) fail("claimEmail", error);
      if (rows(data).length > 0) return { claimed: true as const };

      const prior = await db.from("emails").select("status, resend_id").eq("call_key", callKey).eq("kind", kind)
        .abortSignal(signal()).maybeSingle();
      if (prior.error) fail("claimEmail", prior.error);
      const row = prior.data as { status: string; resend_id: string | null } | null;
      if (!row) throw new Error("store.claimEmail: ledger row vanished after a conflict");
      return { claimed: false as const, status: row.status as EmailStatus, resendId: row.resend_id ?? null };
    },

    async finishEmail(callKey, kind, status, resendId, error) {
      const res = await db.from("emails").update({ status, resend_id: resendId, error }).eq("call_key", callKey)
        .eq("kind", kind).abortSignal(signal());
      if (res.error) fail("finishEmail", res.error);
    },

    async listEmails(callKey) {
      const { data, error } = await db.from("emails").select(EMAIL_COLUMNS).eq("call_key", callKey)
        .order("created_at", { ascending: true })
        .abortSignal(signal());
      if (error) fail("listEmails", error);
      return rows<EmailRow>(data);
    },

    async upsertContact(p) {
      const { data, error } = await db.rpc("upsert_caller_contact", {
        p_call_key: p.callKey,
        p_kind: p.kind,
        p_first_name: p.firstName,
        p_last_name: p.lastName,
        p_email: p.email,
        p_callback_phone: p.callbackPhone,
        p_callback_source: p.callbackSource,
        p_customer_id: p.customerId,
      }).abortSignal(signal());
      if (error) fail("upsertContact", error);
      return toContact(firstRow("upsertContact", data));
    },

    async getContact(callKey) {
      const { data, error } = await db.from("caller_contacts").select(CONTACT_COLUMNS).eq("call_key", callKey)
        .abortSignal(signal()).maybeSingle();
      if (error) fail("getContact", error);
      return data ? toContact(data) : null;
    },

    async setContactConfirmed(callKey, confirmed) {
      const { data, error } = await db.rpc("set_caller_contact_confirmed", {
        p_call_key: callKey,
        p_confirmed: confirmed,
      }).abortSignal(signal());
      if (error) fail("setContactConfirmed", error);
      const row = rows<any>(data)[0];
      return row ? toContact(row) : null;
    },

    async upsertClaimIntake(p) {
      const { data, error } = await db.rpc("upsert_claim_intake", {
        p_call_key: p.callKey,
        p_kind: p.kind,
        p_claim_type: p.claimType,
        p_loss_date: p.lossDate,
        p_summary: p.summary,
        p_description: p.description,
        p_customer_id: p.customerId,
      }).abortSignal(signal());
      if (error) fail("upsertClaimIntake", error);
      return toIntake(firstRow("upsertClaimIntake", data));
    },

    async fileClaimIntake(callKey) {
      const { data, error } = await db.rpc("file_claim_intake_once", { p_call_key: callKey }).abortSignal(signal());
      if (error) fail("fileClaimIntake", error);
      // one row: the intake (a composite, as a nested object) and whether this call filed it
      const row = rows<any>(data)[0];
      return row?.intake ? { intake: toIntake(row.intake), filedNow: row.filed_now === true } : null;
    },

    async rejectClaimIntake(callKey) {
      const { data, error } = await db.rpc("reject_claim_intake", { p_call_key: callKey }).abortSignal(signal());
      if (error) fail("rejectClaimIntake", error);
      const row = rows<any>(data)[0];
      return row ? toIntake(row) : null;
    },

    async getClaimIntake(callKey) {
      const { data, error } = await db.from("claim_intakes").select(INTAKE_COLUMNS).eq("call_key", callKey)
        .abortSignal(signal()).maybeSingle();
      if (error) fail("getClaimIntake", error);
      return data ? toIntake(data) : null;
    },

    async priorInteractions(customerId, excludeCallKey, limit) {
      const { data, error } = await db.from("call_interactions").select("vapi_call_id, started_at, summary")
        .eq("customer_id", customerId)
        .neq("vapi_call_id", excludeCallKey)
        .not("ended_at", "is", null)
        .not("summary", "is", null)
        // Postgres sorts nulls first on desc; a row without a start time cannot be spoken as a date
        .order("started_at", { ascending: false, nullsFirst: false })
        .limit(limit)
        .abortSignal(signal());
      if (error) fail("priorInteractions", error);
      return rows<PriorInteraction>(data);
    },

    async ensureInteraction(row: InteractionRow) {
      const { error } = await db.from("call_interactions")
        .upsert(row, { onConflict: "vapi_call_id", ignoreDuplicates: true })
        .abortSignal(signal());
      if (error) fail("ensureInteraction", error);
    },

    async upsertInteraction(row: InteractionRow) {
      const { error } = await db.rpc("upsert_interaction", { p: row }).abortSignal(signal());
      if (error) fail("upsertInteraction", error);
    },

    async storedAnalysisStatus(callKey) {
      const { data, error } = await db.from("call_interactions").select("analysis_status").eq("vapi_call_id", callKey)
        .abortSignal(signal()).maybeSingle();
      if (error) fail("storedAnalysisStatus", error);
      return (data as { analysis_status: string } | null)?.analysis_status ?? null;
    },

    async interactionEnded(callKey) {
      const { data, error } = await db.from("call_interactions").select("ended_at").eq("vapi_call_id", callKey)
        .abortSignal(signal()).maybeSingle();
      if (error) fail("interactionEnded", error);
      return typeof (data as { ended_at: string | null } | null)?.ended_at === "string";
    },

    async insertTranscriptLine(line: TranscriptLine) {
      const { error } = await db.from("transcript_lines")
        .upsert(
          { call_key: line.call_key, role: line.role, text: line.text, ts_ms: line.ts_ms },
          { onConflict: "call_key,role,ts_ms", ignoreDuplicates: true },
        )
        .abortSignal(signal());
      if (error) fail("insertTranscriptLine", error);
    },

    async recentAssistantLines(callKey, limit) {
      const { data, error } = await db.from("transcript_lines").select("text").eq("call_key", callKey)
        .eq("role", "assistant")
        .order("ts_ms", { ascending: false })
        .limit(limit)
        .abortSignal(signal());
      if (error) fail("recentAssistantLines", error);
      return rows<{ text: string }>(data).map((r) => r.text);
    },

    async deleteTranscriptLines(callKey) {
      const { error } = await db.from("transcript_lines").delete().eq("call_key", callKey).abortSignal(signal());
      if (error) fail("deleteTranscriptLines", error);
    },

    async captureWebhook(messageType, callKey, body) {
      const { error } = await db.from("webhook_captures")
        .insert({ message_type: messageType, call_key: callKey, body })
        .abortSignal(signal());
      if (error) fail("captureWebhook", error);
      // Captures only accrue while CAPTURE_WEBHOOKS is on, so each one also enforces the 7-day
      // retention, whether or not a scheduled job runs.
      const pruned = await db.from("webhook_captures").delete()
        .lt("received_at", new Date(Date.now() - CAPTURE_RETENTION_MS).toISOString())
        .abortSignal(signal());
      if (pruned.error) fail("captureWebhook.prune", pruned.error);
    },

    async enqueueOutbox(kind, refId, destination = "airtable", delayS = 0) {
      const { error } = await db.rpc("enqueue_outbox", {
        p_kind: kind,
        p_ref_id: refId,
        p_destination: destination,
        p_delay_s: delayS,
      }).abortSignal(signal());
      if (error) fail("enqueueOutbox", error);
    },

    async claimOutbox(limit: number, ref?: OutboxRef, destination?) {
      // Not claim_outbox (0005): its row locks end with its own statement, so a row in flight could
      // be claimed again at once. Here the head of the queue is read, the rows inside a lease or not
      // yet due are passed over, and each claim is a compare-and-set on attempts and updated_at,
      // which touch_updated_at moves on every write: of two runners only one can take a row.
      if (!Number.isInteger(limit)) throw new Error("store.claimOutbox: 22P02 limit must be an integer");
      const nowMs = Date.now();
      // Rows deferred well past now stay out of the window, so a backlog of them never hides a due row.
      let query = db.from("outbox_events").select(OUTBOX_COLUMNS).is("delivered_at", null)
        .lt("attempts", OUTBOX_MAX_ATTEMPTS)
        .lte("next_attempt_at", new Date(nowMs + OUTBOX_DUE_SLACK_MS).toISOString());
      if (ref) query = query.eq("kind", ref.kind).eq("ref_id", ref.refId).eq("destination", ref.destination);
      else if (destination) query = query.eq("destination", destination);
      const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true })
        .limit(OUTBOX_CANDIDATES).abortSignal(signal());
      if (error) fail("claimOutbox", error);
      const due = rows<any>(data).map(toOutboxRow).filter((r) => outboxClaimable(r, nowMs));
      const claimed: OutboxRow[] = [];
      for (const c of due) {
        if (claimed.length >= Math.max(limit, 1)) break;
        const res = await db.from("outbox_events").update({ attempts: c.attempts + 1 })
          .eq("id", c.id).eq("attempts", c.attempts).eq("updated_at", c.updated_at).is("delivered_at", null)
          .select(OUTBOX_COLUMNS).abortSignal(signal());
        if (res.error) fail("claimOutbox", res.error);
        const row = rows<any>(res.data)[0];
        if (row) claimed.push(toOutboxRow(row));
      }
      return claimed;
    },

    async finishOutbox(id, result) {
      const patch: Record<string, unknown> = result.delivered
        ? { delivered_at: new Date().toISOString(), last_error: null }
        : { last_error: outboxErrorText(result.error) };
      // A delivery without a record id keeps the one an earlier delivery stored.
      if (result.delivered && result.externalId) patch.external_id = result.externalId;
      if (!result.delivered && result.dead) patch.attempts = OUTBOX_MAX_ATTEMPTS;
      else if (!result.delivered && result.refund && typeof result.attempt === "number") {
        patch.attempts = Math.max(result.attempt - 1, 0);
      }
      const wait = result.retryAfterS;
      if (!result.delivered && !result.dead && typeof wait === "number" && Number.isFinite(wait) && wait > 0) {
        patch.next_attempt_at = new Date(Date.now() + Math.ceil(wait) * 1000).toISOString();
      }
      let query = db.from("outbox_events").update(patch).eq("id", id);
      if (typeof result.attempt === "number") query = query.eq("attempts", result.attempt);
      if (typeof result.claimedAt === "string") query = query.eq("updated_at", result.claimedAt);
      const { data, error } = await query.select("id").abortSignal(signal());
      if (error) fail("finishOutbox", error);
      return rows(data).length > 0;
    },

    async saveOutboxProgress(id, patch, guard) {
      const { data, error } = await db.rpc("save_outbox_progress", {
        p_id: id,
        p_patch: patch,
        p_attempts: guard.attempt,
        p_claimed_at: guard.claimedAt,
      }).abortSignal(signal());
      if (error) fail("saveOutboxProgress", error);
      const row = rows<{ saved_at: string; held: boolean }>(data)[0];
      return row ? { savedAt: row.saved_at, held: row.held === true } : null;
    },

    async getInteractionForMirror(vapiCallId) {
      const { data, error } = await db.from("call_interactions").select(MIRROR_COLUMNS.join(", "))
        .eq("vapi_call_id", vapiCallId).abortSignal(signal()).maybeSingle();
      if (error) fail("getInteractionForMirror", error);
      return (data as InteractionForMirror | null) ?? null;
    },

    async getInteractionForGhl(vapiCallId) {
      const { data, error } = await db.from("call_interactions").select(GHL_COLUMNS.join(", "))
        .eq("vapi_call_id", vapiCallId).abortSignal(signal()).maybeSingle();
      if (error) fail("getInteractionForGhl", error);
      return (data as InteractionForGhl | null) ?? null;
    },

    async listOutboxGaps(fromIso, toIso, destination = "airtable") {
      // PostgREST has no anti-join: the window's ended calls, then their outbox rows by key.
      const ended = await readPages<{ vapi_call_id: string; updated_at: string }>(
        "listOutboxGaps",
        () =>
          db.from("call_interactions").select("vapi_call_id, updated_at").gte("ended_at", fromIso).lt("ended_at", toIso)
            .order("ended_at", { ascending: true }).order("id", { ascending: true }),
      );
      const queued = new Map<string, { delivered_at: string | null }>();
      for (const part of chunks(ended.map((r) => r.vapi_call_id), KEYS_PER_FILTER)) {
        const { data, error } = await db.from("outbox_events").select("ref_id, delivered_at")
          .eq("kind", "interaction.completed").eq("destination", destination).in("ref_id", part)
          .abortSignal(signal());
        if (error) fail("listOutboxGaps", error);
        for (const r of rows<{ ref_id: string; delivered_at: string | null }>(data)) queued.set(r.ref_id, r);
      }
      return ended.filter((r) => outboxGap(r.updated_at, queued.get(r.vapi_call_id), destination))
        .map((r) => r.vapi_call_id).slice(0, JOB_LIST_LIMIT);
    },

    async claimJobRun(job, periodKey) {
      // Same claim as attempts and emails: an empty return from insert ... on conflict do nothing
      // means this period already has its run.
      const { data, error } = await db.from("job_runs")
        .upsert({ job, period_key: periodKey }, { onConflict: "job,period_key", ignoreDuplicates: true })
        .select("job")
        .abortSignal(signal());
      if (error) fail("claimJobRun", error);
      return rows(data).length > 0;
    },

    async finishJobRun(job, periodKey, result) {
      const { error } = await db.from("job_runs").update({ finished_at: new Date().toISOString(), result })
        .eq("job", job).eq("period_key", periodKey).abortSignal(signal());
      if (error) fail("finishJobRun", error);
    },

    async releaseJobRun(job, periodKey) {
      const { error } = await db.from("job_runs").delete().eq("job", job).eq("period_key", periodKey)
        .is("finished_at", null).abortSignal(signal());
      if (error) fail("releaseJobRun", error);
    },

    async listStaleEscalations(cutoffIso) {
      // A chat escalation never paged anyone (escalate skips the alert for a chat), so it is never
      // re-paged either; left in the list it would also crowd out real rows under the cap.
      const { data, error } = await db.from("escalations").select(STALE_COLUMNS)
        .eq("status", "open")
        .lt("created_at", cutoffIso)
        .is("realerted_at", null)
        .neq("channel", "chat")
        .order("created_at", { ascending: true })
        .limit(JOB_LIST_LIMIT)
        .abortSignal(signal());
      if (error) fail("listStaleEscalations", error);
      return rows<StaleEscalation>(data);
    },

    async markRealerted(id) {
      // The re-alert's claim: only an open row never re-alerted, so a row staff claimed meanwhile,
      // or one another run already marked, is never paged.
      const { data, error } = await db.from("escalations").update({ realerted_at: new Date().toISOString() })
        .eq("id", id).is("realerted_at", null).eq("status", "open").select("id").abortSignal(signal());
      if (error) fail("markRealerted", error);
      return rows(data).length > 0;
    },

    async digestStats(fromIso, toIso) {
      const calls = readPages<DigestCallRow>(
        "digestStats",
        () =>
          db.from("call_interactions").select(DIGEST_COLUMNS).gte("created_at", fromIso).lt("created_at", toIso)
            .order("id", { ascending: true }),
      );
      const escalations = readPages<{ status: string }>(
        "digestStats",
        () =>
          db.from("escalations").select("status").gte("created_at", fromIso).lt("created_at", toIso)
            .order("id", { ascending: true }),
      );
      const emails = db.from("emails").select("id", { count: "exact", head: true }).eq("status", "sent")
        .gte("created_at", fromIso).lt("created_at", toIso).abortSignal(signal());
      const [callRows, escalationRows, sent] = await Promise.all([calls, escalations, emails]);
      if (sent.error) fail("digestStats", sent.error);
      return digestFromRows(callRows, escalationRows.map((e) => e.status), sent.count ?? 0);
    },

    async listStuckInteractions(cutoffIso) {
      const { data, error } = await db.from("call_interactions").select("vapi_call_id, created_at")
        .is("ended_at", null)
        .lt("created_at", cutoffIso)
        .order("created_at", { ascending: true })
        .limit(JOB_LIST_LIMIT)
        .abortSignal(signal());
      if (error) fail("listStuckInteractions", error);
      return rows<StuckInteraction>(data);
    },

    async reapInteraction(vapiCallId) {
      // coalesce(ended_reason, 'reaped') without a SQL function: one guarded update for each case.
      // Both require ended_at is null, so a report that lands first is never touched, and after the
      // first update matches the second cannot.
      const closed = { outcome: "abandoned", analysis_status: "missing", ended_at: new Date().toISOString() };
      const first = await db.from("call_interactions").update({ ...closed, ended_reason: "reaped" })
        .eq("vapi_call_id", vapiCallId).is("ended_at", null).is("ended_reason", null)
        .select("vapi_call_id").abortSignal(signal());
      if (first.error) fail("reapInteraction", first.error);
      if (rows(first.data).length > 0) return true;
      const second = await db.from("call_interactions").update(closed)
        .eq("vapi_call_id", vapiCallId).is("ended_at", null)
        .select("vapi_call_id").abortSignal(signal());
      if (second.error) fail("reapInteraction", second.error);
      return rows(second.data).length > 0;
    },

    async deleteOldTranscriptLines(cutoffIso) {
      const { count, error } = await db.from("transcript_lines").delete({ count: "exact" })
        .lt("created_at", cutoffIso).abortSignal(signal());
      if (error) fail("deleteOldTranscriptLines", error);
      return count ?? 0;
    },

    async pruneWebhookCaptures(cutoffIso) {
      const { count, error } = await db.from("webhook_captures").delete({ count: "exact" })
        .lt("received_at", cutoffIso).abortSignal(signal());
      if (error) fail("pruneWebhookCaptures", error);
      return count ?? 0;
    },

    async pruneJobRuns(jobs, cutoffIso) {
      if (jobs.length === 0) return 0;
      const { count, error } = await db.from("job_runs").delete({ count: "exact" }).in("job", jobs)
        .lt("started_at", cutoffIso).abortSignal(signal());
      if (error) fail("pruneJobRuns", error);
      return count ?? 0;
    },
  };
  return store;
}
