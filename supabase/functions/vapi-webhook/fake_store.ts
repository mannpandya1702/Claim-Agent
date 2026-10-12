// In-memory Store for the unit tests. It mirrors 0001_init.sql instead of approximating it: the
// identity ladder runs through identity.step over counts derived from the attempts ledger (the way
// the SQL functions derive them), unique keys and CHECK lists reject what Postgres would reject,
// and upsert_interaction merges column by column like the SQL. A test that passes here should not
// be able to fail in production only because the database is stricter.
//
// Every method body runs synchronously after its failure check, so one call is atomic the way the
// call_sessions row lock makes it atomic in Postgres.

import {
  ALERT_STATUSES,
  ANALYSIS_STATUSES,
  ATTEMPT_KINDS,
  CALLBACK_SOURCES,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  ESCALATION_KINDS,
  ESCALATION_REASONS,
  LEVELS,
  OUTCOMES,
  SENTIMENT_SOURCES,
  SENTIMENTS,
} from "./enums.ts";
import type { AttemptKind, Code } from "./enums.ts";
import { step } from "./identity.ts";
import type { IdentityState } from "./identity.ts";
import type { StoreExtras } from "./store.ts";
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

/** In-memory Store with the SQL semantics (state machine via identity.step, replay guard, unique keys,
 *  upsert_interaction merge rules). failNext(method) makes the next call of that method throw. */
export interface FakeStore extends Store, StoreExtras {
  customers: (Customer & { date_of_birth: string })[];
  claims: Claim[];
  tables: Record<string, any[]>;
  failNext(method: keyof FullStore): void;
}

type FullStore = Store & StoreExtras;
type Row = Record<string, any>;

// The Store contract with synchronous bodies; createFakeStore wraps each one into a Promise.
type SyncStore = {
  [K in keyof FullStore]: (...args: Parameters<FullStore[K]>) => Awaited<ReturnType<FullStore[K]>>;
};

// The column list of upsert_interaction's INSERT, which is also every column a caller may write.
const INTERACTION_COLUMNS = [
  "vapi_call_id",
  "channel",
  "customer_id",
  "caller_name",
  "caller_phone",
  "summary",
  "sentiment",
  "sentiment_source",
  "outcome",
  "escalated",
  "emergency",
  "flags",
  "started_at",
  "ended_at",
  "duration_seconds",
  "ended_reason",
  "transcript",
  "recording_url",
  "cost",
  "success_evaluation",
  "analysis_raw",
  "messages",
  "latency_avg_ms",
  "cost_breakdown",
  "assistant_name",
  "analysis_status",
] as const;

// Text columns where the SQL merge treats '' like null (coalesce(nullif(excluded.x, ''), ci.x)).
const TEXT_KEEP_ON_EMPTY = new Set([
  "channel",
  "caller_name",
  "caller_phone",
  "summary",
  "ended_reason",
  "transcript",
  "recording_url",
  "success_evaluation",
  "assistant_name",
]);
// Columns the SQL merge keeps when the new value is null (coalesce(excluded.x, ci.x)).
const KEEP_ON_NULL = new Set([
  "customer_id",
  "sentiment",
  "sentiment_source",
  "started_at",
  "ended_at",
  "duration_seconds",
  "cost",
  "analysis_raw",
  "messages",
  "latency_avg_ms",
  "cost_breakdown",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// store.ts CAPTURE_RETENTION_MS; a value import would load supabase-js into every unit test.
const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function dbError(sqlstate: string, message: string): Error {
  return new Error(`fake store: ${sqlstate} ${message}`);
}

// Postgres rejects a malformed uuid before it looks for a row; the fake does the same so a bad id
// is a thrown error in tests too, not a quiet "not found".
function uuidArg(value: unknown): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw dbError("22P02", `invalid input syntax for type uuid: "${String(value)}"`);
  }
}

function checkIn(table: string, column: string, value: unknown, allowed: readonly string[]): void {
  if (value === null || value === undefined) return;
  if (!allowed.includes(value as string)) {
    throw dbError("23514", `new row for relation "${table}" violates check constraint on ${column}`);
  }
}

function notNull(table: string, column: string, value: unknown): void {
  if (value === null || value === undefined) {
    throw dbError("23502", `null value in column "${column}" of relation "${table}" violates not-null constraint`);
  }
}

function integerOrNull(column: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw dbError("22P02", `invalid input syntax for type integer: "${String(value)}" (${column})`);
  }
}

function timestampOrNull(column: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw dbError("22007", `invalid input syntax for type timestamp with time zone: "${String(value)}" (${column})`);
  }
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The date Postgres make_date would build, as YYYY-MM-DD, or null where verify_dob_attempt
 *  treats the parts as unreadable (missing, year outside 1900..this year, impossible date). */
function sqlDate(year: number | null, month: number | null, day: number | null): string | null {
  for (const v of [year, month, day]) {
    // the SQL parameters are int: a fractional number is a type error there, not an unreadable DOB
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) {
      throw dbError("22P02", `invalid input syntax for type integer: "${String(v)}"`);
    }
  }
  if (year === null || month === null || day === null) return null;
  if (year < 1900 || year > new Date().getUTCFullYear()) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The generated status column of call_interactions.
function interactionStatus(r: Row): string {
  if (r.ended_at === null) return "in_progress";
  if (r.caller_name !== null && r.summary !== null && r.sentiment !== null && r.started_at !== null) return "completed";
  return "incomplete";
}

export function createFakeStore(
  seed?: { customers?: (Customer & { date_of_birth: string })[]; claims?: Claim[] },
): FakeStore {
  const base = seed ?? demoSeed();
  const customers = clone(base.customers ?? []);
  const claims = clone(base.claims ?? []);
  const tables: Record<string, any[]> = {
    customers,
    claims,
    call_sessions: [],
    attempts: [],
    escalations: [],
    emails: [],
    call_interactions: [],
    transcript_lines: [],
    webhook_captures: [],
  };
  let transcriptSeq = 0;
  let captureSeq = 0;

  const pendingFailures = new Map<string, number>();
  function maybeFail(method: keyof FullStore): void {
    const n = pendingFailures.get(method) ?? 0;
    if (n > 0) {
      pendingFailures.set(method, n - 1);
      throw new Error(`fake store: ${method} failed`);
    }
  }

  function session(callKey: string): Row | undefined {
    return tables.call_sessions.find((s) => s.call_key === callKey);
  }

  function insertSessionIfMissing(callKey: string, channel: string | null, callerNumber: string | null): Row {
    const existing = session(callKey);
    if (existing) return existing;
    notNull("call_sessions", "call_key", callKey);
    notNull("call_sessions", "channel", channel);
    const at = nowIso();
    const row: Row = {
      call_key: callKey,
      channel,
      caller_number: callerNumber,
      level: "none",
      candidate_customer_id: null,
      verified_customer_id: null,
      created_at: at,
      updated_at: at,
    };
    tables.call_sessions.push(row);
    return row;
  }

  function findAttempt(callKey: string, toolCallId: string): Row | undefined {
    return tables.attempts.find((a) => a.call_key === callKey && a.tool_call_id === toolCallId);
  }

  function insertAttempt(
    callKey: string,
    toolCallId: string,
    toolName: string,
    kind: AttemptKind,
    code: string | null,
  ) {
    if (findAttempt(callKey, toolCallId)) {
      throw dbError("23505", 'duplicate key value violates unique constraint "attempts_pkey"');
    }
    notNull("attempts", "tool_name", toolName);
    checkIn("attempts", "kind", kind, ATTEMPT_KINDS);
    tables.attempts.push({
      call_key: callKey,
      tool_call_id: toolCallId,
      tool_name: toolName,
      kind,
      code,
      created_at: nowIso(),
    });
  }

  // The SQL functions read the level from the session row and every counter from the ledger.
  function identityOf(callKey: string): IdentityState {
    const s = session(callKey)!;
    const rows = tables.attempts.filter((a) => a.call_key === callKey);
    return {
      level: s.level,
      misses: rows.filter((a) => a.kind === "lookup_miss").length,
      wrong: rows.filter((a) => a.kind === "dob_wrong").length,
      unreadable: rows.filter((a) => a.kind === "unreadable" && a.tool_name === "verify_identity").length,
      candidate: s.candidate_customer_id,
      verified: s.verified_customer_id,
    };
  }

  function applyIdentity(callKey: string, next: IdentityState): void {
    const s = session(callKey)!;
    if (
      s.level === next.level && s.candidate_customer_id === next.candidate && s.verified_customer_id === next.verified
    ) return;
    checkIn("call_sessions", "level", next.level, LEVELS);
    s.level = next.level;
    s.candidate_customer_id = next.candidate;
    s.verified_customer_id = next.verified;
    s.updated_at = nowIso();
  }

  function firstNameOf(customerId: string | null): string | null {
    return customers.find((c) => c.id === customerId)?.first_name ?? null;
  }

  function validateInteraction(r: Row): void {
    notNull("call_interactions", "vapi_call_id", r.vapi_call_id);
    for (const c of ["escalated", "emergency", "flags", "analysis_status"]) notNull("call_interactions", c, r[c]);
    checkIn("call_interactions", "sentiment", r.sentiment, SENTIMENTS);
    checkIn("call_interactions", "sentiment_source", r.sentiment_source, SENTIMENT_SOURCES);
    checkIn("call_interactions", "outcome", r.outcome, OUTCOMES);
    checkIn("call_interactions", "analysis_status", r.analysis_status, ANALYSIS_STATUSES);
    integerOrNull("duration_seconds", r.duration_seconds);
    integerOrNull("latency_avg_ms", r.latency_avg_ms);
    timestampOrNull("started_at", r.started_at);
    timestampOrNull("ended_at", r.ended_at);
    if (r.customer_id !== null) uuidArg(r.customer_id);
    if (!Array.isArray(r.flags)) throw dbError("22P02", "malformed array literal (flags)");
  }

  function checkCustomerFk(customerId: unknown): void {
    if (customerId === null || customerId === undefined) return;
    if (!customers.some((c) => c.id === customerId)) {
      throw dbError("23503", 'insert or update on table "call_interactions" violates foreign key constraint');
    }
  }

  function insertInteraction(values: Row): void {
    checkCustomerFk(values.customer_id);
    const at = nowIso();
    const row: Row = { id: crypto.randomUUID(), ...values, staff_notes: null, created_at: at, updated_at: at };
    row.status = interactionStatus(row);
    tables.call_interactions.push(row);
  }

  const impl: SyncStore = {
    lookupCustomerAttempt(p): { code: Code; misses: number } {
      insertSessionIfMissing(p.callKey, p.channel ?? "unknown", p.callerNumber ?? null);
      const before = identityOf(p.callKey);
      const prior = findAttempt(p.callKey, p.toolCallId);
      if (prior) return { code: prior.code as Code, misses: before.misses };

      const customerId = p.phoneE164 === null ? null : customers.find((c) => c.phone_e164 === p.phoneE164)?.id ?? null;
      const { state, code } = step(before, { type: "lookup", phoneE164: p.phoneE164, customerId });
      const kind: AttemptKind = code === "needs_dob"
        ? "lookup_hit"
        : state.misses > before.misses
        ? "lookup_miss"
        : code === "invalid_phone"
        ? "unreadable"
        : "other";
      applyIdentity(p.callKey, state);
      insertAttempt(p.callKey, p.toolCallId, "lookup_customer", kind, code);
      return { code, misses: state.misses };
    },

    verifyDobAttempt(p) {
      insertSessionIfMissing(p.callKey, "unknown", null);
      const before = identityOf(p.callKey);
      const prior = findAttempt(p.callKey, p.toolCallId);
      if (prior) {
        if (prior.code === "verified") {
          return {
            code: "verified",
            firstName: firstNameOf(before.verified),
            attempts: before.wrong,
            customerId: before.verified,
          };
        }
        return { code: prior.code as Code, firstName: null, attempts: before.wrong, customerId: null };
      }

      const given = sqlDate(p.year, p.month, p.day);
      const dob = customers.find((c) => c.id === before.candidate)?.date_of_birth ?? null;
      const { state, code } = step(before, {
        type: "dob",
        valid: given !== null,
        matches: given !== null && dob === given,
      });
      const kind: AttemptKind = code === "verified" && before.level !== "verified"
        ? "dob_ok"
        : state.wrong > before.wrong
        ? "dob_wrong"
        : state.unreadable > before.unreadable
        ? "unreadable"
        : "other";
      applyIdentity(p.callKey, state);
      insertAttempt(p.callKey, p.toolCallId, "verify_identity", kind, code);
      if (code === "verified") {
        return { code, firstName: firstNameOf(state.verified), attempts: state.wrong, customerId: state.verified };
      }
      return { code, firstName: null, attempts: state.wrong, customerId: null };
    },

    getSession(callKey): Session | null {
      const s = session(callKey);
      if (!s) return null;
      return {
        call_key: s.call_key,
        channel: s.channel,
        caller_number: s.caller_number,
        level: s.level,
        candidate_customer_id: s.candidate_customer_id,
        verified_customer_id: s.verified_customer_id,
      };
    },

    ensureSession(callKey, channel, callerNumber) {
      insertSessionIfMissing(callKey, channel, callerNumber);
    },

    getCustomer(id): Customer | null {
      uuidArg(id);
      const c = customers.find((x) => x.id === id);
      if (!c) return null;
      return {
        id: c.id,
        phone_e164: c.phone_e164,
        first_name: c.first_name,
        last_name: c.last_name,
        policy_number: c.policy_number,
        email: c.email,
      };
    },

    getClaims(customerId): Claim[] {
      uuidArg(customerId);
      return clone(
        claims
          .filter((c) => c.customer_id === customerId)
          .sort((a, b) =>
            a.filed_on < b.filed_on
              ? -1
              : a.filed_on > b.filed_on
              ? 1
              : a.claim_number < b.claim_number
              ? -1
              : a.claim_number > b.claim_number
              ? 1
              : 0
          ),
      );
    },

    claimAttempt(callKey, toolCallId, toolName) {
      const prior = findAttempt(callKey, toolCallId);
      if (prior) return prior.code ?? null;
      insertAttempt(callKey, toolCallId, toolName, "other", null);
      return null;
    },

    setAttemptCode(callKey, toolCallId, code) {
      const row = findAttempt(callKey, toolCallId);
      if (row) row.code = code;
    },

    listAttempts(callKey): AttemptRow[] {
      return clone(tables.attempts.filter((a) => a.call_key === callKey)) as AttemptRow[];
    },

    upsertEscalation(p) {
      const source = p.callbackSource ?? "none";
      checkIn("escalations", "kind", p.kind, ESCALATION_KINDS);
      checkIn("escalations", "reason", p.reason, ESCALATION_REASONS);
      checkIn("escalations", "callback_source", source, CALLBACK_SOURCES);
      notNull("escalations", "kind", p.kind);
      notNull("escalations", "reason", p.reason);
      notNull("escalations", "channel", p.channel);

      const existing = tables.escalations.find((e) => e.call_key === p.callKey && e.kind === p.kind);
      if (!existing) {
        const at = nowIso();
        const row: Row = {
          id: crypto.randomUUID(),
          call_key: p.callKey,
          kind: p.kind,
          reason: p.reason,
          details: p.details,
          callback_phone: p.callbackPhone,
          channel: p.channel,
          verified: p.verified ?? false,
          callback_source: source,
          alert_status: "pending",
          delivery_error: null,
          status: "open",
          claimed_by: null,
          claimed_at: null,
          closed_by: null,
          closed_at: null,
          close_note: null,
          realerted_at: null,
          created_at: at,
          updated_at: at,
        };
        tables.escalations.push(row);
        return { id: row.id, inserted: true, callbackPhone: row.callback_phone, alertStatus: row.alert_status };
      }

      // A repeat merges only a newly supplied number (with its source), fills details, ORs verified;
      // reason, channel and delivery state stay as first written.
      if (p.callbackPhone !== null) {
        existing.callback_phone = p.callbackPhone;
        existing.callback_source = source;
      }
      existing.details = p.details ?? existing.details;
      existing.verified = existing.verified || (p.verified ?? false);
      existing.updated_at = nowIso();
      return {
        id: existing.id,
        inserted: false,
        callbackPhone: existing.callback_phone,
        alertStatus: existing.alert_status,
      };
    },

    setEscalationDelivery(id, alertStatus, deliveryError) {
      uuidArg(id);
      checkIn("escalations", "alert_status", alertStatus, ALERT_STATUSES);
      notNull("escalations", "alert_status", alertStatus);
      const row = tables.escalations.find((e) => e.id === id);
      if (!row) return;
      row.alert_status = alertStatus;
      row.delivery_error = deliveryError;
      row.updated_at = nowIso();
    },

    listEscalations(callKey): EscalationRow[] {
      return tables.escalations
        .filter((e) => e.call_key === callKey)
        .map((e) => ({
          id: e.id,
          call_key: e.call_key,
          kind: e.kind,
          reason: e.reason,
          details: e.details,
          callback_phone: e.callback_phone,
          channel: e.channel,
          verified: e.verified,
          callback_source: e.callback_source,
          alert_status: e.alert_status,
          delivery_error: e.delivery_error,
          status: e.status,
          created_at: e.created_at,
        }));
    },

    claimEmail(callKey, kind, toMasked) {
      checkIn("emails", "kind", kind, EMAIL_KINDS);
      notNull("emails", "kind", kind);
      notNull("emails", "to_masked", toMasked);
      const existing = tables.emails.find((m) => m.call_key === callKey && m.kind === kind);
      if (existing) return { claimed: false, status: existing.status, resendId: existing.resend_id };
      tables.emails.push({
        id: crypto.randomUUID(),
        call_key: callKey,
        kind,
        to_masked: toMasked,
        resend_id: null,
        status: "sending",
        error: null,
        created_at: nowIso(),
      });
      return { claimed: true };
    },

    finishEmail(callKey, kind, status, resendId, error) {
      checkIn("emails", "status", status, EMAIL_STATUSES);
      notNull("emails", "status", status);
      const row = tables.emails.find((m) => m.call_key === callKey && m.kind === kind);
      if (!row) return;
      row.status = status;
      row.resend_id = resendId;
      row.error = error;
    },

    listEmails(callKey): EmailRow[] {
      return tables.emails
        .filter((m) => m.call_key === callKey)
        .map((m) => ({
          call_key: m.call_key,
          kind: m.kind,
          to_masked: m.to_masked,
          resend_id: m.resend_id,
          status: m.status,
          error: m.error,
        }));
    },

    priorInteractions(customerId, excludeCallKey, limit): PriorInteraction[] {
      uuidArg(customerId);
      const time = (r: Row) => (r.started_at === null ? null : Date.parse(r.started_at));
      return tables.call_interactions
        .filter((r) =>
          r.customer_id === customerId && r.vapi_call_id !== excludeCallKey && r.ended_at !== null && r.summary !== null
        )
        .sort((a, b) => {
          const ta = time(a);
          const tb = time(b);
          if (ta === tb) return 0;
          if (ta === null) return 1; // nulls last, as store.ts orders them
          if (tb === null) return -1;
          return tb - ta;
        })
        .slice(0, Math.max(0, limit))
        .map((r) => ({ vapi_call_id: r.vapi_call_id, started_at: r.started_at, summary: r.summary }));
    },

    ensureInteraction(row: InteractionRow) {
      // PostgREST rejects a key that is not a writable column; absent keys take the column default.
      for (const k of Object.keys(row)) {
        if (!(INTERACTION_COLUMNS as readonly string[]).includes(k)) {
          throw dbError("PGRST204", `Could not find the '${k}' column of 'call_interactions'`);
        }
      }
      const r: Row = {};
      for (const c of INTERACTION_COLUMNS) {
        const v = (row as Row)[c];
        r[c] = v === undefined ? null : clone(v);
      }
      if (!("escalated" in row) || row.escalated === undefined) r.escalated = false;
      if (!("emergency" in row) || row.emergency === undefined) r.emergency = false;
      if (!("flags" in row) || row.flags === undefined) r.flags = [];
      if (!("analysis_status" in row) || row.analysis_status === undefined) r.analysis_status = "pending";
      validateInteraction(r);
      if (tables.call_interactions.some((x) => x.vapi_call_id === r.vapi_call_id)) return;
      insertInteraction(r);
    },

    upsertInteraction(row: InteractionRow) {
      // jsonb_populate_record: absent keys and JSON nulls are SQL NULL; unknown keys are ignored.
      const r: Row = {};
      for (const c of INTERACTION_COLUMNS) {
        const v = (row as Row)[c];
        r[c] = v === undefined || v === null ? null : clone(v);
      }
      const values: Row = {
        ...r,
        escalated: r.escalated ?? false,
        emergency: r.emergency ?? false,
        flags: r.flags ?? [],
        analysis_status: r.analysis_status ?? "pending",
      };
      validateInteraction(values);

      const ci = tables.call_interactions.find((x) => x.vapi_call_id === values.vapi_call_id);
      if (!ci) {
        insertInteraction(values);
        return;
      }
      // Forward-only: a stub (no ended_at) never overwrites a completed row.
      if (!(ci.ended_at === null || values.ended_at !== null)) return;

      const next: Row = { ...ci };
      for (const c of TEXT_KEEP_ON_EMPTY) {
        const v = values[c];
        next[c] = v === null || v === "" ? ci[c] : v;
      }
      for (const c of KEEP_ON_NULL) next[c] = values[c] ?? ci[c];
      next.outcome = values.outcome === null || values.outcome === "in_progress"
        ? ci.outcome ?? values.outcome
        : values.outcome;
      next.escalated = ci.escalated || values.escalated;
      next.emergency = ci.emergency || values.emergency;
      next.flags = values.flags.length > 0 ? values.flags : ci.flags;
      next.analysis_status = values.analysis_status === "pending" ? ci.analysis_status : values.analysis_status;
      if (next.customer_id !== ci.customer_id) checkCustomerFk(next.customer_id);
      next.updated_at = nowIso();
      next.status = interactionStatus(next);
      Object.assign(ci, next);
    },

    storedAnalysisStatus(callKey) {
      return tables.call_interactions.find((x) => x.vapi_call_id === callKey)?.analysis_status ?? null;
    },

    insertTranscriptLine(line: TranscriptLine) {
      notNull("transcript_lines", "call_key", line.call_key);
      notNull("transcript_lines", "text", line.text);
      notNull("transcript_lines", "ts_ms", line.ts_ms);
      checkIn("transcript_lines", "role", line.role, ["user", "assistant"]);
      notNull("transcript_lines", "role", line.role);
      if (!Number.isInteger(line.ts_ms)) {
        throw dbError("22P02", `invalid input syntax for type bigint: "${String(line.ts_ms)}"`);
      }
      const dup = tables.transcript_lines.some((t) =>
        t.call_key === line.call_key && t.role === line.role && t.ts_ms === line.ts_ms
      );
      if (dup) return;
      tables.transcript_lines.push({
        id: ++transcriptSeq,
        call_key: line.call_key,
        role: line.role,
        text: line.text,
        ts_ms: line.ts_ms,
        created_at: nowIso(),
      });
    },

    lastAssistantLine(callKey) {
      let best: Row | null = null;
      for (const t of tables.transcript_lines) {
        if (t.call_key !== callKey || t.role !== "assistant") continue;
        if (!best || t.ts_ms > best.ts_ms) best = t;
      }
      return best ? best.text : null;
    },

    deleteTranscriptLines(callKey) {
      const kept = tables.transcript_lines.filter((t) => t.call_key !== callKey);
      tables.transcript_lines.splice(0, tables.transcript_lines.length, ...kept);
    },

    captureWebhook(messageType, callKey, body) {
      notNull("webhook_captures", "body", body);
      tables.webhook_captures.push({
        id: ++captureSeq,
        message_type: messageType,
        call_key: callKey,
        body: clone(body),
        received_at: nowIso(),
      });
      const cutoff = Date.now() - CAPTURE_RETENTION_MS;
      const kept = tables.webhook_captures.filter((c) => Date.parse(c.received_at) >= cutoff);
      tables.webhook_captures.splice(0, tables.webhook_captures.length, ...kept);
    },
  };

  // Each method resolves or rejects like the real store (a throw becomes a rejection), and the
  // failure injection sits in one place in front of every method.
  const methods = {} as Record<keyof FullStore, (...args: unknown[]) => Promise<unknown>>;
  for (const name of Object.keys(impl) as (keyof FullStore)[]) {
    const fn = impl[name] as (...args: unknown[]) => unknown;
    methods[name] = (...args: unknown[]) => {
      try {
        maybeFail(name);
        return Promise.resolve(fn(...args));
      } catch (e) {
        return Promise.reject(e);
      }
    };
  }

  return {
    ...(methods as unknown as FullStore),
    customers,
    claims,
    tables,
    failNext(method) {
      pendingFailures.set(method, (pendingFailures.get(method) ?? 0) + 1);
    },
  };
}

/** The seeded demo data (mirrors 0002_seed.sql; emails set to "owner@example.com" except Teague: null). */
export function demoSeed(): { customers: (Customer & { date_of_birth: string })[]; claims: Claim[] } {
  const owner = "owner@example.com";
  const tobias = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
  const ronan = "6b0d6f0e-1c11-4c7a-9a01-000000000102";
  const sloane = "6b0d6f0e-1c11-4c7a-9a01-000000000103";
  const teague = "6b0d6f0e-1c11-4c7a-9a01-000000000104";
  const ines = "6b0d6f0e-1c11-4c7a-9a01-000000000105";
  const customers = [
    customer(tobias, "+16025550101", "Tobias", "Halvorsen", "1986-03-14", "POL-7301", owner),
    customer(ronan, "+16025550102", "Ronan", "Quintero", "1979-11-02", "POL-7302", owner),
    customer(sloane, "+16025550103", "Sloane", "Marchetti", "1992-07-21", "POL-7303", owner),
    customer(teague, "+16025550104", "Teague", "Ashdown", "1965-01-30", "POL-7304", null),
    customer(ines, "+16025550105", "Ines", "Lindqvist", "1990-05-09", "POL-7305", owner),
  ];
  // The SQL seed lets Postgres generate claim ids; fixed ids here keep test assertions stable.
  const claims: Claim[] = [
    {
      id: "6b0d6f0e-1c11-4c7a-9a02-000000000201",
      customer_id: tobias,
      claim_number: "CLM-240115",
      claim_type: "auto",
      status: "payment_issued",
      status_detail: "Payment issued by direct deposit",
      documents_required: [],
      documents_due: null,
      adjuster_name: "Leona Fairbanks",
      filed_on: "2026-09-02",
      updated_on: "2026-10-08",
      amount_approved: 4820,
    },
    {
      id: "6b0d6f0e-1c11-4c7a-9a02-000000000202",
      customer_id: tobias,
      claim_number: "CLM-240198",
      claim_type: "home",
      status: "awaiting_documents",
      status_detail: "Water damage in the kitchen; review is paused until the documents arrive",
      documents_required: [
        "photos of the damage",
        "a contractor estimate",
        "proof of ownership for the damaged items",
      ],
      documents_due: "2026-10-24",
      adjuster_name: "Leona Fairbanks",
      filed_on: "2026-09-28",
      updated_on: "2026-10-06",
      amount_approved: null,
    },
    {
      id: "6b0d6f0e-1c11-4c7a-9a02-000000000203",
      customer_id: ronan,
      claim_number: "CLM-240211",
      claim_type: "auto",
      status: "under_review",
      status_detail: "A decision is expected within 5 business days",
      documents_required: [],
      documents_due: null,
      adjuster_name: "Bertrand Wexley",
      filed_on: "2026-10-01",
      updated_on: "2026-10-09",
      amount_approved: null,
    },
    {
      id: "6b0d6f0e-1c11-4c7a-9a02-000000000204",
      customer_id: sloane,
      claim_number: "CLM-240177",
      claim_type: "property",
      status: "denied",
      status_detail: "The item class is not covered by the policy; there is a 30-day appeal window",
      documents_required: [],
      documents_due: null,
      adjuster_name: "Leona Fairbanks",
      filed_on: "2026-09-15",
      updated_on: "2026-10-03",
      amount_approved: null,
    },
    {
      id: "6b0d6f0e-1c11-4c7a-9a02-000000000205",
      customer_id: teague,
      claim_number: "CLM-240230",
      claim_type: "home",
      status: "received",
      status_detail: "Received and waiting for an adjuster to be assigned",
      documents_required: [],
      documents_due: null,
      adjuster_name: null,
      filed_on: "2026-10-10",
      updated_on: "2026-10-10",
      amount_approved: null,
    },
  ];
  return { customers, claims };
}

function customer(
  id: string,
  phone: string,
  first: string,
  last: string,
  dob: string,
  policy: string,
  email: string | null,
): Customer & { date_of_birth: string } {
  return {
    id,
    phone_e164: phone,
    first_name: first,
    last_name: last,
    date_of_birth: dob,
    policy_number: policy,
    email,
  };
}
