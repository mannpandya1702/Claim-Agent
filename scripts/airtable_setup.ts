// deno task airtable:setup — create (or complete) the "Call Log" table in the Airtable base.
// Idempotent: lists the base's tables, creates the table if it is missing, then adds any field
// that is missing. Never deletes or retypes an existing field (a human may have customised it).
// Needs AIRTABLE_TOKEN with schema.bases:read + schema.bases:write and AIRTABLE_BASE_ID.

import { loadEnv, need } from "./lib/env.ts";
import {
  ANALYSIS_STATUSES,
  CALLER_TYPES,
  FLAGS,
  OUTCOMES,
  SENTIMENTS,
} from "../supabase/functions/vapi-webhook/enums.ts";
import { DEFAULT_TABLE, MERGE_FIELD } from "../supabase/functions/vapi-webhook/airtable.ts";

const choices = (values: readonly string[]) => ({ choices: values.map((name) => ({ name })) });
const dateTime = { timeZone: "America/New_York", dateFormat: { name: "iso" }, timeFormat: { name: "24hour" } };

// The first field is the table's primary field and the upsert merge key. Exported for the unit test
// that pins every field interactionToFields writes to a field this script creates.
export const FIELDS: { name: string; type: string; options?: unknown; description?: string }[] = [
  { name: MERGE_FIELD, type: "singleLineText", description: "VAPI call id; the upsert merge key" },
  { name: "Started At", type: "dateTime", options: dateTime },
  { name: "Ended At", type: "dateTime", options: dateTime },
  { name: "Caller Name", type: "singleLineText", description: "Verified name, else the name the caller confirmed, else the name given, else Unknown caller" },
  { name: "Caller Phone", type: "singleLineText", description: "Last four digits only" },
  {
    name: "Caller Type",
    type: "singleSelect",
    options: choices(CALLER_TYPES),
    description: "existing: matched an account; new: gave their details as a new customer; else unknown",
  },
  { name: "Email", type: "email", description: "The address a caller spelled and confirmed (caller-provided, unverified)" },
  { name: "Channel", type: "singleSelect", options: choices(["webCall", "inboundPhoneCall", "outboundPhoneCall"]) },
  { name: "Outcome", type: "singleSelect", options: choices(OUTCOMES) },
  { name: "Sentiment", type: "singleSelect", options: choices(SENTIMENTS) },
  { name: "Summary", type: "multilineText", description: "Redacted AI summary" },
  { name: "Escalated", type: "checkbox", options: { icon: "check", color: "yellowBright" } },
  { name: "Emergency", type: "checkbox", options: { icon: "check", color: "redBright" } },
  { name: "Flags", type: "multipleSelects", options: choices(FLAGS) },
  { name: "Duration (s)", type: "number", options: { precision: 0 } },
  { name: "Cost (USD)", type: "number", options: { precision: 4 } },
  { name: "Analysis Status", type: "singleSelect", options: choices(ANALYSIS_STATUSES) },
  { name: "Dashboard", type: "url" },
  { name: "Synced At", type: "dateTime", options: dateTime },
];

async function api(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main(): Promise<number> {
  const env = loadEnv();
  const [token, baseId] = need(env, "AIRTABLE_TOKEN", "AIRTABLE_BASE_ID");
  const tableName = env.AIRTABLE_TABLE || DEFAULT_TABLE;
  const meta = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;

  const { tables } = await api(token, "GET", meta);
  let table = tables.find((t: any) => t.name === tableName);
  if (!table) {
    table = await api(token, "POST", meta, {
      name: tableName,
      description: "Post-call interaction records mirrored from Supabase (call_interactions).",
      fields: FIELDS,
    });
    console.log(`created table "${tableName}" (${table.id}) with ${FIELDS.length} fields`);
    return 0;
  }
  const have = new Set(table.fields.map((f: any) => f.name));
  if (table.fields[0]?.name !== MERGE_FIELD) {
    console.error(`table "${tableName}" exists but its primary field is "${table.fields[0]?.name}", not "${MERGE_FIELD}"`);
    return 1;
  }
  for (const f of FIELDS.slice(1)) {
    if (have.has(f.name)) continue;
    await api(token, "POST", `${meta}/${table.id}/fields`, f);
    console.log(`added field "${f.name}"`);
  }
  console.log(`table "${tableName}" (${table.id}) is complete`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
