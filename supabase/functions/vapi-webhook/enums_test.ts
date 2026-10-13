// Parity between enums.ts and the live schema. A value the code writes but a CHECK constraint
// rejects only fails at runtime, on a real call, as a database error the caller hears as the
// trouble line; reading 0001_init.sql here turns that drift into a failing unit test instead.

import { assert, assertEquals } from "@std/assert";
import {
  ALERT_STATUSES,
  ANALYSIS_OUTCOMES,
  ANALYSIS_STATUSES,
  ATTEMPT_KINDS,
  CALL_REASON_SOURCES,
  CALL_REASONS,
  CALLBACK_SOURCES,
  CALLER_TYPES,
  CLAIM_DOCUMENTS,
  CLAIM_INTAKE_KINDS,
  CLAIM_STATUSES,
  CLAIM_TYPES,
  CODES,
  CONTACT_CALLBACK_SOURCES,
  CONTACT_KINDS,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  ESCALATION_KINDS,
  ESCALATION_REASONS,
  ESCALATION_STATUSES,
  GHL_TAGS,
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
  VERIFY_INTENTS,
} from "./enums.ts";

const SQL = await Deno.readTextFile(new URL("../../migrations/0001_init.sql", import.meta.url));

const OUTBOX_SQL = await Deno.readTextFile(new URL("../../migrations/0005_outbox.sql", import.meta.url));
const AUTOMATION_SQL = await Deno.readTextFile(new URL("../../migrations/0004_automation.sql", import.meta.url));
const CONTACTS_SQL = await Deno.readTextFile(new URL("../../migrations/0006_contacts.sql", import.meta.url));
const FNOL_SQL = await Deno.readTextFile(new URL("../../migrations/0007_fnol_reasons.sql", import.meta.url));
const GHL_SQL = await Deno.readTextFile(new URL("../../migrations/0008_ghl.sql", import.meta.url));

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

Deno.test("the outbox kinds equal 0005_outbox.sql; the destinations equal the CHECK 0008_ghl.sql puts back", () => {
  assertEquals(checkList("outbox_events", "kind", OUTBOX_SQL), [...OUTBOX_KINDS]);
  const original = checkList("outbox_events", "destination", OUTBOX_SQL);
  const widened = /add constraint outbox_events_destination_check check \(destination in \(([^)]*)\)\)/.exec(GHL_SQL);
  assert(widened, "the destination CHECK 0008 adds was found");
  assert(
    /alter table outbox_events drop constraint outbox_events_destination_check;/.test(GHL_SQL),
    "the old constraint is dropped first",
  );
  const destinations = [...widened[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assertEquals(destinations, [...OUTBOX_DESTINATIONS]);
  // nothing 0005 accepted is refused now (rows already stored stay valid)
  assertEquals(destinations.slice(0, original.length), original);
});

Deno.test("GHL_TAGS: lowercase, one oi- prefix, an outcome tag per outcome and a reason tag per call reason", () => {
  for (const tag of GHL_TAGS) {
    assert(/^oi-[a-z0-9_-]+$/.test(tag), tag);
    assert(!tag.slice(3).startsWith("oi-"), `${tag}: one prefix`);
    assert(tag.length <= 40, `${tag}: short enough for a CRM tag`);
  }
  assertEquals(GHL_TAGS.filter((t) => t.startsWith("oi-outcome-")), OUTCOMES.map((o) => `oi-outcome-${o}`));
  assertEquals(GHL_TAGS.filter((t) => t.startsWith("oi-reason-")), CALL_REASONS.map((r) => `oi-reason-${r}`));
  for (
    const fixed of [
      "oi-voice",
      "oi-caller-existing",
      "oi-caller-new",
      "oi-verified",
      "oi-unverified",
      "oi-verify-locked",
      "oi-lead-new",
      "oi-phone-matched",
      "oi-channel-phone",
      "oi-channel-web",
      "oi-callback",
      "oi-emergency",
      "oi-claim-filed",
      "oi-claim-intake",
    ]
  ) {
    assert((GHL_TAGS as readonly string[]).includes(fixed), fixed);
  }
  assertEquals(GHL_TAGS.length, 14 + OUTCOMES.length + CALL_REASONS.length);
});

Deno.test("the contact lists equal the CHECK constraints in 0006_contacts.sql", () => {
  assertEquals(checkList("caller_contacts", "kind", CONTACTS_SQL), [
    ...CONTACT_KINDS,
  ]);
  assertEquals(checkList("caller_contacts", "callback_source", CONTACTS_SQL), [
    ...CONTACT_CALLBACK_SOURCES,
  ]);
  // caller_type arrives with alter table, not inside a create table body
  const added = /add column caller_type text\b[^\n]*?check \(caller_type in \(([^)]*)\)\)/
    .exec(CONTACTS_SQL);
  assert(added, "caller_type's CHECK list was found");
  assertEquals([...added[1].matchAll(/'([^']*)'/g)].map((m) => m[1]), [
    ...CALLER_TYPES,
  ]);
  assert(
    /caller_type text not null default 'unknown'/.test(CONTACTS_SQL),
    "caller_type defaults to unknown",
  );
  for (const source of CONTACT_CALLBACK_SOURCES) {
    assert(
      (CALLBACK_SOURCES as readonly string[]).includes(source),
      `${source} is also an escalation source`,
    );
  }
});

/** The quoted values inside the first match's group (a CHECK list that may span lines). */
function quoted(re: RegExp, sql: string, what: string): string[] {
  const match = re.exec(sql);
  assert(match, `${what} was found`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

Deno.test("the email kinds equal the CHECK constraint 0007_fnol_reasons.sql puts back, which extends 0001's", () => {
  const widened = quoted(
    /add constraint emails_kind_check check \(kind in\s*\(([^)]*)\)\)/,
    FNOL_SQL,
    "the emails kind CHECK",
  );
  assertEquals(widened, [...EMAIL_KINDS]);
  assert(/alter table emails drop constraint emails_kind_check;/.test(FNOL_SQL), "the old constraint is dropped first");
  // nothing 0001 accepted is refused now (rows already stored stay valid)
  const original = checkList("emails", "kind");
  assertEquals(widened.slice(0, original.length), original);
  assertEquals(widened.slice(original.length), ["claim_received", "claim_intake"]);
});

Deno.test("the claim intake and call reason lists equal the CHECK constraints in 0007_fnol_reasons.sql", () => {
  assertEquals(checkList("claim_intakes", "kind", FNOL_SQL), [...CLAIM_INTAKE_KINDS]);
  assertEquals(checkList("claim_intakes", "claim_type", FNOL_SQL), [...CLAIM_TYPES]);
  assertEquals(
    quoted(/add column call_reason text check \(call_reason in\s*\(([^)]*)\)\)/, FNOL_SQL, "call_reason's CHECK"),
    [...CALL_REASONS],
  );
  assertEquals(
    quoted(
      /add column call_reason_source text check \(call_reason_source in\s*\(([^)]*)\)\)/,
      FNOL_SQL,
      "call_reason_source's CHECK",
    ),
    [...CALL_REASON_SOURCES],
  );
  // upsert_interaction ranks exactly these sources, highest first
  const ranks = [...FNOL_SQL.matchAll(/when '([a-z_]+)' then (\d)/g)].map((m) => `${m[1]}:${m[2]}`);
  assertEquals([...new Set(ranks)], ["server:3", "structured_output:2", "derived:1"]);
});

Deno.test("CLAIM_DOCUMENTS equals the lists file_claim_intake writes into claims.documents_required", () => {
  const auto = quoted(/when 'auto' then array\[([^\]]*)\]/, FNOL_SQL, "the auto documents");
  const other = quoted(/else array\[([^\]]*)\]/, FNOL_SQL, "the home and property documents");
  assertEquals(auto, [...CLAIM_DOCUMENTS.auto]);
  assertEquals(other, [...CLAIM_DOCUMENTS.home]);
  assertEquals(other, [...CLAIM_DOCUMENTS.property]);
  assertEquals(Object.keys(CLAIM_DOCUMENTS).sort(), [...CLAIM_TYPES].sort());
  // the home and property wording is the seeded claim's (0002_seed.sql), so both read the same
  const seed = Deno.readTextFileSync(new URL("../../migrations/0002_seed.sql", import.meta.url));
  for (const doc of CLAIM_DOCUMENTS.home) assert(seed.includes(`"${doc}"`), doc);
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
  // the verify intents name reasons a caller can have; each but "other" is also a call reason
  for (const intent of VERIFY_INTENTS) assert((CALL_REASONS as readonly string[]).includes(intent), intent);
});

Deno.test("no list has duplicates", () => {
  for (const [table, column, values] of PAIRS) {
    assertEquals(new Set(values).size, values.length, `${table}.${column}`);
  }
  assertEquals(new Set(CODES).size, CODES.length, "CODES");
  for (
    const list of [
      SERVER_TOOLS,
      CONTACT_KINDS,
      CONTACT_CALLBACK_SOURCES,
      CALLER_TYPES,
      EMAIL_KINDS,
      CALL_REASONS,
      CALL_REASON_SOURCES,
      CLAIM_INTAKE_KINDS,
      VERIFY_INTENTS,
      OUTBOX_DESTINATIONS,
      GHL_TAGS,
    ]
  ) {
    assertEquals(new Set(list).size, list.length);
  }
});
