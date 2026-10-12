// Entry point: wires the real environment into the pure handler in logic.ts.
// verify_jwt is on (supabase/config.toml), so the gateway has already checked the JWT signature;
// is_staff() below runs as the caller, so RLS and the staff allowlist decide, not this code.
// Pinned in place (same version as the deno.json import map) so the deploy never depends on
// import-map resolution.
// deno-lint-ignore no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { createHandler, parseAllowedOrigins } from "./logic.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Every read runs as the caller (their JWT, the anon key), so grants and RLS decide.
function callerClient(authorization: string) {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function isStaff(authorization: string): Promise<boolean> {
  const { data, error } = await callerClient(authorization).rpc("is_staff");
  if (error) throw new Error(error.message);
  return data === true;
}

async function callVisible(authorization: string, callId: string): Promise<boolean> {
  const { data, error } = await callerClient(authorization)
    .from("call_interactions")
    .select("vapi_call_id")
    .eq("vapi_call_id", callId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

Deno.serve(
  createHandler({
    vapiPrivateKey: Deno.env.get("VAPI_PRIVATE_KEY") ?? null,
    isStaff,
    callVisible,
    fetch: (input, init) => fetch(input, init),
    allowedOrigins: parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
  }),
);
