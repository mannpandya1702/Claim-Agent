// HTTP entry for every VAPI server message. The envelope is the trust boundary: the call key,
// channel, org and caller id come from message.call / message.chat, never from tool arguments.
// A tool-calls delivery is always answered with HTTP 200 and a spoken sentence, because a 4xx/5xx
// makes VAPI fall back to a generic line or to the model improvising; a fault on our side must be
// heard as the system_error offer of a representative, never as silence or a made-up answer.

import { type Channel, CHANNELS, type Code, CODES } from "./enums.ts";
import { callerIdNumber } from "./identity.ts";
import { callKeyOf, parseCalls } from "./parse_tool_request.ts";
import { onEndOfCallReport, onStatusUpdate, onTranscript } from "./post_call.ts";
import { redactPII } from "./redact.ts";
import { sentenceFor } from "./speak.ts";
import { runTool, TOOL_BUDGET_MS } from "./tools.ts";
import type { Deps, ParsedToolCall, ToolCtx, ToolResult, VapiMessage } from "./types.ts";

/** Per-tool budget, enforced inside runTool with each tool's own fallback sentence (one source:
 *  tools.ts). The tool JSON's server timeoutSeconds is 10, so VAPI still receives it in time. */
export { TOOL_BUDGET_MS };
/** The handler's own timer is only a backstop for a runTool that breaks its contract. It must
 *  fire after the tool's budget, or it would pre-empt the tool's better fallback (an emergency
 *  answered with the generic trouble line), and well before VAPI's 10 s timeout. */
export const TOOL_BACKSTOP_MS = TOOL_BUDGET_MS + 1000;
/** VAPI waits 10 s for the whole delivery, not per call. Calls run one after another, so later
 *  calls in a batch get only what is left of this; one call alone keeps its full backstop. */
export const BATCH_BUDGET_MS = 8500;

/** The modules the router dispatches to; createHandler swaps them for fakes in tests. */
export interface Routes {
  runTool: typeof runTool;
  onStatusUpdate: typeof onStatusUpdate;
  onTranscript: typeof onTranscript;
  onEndOfCallReport: typeof onEndOfCallReport;
}

export interface HandlerOptions {
  backstopMs?: number;
  batchMs?: number;
}

/** One entry of the tool-calls response (VAPI ToolCallResult). */
export interface ToolCallResponse {
  name: string;
  toolCallId: string;
  result: string;
  message?: { type: "request-complete"; content: string };
}

type Obj = Record<string, unknown>;

const JOB_NAMES = new Set(["sla", "digest", "reaper"]);
const TRANSCRIPT_TYPES = new Set(["transcript", 'transcript[transcriptType="final"]']);
const JOB_PATH_RE = /\/jobs\/([A-Za-z0-9_-]{1,64})$/;
const BEARER_RE = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const CODE_SET: ReadonlySet<string> = new Set(CODES);
const CHANNEL_SET: ReadonlySet<string> = new Set(CHANNELS);
const TIMED_OUT = Symbol("timed_out");
const encoder = new TextEncoder();

const HEALTH_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Cache-Control": "no-store",
};

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Error text reaches the log line, and a thrown database or tool error can quote its input, so it
// is redacted and capped here as well as in the logger.
function errorText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown";
  return redactPII(text.slice(0, 1000)).slice(0, 200);
}

/** Constant-time string comparison over UTF-8 bytes. The loop always runs over the longer input
 *  and a length mismatch only sets a flag, so neither the content nor the length of the secret
 *  shortens the work. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  const length = Math.max(ea.length, eb.length);
  // Both sides padded to the same length so the loop body never branches on an index.
  const pa = new Uint8Array(length);
  const pb = new Uint8Array(length);
  pa.set(ea);
  pb.set(eb);
  let diff = ea.length === eb.length ? 0 : 1;
  for (let i = 0; i < length; i++) diff |= pa[i] ^ pb[i];
  return diff === 0;
}

// An unset or blank secret never authorises anything, even an equally blank Bearer token.
function bearerMatches(req: Request, secret: string | undefined): boolean {
  const expected = typeof secret === "string" ? secret.trim() : "";
  const match = BEARER_RE.exec(req.headers.get("authorization") ?? "");
  const presented = match ? match[1] : "";
  const equal = timingSafeEqual(presented, expected);
  return expected !== "" && presented !== "" && equal;
}

function channelOf(message: VapiMessage): Channel {
  const call = isObj(message.call) ? message.call : null;
  const type = call?.type;
  if (typeof type === "string" && CHANNEL_SET.has(type)) return type as Channel;
  if (isObj(message.chat) && !message.call) return "chat";
  return "unknown";
}

function ownNumbers(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function callerNumberOf(message: VapiMessage, own: string[]): string | null {
  const call = isObj(message.call) ? message.call : {};
  const callCustomer = isObj(call.customer) ? call.customer : {};
  const envelopeCustomer = isObj(message.customer) ? message.customer : {};
  return callerIdNumber(callCustomer.number ?? envelopeCustomer.number, own);
}

function orgIdOf(message: VapiMessage): unknown {
  const call = isObj(message.call) ? message.call : {};
  const chat = isObj(message.chat) ? message.chat : {};
  return call.orgId ?? chat.orgId;
}

function systemError(): ToolResult {
  return { code: "system_error", sentence: sentenceFor("system_error") };
}

// Used only when runTool itself fails (throws, hangs past the backstop, returns garbage). It
// mirrors the two tool fallbacks where the generic trouble line would be wrong: an emergency is
// never answered with an offer of a callback, and a failed escalation names the main line
// instead of promising a callback nobody recorded.
function fallbackFor(toolName: string): ToolResult {
  if (toolName === "report_emergency") {
    return {
      code: "emergency_logged",
      sentence: sentenceFor("emergency_logged", { db_failed: true }),
      data: { db_failed: true },
    };
  }
  if (toolName === "escalate") return { code: "rep_unavailable", sentence: sentenceFor("rep_unavailable") };
  return systemError();
}

// runTool is contracted never to throw, but the spoken answer is too important to trust that:
// anything other than a known code with a non-empty sentence is replaced by system_error.
function wellFormed(out: unknown): ToolResult | null {
  if (!isObj(out)) return null;
  if (typeof out.code !== "string" || !CODE_SET.has(out.code)) return null;
  if (typeof out.sentence !== "string" || out.sentence.trim() === "") return null;
  const result: ToolResult = { code: out.code as Code, sentence: out.sentence };
  if (isObj(out.data)) result.data = out.data;
  return result;
}

function keepAlive(deps: Deps, p: Promise<unknown>): void {
  const settled = p.then(() => undefined, () => undefined);
  try {
    deps.waitUntil(settled);
  } catch {
    // outside the Edge Runtime there is nothing to extend; the promise is already guarded
  }
}

interface Outcome {
  result: ToolResult;
  error?: string;
}

async function runWithBackstop(
  routes: Routes,
  call: ParsedToolCall,
  ctx: Omit<ToolCtx, "toolCallId">,
  backstopMs: number,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(() => routes.runTool(call, ctx));
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), backstopMs);
  });
  try {
    const out = await Promise.race([work, deadline]);
    if (out === TIMED_OUT) {
      // The tool is not cancelled: letting its writes finish means a VAPI retry of this
      // toolCallId replays the stored code instead of meeting a half-written attempt.
      keepAlive(ctx.deps, work);
      return { result: fallbackFor(call.name), error: "tool_timeout" };
    }
    const result = wellFormed(out);
    return result ? { result } : { result: fallbackFor(call.name), error: "malformed_tool_result" };
  } catch (e) {
    return { result: fallbackFor(call.name), error: errorText(e) };
  } finally {
    clearTimeout(timer);
  }
}

function toResponse(call: ParsedToolCall, result: ToolResult, native: boolean): ToolCallResponse {
  let payload: string;
  try {
    payload = JSON.stringify({
      code: result.code,
      message: result.sentence,
      ...(result.data ? { data: result.data } : {}),
    });
  } catch {
    // data that cannot be serialised is dropped rather than losing the sentence
    payload = JSON.stringify({ code: result.code, message: result.sentence });
  }
  const entry: ToolCallResponse = { name: call.name, toolCallId: call.id, result: payload };
  if (native) entry.message = { type: "request-complete", content: result.sentence };
  return entry;
}

interface LogLine {
  call_key: string | null;
  type: string | null;
  status: number;
  tool?: string;
  code?: string;
  error?: string;
}

/** Builds the request handler over a set of routes. handle() uses the real modules. */
export function createHandler(
  overrides: Partial<Routes> = {},
  options: HandlerOptions = {},
): (req: Request, deps: Deps) => Promise<Response> {
  const routes: Routes = { runTool, onStatusUpdate, onTranscript, onEndOfCallReport, ...overrides };
  const backstopMs = options.backstopMs ?? TOOL_BACKSTOP_MS;
  const batchMs = options.batchMs ?? BATCH_BUDGET_MS;

  async function toolCalls(message: VapiMessage, callKey: string | null, deps: Deps, line: LogLine) {
    const batchDeadline = performance.now() + batchMs;
    const calls = parseCalls(message);
    if (calls.length === 0) return json(200, { results: [] });
    if (!callKey) {
      line.error = "missing_call_key";
      return json(400, { error: "missing_call_key" });
    }
    const ctx: Omit<ToolCtx, "toolCallId"> = {
      callKey,
      channel: channelOf(message),
      callerNumber: callerNumberOf(message, ownNumbers(deps.env.OWN_NUMBERS)),
      isChat: !message.call && isObj(message.chat),
      deps,
    };
    const native = deps.env.NATIVE_TOOL_MESSAGES !== "false";
    const results: ToolCallResponse[] = [];
    const tools: string[] = [];
    const codes: string[] = [];
    const errors: string[] = [];
    // Sequential on purpose: a batch such as lookup_customer then verify_identity must walk the
    // identity ladder in the order the model asked, which parallel execution cannot promise.
    for (const call of calls) {
      // A call that starts after a slow one still runs (an emergency must still be logged and
      // paged), but its answer is the fallback once the batch is out of time.
      const left = Math.max(0, Math.floor(batchDeadline - performance.now()));
      const { result, error } = await runWithBackstop(routes, call, ctx, Math.min(backstopMs, left));
      results.push(toResponse(call, result, native));
      tools.push(call.name);
      codes.push(result.code);
      if (error) errors.push(error);
    }
    line.tool = tools.join(",");
    line.code = codes.join(",");
    if (errors.length > 0) line.error = errors.join("; ");
    return json(200, { results });
  }

  async function route(message: VapiMessage, type: string | null, callKey: string | null, deps: Deps, line: LogLine) {
    if (type === "tool-calls") return await toolCalls(message, callKey, deps, line);
    try {
      if (type === "status-update") {
        await routes.onStatusUpdate(message, deps);
        return json(200, {});
      }
      if (type !== null && TRANSCRIPT_TYPES.has(type)) {
        await routes.onTranscript(message, deps);
        return json(200, {});
      }
      if (type === "end-of-call-report") {
        const out = await routes.onEndOfCallReport(message, deps);
        const status = Number.isInteger(out?.status) && out.status >= 200 && out.status <= 599 ? out.status : 500;
        return json(status, out?.body ?? {});
      }
    } catch (e) {
      // A 5xx lets VAPI's server backoffPlan redeliver; every post-call write is an idempotent
      // upsert or an on-conflict-do-nothing insert, so a redelivery cannot double anything.
      line.error = errorText(e);
      return json(500, { error: "internal_error" });
    }
    return json(200, {});
  }

  function capture(deps: Deps, type: string | null, callKey: string | null, body: unknown): void {
    if (deps.env.CAPTURE_WEBHOOKS !== "true") return;
    const p = Promise.resolve()
      .then(() => deps.store.captureWebhook(type, callKey, body))
      .catch((e) => {
        try {
          deps.log({ event: "capture_failed", call_key: callKey, type, error: errorText(e) });
        } catch {
          // logging must never surface as a failed capture of a failed capture
        }
      });
    keepAlive(deps, p);
  }

  async function serve(req: Request, deps: Deps, line: LogLine): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    if (path.endsWith("/health") && (req.method === "GET" || req.method === "OPTIONS")) {
      line.type = "health";
      return json(200, { ok: true }, HEALTH_HEADERS);
    }
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });

    const job = JOB_PATH_RE.exec(path);
    if (job) {
      line.type = "job";
      // The route does not exist for anyone without the jobs bearer; with it, the job runner
      // (jobs.ts) is not deployed yet, so a known job name is reported as not implemented.
      if (!bearerMatches(req, deps.env.JOBS_BEARER) || !JOB_NAMES.has(job[1])) {
        return json(404, { error: "not_found" });
      }
      line.tool = job[1];
      return json(501, { error: "not_implemented", job: job[1] });
    }

    if (!bearerMatches(req, deps.env.VAPI_WEBHOOK_SECRET)) {
      return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    }

    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return json(400, { error: "bad_json" });
    }
    const message = isObj(body) && isObj(body.message) ? body.message as VapiMessage : null;
    if (!message) return json(400, { error: "missing_message" });

    const type = typeof message.type === "string" ? message.type : null;
    const callKey = callKeyOf(message);
    line.type = type;
    line.call_key = callKey;

    const org = orgIdOf(message);
    const expectedOrg = typeof deps.env.VAPI_ORG_ID === "string" ? deps.env.VAPI_ORG_ID.trim() : "";
    if (expectedOrg === "" || typeof org !== "string" || org !== expectedOrg) {
      return json(403, { error: "forbidden" });
    }

    capture(deps, type, callKey, body);
    return await route(message, type, callKey, deps, line);
  }

  return async (req: Request, deps: Deps): Promise<Response> => {
    const started = performance.now();
    const line: LogLine = { call_key: null, type: null, status: 500 };
    let response: Response;
    try {
      response = await serve(req, deps, line);
    } catch (e) {
      line.error = errorText(e);
      response = json(500, { error: "internal_error" });
    }
    line.status = response.status;
    try {
      // ids, enums and timings only: never a phone number, a DOB or a tool argument
      deps.log({ ...line, ms: Math.round(performance.now() - started) });
    } catch {
      // a logging fault must not change the answer VAPI receives
    }
    return response;
  };
}

const defaultHandler = createHandler();

/** Route one HTTP request. Never throws: an internal fault is a 500 for non-tool messages and a
 *  fallback sentence (system_error unless the tool has a safer one) at HTTP 200 for tool calls. */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  return await defaultHandler(req, deps);
}
