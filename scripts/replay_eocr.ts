// deno task replay <fixture.json> [options]     POST a saved webhook body (fixtures/eocr/*.json)
// deno task replay --capture <id> [options]     POST a body captured in webhook_captures (CAPTURE_WEBHOOKS=true)
//
// Options:
//   --url <url>       target (default: $SUPABASE_URL/functions/v1/vapi-webhook; a local
//                     `supabase functions serve` URL works too)
//   --call-id <id>    replace message.call.id, to replay into a chosen call
//   --new-id          replace message.call.id with a fresh UUID, so a replay never merges into a real call's row
//   --dry-run         print what would be sent and stop
//
// The body is sent as VAPI sends it, with the Bearer from .env (VAPI_WEBHOOK_SECRET). Fixtures carry
// a placeholder org id, so message.call.orgId (and message.chat.orgId) is set to VAPI_ORG_ID first;
// otherwise the function's org check answers 403. The response status and body are printed; the
// exit code is 1 for any status of 400 or above. The secret is never printed.

import { loadEnv, need } from "./lib/env.ts";

type Obj = Record<string, unknown>;

interface Options {
  file: string | null;
  capture: number | null;
  url: string | null;
  callId: string | null;
  newId: boolean;
  dryRun: boolean;
}

const USAGE =
  "usage: deno task replay <fixture.json> | --capture <id>  [--url <url>] [--call-id <id> | --new-id] [--dry-run]";

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  console.error(message);
  Deno.exit(2);
}

export function parseArgs(args: string[]): Options {
  const out: Options = { file: null, capture: null, url: null, callId: null, newId: false, dryRun: false };
  const value = (i: number, flag: string) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--capture") {
      const id = Number(value(i++, a));
      if (!Number.isSafeInteger(id) || id < 1) fail(`--capture takes a webhook_captures id\n${USAGE}`);
      out.capture = id;
    } else if (a === "--url") out.url = value(i++, a);
    else if (a === "--call-id") out.callId = value(i++, a);
    else if (a === "--new-id") out.newId = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      Deno.exit(0);
    } else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (out.file === null) out.file = a;
    else fail(`one body at a time\n${USAGE}`);
  }
  if ((out.file === null) === (out.capture === null)) fail(USAGE);
  if (out.callId !== null && out.newId) fail(`--call-id and --new-id are exclusive\n${USAGE}`);
  return out;
}

/** The body as it will be sent: org ids set to ours and, when asked, the call id replaced. */
export function prepareBody(body: unknown, p: { orgId: string; callId?: string | null }): { message: Obj } {
  if (!isObj(body) || !isObj(body.message)) throw new Error('not a webhook body: expected {"message": {...}}');
  const message: Obj = structuredClone(body.message);
  if (isObj(message.call)) {
    message.call.orgId = p.orgId;
    if (p.callId) message.call.id = p.callId;
  } else if (p.callId) {
    message.call = { id: p.callId, orgId: p.orgId };
  }
  if (isObj(message.chat)) message.chat.orgId = p.orgId;
  return { ...body, message };
}

async function readCapture(env: Record<string, string>, id: number): Promise<unknown> {
  const [url, key] = need(env, "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${url}/rest/v1/webhook_captures?id=eq.${id}&select=id,message_type,call_key,body`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) fail(`webhook_captures read failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length === 0) fail(`no webhook_captures row with id ${id}`);
  return rows[0].body;
}

function describe(message: Obj): string {
  const call = isObj(message.call) ? message.call : {};
  const chat = isObj(message.chat) ? message.chat : {};
  const key = call.id ?? chat.sessionId ?? chat.id ?? "none";
  return `type=${String(message.type ?? "unknown")} call=${String(key)}`;
}

async function main() {
  const opts = parseArgs(Deno.args);
  const env = loadEnv();
  const [orgId] = need(env, "VAPI_ORG_ID");
  const raw = opts.capture !== null
    ? await readCapture(env, opts.capture)
    : JSON.parse(await Deno.readTextFile(opts.file!));
  const callId = opts.newId ? crypto.randomUUID() : opts.callId;
  const body = prepareBody(raw, { orgId, callId });
  const payload = JSON.stringify(body);
  const url = opts.url ?? `${need(env, "SUPABASE_URL")[0]}/functions/v1/vapi-webhook`;
  const target = new URL(url);
  if (target.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    fail(`refusing to send a webhook body over ${target.protocol} to ${target.hostname}`);
  }

  const source = opts.capture !== null ? `capture ${opts.capture}` : opts.file;
  console.log(`${source}: ${describe(body.message)} (${payload.length} bytes) -> ${target.origin}${target.pathname}`);
  if (opts.dryRun) {
    console.log("dry run: nothing sent");
    return;
  }

  const [secret] = need(env, "VAPI_WEBHOOK_SECRET");
  const started = performance.now();
  const res = await fetch(target, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status} in ${Math.round(performance.now() - started)} ms`);
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: print as received
  }
  console.log(pretty);
  if (res.status >= 400) Deno.exit(1);
}

if (import.meta.main) await main();
