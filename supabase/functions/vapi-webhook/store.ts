// Store over supabase-js with the service-role key: the only path from the Edge Function to
// Postgres. The counted identity steps and the merges run inside the SQL functions of
// 0001_init.sql, so this file stays a thin mapping. Every call is bounded at 5 s and every error
// throws; callers turn that into system_error, never into a business answer such as not_found.

import { createClient } from "@supabase/supabase-js";
import type { AlertStatus, Code, EmailKind, EmailStatus } from "./enums.ts";
import type {
  AttemptRow,
  Claim,
  Customer,
  EmailRow,
  EscalationRow,
  InteractionRow,
  PriorInteraction,
  Session,
  Store,
  TranscriptLine,
} from "./types.ts";

const TIMEOUT_MS = 5000;

// date_of_birth is deliberately absent: no tool needs it, the SQL function compares it in place.
const CUSTOMER_COLUMNS = "id, phone_e164, first_name, last_name, policy_number, email";
const CLAIM_COLUMNS = "id, customer_id, claim_number, claim_type, status, status_detail, documents_required, " +
  "documents_due, adjuster_name, filed_on, updated_on, amount_approved";
const SESSION_COLUMNS = "call_key, channel, caller_number, level, candidate_customer_id, verified_customer_id";
const ATTEMPT_COLUMNS = "call_key, tool_call_id, tool_name, kind, code, created_at";
const ESCALATION_COLUMNS = "id, call_key, kind, reason, details, callback_phone, channel, verified, callback_source, " +
  "alert_status, delivery_error, status, created_at";
const EMAIL_COLUMNS = "call_key, kind, to_masked, resend_id, status, error";

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

  return {
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

    async insertTranscriptLine(line: TranscriptLine) {
      const { error } = await db.from("transcript_lines")
        .upsert(
          { call_key: line.call_key, role: line.role, text: line.text, ts_ms: line.ts_ms },
          { onConflict: "call_key,role,ts_ms", ignoreDuplicates: true },
        )
        .abortSignal(signal());
      if (error) fail("insertTranscriptLine", error);
    },

    async lastAssistantLine(callKey) {
      const { data, error } = await db.from("transcript_lines").select("text").eq("call_key", callKey)
        .eq("role", "assistant")
        .order("ts_ms", { ascending: false })
        .limit(1)
        .abortSignal(signal());
      if (error) fail("lastAssistantLine", error);
      return rows<{ text: string }>(data)[0]?.text ?? null;
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
    },
  };
}
