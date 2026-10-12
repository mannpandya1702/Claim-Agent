// VAPI-shaped server-message envelopes for the scripts that drive the webhook from outside
// (smoke_tools, replays). Only the fields the webhook reads are built, in the flat shape VAPI
// delivers: message.type, message.call {id, orgId, type} (or message.chat for a chat session),
// and per-type fields. A builder never invents PII: callers pass fictional 555 values.

export type CallChannel = "webCall" | "inboundPhoneCall" | "outboundPhoneCall";

/** Who the envelope is from. channel "chat" builds message.chat {id, orgId} with no call. */
export interface EnvelopeRef {
  callKey: string;
  orgId: string;
  channel?: CallChannel | "chat";
  customerNumber?: string; // caller id on phone channels; omitted on web calls and chats
}

export interface ToolCallSpec {
  id: string;
  name: string;
  /** An object, or a raw string sent as-is (malformed-argument cases). Absent -> {}. */
  args?: Record<string, unknown> | string;
}

export interface TranscriptSpec {
  role: "user" | "assistant";
  text: string;
  timestamp?: number; // ms since epoch, as VAPI sends it
  transcriptType?: "final" | "partial";
  /** VAPI names the filtered final-only subscription 'transcript[transcriptType="final"]'. */
  typeName?: "transcript" | 'transcript[transcriptType="final"]';
}

export interface EndOfCallSpec {
  startedAt?: string | null; // ISO; null omits it (a call that never connected)
  endedAt?: string | null;
  endedReason?: string;
  durationSeconds?: number;
  cost?: number;
  summary?: string | null;
  sentiment?: "positive" | "neutral" | "negative" | null;
  outcome?: string | null;
  callerName?: string | null;
  successEvaluation?: string | null;
  /** artifact.messages in VAPI's shape (role bot/user/tool_calls/tool_call_result). */
  messages?: Record<string, unknown>[];
  transcript?: string | null;
  recordingUrl?: string | null;
  assistantName?: string | null;
}

export interface WebhookTarget {
  url: string; // .../functions/v1/vapi-webhook
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PostResult {
  status: number;
  headers: Headers;
  text: string;
  json: unknown; // parsed body, or null when it is not JSON
}

type Obj = Record<string, unknown>;

/** message.call or message.chat for the ref; the org check reads orgId from either. */
export function origin(ref: EnvelopeRef): Obj {
  if (ref.channel === "chat") return { chat: { id: ref.callKey, orgId: ref.orgId } };
  const call: Obj = { id: ref.callKey, orgId: ref.orgId, type: ref.channel ?? "webCall" };
  if (ref.customerNumber) call.customer = { number: ref.customerNumber };
  return { call };
}

/** A flat tool-calls delivery: toolCallList only, arguments as an object (VAPI's current shape). */
export function toolCallsEnvelope(ref: EnvelopeRef, calls: ToolCallSpec[]): { message: Obj } {
  return {
    message: {
      type: "tool-calls",
      ...origin(ref),
      toolCallList: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args ?? {} },
      })),
    },
  };
}

export function statusUpdateEnvelope(ref: EnvelopeRef, status: string, extra: Obj = {}): { message: Obj } {
  return { message: { type: "status-update", status, ...origin(ref), ...extra } };
}

export function transcriptEnvelope(ref: EnvelopeRef, line: TranscriptSpec): { message: Obj } {
  return {
    message: {
      type: line.typeName ?? 'transcript[transcriptType="final"]',
      role: line.role,
      transcriptType: line.transcriptType ?? "final",
      transcript: line.text,
      timestamp: line.timestamp ?? Date.now(),
      ...origin(ref),
    },
  };
}

/** An end-of-call-report with the analysis VAPI produces on a connected call. A report built with
 *  summary and sentiment present needs no backfill, so nothing calls the VAPI API afterwards. */
export function endOfCallReportEnvelope(ref: EnvelopeRef, spec: EndOfCallSpec = {}): { message: Obj } {
  const structuredData: Obj = {};
  if (spec.callerName !== undefined && spec.callerName !== null) structuredData.caller_name = spec.callerName;
  if (spec.sentiment) structuredData.sentiment = spec.sentiment;
  if (spec.outcome) structuredData.outcome = spec.outcome;
  const analysis: Obj = {};
  if (spec.summary) analysis.summary = spec.summary;
  if (Object.keys(structuredData).length > 0) analysis.structuredData = structuredData;
  if (spec.successEvaluation) analysis.successEvaluation = spec.successEvaluation;

  const artifact: Obj = {};
  if (spec.messages) artifact.messages = spec.messages;
  if (spec.transcript) artifact.transcript = spec.transcript;
  if (spec.recordingUrl) artifact.recordingUrl = spec.recordingUrl;

  const message: Obj = {
    type: "end-of-call-report",
    ...origin(ref),
    endedReason: spec.endedReason ?? "customer-ended-call",
    analysis,
    artifact,
  };
  if (spec.startedAt) message.startedAt = spec.startedAt;
  if (spec.endedAt) message.endedAt = spec.endedAt;
  if (spec.durationSeconds !== undefined) message.durationSeconds = spec.durationSeconds;
  if (spec.cost !== undefined) message.cost = spec.cost;
  if (spec.summary) message.summary = spec.summary;
  if (spec.transcript) message.transcript = spec.transcript;
  if (spec.assistantName) message.assistant = { name: spec.assistantName };
  return { message };
}

/** A captured or fixture body re-keyed onto ref (call id and org), leaving everything else as-is. */
export function rekey(body: unknown, ref: EnvelopeRef): { message: Obj } {
  const copy = structuredClone(body) as Obj;
  const message = copy && typeof copy === "object" && copy.message && typeof copy.message === "object"
    ? copy.message as Obj
    : null;
  if (!message) throw new Error("rekey: body has no message object");
  if (ref.channel === "chat") throw new Error("rekey: post-call fixtures are keyed by a call, not a chat");
  const existing = message.call && typeof message.call === "object" ? message.call as Obj : {};
  message.call = { ...existing, id: ref.callKey, orgId: ref.orgId, type: ref.channel ?? existing.type ?? "webCall" };
  delete message.chat;
  return { message };
}

/** POSTs a body with the webhook Bearer. auth: null sends no Authorization header; a string
 *  replaces the secret (wrong-secret cases); raw sends that text instead of JSON. */
export async function postEnvelope(
  target: WebhookTarget,
  body: unknown,
  opts: { auth?: string | null; raw?: string; path?: string; method?: string } = {},
): Promise<PostResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = opts.auth === undefined ? target.secret : opts.auth;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const method = opts.method ?? "POST";
  const res = await (target.fetch ?? fetch)(target.url.replace(/\/+$/, "") + (opts.path ?? ""), {
    method,
    headers,
    body: method === "GET" || method === "OPTIONS" ? undefined : opts.raw ?? JSON.stringify(body),
    signal: AbortSignal.timeout(target.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: callers assert on status and text
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** The decoded tool results of a tool-calls response, in order. */
export interface ToolReply {
  name: unknown;
  toolCallId: unknown;
  code: string | null;
  sentence: string | null;
  data: Obj | null;
  nativeContent: string | null; // results[].message.content when VAPI is told to speak it
}

export function toolReplies(json: unknown): ToolReply[] | null {
  const results = json && typeof json === "object" ? (json as Obj).results : undefined;
  if (!Array.isArray(results)) return null;
  return results.map((r) => {
    const entry = r && typeof r === "object" ? r as Obj : {};
    let parsed: Obj = {};
    try {
      const v = typeof entry.result === "string" ? JSON.parse(entry.result) : null;
      if (v && typeof v === "object") parsed = v as Obj;
    } catch {
      // an unparseable result reads as code null
    }
    const native = entry.message && typeof entry.message === "object" ? entry.message as Obj : null;
    return {
      name: entry.name,
      toolCallId: entry.toolCallId,
      code: typeof parsed.code === "string" ? parsed.code : null,
      sentence: typeof parsed.message === "string" ? parsed.message : null,
      data: parsed.data && typeof parsed.data === "object" ? parsed.data as Obj : null,
      nativeContent: native && typeof native.content === "string" ? native.content : null,
    };
  });
}
