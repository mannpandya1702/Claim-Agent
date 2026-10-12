// Shared types and the injected dependencies. Every module takes what it needs from Deps, so the
// unit tests run against fakes (fake_store.ts, a recording fetch, a fixed clock) with no network.

import type {
  AlertStatus,
  AttemptKind,
  CallbackSource,
  Channel,
  ClaimStatus,
  ClaimType,
  Code,
  EmailKind,
  EmailStatus,
  EscalationKind,
  EscalationReason,
  EscalationStatus,
  Level,
} from "./enums.ts";

// ---------------------------------------------------------------------------------------------
// Configuration (Edge Function secrets). Optional values have documented defaults.
// ---------------------------------------------------------------------------------------------
export interface Env {
  VAPI_ORG_ID: string;
  VAPI_WEBHOOK_SECRET: string;
  VAPI_PRIVATE_KEY?: string; // backfill GET /call/{id}, structured-output run
  JOBS_BEARER?: string; // /jobs/* routes (pg_cron through pg_net)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string; // default onboarding@resend.dev
  CLAIMS_TEAM_EMAIL?: string;
  ALERT_SINKS?: string; // comma list of AlertSink; default "telegram,email"
  DASHBOARD_URL?: string; // links in alerts, hash routes: <DASHBOARD_URL>#/calls/<id>
  NATIVE_TOOL_MESSAGES?: string; // "false" omits results[].message (model reads result.message)
  PRIOR_CONTACTS_ENABLED?: string; // "true" enables the welcome-back clause
  OWN_NUMBERS?: string; // comma list of E.164 numbers we own (never a callback number)
  CAPTURE_WEBHOOKS?: string; // "true" stores raw bodies in webhook_captures
}

export interface Logger {
  (event: Record<string, unknown>): void;
}

export interface Deps {
  store: Store;
  fetch: typeof fetch;
  env: Env;
  now: () => Date;
  waitUntil: (p: Promise<unknown>) => void; // EdgeRuntime.waitUntil in production
  log: Logger;
}

// ---------------------------------------------------------------------------------------------
// Domain rows (shapes as read from Postgres).
// ---------------------------------------------------------------------------------------------
export interface Customer {
  id: string;
  phone_e164: string;
  first_name: string;
  last_name: string;
  date_of_birth?: string; // never selected by tools that do not need it
  policy_number: string;
  email: string | null;
}

export interface Claim {
  id: string;
  customer_id: string;
  claim_number: string;
  claim_type: ClaimType;
  status: ClaimStatus;
  status_detail: string | null;
  documents_required: string[];
  documents_due: string | null; // YYYY-MM-DD
  adjuster_name: string | null;
  filed_on: string; // YYYY-MM-DD
  updated_on: string; // YYYY-MM-DD
  amount_approved: number | null;
}

export interface Session {
  call_key: string;
  channel: string;
  caller_number: string | null;
  level: Level;
  candidate_customer_id: string | null;
  verified_customer_id: string | null;
}

export interface AttemptRow {
  call_key: string;
  tool_call_id: string;
  tool_name: string;
  kind: AttemptKind | null;
  code: string | null;
  created_at: string;
}

export interface EscalationRow {
  id: string;
  call_key: string;
  kind: EscalationKind;
  reason: EscalationReason;
  details: string | null;
  callback_phone: string | null;
  channel: string;
  verified: boolean;
  callback_source: CallbackSource | null;
  alert_status: AlertStatus;
  delivery_error: string | null;
  status: EscalationStatus;
  created_at: string;
}

export interface EmailRow {
  call_key: string;
  kind: EmailKind;
  to_masked: string;
  resend_id: string | null;
  status: EmailStatus;
  error: string | null;
}

export interface PriorInteraction {
  vapi_call_id: string;
  started_at: string; // ISO timestamp
  summary: string | null;
}

// The post-call record as written through upsert_interaction(jsonb). Every field is optional
// except the key; the SQL merge decides what an absent value means.
export interface InteractionRow {
  vapi_call_id: string;
  channel?: string | null;
  customer_id?: string | null;
  caller_name?: string | null;
  caller_phone?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  sentiment_source?: string | null;
  outcome?: string | null;
  escalated?: boolean;
  emergency?: boolean;
  flags?: string[];
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
  ended_reason?: string | null;
  transcript?: string | null;
  recording_url?: string | null;
  cost?: number | null;
  success_evaluation?: string | null;
  analysis_raw?: unknown;
  messages?: unknown;
  latency_avg_ms?: number | null;
  cost_breakdown?: unknown;
  assistant_name?: string | null;
  analysis_status?: string;
}

export interface TranscriptLine {
  call_key: string;
  role: "user" | "assistant";
  text: string;
  ts_ms: number;
}

// ---------------------------------------------------------------------------------------------
// Store: the only path to Postgres. store.ts implements it over supabase-js (service role);
// fake_store.ts implements it in memory with the same state-machine semantics for unit tests.
// Every method throws on a database error; callers map that to system_error.
// ---------------------------------------------------------------------------------------------
export interface Store {
  // identity state machine (SQL functions in 0001_init.sql)
  lookupCustomerAttempt(p: {
    callKey: string;
    channel: string;
    phoneE164: string | null;
    toolCallId: string;
    callerNumber: string | null;
  }): Promise<{ code: Code; misses: number }>;
  verifyDobAttempt(p: {
    callKey: string;
    year: number | null;
    month: number | null;
    day: number | null;
    toolCallId: string;
  }): Promise<{ code: Code; firstName: string | null; attempts: number; customerId: string | null }>;

  getSession(callKey: string): Promise<Session | null>;
  ensureSession(callKey: string, channel: string, callerNumber: string | null): Promise<void>;
  getCustomer(id: string): Promise<Customer | null>; // without date_of_birth
  getClaims(customerId: string): Promise<Claim[]>; // ordered by filed_on, claim_number

  // tool timeline / replay guard for the uncounted tools: inserts (call_key, tool_call_id) once.
  // Returns the code stored by an earlier delivery of the same toolCallId, or null when new.
  claimAttempt(callKey: string, toolCallId: string, toolName: string): Promise<string | null>;
  setAttemptCode(callKey: string, toolCallId: string, code: string): Promise<void>;
  listAttempts(callKey: string): Promise<AttemptRow[]>;

  upsertEscalation(p: {
    callKey: string;
    kind: EscalationKind;
    reason: EscalationReason;
    details: string | null; // already redacted
    callbackPhone: string | null;
    callbackSource: CallbackSource;
    channel: string;
    verified: boolean;
  }): Promise<{ id: string; inserted: boolean; callbackPhone: string | null; alertStatus: AlertStatus }>;
  setEscalationDelivery(id: string, alertStatus: AlertStatus, deliveryError: string | null): Promise<void>;
  listEscalations(callKey: string): Promise<EscalationRow[]>;

  // at-most-once email ledger: claim moves (call_key, kind) to 'sending' exactly once.
  // Returns {claimed:true} for the first caller; otherwise the existing row's status/resend_id.
  claimEmail(callKey: string, kind: EmailKind, toMasked: string): Promise<
    { claimed: true } | { claimed: false; status: EmailStatus; resendId: string | null }
  >;
  finishEmail(callKey: string, kind: EmailKind, status: "sent" | "failed", resendId: string | null, error: string | null): Promise<void>;
  listEmails(callKey: string): Promise<EmailRow[]>;

  // last 3 completed interactions for this customer, excluding this call, newest first
  priorInteractions(customerId: string, excludeCallKey: string, limit: number): Promise<PriorInteraction[]>;

  ensureInteraction(row: InteractionRow): Promise<void>; // insert ... on conflict do nothing
  upsertInteraction(row: InteractionRow): Promise<void>; // SQL upsert_interaction(jsonb)
  insertTranscriptLine(line: TranscriptLine): Promise<void>; // on conflict do nothing
  lastAssistantLine(callKey: string): Promise<string | null>; // newest assistant text by ts_ms
  deleteTranscriptLines(callKey: string): Promise<void>;
  captureWebhook(messageType: string | null, callKey: string | null, body: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// VAPI envelope (only the fields we read; everything else passes through untyped).
// ---------------------------------------------------------------------------------------------
export interface VapiCall {
  id?: string;
  orgId?: string;
  type?: string; // webCall | inboundPhoneCall | outboundPhoneCall
  customer?: { number?: string; name?: string };
  phoneNumber?: { number?: string };
  [k: string]: unknown;
}

export interface VapiMessage {
  type?: string;
  call?: VapiCall;
  chat?: { id?: string; sessionId?: string; orgId?: string; [k: string]: unknown };
  customer?: { number?: string };
  toolCallList?: unknown[];
  toolCalls?: unknown[];
  toolWithToolCallList?: unknown[];
  status?: string;
  endedReason?: string;
  artifact?: any;
  analysis?: any;
  timestamp?: number;
  [k: string]: unknown;
}

// A tool call after envelope parsing: the name and the arguments object (parsed once).
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null; // null = arguments arrived unparseable -> bad_args
}

// What every tool returns. The sentence is spoken natively by VAPI exactly once and is also the
// `message` inside the JSON result string, so the model's history matches what was said.
export interface ToolResult {
  code: Code;
  sentence: string;
  data?: Record<string, unknown>;
}

// Per-request context handed to every tool.
export interface ToolCtx {
  callKey: string;
  channel: Channel;
  callerNumber: string | null; // message.call.customer.number when it is a real number
  isChat: boolean; // chat envelope (no call): send no Telegram or email, alert_status 'skipped'
  toolCallId: string;
  deps: Deps;
}
