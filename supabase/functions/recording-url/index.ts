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

async function isStaff(authorization: string): Promise<boolean> {
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc("is_staff");
  if (error) throw new Error(error.message);
  return data === true;
}

Deno.serve(
  createHandler({
    vapiPrivateKey: Deno.env.get("VAPI_PRIVATE_KEY") ?? null,
    isStaff,
    fetch: (input, init) => fetch(input, init),
    allowedOrigins: parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
  }),
);
