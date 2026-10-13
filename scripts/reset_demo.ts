// Resets the demo project before a demo or a re-run of the flows: every per-call row goes
// (sessions, attempts, escalations, emails, caller contacts, claim intakes, live transcript lines,
// interactions and their queued call-log deliveries, which would otherwise be given up as "record
// missing"), every claim filed by phone goes (claims.reported_call_key is set only on those), and
// the seeded customers get OWNER_EMAIL as their address on file, except Teague Ashdown, who keeps
// none (the no_email_on_file branch). Identity counters are per call, so a clean slate means the next F1
// hears the plain verified sentence and F2 can lock and then F1 verify again.
//
//   deno task reset            show what would be deleted
//   deno task reset --yes      delete it
//
// The demo project is the sandbox (the plan has one project), so the per-call tables are emptied
// whole rather than filtered by number: every row in them belongs to a demo, smoke, battery or DB
// test call. customers are never deleted, and the seeded claims are kept: only a claim a call filed
// (reported_call_key not null) is removed.

import { maskEmail } from "../supabase/functions/vapi-webhook/email.ts";
import { loadEnv, need } from "./lib/env.ts";
import { lit, sqlClient } from "./lib/sql.ts";

// 0002_seed.sql; Teague is the one seeded customer without an email on file.
export const SEEDED_PHONES = ["+16025550101", "+16025550102", "+16025550103", "+16025550104", "+16025550105"];
export const NO_EMAIL_PHONE = "+16025550104";
export const CALL_TABLES = [
  { table: "attempts", key: "call_key" },
  { table: "call_sessions", key: "call_key" },
  { table: "escalations", key: "call_key" },
  { table: "emails", key: "call_key" },
  // 0006_contacts.sql: the names, emails and callback numbers callers gave on demo calls.
  { table: "caller_contacts", key: "call_key" },
  // 0007_fnol_reasons.sql: the losses callers reported on demo calls.
  { table: "claim_intakes", key: "call_key" },
  { table: "transcript_lines", key: "call_key" },
  { table: "call_interactions", key: "vapi_call_id" },
  { table: "outbox_events", key: "ref_id" },
] as const;

// The claims calls filed (0007_fnol_reasons.sql); the seeded claims have no reported_call_key.
export const PHONE_CLAIMS = { label: "phone_claims", where: "reported_call_key is not null" } as const;

const EMAIL_RE = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;

export function countSql(): string {
  return `select ${CALL_TABLES.map(({ table }) => `(select count(*) from ${table})::int as ${table}`).join(", ")}, ` +
    `(select count(*) from claims where ${PHONE_CLAIMS.where})::int as ${PHONE_CLAIMS.label}`;
}

/** One statement, so the reset is atomic: every delete and the email update commit together. */
export function resetSql(ownerEmail: string): string {
  if (!EMAIL_RE.test(ownerEmail)) throw new Error("OWNER_EMAIL does not look like an email address");
  const phones = SEEDED_PHONES.map(lit).join(", ");
  const deletes = CALL_TABLES.map(({ table }) => `  d_${table} as (delete from ${table} returning 1)`);
  return `with
${deletes.join(",\n")},
  d_${PHONE_CLAIMS.label} as (delete from claims where ${PHONE_CLAIMS.where} returning 1),
  u_customers as (
    update customers
       set email = case when phone_e164 = ${lit(NO_EMAIL_PHONE)} then null else ${lit(ownerEmail)} end
     where phone_e164 in (${phones})
    returning phone_e164, email is not null as has_email
  )
select
${CALL_TABLES.map(({ table }) => `  (select count(*) from d_${table})::int as ${table}`).join(",\n")},
  (select count(*) from d_${PHONE_CLAIMS.label})::int as ${PHONE_CLAIMS.label},
  (select count(*) from u_customers)::int as customers_updated,
  (select count(*) from u_customers where has_email)::int as customers_with_email`;
}

function table(counts: Record<string, number>): string {
  return [...CALL_TABLES.map(({ table }) => table), PHONE_CLAIMS.label]
    .map((name) => `  ${name.padEnd(18)} ${counts[name] ?? 0}`).join("\n");
}

async function main(): Promise<number> {
  const args = Deno.args.filter((a) => a !== "--");
  const unknown = args.filter((a) => a !== "--yes");
  if (unknown.length) {
    console.error(`unknown argument ${unknown[0]}\nusage: deno task reset [--yes]`);
    return 2;
  }
  const env = loadEnv();
  const sql = sqlClient(env);

  if (!args.includes("--yes")) {
    const [counts] = await sql<Record<string, number>>(countSql());
    console.log(`rows a reset would delete:\n${table(counts ?? {})}`);
    console.log("customers and the seeded claims are kept. Run again with --yes to reset.");
    return 1;
  }

  const [ownerEmail] = need(env, "OWNER_EMAIL");
  const [result] = await sql<Record<string, number>>(resetSql(ownerEmail));
  if (!result) throw new Error("the reset returned no row");
  console.log(`deleted:\n${table(result)}`);
  console.log(
    `seeded customers updated: ${result.customers_updated} of ${SEEDED_PHONES.length}; ` +
      `${result.customers_with_email} now have ${maskEmail(ownerEmail)} on file, Teague Ashdown has none`,
  );
  if (result.customers_updated !== SEEDED_PHONES.length) {
    console.error("some seeded customers are missing: re-apply 0002_seed.sql");
    return 1;
  }
  const [after] = await sql<Record<string, number>>(countSql());
  const left = Object.entries(after ?? {}).filter(([, n]) => n > 0);
  if (left.length) {
    // a live call or a background write landed during the reset
    console.error(`rows written during the reset: ${left.map(([t, n]) => `${t} ${n}`).join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
