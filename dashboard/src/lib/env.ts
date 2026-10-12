// Build-time configuration. Every value is public by design; missing ids are normal before the
// VAPI sync has run, so consumers check for null instead of assuming a value.

function clean(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : null;
}

export const env = {
  supabaseUrl: clean(import.meta.env.VITE_SUPABASE_URL),
  supabaseAnonKey: clean(import.meta.env.VITE_SUPABASE_ANON_KEY),
  vapiPublicKey: clean(import.meta.env.VITE_VAPI_PUBLIC_KEY),
  assistantCoreId: clean(import.meta.env.VITE_ASSISTANT_CORE_ID),
  assistantSoloId: clean(import.meta.env.VITE_ASSISTANT_SOLO_ID),
  squadId: clean(import.meta.env.VITE_SQUAD_ID),
  phoneNumber: clean(import.meta.env.VITE_PHONE_NUMBER),
  buildSha: clean(import.meta.env.VITE_BUILD_SHA),
} as const;

export type Env = typeof env;

/** Short commit id for the footer; "dev" when the build did not stamp one. */
export function shortSha(sha: string | null = env.buildSha): string {
  return sha ? sha.slice(0, 7) : "dev";
}
