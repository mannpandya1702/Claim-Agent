// Reads the Edge Function environment into Env. Kept apart from index.ts (which boots the server)
// so a test can prove every optional secret is actually read: a key declared in Env but missing
// here would never reach deps.env, and its feature would stay off in production while every unit
// test, which builds env directly, still passed.

import type { Env } from "./types.ts";

export const OPTIONAL_KEYS = [
  "VAPI_PRIVATE_KEY",
  "JOBS_BEARER",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "CLAIMS_TEAM_EMAIL",
  "ALERT_SINKS",
  "DASHBOARD_URL",
  "NATIVE_TOOL_MESSAGES",
  "PRIOR_CONTACTS_ENABLED",
  "OWN_NUMBERS",
  "CAPTURE_WEBHOOKS",
  "AIRTABLE_TOKEN",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_TABLE",
  "GHL_TOKEN",
  "GHL_LOCATION_ID",
  "GHL_ASSIGNEE_USER_ID",
  "GHL_EMERGENCY_USER_ID",
] as const satisfies readonly (keyof Env)[];
// An optional key added to Env but not to the list fails the type check here.
type OptionalKey = { [K in keyof Env]-?: undefined extends Env[K] ? K : never }[keyof Env];
const _everyOptionalKey: Exclude<OptionalKey, typeof OPTIONAL_KEYS[number]> extends never ? true : never = true;

/** `get` returns the raw value (Deno.env.get in production). A secret pasted with a trailing
 *  newline would otherwise never match its Bearer token, so values are trimmed; blank is unset. */
export function readEnv(get: (name: string) => string | undefined): Env {
  const read = (name: string): string | undefined => get(name)?.trim() || undefined;
  const env: Env = { VAPI_ORG_ID: read("VAPI_ORG_ID") ?? "", VAPI_WEBHOOK_SECRET: read("VAPI_WEBHOOK_SECRET") ?? "" };
  for (const key of OPTIONAL_KEYS) {
    const value = read(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}
