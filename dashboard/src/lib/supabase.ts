import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/** False when the build has no Supabase URL or anon key; the sign-in page explains it. */
export const supabaseConfigured = Boolean(env.supabaseUrl && env.supabaseAnonKey);

// createClient throws on an empty URL, which would blank the whole app (including the public
// call page). A placeholder keeps the module loadable; every request then fails visibly instead.
export const supabase = createClient(
  env.supabaseUrl ?? "http://localhost:54321",
  env.supabaseAnonKey ?? "missing-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: "observe-claims-auth",
    },
    realtime: {
      params: { eventsPerSecond: 20 },
    },
  },
);

export type SupabaseClient = typeof supabase;

