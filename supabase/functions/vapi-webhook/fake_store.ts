// In-memory Store for the unit tests. It mirrors 0001_init.sql instead of approximating it: the
// identity ladder runs through identity.step over counts derived from the attempts ledger (the way
// the SQL functions derive them), unique keys and CHECK lists reject what Postgres would reject,
// and upsert_interaction merges column by column like the SQL. A test that passes here should not
// be able to fail in production only because the database is stricter.
//
// Every method body runs synchronously after its failure check, so one call is atomic the way the
// call_sessions row lock makes it atomic in Postgres.

import { type InteractionForMirror, MIRROR_COLUMNS } from "./airtable.ts";
import { GHL_COLUMNS, type InteractionForGhl } from "./ghl.ts";
import {
  ALERT_STATUSES,
  ANALYSIS_STATUSES,
  ATTEMPT_KINDS,
  CALL_REASON_SOURCES,
  CALL_REASONS,
  CALLBACK_SOURCES,
  CALLER_TYPES,
  CLAIM_DOCUMENTS,
  CLAIM_INTAKE_KINDS,
  CLAIM_TYPES,
  CONTACT_CALLBACK_SOURCES,
  CONTACT_KINDS,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  ESCALATION_KINDS,
  ESCALATION_REASONS,
  LEVELS,
  OUTBOX_DESTINATIONS,
  OUTBOX_KINDS,
  OUTCOMES,
  SENTIMENT_SOURCES,
  SENTIMENTS,
  TIMEZONE,
} from "./enums.ts";
import type { AttemptKind, Code } from "./enums.ts";
import { step } from "./identity.ts";
import type { IdentityState } from "./identity.ts";
import type { StoreExtras } from "./store.ts";
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
  OutboxRow,
  PriorInteraction,
  Session,
  StaleEscalation,
  Store,
  StuckInteraction,
  TranscriptLine,
} from "./types.ts";

/** In-memory Store with the SQL semantics (state machine via identity.step, replay guard, unique keys,
 *  upsert_interaction merge rules). failNext(method) makes the next call of that method throw. Every
 *  timestamp the database would take from now() comes from options.now (default: the real clock), so
 *  a test can move time for the store and the code under test together. */
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
  "caller_type",
  "caller_email",
  "call_reason",
  "call_reason_source",
  "claim_number",
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
  "caller_email",
  "claim_number",
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

// caller_contacts CHECKs (0006_contacts.sql).
const CONTACT_EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/;
const E164_RE = /^\+1[0-9]{10}$/;
const CONTACT_COLUMNS = [
  "call_key",
  "kind",
  "first_name",
  "last_name",
  "email",
  "callback_phone",
  "callback_source",
  "customer_id",
  "confirmed",
  "confirmed_at",
] as const;

// claim_intakes (0007_fnol_reasons.sql).
const INTAKE_COLUMNS = [
  "call_key",
  "kind",
  "claim_type",
  "loss_date",
  "summary",
  "description",
  "customer_id",
  "claim_id",
  "claim_number",
  "confirmed",
  "confirmed_at",
] as const;
const CLAIM_NUMBER_RE = /^CLM-[0-9]{6}$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// file_claim_intake's status detail and number draws.
const PHONE_CLAIM_DETAIL = "Reported by phone. An adjuster will be assigned within one business day.";
const CLAIM_NUMBER_DRAWS = 20;
// upsert_interaction's rank of a call_reason_source (an absent source ranks 0).
const REASON_RANK: Readonly<Record<string, number>> = { server: 3, structured_output: 2, derived: 1 };

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

// A timestamptz parameter: Postgres rejects anything it cannot parse before it reads a row.
function timestampArg(name: string, value: unknown): number {
  const t = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(t)) {
    throw dbError("22007", `invalid input syntax for type timestamp with time zone: "${String(value)}" (${name})`);
  }
  return t;
}

const before = (iso: string | null | undefined, cutoff: number) => typeof iso === "string" && Date.parse(iso) < cutoff;

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
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

// The generated caller_email_masked column (0006_contacts.sql), the same mask as email.ts maskEmail.
function maskedCallerEmail(email: unknown): string | null {
  if (typeof email !== "string" || email === "") return null;
  const at = email.indexOf("@");
  return at < 0 ? "***" : `${email.slice(0, Math.min(1, at))}***${email.slice(at)}`;
}

/** The calendar day in New York as YYYY-MM-DD: file_claim_intake's (now() at time zone ...)::date. */
function newYorkDay(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function withGenerated(r: Row): void {
  r.status = interactionStatus(r);
  r.caller_email_masked = maskedCallerEmail(r.caller_email);
}

export function createFakeStore(
  seed?: { customers?: (Customer & { date_of_birth: string })[]; claims?: Claim[] },
  options: { now?: () => Date; random?: () => number } = {},
): FakeStore {
  const clock = options.now ?? (() => new Date());
  // file_claim_intake's random(): tests pass a sequence to force a number collision.
  const random = options.random ?? Math.random;
  const nowIso = () => clock().toISOString();
  // touch_updated_at: every write moves updated_at, and two writes in Postgres never share a
  // timestamp; the outbox lease and the claim's compare-and-set rely on both.
  const touched = (prev: string | undefined): string => {
    const p = typeof prev === "string" ? Date.parse(prev) : Number.NaN;
    return new Date(Number.isFinite(p) ? Math.max(clock().getTime(), p + 1) : clock().getTime()).toISOString();
  };
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
    caller_contacts: [],
    claim_intakes: [],
    transcript_lines: [],
    webhook_captures: [],
    outbox_events: [],
    job_runs: [],
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
    notNull("call_interactions", "caller_type", r.caller_type);
    checkIn("call_interactions", "caller_type", r.caller_type, CALLER_TYPES);
    checkIn("call_interactions", "call_reason", r.call_reason, CALL_REASONS);
    checkIn("call_interactions", "call_reason_source", r.call_reason_source, CALL_REASON_SOURCES);
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

  function contactOf(row: Row): CallerContact {
    const out: Row = {};
    for (const c of CONTACT_COLUMNS) out[c] = clone(row[c]);
    return out as CallerContact;
  }

  // The caller_contacts CHECKs, NOT NULLs and the customers foreign key, as Postgres applies them.
  function validateContact(r: Row): void {
    for (const c of ["call_key", "kind", "first_name", "last_name", "callback_source", "confirmed"]) {
      notNull("caller_contacts", c, r[c]);
    }
    checkIn("caller_contacts", "kind", r.kind, CONTACT_KINDS);
    checkIn("caller_contacts", "callback_source", r.callback_source, CONTACT_CALLBACK_SOURCES);
    const violates = (column: string) =>
      dbError("23514", `new row for relation "caller_contacts" violates check constraint on ${column}`);
    for (const c of ["first_name", "last_name"]) {
      if (typeof r[c] !== "string" || [...r[c]].length < 1 || [...r[c]].length > 40) throw violates(c);
    }
    if (r.email !== null && (typeof r.email !== "string" || r.email.length > 100 || !CONTACT_EMAIL_RE.test(r.email))) {
      throw violates("email");
    }
    if (r.callback_phone !== null && (typeof r.callback_phone !== "string" || !E164_RE.test(r.callback_phone))) {
      throw violates("callback_phone");
    }
    if (r.confirmed !== (r.confirmed_at !== null)) throw violates("confirmed");
    if (r.customer_id !== null) {
      uuidArg(r.customer_id);
      if (!customers.some((c) => c.id === r.customer_id)) {
        throw dbError("23503", 'insert or update on table "caller_contacts" violates foreign key constraint');
      }
    }
  }

  function intakeOf(row: Row): ClaimIntake {
    const out: Row = {};
    for (const c of INTAKE_COLUMNS) out[c] = clone(row[c]);
    return out as ClaimIntake;
  }

  // The claim_intakes CHECKs, NOT NULLs and foreign keys, as Postgres applies them.
  function validateIntake(r: Row): void {
    for (const c of ["call_key", "kind", "claim_type", "loss_date", "summary", "description", "confirmed"]) {
      notNull("claim_intakes", c, r[c]);
    }
    checkIn("claim_intakes", "kind", r.kind, CLAIM_INTAKE_KINDS);
    checkIn("claim_intakes", "claim_type", r.claim_type, CLAIM_TYPES);
    const violates = (column: string) =>
      dbError("23514", `new row for relation "claim_intakes" violates check constraint on ${column}`);
    if (typeof r.loss_date !== "string" || !ISO_DAY_RE.test(r.loss_date) || !Number.isFinite(Date.parse(r.loss_date))) {
      throw dbError("22007", `invalid input syntax for type date: "${String(r.loss_date)}"`);
    }
    if (typeof r.summary !== "string" || [...r.summary].length < 1 || [...r.summary].length > 80) {
      throw violates("summary");
    }
    if (typeof r.description !== "string" || [...r.description].length < 1 || [...r.description].length > 500) {
      throw violates("description");
    }
    if (r.claim_number !== null && (typeof r.claim_number !== "string" || !CLAIM_NUMBER_RE.test(r.claim_number))) {
      throw violates("claim_number");
    }
    if (r.confirmed !== (r.confirmed_at !== null)) throw violates("confirmed");
    if (r.customer_id !== null) {
      uuidArg(r.customer_id);
      if (!customers.some((c) => c.id === r.customer_id)) {
        throw dbError("23503", 'insert or update on table "claim_intakes" violates foreign key constraint');
      }
    }
  }

  // file_claim_intake's claims insert: a number drawn until unused, the per-type documents, today in
  // New York, and the call that filed it (claims_reported_call_key_idx: one claim per call).
  function insertPhoneClaim(intake: Row): { id: string; number: string } {
    if (intake.customer_id === null) throw dbError("23502", `claim intake ${intake.call_key} has no customer`);
    if (claims.some((c) => (c as Row).reported_call_key === intake.call_key)) {
      throw dbError("23505", 'duplicate key value violates unique constraint "claims_reported_call_key_idx"');
    }
    for (let i = 0; i < CLAIM_NUMBER_DRAWS; i++) {
      const number = `CLM-${String(Math.floor(random() * 1_000_000)).padStart(6, "0")}`;
      if (claims.some((c) => c.claim_number === number)) continue;
      const today = newYorkDay(clock());
      const id = crypto.randomUUID();
      const row: Claim & { reported_call_key: string } = {
        id,
        customer_id: intake.customer_id,
        claim_number: number,
        claim_type: intake.claim_type,
        status: "received",
        status_detail: PHONE_CLAIM_DETAIL,
        documents_required: [...CLAIM_DOCUMENTS[intake.claim_type as keyof typeof CLAIM_DOCUMENTS]],
        documents_due: null,
        adjuster_name: null,
        filed_on: today,
        updated_on: today,
        amount_approved: null,
        reported_call_key: intake.call_key,
      };
      claims.push(row);
      return { id, number };
    }
    throw dbError("23505", `no unused claim number after ${CLAIM_NUMBER_DRAWS} draws`);
  }

  function outboxRow(o: Row): OutboxRow {
    return {
      id: o.id,
      kind: o.kind,
      ref_id: o.ref_id,
      destination: o.destination,
      attempts: o.attempts,
      delivered_at: o.delivered_at,
      last_error: o.last_error,
      external_id: o.external_id,
      progress: clone(o.progress),
      next_attempt_at: o.next_attempt_at,
      created_at: o.created_at,
      updated_at: o.updated_at,
    };
  }

  function insertInteraction(values: Row): void {
    checkCustomerFk(values.customer_id);
    const at = nowIso();
    const row: Row = { id: crypto.randomUUID(), ...values, staff_notes: null, created_at: at, updated_at: at };
    withGenerated(row);
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
      // store.ts selects the Claim columns only; reported_call_key stays behind
      return clone(
        claims
          .filter((c) => c.customer_id === customerId)
          .map(({ reported_call_key: _call, ...c }: Claim & { reported_call_key?: string }) => c)
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

    // upsert_caller_contact: insert or replace; the confirmation survives only an identical read-back
    // (same kind, names and email).
    upsertContact(p): CallerContact {
      const next: Row = {
        call_key: p.callKey,
        kind: p.kind,
        first_name: p.firstName,
        last_name: p.lastName,
        email: p.email ?? null,
        callback_phone: p.callbackPhone ?? null,
        callback_source: p.callbackSource ?? "none",
        customer_id: p.customerId ?? null,
        confirmed: false,
        confirmed_at: null,
      };
      const existing = tables.caller_contacts.find((c) => c.call_key === p.callKey);
      if (existing) {
        // 0009: the number said (and where it came from) is part of what the caller confirmed
        const same = existing.kind === next.kind && existing.first_name === next.first_name &&
          existing.last_name === next.last_name && existing.email === next.email &&
          existing.callback_phone === next.callback_phone && existing.callback_source === next.callback_source;
        next.confirmed = same && existing.confirmed;
        next.confirmed_at = same ? existing.confirmed_at : null;
      }
      validateContact(next);
      const at = nowIso();
      if (existing) {
        Object.assign(existing, next, { updated_at: touched(existing.updated_at) });
        return contactOf(existing);
      }
      const row = { ...next, created_at: at, updated_at: at };
      tables.caller_contacts.push(row);
      return contactOf(row);
    },

    getContact(callKey): CallerContact | null {
      const row = tables.caller_contacts.find((c) => c.call_key === callKey);
      return row ? contactOf(row) : null;
    },

    // set_caller_contact_confirmed: true keeps the first confirmation time, false clears it.
    setContactConfirmed(callKey, confirmed): CallerContact | null {
      const row = tables.caller_contacts.find((c) => c.call_key === callKey);
      if (!row) return null;
      const on = confirmed === true;
      row.confirmed = on;
      row.confirmed_at = on ? row.confirmed_at ?? nowIso() : null;
      row.updated_at = touched(row.updated_at);
      return contactOf(row);
    },

    // upsert_claim_intake: insert or replace the unconfirmed intake; a filed one comes back unchanged.
    upsertClaimIntake(p): ClaimIntake {
      const existing = tables.claim_intakes.find((r) => r.call_key === p.callKey);
      if (existing?.confirmed) return intakeOf(existing);
      const next: Row = {
        call_key: p.callKey,
        kind: p.kind,
        claim_type: p.claimType,
        loss_date: p.lossDate,
        summary: p.summary,
        description: p.description,
        customer_id: p.customerId ?? null,
        claim_id: existing?.claim_id ?? null,
        claim_number: existing?.claim_number ?? null,
        confirmed: false,
        confirmed_at: null,
      };
      validateIntake(next);
      if (existing) {
        Object.assign(existing, next, { updated_at: touched(existing.updated_at) });
        return intakeOf(existing);
      }
      const at = nowIso();
      const row = { ...next, created_at: at, updated_at: at };
      tables.claim_intakes.push(row);
      return intakeOf(row);
    },

    // file_claim_intake: once; a claim gets its claims row, a lead intake none; a filed row as it is.
    fileClaimIntake(callKey): { intake: ClaimIntake; filedNow: boolean } | null {
      const row = tables.claim_intakes.find((r) => r.call_key === callKey);
      if (!row) return null;
      // filed already (by an earlier or a parallel delivery): the same row, and not this call's filing
      if (row.confirmed) return { intake: intakeOf(row), filedNow: false };
      const filed = row.kind === "claim" ? insertPhoneClaim(row) : null;
      Object.assign(row, {
        claim_id: filed?.id ?? null,
        claim_number: filed?.number ?? null,
        confirmed: true,
        confirmed_at: nowIso(),
        updated_at: touched(row.updated_at),
      });
      return { intake: intakeOf(row), filedNow: true };
    },

    // reject_claim_intake: unconfirmed stays unconfirmed; a filed intake is never un-filed.
    rejectClaimIntake(callKey): ClaimIntake | null {
      const row = tables.claim_intakes.find((r) => r.call_key === callKey);
      if (!row) return null;
      if (!row.confirmed) row.updated_at = touched(row.updated_at);
      return intakeOf(row);
    },

    getClaimIntake(callKey): ClaimIntake | null {
      const row = tables.claim_intakes.find((r) => r.call_key === callKey);
      return row ? intakeOf(row) : null;
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
      if (!("caller_type" in row) || row.caller_type === undefined) r.caller_type = "unknown";
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
        caller_type: r.caller_type ?? "unknown",
        caller_email: r.caller_email === "" ? null : r.caller_email,
        // a reason's source is stored only with a reason
        call_reason_source: r.call_reason === null ? null : r.call_reason_source,
        claim_number: r.claim_number === "" ? null : r.claim_number,
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
      // existing/new replace unknown; nothing is ever downgraded to unknown
      next.caller_type = values.caller_type === "unknown" ? ci.caller_type : values.caller_type;
      // a reason from a source ranked at least as high replaces the stored one, its source with it
      const outranks = values.call_reason !== null &&
        (REASON_RANK[values.call_reason_source] ?? 0) >= (REASON_RANK[ci.call_reason_source] ?? 0);
      next.call_reason = outranks ? values.call_reason : ci.call_reason;
      next.call_reason_source = outranks ? values.call_reason_source : ci.call_reason_source;
      if (next.customer_id !== ci.customer_id) checkCustomerFk(next.customer_id);
      next.updated_at = nowIso();
      withGenerated(next);
      Object.assign(ci, next);
    },

    storedAnalysisStatus(callKey) {
      return tables.call_interactions.find((x) => x.vapi_call_id === callKey)?.analysis_status ?? null;
    },

    interactionEnded(callKey) {
      return typeof tables.call_interactions.find((x) => x.vapi_call_id === callKey)?.ended_at === "string";
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
      const cutoff = clock().getTime() - CAPTURE_RETENTION_MS;
      const kept = tables.webhook_captures.filter((c) => Date.parse(c.received_at) >= cutoff);
      tables.webhook_captures.splice(0, tables.webhook_captures.length, ...kept);
    },

    // enqueue_outbox: insert, or re-arm the existing (kind, ref_id, destination) row with a fresh budget;
    // either way next_attempt_at = now() + the delay, and a re-arm keeps progress and external_id.
    enqueueOutbox(kind, refId, destination = "airtable", delayS = 0) {
      notNull("outbox_events", "kind", kind);
      notNull("outbox_events", "ref_id", refId);
      notNull("outbox_events", "destination", destination);
      checkIn("outbox_events", "kind", kind, OUTBOX_KINDS);
      checkIn("outbox_events", "destination", destination, OUTBOX_DESTINATIONS);
      integerOrNull("p_delay_s", delayS);
      const delayMs = Math.max(delayS ?? 0, 0) * 1000;
      const existing = tables.outbox_events.find((o) =>
        o.kind === kind && o.ref_id === refId && o.destination === destination
      );
      if (existing) {
        // the update's now() is its write time, as one statement shares one now() in Postgres
        const updated_at = touched(existing.updated_at);
        const next_attempt_at = new Date(Date.parse(updated_at) + delayMs).toISOString();
        Object.assign(existing, { delivered_at: null, attempts: 0, last_error: null, next_attempt_at, updated_at });
        return;
      }
      const at = nowIso();
      tables.outbox_events.push({
        id: crypto.randomUUID(),
        kind,
        ref_id: refId,
        destination,
        delivered_at: null,
        attempts: 0,
        last_error: null,
        external_id: null,
        progress: {},
        next_attempt_at: new Date(Date.parse(at) + delayMs).toISOString(),
        created_at: at,
        updated_at: at,
      });
    },

    // store.ts claimOutbox: the head of the queue (or the ref's row, else the destination's rows), the
    // due rows outside a lease, each bumped once. One synchronous body, so the compare-and-set always
    // holds here.
    claimOutbox(limit, ref, destination): OutboxRow[] {
      integerOrNull("p_limit", limit);
      notNull("claim_outbox", "p_limit", limit);
      const nowMs = clock().getTime();
      const due = tables.outbox_events
        .filter((o) => o.delivered_at === null && o.attempts < OUTBOX_MAX_ATTEMPTS)
        .filter((o) => !o.next_attempt_at || Date.parse(o.next_attempt_at) <= nowMs + OUTBOX_DUE_SLACK_MS)
        .filter((o) => !ref || (o.kind === ref.kind && o.ref_id === ref.refId && o.destination === ref.destination))
        .filter((o) => ref || !destination || o.destination === destination)
        // insertion order breaks a tie, as distinct transactions never share created_at in Postgres
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, 50)
        .filter((o) => outboxClaimable(o as OutboxRow, nowMs))
        .slice(0, Math.max(limit, 1));
      for (const o of due) {
        o.attempts += 1;
        o.updated_at = touched(o.updated_at);
      }
      return due.map(outboxRow);
    },

    finishOutbox(id, result) {
      uuidArg(id);
      const row = tables.outbox_events.find((o) => o.id === id);
      if (!row) return false;
      if (typeof result.attempt === "number" && row.attempts !== result.attempt) return false;
      if (typeof result.claimedAt === "string" && Date.parse(row.updated_at) !== Date.parse(result.claimedAt)) {
        return false;
      }
      if (result.delivered) {
        row.delivered_at = nowIso();
        row.last_error = null;
        if (result.externalId) row.external_id = result.externalId;
      } else {
        row.last_error = outboxErrorText(result.error);
        if (result.dead) row.attempts = OUTBOX_MAX_ATTEMPTS;
        else if (result.refund && typeof result.attempt === "number") row.attempts = Math.max(result.attempt - 1, 0);
        const wait = result.retryAfterS;
        if (!result.dead && typeof wait === "number" && Number.isFinite(wait) && wait > 0) {
          row.next_attempt_at = new Date(clock().getTime() + Math.ceil(wait) * 1000).toISOString();
        }
      }
      row.updated_at = touched(row.updated_at);
      return true;
    },

    // save_outbox_progress: the merge always lands; held reports whether the guard's claim still holds.
    saveOutboxProgress(id, patch, guard): { savedAt: string; held: boolean } | null {
      uuidArg(id);
      integerOrNull("p_attempts", guard.attempt);
      timestampArg("p_claimed_at", guard.claimedAt);
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw dbError("23514", 'new row for relation "outbox_events" violates check constraint on progress');
      }
      const row = tables.outbox_events.find((o) => o.id === id);
      if (!row) return null;
      const held = row.attempts === guard.attempt && Date.parse(row.updated_at) === Date.parse(guard.claimedAt) &&
        row.delivered_at === null;
      row.progress = { ...(row.progress ?? {}), ...clone(patch) };
      row.updated_at = touched(row.updated_at);
      return { savedAt: row.updated_at, held };
    },

    getInteractionForMirror(vapiCallId): InteractionForMirror | null {
      const r = tables.call_interactions.find((x) => x.vapi_call_id === vapiCallId);
      if (!r) return null;
      const out: Row = {};
      for (const c of MIRROR_COLUMNS) out[c] = clone(r[c]);
      return out as InteractionForMirror;
    },

    getInteractionForGhl(vapiCallId): InteractionForGhl | null {
      const r = tables.call_interactions.find((x) => x.vapi_call_id === vapiCallId);
      if (!r) return null;
      const out: Row = {};
      for (const c of GHL_COLUMNS) out[c] = clone(r[c] ?? null);
      return out as InteractionForGhl;
    },

    listOutboxGaps(fromIso, toIso, destination = "airtable"): string[] {
      const from = timestampArg("from", fromIso);
      const to = timestampArg("to", toIso);
      return tables.call_interactions
        .filter((r) => typeof r.ended_at === "string" && Date.parse(r.ended_at) >= from && Date.parse(r.ended_at) < to)
        .sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at))
        .filter((r) =>
          outboxGap(
            r.updated_at,
            tables.outbox_events.find((o) =>
              o.kind === "interaction.completed" && o.destination === destination && o.ref_id === r.vapi_call_id
            ),
            destination,
          )
        )
        .slice(0, JOB_LIST_LIMIT)
        .map((r) => r.vapi_call_id);
    },

    claimJobRun(job, periodKey) {
      notNull("job_runs", "job", job);
      notNull("job_runs", "period_key", periodKey);
      if (tables.job_runs.some((j) => j.job === job && j.period_key === periodKey)) return false;
      tables.job_runs.push({ job, period_key: periodKey, started_at: nowIso(), finished_at: null, result: null });
      return true;
    },

    finishJobRun(job, periodKey, result) {
      const row = tables.job_runs.find((j) => j.job === job && j.period_key === periodKey);
      if (!row) return;
      row.finished_at = nowIso();
      row.result = clone(result);
    },

    releaseJobRun(job, periodKey) {
      const open = (j: Row) => j.job === job && j.period_key === periodKey && j.finished_at === null;
      const kept = tables.job_runs.filter((j) => !open(j));
      tables.job_runs.splice(0, tables.job_runs.length, ...kept);
    },

    listStaleEscalations(cutoffIso): StaleEscalation[] {
      const cutoff = timestampArg("cutoff", cutoffIso);
      return tables.escalations
        .filter((e) =>
          e.status === "open" && before(e.created_at, cutoff) && e.realerted_at === null && e.channel !== "chat"
        )
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, JOB_LIST_LIMIT)
        .map((e) => ({
          id: e.id,
          call_key: e.call_key,
          kind: e.kind,
          reason: e.reason,
          channel: e.channel,
          verified: e.verified,
          created_at: e.created_at,
        }));
    },

    markRealerted(id) {
      uuidArg(id);
      const row = tables.escalations.find((e) => e.id === id);
      if (!row || row.realerted_at !== null || row.status !== "open") return false;
      row.realerted_at = nowIso();
      row.updated_at = row.realerted_at;
      return true;
    },

    digestStats(fromIso, toIso) {
      const from = timestampArg("from", fromIso);
      const to = timestampArg("to", toIso);
      const inWindow = (iso: string) => Date.parse(iso) >= from && Date.parse(iso) < to;
      const calls: DigestCallRow[] = tables.call_interactions.filter((r) => inWindow(r.created_at)).map((r) => ({
        outcome: r.outcome,
        sentiment: r.sentiment,
        flags: clone(r.flags),
        cost: r.cost,
        ended_at: r.ended_at,
      }));
      const statuses = tables.escalations.filter((e) => inWindow(e.created_at)).map((e) => e.status as string);
      const sent = tables.emails.filter((m) => m.status === "sent" && inWindow(m.created_at)).length;
      return digestFromRows(calls, statuses, sent);
    },

    listStuckInteractions(cutoffIso): StuckInteraction[] {
      const cutoff = timestampArg("cutoff", cutoffIso);
      return tables.call_interactions
        .filter((r) => r.ended_at === null && before(r.created_at, cutoff))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, JOB_LIST_LIMIT)
        .map((r) => ({ vapi_call_id: r.vapi_call_id, created_at: r.created_at }));
    },

    reapInteraction(vapiCallId) {
      const row = tables.call_interactions.find((r) => r.vapi_call_id === vapiCallId);
      if (!row || row.ended_at !== null) return false;
      const at = nowIso();
      Object.assign(row, {
        outcome: "abandoned",
        analysis_status: "missing",
        ended_at: at,
        ended_reason: row.ended_reason ?? "reaped",
        updated_at: at,
      });
      withGenerated(row);
      return true;
    },

    deleteOldTranscriptLines(cutoffIso) {
      const cutoff = timestampArg("cutoff", cutoffIso);
      const kept = tables.transcript_lines.filter((t) => !before(t.created_at, cutoff));
      const deleted = tables.transcript_lines.length - kept.length;
      tables.transcript_lines.splice(0, tables.transcript_lines.length, ...kept);
      return deleted;
    },

    pruneWebhookCaptures(cutoffIso) {
      const cutoff = timestampArg("cutoff", cutoffIso);
      const kept = tables.webhook_captures.filter((c) => !before(c.received_at, cutoff));
      const deleted = tables.webhook_captures.length - kept.length;
      tables.webhook_captures.splice(0, tables.webhook_captures.length, ...kept);
      return deleted;
    },

    pruneJobRuns(jobs, cutoffIso) {
      const cutoff = timestampArg("cutoff", cutoffIso);
      const kept = tables.job_runs.filter((j) => !(jobs.includes(j.job) && before(j.started_at, cutoff)));
      const deleted = tables.job_runs.length - kept.length;
      tables.job_runs.splice(0, tables.job_runs.length, ...kept);
      return deleted;
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
