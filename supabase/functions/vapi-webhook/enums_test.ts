// Parity between enums.ts and the live schema. A value the code writes but a CHECK constraint
// rejects only fails at runtime, on a real call, as a database error the caller hears as the
// trouble line; reading 0001_init.sql here turns that drift into a failing unit test instead.

import { assert, assertEquals } from "@std/assert";
import {
  ALERT_STATUSES,
  ANALYSIS_OUTCOMES,
  ANALYSIS_STATUSES,
  ATTEMPT_KINDS,
  CALLBACK_SOURCES,
  CLAIM_STATUSES,
  CLAIM_TYPES,
  CODES,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  ESCALATION_KINDS,
  ESCALATION_REASONS,
  ESCALATION_STATUSES,
  INFO_EMAIL_TOPICS,
  JOB_NAMES,
  LEVELS,
  MODEL_ESCALATION_REASONS,
  OUTBOX_DESTINATIONS,
  OUTBOX_KINDS,
  OUTCOMES,
  SENTIMENT_SOURCES,
  SENTIMENTS,
  SERVER_TOOLS,
} from "./enums.ts";

const SQL = await Deno.readTextFile(new URL("../../migrations/0001_init.sql", import.meta.url));

const OUTBOX_SQL = await Deno.readTextFile(new URL("../../migrations/0005_outbox.sql", import.meta.url));
const AUTOMATION_SQL = await Deno.readTextFile(new URL("../../migrations/0004_automation.sql", import.meta.url));

function tableBody(table: string, sql = SQL): string {
  const start = sql.indexOf(`create table ${table} (`);
  assert(start >= 0, `table ${table} not found`);
  const end = sql.indexOf("\n);", start);
  assert(end > start, `table ${table} has no closing parenthesis`);
  return sql.slice(start, end);
}

/** The quoted values of `<column> text ... check (<column> in (...))` inside one table. */
function checkList(table: string, column: string, sql = SQL): string[] {
  const re = new RegExp(String.raw`^\s*${column}\s+text\b[^\n]*?check\s*\(\s*${column}\s+in\s*\(([^)]*)\)`, "m");
  const match = re.exec(tableBody(table, sql));
  assert(match, `no CHECK list for ${table}.${column}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const PAIRS: [string, string, readonly string[]][] = [
  ["claims", "claim_type", CLAIM_TYPES],
  ["claims", "status", CLAIM_STATUSES],
  ["call_sessions", "level", LEVELS],
  ["attempts", "kind", ATTEMPT_KINDS],
  ["escalations", "kind", ESCALATION_KINDS],
  ["escalations", "reason", ESCALATION_REASONS],
  ["escalations", "callback_source", CALLBACK_SOURCES],
  ["escalations", "alert_status", ALERT_STATUSES],
  ["escalations", "status", ESCALATION_STATUSES],
  ["emails", "kind", EMAIL_KINDS],
  ["emails", "status", EMAIL_STATUSES],
  ["call_interactions", "sentiment", SENTIMENTS],
  ["call_interactions", "sentiment_source", SENTIMENT_SOURCES],
  ["call_interactions", "outcome", OUTCOMES],
  ["call_interactions", "analysis_status", ANALYSIS_STATUSES],
];

Deno.test("every enums.ts list equals its CHECK constraint in 0001_init.sql, in order", () => {
  for (const [table, column, values] of PAIRS) {
    assertEquals(checkList(table, column), [...values], `${table}.${column}`);
  }
});

Deno.test("the outbox lists equal the CHECK constraints in 0005_outbox.sql", () => {
  assertEquals(checkList("outbox_events", "kind", OUTBOX_SQL), [...OUTBOX_KINDS]);
  assertEquals(checkList("outbox_events", "destination", OUTBOX_SQL), [...OUTBOX_DESTINATIONS]);
});

Deno.test("JOB_NAMES are exactly the jobs invoke_job accepts and pg_cron schedules (0004_automation.sql)", () => {
  const accepted = /if p_name not in \(([^)]*)\)/.exec(AUTOMATION_SQL);
  assert(accepted, "invoke_job's name list was found");
  assertEquals([...accepted[1].matchAll(/'([^']*)'/g)].map((m) => m[1]), [...JOB_NAMES]);
  const scheduled = [...AUTOMATION_SQL.matchAll(/public\.invoke_job\('([a-z]+)'\)/g)].map((m) => m[1]);
  assertEquals(scheduled, [...JOB_NAMES]);
});

Deno.test("transcript_lines.role accepts exactly the two roles TranscriptLine allows", () => {
  assertEquals(checkList("transcript_lines", "role"), ["user", "assistant"]);
});

Deno.test("every code the identity SQL functions can return is a known code", () => {
  const assigned = [...SQL.matchAll(/v_code\s*:=\s*([^;]+);/g)].flatMap((m) =>
    [...m[1].matchAll(/'([^']*)'/g)].map((q) => q[1])
  );
  assert(assigned.length >= 10, "the v_code assignments were found");
  const known: ReadonlySet<string> = new Set(CODES);
  for (const code of new Set(assigned)) assert(known.has(code), `SQL returns unknown code ${code}`);
});

Deno.test("the tool names the SQL functions record are server tools", () => {
  const recorded = [...SQL.matchAll(/values \(p_call_key, p_tool_call_id, '([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(recorded.sort(), ["lookup_customer", "verify_identity"]);
  for (const name of recorded) assert((SERVER_TOOLS as readonly string[]).includes(name), name);
});

Deno.test("the model-facing lists are subsets of the stored lists", () => {
  for (const r of MODEL_ESCALATION_REASONS) assert((ESCALATION_REASONS as readonly string[]).includes(r), r);
  for (const t of INFO_EMAIL_TOPICS) assert((EMAIL_KINDS as readonly string[]).includes(t), t);
  assertEquals([...ANALYSIS_OUTCOMES], OUTCOMES.filter((o) => o !== "in_progress"));
  // The server derives these from session state; the model is never offered them.
  for (const derived of ["emergency", "auth_locked", "not_found"]) {
    assert(!(MODEL_ESCALATION_REASONS as readonly string[]).includes(derived), derived);
  }
});

Deno.test("no list has duplicates", () => {
  for (const [table, column, values] of PAIRS) {
    assertEquals(new Set(values).size, values.length, `${table}.${column}`);
  }
  assertEquals(new Set(CODES).size, CODES.length, "CODES");
});
