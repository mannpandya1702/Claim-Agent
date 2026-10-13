// Entry point: builds the dependencies once per isolate from the Edge Function environment and
// hands every request to handler.ts. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by
// the platform; everything else is a function secret. Missing VAPI credentials do not stop the
// boot: /health keeps answering and the handler fails closed (401 / 403) until they are set.

import { readEnv } from "./env.ts";
import { handle } from "./handler.ts";
import { jsonLogger } from "./log.ts";
import { createStore } from "./store.ts";
import type { Deps } from "./types.ts";

function read(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
}

const supabaseUrl = read("SUPABASE_URL");
const serviceRoleKey = read("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

const env = readEnv((name) => Deno.env.get(name));
const missing = (["VAPI_ORG_ID", "VAPI_WEBHOOK_SECRET"] as const).filter((k) => env[k] === "");
if (missing.length > 0) jsonLogger({ event: "config_missing", keys: missing });

const deps: Deps = {
  store: createStore(supabaseUrl, serviceRoleKey),
  fetch: globalThis.fetch.bind(globalThis),
  env,
  now: () => new Date(),
  waitUntil: (p) => {
    // Always guarded: an unhandled rejection would take the whole isolate down with it.
    const guarded = Promise.resolve(p).catch((e) =>
      jsonLogger({ event: "background_error", error: e instanceof Error ? `${e.name}: ${e.message}` : "error" })
    );
    (globalThis as any).EdgeRuntime?.waitUntil?.(guarded);
  },
  log: jsonLogger,
};

Deno.serve((req) => handle(req, deps));
