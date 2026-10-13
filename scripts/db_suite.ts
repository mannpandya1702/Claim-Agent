// deno task db:test: SQL tests against the live demo project. Raw Postgres TCP is not reachable
// from every build environment, so everything goes through the Management API (scripts/lib/sql.ts).
//
// Each SQL case is one script: begin, assertions in DO blocks, rollback. Nothing it writes
// survives, and a failed ASSERT comes back as HTTP 400 with its message, which fails the case.
// Two cases cannot live inside one transaction: the concurrency case needs eight separate
// connections, and the store.ts round trip goes through PostgREST. Both use a call key unique to
// this run and delete what they wrote.
//
// Prints PASS / FAIL per case and exits 1 on any failure; prints NOT RUN and exits 0 when the
// project credentials are not configured.

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { loadEnv } from "./lib/env.ts";
import { lit, sqlClient } from "./lib/sql.ts";
import { MIRROR_COLUMNS } from "../supabase/functions/vapi-webhook/airtable.ts";
import type { JobName } from "../supabase/functions/vapi-webhook/enums.ts";
import { createStore, type StoreExtras } from "../supabase/functions/vapi-webhook/store.ts";

const env = loadEnv();
if (!env.SUPABASE_ACCESS_TOKEN || !env.SUPABASE_PROJECT_REF) {
  console.log("NOT RUN: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are not set");
  Deno.exit(0);
}
// PROTECTED_DB_REFS (local only, comma list) names projects these tests must never touch, so a
// mistyped ref fails here instead of writing test rows somewhere real.
const protectedRefs = (env.PROTECTED_DB_REFS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (protectedRefs.some((r) => env.SUPABASE_PROJECT_REF.includes(r) || (env.SUPABASE_URL ?? "").includes(r))) {
  console.error("refusing to run: the configured project is listed in PROTECTED_DB_REFS");
  Deno.exit(2);
}

const sql = sqlClient(env);
const run = crypto.randomUUID().slice(0, 8);
const DOB = [1986, 3, 14] as const;

// Grants the dashboard migration (0003), the outbox migration (0005, the staff read of
// outbox_events) and the contacts migration (0006, the staff read of caller_contacts) give to
// authenticated. Anything outside this list is a failure; before 0003 is
// applied authenticated must hold nothing at all.
const AUTHENTICATED_ALLOWLIST = [
  ...["staff", "call_interactions", "attempts", "call_sessions", "escalations", "emails", "job_runs"]
    .map((t) => `table:${t}:SELECT`),
  "table:transcript_lines:SELECT",
  "table:outbox_events:SELECT",
  "table:caller_contacts:SELECT",
  "table:ops_health:SELECT",
  "column:call_interactions.staff_notes:UPDATE",
  ...[
    "is_staff",
    "claim_escalation",
    "close_escalation",
    "dashboard_metrics",
    "calls_by_day",
    "search_calls",
    "escalation_delivery_gap",
  ].map((f) => `function:${f}:EXECUTE`),
];

// The functions only the Edge Function (service role) may call.
const SERVER_FUNCTIONS = [
  "lookup_customer_attempt(text,text,text,text,text)",
  "verify_dob_attempt(text,integer,integer,integer,text)",
  "upsert_escalation(text,text,text,text,text,text,text,boolean)",
  "upsert_interaction(jsonb)",
  "enqueue_outbox(text,text,text)",
  "claim_outbox(integer)",
  "upsert_caller_contact(text,text,text,text,text,text,text,uuid)",
  "set_caller_contact_confirmed(text,boolean)",
];

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
let failed = 0;

async function test(name: string, fn: () => Promise<void | "skip">) {
  const t0 = performance.now();
  try {
    const r = await fn();
    const ms = Math.round(performance.now() - t0);
    console.log(r === "skip" ? `SKIP  ${name}` : `PASS  ${name} (${ms} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface Fixture {
  callKey: string;
  customerId: string;
  phone: string; // the test customer's number
  nobody: string[]; // numbers that match no customer
  policy: string;
}

let fixtureSeq = 0;
function fixture(tag: string): Fixture {
  const n = String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  fixtureSeq++;
  return {
    callKey: `dbtest-${tag}-${run}`,
    customerId: crypto.randomUUID(),
    // +1999 / +1998 / +1997 are outside the seeded 602-555 range, so a lookup can never hit
    // a real demo customer by accident
    phone: `+1999${n}`,
    nobody: [`+1998${n}`, `+1997${n}`],
    policy: `POL-DBT-${run}-${fixtureSeq}`,
  };
}

function insertCustomer(f: Fixture, email: string | null = null): string {
  return `insert into customers (id, phone_e164, first_name, last_name, date_of_birth, policy_number, email)
    values (${lit(f.customerId)}, ${lit(f.phone)}, 'Dbtest', 'Customer', '${DOB.join("-")}', ${lit(f.policy)},
            ${lit(email)});`;
}

/** One rolled-back transaction with asserts enabled even if the server default turns them off. */
function tx(...statements: string[]): string {
  return `begin;\nset local plpgsql.check_asserts = on;\n${statements.join("\n")}\nrollback;`;
}

function doBlock(body: string, declare = "r record;"): string {
  return `do $t$\ndeclare ${declare}\nbegin\n${body}\nend\n$t$;`;
}

function lookup(f: Fixture, toolCallId: string, phone: string | null, code: string, misses: number): string {
  return `select * into r from lookup_customer_attempt(${lit(f.callKey)}, 'webCall', ${lit(phone)}, ${
    lit(toolCallId)
  }, null);
  assert r.code is not distinct from ${lit(code)} and r.misses = ${misses},
    format('lookup ${toolCallId}: got %s/%s, want ${code}/${misses}', r.code, r.misses);`;
}

function verify(
  f: Fixture,
  toolCallId: string,
  dob: readonly [number | null, number | null, number | null],
  code: string,
  attempts: number,
  verified = false,
): string {
  const [y, m, d] = dob;
  const first = verified ? "'Dbtest'" : "null";
  const customer = verified ? lit(f.customerId) : "null";
  return `select * into r from verify_dob_attempt(${lit(f.callKey)}, ${lit(y)}, ${lit(m)}, ${lit(d)}, ${
    lit(toolCallId)
  });
  assert r.code is not distinct from ${lit(code)} and r.attempts = ${attempts}
      and r.first_name is not distinct from ${first} and r.customer_id is not distinct from ${customer},
    format('verify ${toolCallId}: got %s/%s/%s/%s, want ${code}/${attempts}', r.code, r.attempts, r.first_name,
           r.customer_id);`;
}

function levelIs(f: Fixture, level: string): string {
  const q = `(select level from call_sessions where call_key = ${lit(f.callKey)})`;
  return `assert ${q} is not distinct from ${lit(level)}, format('level: got %s, want ${level}', ${q});`;
}

// Tool call ids are t01, t02, ... so their order is the call order (one transaction shares one now()).
function ledgerIs(f: Fixture, entries: string[]): string {
  const q = `(select coalesce(string_agg(kind || ':' || code, ',' order by tool_call_id), '')
      from attempts where call_key = ${lit(f.callKey)})`;
  return `assert ${q} = ${lit(entries.join(","))}, format('ledger: got %s', ${q});`;
}

// ---------------------------------------------------------------------------------------------
// Identity state machine
// ---------------------------------------------------------------------------------------------
await test("wrong DOB twice locks; the lock is sticky against a correct DOB and new lookups", async () => {
  const f = fixture("lock");
  await sql(tx(
    insertCustomer(f),
    doBlock([
      lookup(f, "t01", f.phone, "needs_dob", 0),
      levelIs(f, "phone_found"),
      verify(f, "t02", [1986, 3, 15], "auth_failed", 1),
      levelIs(f, "phone_found"),
      verify(f, "t03", [1987, 3, 14], "locked", 2),
      levelIs(f, "locked"),
      verify(f, "t04", DOB, "locked", 2),
      lookup(f, "t05", f.phone, "locked", 0),
      levelIs(f, "locked"),
      `assert (select verified_customer_id from call_sessions where call_key = ${lit(f.callKey)}) is null,
        'a locked session has a verified customer';`,
      ledgerIs(f, [
        "lookup_hit:needs_dob",
        "dob_wrong:auth_failed",
        "dob_wrong:locked",
        "other:locked",
        "other:locked",
      ]),
    ].join("\n")),
  ));
});

await test("right DOB verifies (also after one wrong answer); later steps keep the verified state", async () => {
  const f = fixture("verify");
  await sql(tx(
    insertCustomer(f),
    doBlock([
      lookup(f, "t01", f.phone, "needs_dob", 0),
      `assert (select candidate_customer_id from call_sessions where call_key = ${lit(f.callKey)}) = ${
        lit(f.customerId)
      }, 'candidate not set on a lookup hit';`,
      verify(f, "t02", [1986, 4, 14], "auth_failed", 1),
      verify(f, "t03", DOB, "verified", 1, true),
      levelIs(f, "verified"),
      `assert (select verified_customer_id from call_sessions where call_key = ${lit(f.callKey)}) = ${
        lit(f.customerId)
      }, 'verified customer not set';`,
      lookup(f, "t04", f.nobody[0], "already_verified", 0),
      verify(f, "t05", [1990, 1, 1], "verified", 1, true),
      ledgerIs(f, [
        "lookup_hit:needs_dob",
        "dob_wrong:auth_failed",
        "dob_ok:verified",
        "other:already_verified",
        "other:verified",
      ]),
    ].join("\n")),
  ));
});

await test("unreadable DOBs and phones are never counted; the third unreadable DOB gives up unlocked", async () => {
  const f = fixture("unread");
  await sql(tx(
    insertCustomer(f),
    doBlock([
      verify(f, "t01", DOB, "no_lookup_yet", 0),
      levelIs(f, "none"),
      lookup(f, "t02", null, "invalid_phone", 0),
      lookup(f, "t03", f.phone, "needs_dob", 0),
      verify(f, "t04", [null, null, null], "dob_unreadable", 0),
      verify(f, "t05", [1986, 2, 30], "dob_unreadable", 0),
      verify(f, "t06", [1986, 3, 15], "auth_failed", 1),
      // the unreadable phone (t02) is not a verify_identity read, so this is the third, not the fourth
      verify(f, "t07", [1899, 3, 14], "dob_give_up", 1),
      levelIs(f, "phone_found"),
      ledgerIs(f, [
        "other:no_lookup_yet",
        "unreadable:invalid_phone",
        "lookup_hit:needs_dob",
        "unreadable:dob_unreadable",
        "unreadable:dob_unreadable",
        "dob_wrong:auth_failed",
        "unreadable:dob_give_up",
      ]),
    ].join("\n")),
  ));
});

await test("two lookup misses end lookups for the call (not_found_final is sticky)", async () => {
  const f = fixture("notfound");
  await sql(tx(
    insertCustomer(f),
    doBlock([
      lookup(f, "t01", f.nobody[0], "not_found", 1),
      lookup(f, "t02", null, "invalid_phone", 1),
      lookup(f, "t03", f.nobody[1], "not_found_final", 2),
      lookup(f, "t04", f.phone, "not_found_final", 2),
      levelIs(f, "none"),
      `assert (select candidate_customer_id from call_sessions where call_key = ${lit(f.callKey)}) is null,
        'a sticky not_found_final still set a candidate';`,
      ledgerIs(f, [
        "lookup_miss:not_found",
        "unreadable:invalid_phone",
        "lookup_miss:not_found_final",
        "other:not_found_final",
      ]),
    ].join("\n")),
  ));
});

await test("a replayed toolCallId returns the stored code and never burns a counter", async () => {
  const f = fixture("replay");
  await sql(tx(
    insertCustomer(f),
    doBlock([
      lookup(f, "t01", f.nobody[0], "not_found", 1),
      lookup(f, "t01", f.nobody[0], "not_found", 1),
      lookup(f, "t01", f.phone, "not_found", 1), // a retry with other arguments is still the same call
      lookup(f, "t02", f.phone, "needs_dob", 1),
      verify(f, "t03", [1986, 3, 15], "auth_failed", 1),
      verify(f, "t03", [1986, 3, 15], "auth_failed", 1),
      verify(f, "t03", [1986, 3, 16], "auth_failed", 1),
      levelIs(f, "phone_found"),
      verify(f, "t04", DOB, "verified", 1, true),
      verify(f, "t04", DOB, "verified", 1, true),
      lookup(f, "t01", f.nobody[0], "not_found", 1),
      `assert (select count(*) from attempts where call_key = ${lit(f.callKey)}) = 4,
        format('attempts: got %s rows, want 4', (select count(*) from attempts where call_key = ${lit(f.callKey)}));`,
    ].join("\n")),
  ));
});

// ---------------------------------------------------------------------------------------------
// Write-back merges
// ---------------------------------------------------------------------------------------------
await test("upsert_escalation: one row per (call, kind); a repeat merges only a new number", async () => {
  const f = fixture("esc");
  const k = lit(f.callKey);
  const k2 = lit(`${f.callKey}-b`);
  const k3 = lit(`${f.callKey}-c`);
  await sql(tx(
    doBlock(
      `
  select * into r from upsert_escalation(${k}, 'representative', 'representative_requested', null, null, 'none',
                                         'webCall', false);
  assert r.inserted and r.callback_phone is null and r.callback_source = 'none' and r.alert_status = 'pending'
         and not r.verified, format('first upsert: %s', row_to_json(r));
  v_id := r.id;

  select * into r from upsert_escalation(${k}, 'representative', 'auth_locked', 'wants a call', '+16025550111',
                                         'argument', 'webCall', false);
  assert not r.inserted and r.id = v_id and r.callback_phone = '+16025550111' and r.callback_source = 'argument',
         format('number merge: %s', row_to_json(r));

  update escalations set alert_status = 'sent' where id = v_id;
  select * into r from upsert_escalation(${k}, 'representative', 'representative_requested', null, null, 'caller_id',
                                         'inboundPhoneCall', true);
  assert not r.inserted and r.callback_phone = '+16025550111' and r.callback_source = 'argument'
         and r.alert_status = 'sent' and r.verified, format('repeat without a number: %s', row_to_json(r));

  select * into r from upsert_escalation(${k}, 'representative', 'representative_requested', null, null, 'none',
                                         'webCall', false);
  assert r.verified, 'verified was cleared by a later upsert';

  select * into e from escalations where id = v_id;
  assert e.reason = 'representative_requested' and e.details = 'wants a call' and e.channel = 'webCall'
         and e.status = 'open' and e.delivery_error is null, format('merged row: %s', row_to_json(e));

  select * into r from upsert_escalation(${k}, 'emergency', 'emergency', null, null, 'none', 'webCall', false);
  assert r.inserted and r.id <> v_id, 'the emergency row must be separate from the representative row';
  assert (select count(*) from escalations where call_key = ${k}) = 2, 'expected exactly two rows for the call';

  select * into r from upsert_escalation(${k2}, 'representative', 'not_found', null, null, null, 'chat', null);
  assert r.callback_source = 'none' and not r.verified, format('null defaults: %s', row_to_json(r));

  begin
    perform upsert_escalation(${k3}, 'representative', 'made_up', null, null, 'none', 'webCall', false);
    assert false, 'a reason outside the CHECK list was accepted';
  exception when check_violation then null;
  end;`,
      "r record; e record; v_id uuid;",
    ),
  ));
});

await test("upsert_interaction merge order: stub, full, partial, stub after full, backfill", async () => {
  const f = fixture("eocr");
  const k = f.callKey;
  const stub = { vapi_call_id: k, channel: "webCall", started_at: "2026-10-12T14:00:00Z", outcome: "in_progress" };
  const full = {
    vapi_call_id: k,
    channel: "webCall",
    customer_id: f.customerId,
    caller_name: "Dbtest Customer",
    caller_phone: f.phone,
    summary: "Caller asked about a claim.",
    sentiment: "positive",
    sentiment_source: "vapi",
    outcome: "resolved",
    escalated: true,
    emergency: false,
    flags: ["tool_markup_spoken"],
    started_at: "2026-10-12T14:00:00Z",
    ended_at: "2026-10-12T14:03:30Z",
    duration_seconds: 210,
    ended_reason: "customer-ended-call",
    transcript: "AI: Hello\nUser: Hi",
    cost: 0.1234,
    messages: [{ role: "assistant", text: "Hello", t: "00:00" }],
    latency_avg_ms: 820,
    assistant_name: "solo-web",
    analysis_status: "ok",
  };
  const partial = {
    vapi_call_id: k,
    channel: "",
    summary: "",
    sentiment: null,
    outcome: "in_progress",
    escalated: false,
    flags: [],
    ended_at: "2026-10-12T14:03:31Z",
    transcript: "AI: Hello",
    analysis_status: "pending",
  };
  const lateStub = {
    vapi_call_id: k,
    channel: "inboundPhoneCall",
    caller_name: "Someone Else",
    started_at: "2026-10-12T15:00:00Z",
    outcome: "abandoned",
    emergency: true,
    analysis_status: "missing",
  };
  const backfill = {
    vapi_call_id: k,
    ended_at: "2026-10-12T14:03:31Z",
    sentiment: "negative",
    sentiment_source: "backfill",
    analysis_status: "backfilled",
  };
  const j = (v: unknown) => `${lit(JSON.stringify(v))}::jsonb`;
  const row = `select * into c from call_interactions where vapi_call_id = ${lit(k)};`;
  await sql(tx(
    insertCustomer(f),
    doBlock(
      `
  perform upsert_interaction(${j(stub)});
  ${row}
  assert c.outcome = 'in_progress' and c.status = 'in_progress' and not c.escalated and c.flags = '{}'
         and c.analysis_status = 'pending', format('stub: %s', row_to_json(c));

  perform upsert_interaction(${j(full)});
  ${row}
  assert c.outcome = 'resolved' and c.status = 'completed' and c.summary = 'Caller asked about a claim.'
         and c.flags = '{tool_markup_spoken}' and c.escalated and c.analysis_status = 'ok'
         and c.duration_seconds = 210 and c.customer_id = ${lit(f.customerId)}, format('full: %s', row_to_json(c));

  -- The merge itself lets a partial's shorter transcript replace the full one (text columns take any
  -- non-empty value). post_call.ts never sends a report without the analysis over a row whose
  -- analysis_status is ok or backfilled, so this path is pinned here as the function behaves.
  perform upsert_interaction(${j(partial)});
  ${row}
  assert c.summary = 'Caller asked about a claim.' and c.sentiment = 'positive' and c.outcome = 'resolved'
         and c.escalated and c.flags = '{tool_markup_spoken}' and c.analysis_status = 'ok' and c.channel = 'webCall'
         and c.transcript = 'AI: Hello' and c.ended_at = '2026-10-12T14:03:31Z' and c.status = 'completed',
         format('partial after full: %s', row_to_json(c));

  perform upsert_interaction(${j(lateStub)});
  ${row}
  assert c.channel = 'webCall' and c.caller_name = 'Dbtest Customer' and c.started_at = '2026-10-12T14:00:00Z'
         and c.outcome = 'resolved' and not c.emergency and c.analysis_status = 'ok',
         format('stub after full: %s', row_to_json(c));

  perform upsert_interaction(${j(backfill)});
  ${row}
  assert c.sentiment = 'negative' and c.sentiment_source = 'backfill' and c.analysis_status = 'backfilled'
         and c.summary = 'Caller asked about a claim.', format('backfill: %s', row_to_json(c));

  assert (select count(*) from call_interactions where vapi_call_id = ${lit(k)}) = 1, 'more than one row';`,
      "c record;",
    ),
  ));
});

// ---------------------------------------------------------------------------------------------
// Caller contacts and the post-call caller columns (0006)
// ---------------------------------------------------------------------------------------------
await test("caller_contacts: captured unconfirmed, confirmed once, kept by an identical capture, reset by a change", async () => {
  const f = fixture("contact");
  const k = lit(f.callKey);
  const upsert = (email: string | null, phone: string | null = "+16025550177", source = "argument") =>
    `upsert_caller_contact(${k}, 'new_customer', 'Jane', 'Doe', ${lit(email)}, ${lit(phone)}, ${lit(source)}, null)`;
  await sql(tx(
    insertCustomer(f),
    doBlock(
      `
  select * into r from ${upsert("jane.doe@example.com")};
  assert r.kind = 'new_customer' and r.first_name = 'Jane' and r.email = 'jane.doe@example.com'
    and r.callback_phone = '+16025550177' and r.callback_source = 'argument' and r.customer_id is null
    and not r.confirmed and r.confirmed_at is null, format('capture: %s', row_to_json(r));

  select * into r from set_caller_contact_confirmed(${k}, true);
  assert r.confirmed and r.confirmed_at is not null, format('confirm: %s', row_to_json(r));
  -- the first confirmation time is kept
  update caller_contacts set confirmed_at = '2001-01-01T00:00:00Z' where call_key = ${k};
  select * into r from set_caller_contact_confirmed(${k}, true);
  assert r.confirmed_at = '2001-01-01T00:00:00Z', format('second confirm moved the time: %s', r.confirmed_at);

  -- the same read-back again keeps the yes, even with another callback number (not read back)
  select * into r from ${upsert("jane.doe@example.com", null, "none")};
  assert r.confirmed and r.confirmed_at = '2001-01-01T00:00:00Z' and r.callback_phone is null
    and r.callback_source = 'none', format('identical capture: %s', row_to_json(r));
  -- a changed address needs a new yes
  select * into r from ${upsert("jayne.doe@example.com")};
  assert not r.confirmed and r.confirmed_at is null, format('changed capture: %s', row_to_json(r));
  perform set_caller_contact_confirmed(${k}, true);
  select * into r from set_caller_contact_confirmed(${k}, false);
  assert not r.confirmed and r.confirmed_at is null, format('no: %s', row_to_json(r));
  assert (select count(*) from caller_contacts where call_key = ${k}) = 1, 'one row per call';
  assert not exists (select 1 from set_caller_contact_confirmed(${lit(`${f.callKey}-none`)}, true)), 'no row, no confirm';

  -- an email update carries the verified customer; an unknown customer is refused
  select * into r from upsert_caller_contact(${lit(`${f.callKey}-upd`)}, 'email_update', 'Dbtest', 'Customer',
    'dbtest@example.com', null, 'none', ${lit(f.customerId)});
  assert r.kind = 'email_update' and r.customer_id = ${lit(f.customerId)}, format('update: %s', row_to_json(r));
  begin
    perform upsert_caller_contact(${lit(`${f.callKey}-fk`)}, 'email_update', 'A', 'B', null, null, 'none', gen_random_uuid());
    assert false, 'an unknown customer was accepted';
  exception when foreign_key_violation then null;
  end;

  -- the CHECKs
  begin perform upsert_caller_contact(${k}, 'prospect', 'A', 'B', null, null, 'none', null);
    assert false, 'kind'; exception when check_violation then null; end;
  begin perform upsert_caller_contact(${k}, 'new_customer', 'A', 'B', null, null, 'account', null);
    assert false, 'callback_source'; exception when check_violation then null; end;
  begin perform upsert_caller_contact(${k}, 'new_customer', '', 'B', null, null, 'none', null);
    assert false, 'empty first name'; exception when check_violation then null; end;
  begin perform upsert_caller_contact(${k}, 'new_customer', 'A', repeat('b', 41), null, null, 'none', null);
    assert false, 'long last name'; exception when check_violation then null; end;
  begin perform upsert_caller_contact(${k}, 'new_customer', 'A', 'B', 'Jane@Example.com', null, 'none', null);
    assert false, 'upper-case email'; exception when check_violation then null; end;
  begin perform upsert_caller_contact(${k}, 'new_customer', 'A', 'B', 'jane@example', null, 'none', null);
    assert false, 'email without a top-level domain'; exception when check_violation then null; end;
  begin perform upsert_caller_contact(${k}, 'new_customer', 'A', 'B', null, '6025550177', 'argument', null);
    assert false, 'callback not E.164'; exception when check_violation then null; end;
  begin update caller_contacts set confirmed = true, confirmed_at = null where call_key = ${k};
    assert false, 'confirmed without a time'; exception when check_violation then null; end;`,
      "r record;",
    ),
  ));
});

await test("upsert_interaction: caller_type replaces unknown, never downgrades; caller_email kept; search_calls returns both", async () => {
  const f = fixture("ctype");
  const k = f.callKey;
  const j = (v: Record<string, unknown>) => `${lit(JSON.stringify({ vapi_call_id: k, ...v }))}::jsonb`;
  const row = `select * into c from call_interactions where vapi_call_id = ${lit(k)};`;
  await sql(tx(doBlock(
    `
  perform upsert_interaction(${j({ outcome: "in_progress", started_at: "2026-10-12T14:00:00Z" })});
  ${row}
  assert c.caller_type = 'unknown' and c.caller_email is null and c.caller_email_masked is null,
    format('stub: %s/%s', c.caller_type, c.caller_email);

  perform upsert_interaction(${j({ caller_type: "new", caller_email: "jane.doe@example.com" })});
  ${row}
  assert c.caller_type = 'new' and c.caller_email = 'jane.doe@example.com' and c.caller_email_masked = 'j***@example.com',
    format('new: %s/%s/%s', c.caller_type, c.caller_email, c.caller_email_masked);

  perform upsert_interaction(${j({ outcome: "in_progress" })});
  perform upsert_interaction(${j({ caller_type: "unknown", caller_email: "" })});
  perform upsert_interaction(${j({ caller_type: null, caller_email: null })});
  ${row}
  assert c.caller_type = 'new' and c.caller_email = 'jane.doe@example.com',
    format('downgraded: %s/%s', c.caller_type, c.caller_email);

  perform upsert_interaction(${j({ caller_type: "existing", ended_at: "2026-10-12T14:03:00Z", outcome: "resolved" })});
  ${row}
  assert c.caller_type = 'existing', format('replace: %s', c.caller_type);
  -- forward-only: a stub after the end changes nothing, caller_type included
  perform upsert_interaction(${j({ caller_type: "new" })});
  ${row}
  assert c.caller_type = 'existing', format('stub after end: %s', c.caller_type);

  begin
    perform upsert_interaction(${lit(JSON.stringify({ vapi_call_id: `${k}-bad`, caller_type: "prospect" }))}::jsonb);
    assert false, 'an unknown caller_type was accepted';
  exception when check_violation then null;
  end;

  select * into s from search_calls(p_q => ${lit(k)}, p_limit => 5);
  assert s.vapi_call_id = ${lit(k)} and s.caller_type = 'existing' and s.caller_email_masked = 'j***@example.com',
    format('search_calls: %s', row_to_json(s));`,
    "c record; s record;",
  )));
});

// ---------------------------------------------------------------------------------------------
// Catalog: privileges and RLS
// ---------------------------------------------------------------------------------------------

/** Every privilege a role effectively holds in schema public, plus its explicit grants. */
function grantsOf(role: string): string {
  const r = lit(role);
  return `(select coalesce(array_agg(distinct g order by g), '{}') from (
    select format('table:%s:%s', c.relname, p.priv) g
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
      || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else '{}' end) p(priv)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(${r}, c.oid, p.priv)
    union all
    select format('column:%s.%s:%s', c.relname, a.attname, p.priv)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p(priv)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_column_privilege(${r}, c.oid, a.attnum, p.priv) and not has_table_privilege(${r}, c.oid, p.priv)
    union all
    select format('sequence:%s:%s', c.relname, p.priv)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) p(priv)
    where n.nspname = 'public' and c.relkind = 'S' and has_sequence_privilege(${r}, c.oid, p.priv)
    union all
    select format('function:%s:EXECUTE', p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege(${r}, p.oid, 'EXECUTE')
    union all
    select format('table:%s:%s', g.table_name, g.privilege_type)
    from information_schema.role_table_grants g where g.table_schema = 'public' and g.grantee = ${r}
    union all
    select format('function:%s:EXECUTE', g.routine_name)
    from information_schema.role_routine_grants g where g.routine_schema = 'public' and g.grantee = ${r}
  ) x)`;
}

await test("catalog: anon holds nothing in public; authenticated only the reviewed dashboard grants", async () => {
  const allow = `array[${AUTHENTICATED_ALLOWLIST.map(lit).join(", ")}]::text[]`;
  await sql(tx(doBlock(
    `
  v_anon := ${grantsOf("anon")};
  assert cardinality(v_anon) = 0, 'anon holds: ' || array_to_string(v_anon, ', ');

  v_auth := ${grantsOf("authenticated")};
  if to_regprocedure('public.is_staff()') is null then
    -- before the dashboard migration authenticated holds nothing either
    assert cardinality(v_auth) = 0, 'authenticated holds (no dashboard migration yet): ' || array_to_string(v_auth, ', ');
  else
    select array_agg(g order by g) into v_extra from unnest(v_auth) g where g <> all (${allow});
    assert v_extra is null, 'authenticated holds unreviewed privileges: ' || array_to_string(v_extra, ', ');
  end if;
  assert not (v_auth && array['table:customers:SELECT', 'table:claims:SELECT']),
    'authenticated can read customers or claims';`,
    "v_anon text[]; v_auth text[]; v_extra text[];",
  )));
});

await test("catalog: service_role has select/insert/update/delete on every table and runs the server functions", async () => {
  const fns = SERVER_FUNCTIONS.map((f) => lit(`public.${f}`)).join(", ");
  await sql(tx(doBlock(
    `
  select count(*), string_agg(format('%s:%s', c.relname, p.priv), ', ' order by c.relname, p.priv)
    into v_tables, v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not has_table_privilege('service_role', c.oid, p.priv);
  assert v_missing is null, 'service_role lacks: ' || v_missing;
  assert (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')) >= 11, 'expected at least the 11 tables of 0001';

  select string_agg(f, ', ') into v_missing from unnest(array[${fns}]) f
  where to_regprocedure(f) is null or not has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE');
  assert v_missing is null, 'service_role cannot execute: ' || v_missing;`,
    "v_tables bigint; v_missing text;",
  )));
});

await test("catalog: RLS is enabled on every table in public", async () => {
  await sql(tx(doBlock(
    `
  select string_agg(c.relname, ', ' order by c.relname) into v_off
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  assert v_off is null, 'RLS is off on: ' || v_off;`,
    "v_off text;",
  )));
});

await test("runtime: anon and authenticated are denied the customer data and the server functions", async () => {
  const denied = (role: string, extraTables: boolean) =>
    tx(
      `set local role ${role};`,
      doBlock(
        `
  for v_table in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (${extraTables} or c.relname in ('customers', 'claims'))
  loop
    begin
      execute format('select 1 from public.%I limit 1', v_table);
      assert false, format('${role} can read %s', v_table);
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.lookup_customer_attempt('dbtest-denied', 'webCall', null, 't01', null);
    assert false, '${role} can call lookup_customer_attempt';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.verify_dob_attempt('dbtest-denied', 1986, 3, 14, 't02');
    assert false, '${role} can call verify_dob_attempt';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.upsert_escalation('dbtest-denied', 'emergency', 'emergency', null, null, 'none', 'webCall', false);
    assert false, '${role} can call upsert_escalation';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.upsert_interaction('{"vapi_call_id": "dbtest-denied"}'::jsonb);
    assert false, '${role} can call upsert_interaction';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enqueue_outbox('interaction.completed', 'dbtest-denied');
    assert false, '${role} can call enqueue_outbox';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_outbox(1);
    assert false, '${role} can call claim_outbox';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.upsert_caller_contact('dbtest-denied', 'new_customer', 'A', 'B', null, null, 'none', null);
    assert false, '${role} can call upsert_caller_contact';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_caller_contact_confirmed('dbtest-denied', true);
    assert false, '${role} can call set_caller_contact_confirmed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.caller_contacts (call_key, kind, first_name, last_name) values ('dbtest-denied', 'new_customer', 'A', 'B');
    assert false, '${role} can insert caller_contacts';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.escalations (call_key, kind, reason, channel) values ('dbtest-denied', 'emergency', 'emergency', 'x');
    assert false, '${role} can insert escalations';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.call_interactions set summary = 'x' where false;
    assert false, '${role} can update call_interactions.summary';
  exception when insufficient_privilege then null;
  end;`,
        "v_table text;",
      ),
    );
  // anon is denied every table; authenticated may read the dashboard tables once 0003 is applied
  await sql(denied("anon", true));
  await sql(denied("authenticated", false));
});

await test("outbox: enqueue_outbox inserts once and re-arms; claim_outbox bumps attempts and stops at five", async () => {
  const k = lit(`dbtest-outbox-${run}`);
  await sql(tx(doBlock(
    `
  perform enqueue_outbox('interaction.completed', ${k});
  perform enqueue_outbox('interaction.completed', ${k}, 'airtable');
  assert (select count(*) from outbox_events where ref_id = ${k}) = 1, 'one row per (kind, ref_id, destination)';
  select id into v_id from outbox_events where ref_id = ${k};
  -- the oldest pending row, so a claim of one takes it whatever else is queued
  update outbox_events set created_at = '2001-01-01T00:00:00Z' where id = v_id;

  select * into r from claim_outbox(1);
  assert r.id = v_id and r.attempts = 1 and r.delivered_at is null, format('first claim: %s/%s', r.id, r.attempts);
  select * into r from claim_outbox(1);
  assert r.id = v_id and r.attempts = 2, format('second claim: %s/%s', r.id, r.attempts);

  update outbox_events set delivered_at = now(), last_error = 'old', external_id = 'recDB' where id = v_id;
  assert not exists (select 1 from claim_outbox(1000) c where c.id = v_id), 'a delivered row was claimed';

  perform enqueue_outbox('interaction.completed', ${k});
  select * into r from outbox_events where id = v_id;
  assert r.delivered_at is null and r.attempts = 0 and r.last_error is null and r.external_id = 'recDB'
    and r.created_at = '2001-01-01T00:00:00Z', 're-arm must reset delivery and budget, keep the record id and position';

  update outbox_events set attempts = 4 where id = v_id;
  select * into r from claim_outbox(1);
  assert r.id = v_id and r.attempts = 5, format('last claim: %s/%s', r.id, r.attempts);
  assert not exists (select 1 from claim_outbox(1000) c where c.id = v_id), 'a row at five attempts was claimed';

  begin
    perform enqueue_outbox('escalation.created', ${k});
    assert false, 'an unknown kind was accepted';
  exception when check_violation then null;
  end;
  begin
    perform enqueue_outbox('interaction.completed', ${k}, 'sheets');
    assert false, 'an unknown destination was accepted';
  exception when check_violation then null;
  end;`,
    "r record; v_id uuid;",
  )));
});

// ---------------------------------------------------------------------------------------------
// Committed cases (cleaned up)
// ---------------------------------------------------------------------------------------------
await test("8 concurrent deliveries of one toolCallId record exactly one attempt", async () => {
  const f = fixture("conc");
  const k = lit(f.callKey);
  const phone = f.nobody[0];
  const [{ n: owners }] = await sql<{ n: number }>(
    `select count(*)::int n from customers where phone_e164 = ${lit(phone)}`,
  );
  assertEquals(owners, 0, "the miss number belongs to a customer");
  // Every request sleeps until the same database-clock instant, so the eight function calls
  // really start together and contend for the call_sessions row lock.
  const at = lit(new Date(Date.now() + 2500).toISOString());
  const q = `select pg_sleep(greatest(0, extract(epoch from (${at}::timestamptz - clock_timestamp()))));
    select code, misses from lookup_customer_attempt(${k}, 'webCall', ${lit(phone)}, 'tc-conc', null);`;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => sql<{ code: string; misses: number }>(q)));
    assertEquals(results.map((r) => `${r[0]?.code}/${r[0]?.misses}`), Array(8).fill("not_found/1"));
    const [row] = await sql<{ attempts: number; misses: number; sessions: number; level: string }>(
      `select (select count(*)::int from attempts where call_key = ${k}) attempts,
              (select count(*)::int from attempts where call_key = ${k} and kind = 'lookup_miss') misses,
              (select count(*)::int from call_sessions where call_key = ${k}) sessions,
              (select level from call_sessions where call_key = ${k}) level`,
    );
    assertEquals(row, { attempts: 1, misses: 1, sessions: 1, level: "none" });
  } finally {
    await sql(`delete from attempts where call_key = ${k}; delete from call_sessions where call_key = ${k};`);
  }
});

await test("store.ts round trip through PostgREST maps every method onto the schema", async () => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return "skip";
  const f = fixture("store");
  const k = f.callKey;
  const claimNo = (s: string) => `CLM-T${run}${s}`;
  await sql(`begin;
    ${insertCustomer(f, "dbtest@example.com")}
    insert into claims (customer_id, claim_number, claim_type, status, documents_required, filed_on, updated_on,
                        amount_approved)
    values (${lit(f.customerId)}, ${lit(claimNo("b"))}, 'home', 'awaiting_documents', '{"photos","an estimate"}',
            '2026-10-02', '2026-10-05', null),
           (${lit(f.customerId)}, ${lit(claimNo("a"))}, 'auto', 'approved', '{}', '2026-10-02', '2026-10-06', 1250.50),
           (${lit(f.customerId)}, ${lit(claimNo("c"))}, 'property', 'closed', '{}', '2026-09-01', '2026-09-20', null);
    commit;`);
  // createStore keeps the Store contract's type; the extra reads are there at runtime too
  const store = createStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) as
    & ReturnType<typeof createStore>
    & StoreExtras;
  const lookupP = (toolCallId: string, phoneE164: string | null) =>
    store.lookupCustomerAttempt({ callKey: k, channel: "webCall", phoneE164, toolCallId, callerNumber: null });
  try {
    assertEquals(await store.getSession(k), null);
    await store.ensureSession(k, "webCall", "+16025550123");
    await store.ensureSession(k, "chat", null); // insert-or-nothing
    assertEquals(await store.getSession(k), {
      call_key: k,
      channel: "webCall",
      caller_number: "+16025550123",
      level: "none",
      candidate_customer_id: null,
      verified_customer_id: null,
    });

    assertEquals(await lookupP("t01", null), { code: "invalid_phone", misses: 0 });
    assertEquals(await lookupP("t02", f.phone), { code: "needs_dob", misses: 0 });
    assertEquals(await lookupP("t02", f.phone), { code: "needs_dob", misses: 0 });
    assertEquals(await store.verifyDobAttempt({ callKey: k, year: 1986, month: 3, day: 15, toolCallId: "t03" }), {
      code: "auth_failed",
      firstName: null,
      attempts: 1,
      customerId: null,
    });
    assertEquals(await store.verifyDobAttempt({ callKey: k, year: 1986, month: 3, day: 14, toolCallId: "t04" }), {
      code: "verified",
      firstName: "Dbtest",
      attempts: 1,
      customerId: f.customerId,
    });
    const s = await store.getSession(k);
    assertEquals([s?.level, s?.verified_customer_id], ["verified", f.customerId]);

    const c = await store.getCustomer(f.customerId);
    assert(c);
    assertFalse("date_of_birth" in c, "getCustomer returned the date of birth");
    assertEquals(c, {
      id: f.customerId,
      phone_e164: f.phone,
      first_name: "Dbtest",
      last_name: "Customer",
      policy_number: f.policy,
      email: "dbtest@example.com",
    });
    assertEquals(await store.getCustomer(crypto.randomUUID()), null);
    await assertRejects(() => store.getCustomer("not-a-uuid"), Error, "store.getCustomer");

    const claims = await store.getClaims(f.customerId);
    assertEquals(claims.map((x) => x.claim_number), [claimNo("c"), claimNo("a"), claimNo("b")]);
    assertEquals(claims[1].amount_approved, 1250.5);
    assertEquals(claims[2].documents_required, ["photos", "an estimate"]);
    assertEquals(claims[2].filed_on, "2026-10-02");

    assertEquals(await store.claimAttempt(k, "t05", "escalate"), null);
    assertEquals(await store.claimAttempt(k, "t05", "escalate"), null);
    await store.setAttemptCode(k, "t05", "rep_queued");
    assertEquals(await store.claimAttempt(k, "t05", "escalate"), "rep_queued");
    assertEquals(
      (await store.listAttempts(k)).map((a) => `${a.tool_call_id}:${a.tool_name}:${a.kind}:${a.code}`),
      [
        "t01:lookup_customer:unreadable:invalid_phone",
        "t02:lookup_customer:lookup_hit:needs_dob",
        "t03:verify_identity:dob_wrong:auth_failed",
        "t04:verify_identity:dob_ok:verified",
        "t05:escalate:other:rep_queued",
      ],
    );

    const esc = {
      callKey: k,
      kind: "representative" as const,
      reason: "representative_requested" as const,
      details: null,
      callbackPhone: null,
      callbackSource: "none" as const,
      channel: "webCall",
      verified: true,
    };
    const e1 = await store.upsertEscalation(esc);
    assertEquals([e1.inserted, e1.callbackPhone, e1.alertStatus], [true, null, "pending"]);
    const e2 = await store.upsertEscalation({ ...esc, callbackPhone: "+16025550111", callbackSource: "argument" });
    assertEquals(e2, { id: e1.id, inserted: false, callbackPhone: "+16025550111", alertStatus: "pending" });
    await store.setEscalationDelivery(e1.id, "failed", "telegram timeout");
    const escRows = await store.listEscalations(k);
    assertEquals(escRows.length, 1);
    assertEquals(
      [escRows[0].alert_status, escRows[0].delivery_error, escRows[0].callback_source, escRows[0].verified],
      ["failed", "telegram timeout", "argument", true],
    );

    assertEquals(await store.claimEmail(k, "claim_summary", "d***@example.com"), { claimed: true });
    assertEquals(await store.claimEmail(k, "claim_summary", "d***@example.com"), {
      claimed: false,
      status: "sending",
      resendId: null,
    });
    await store.finishEmail(k, "claim_summary", "sent", "re_dbtest", null);
    assertEquals(await store.claimEmail(k, "claim_summary", "d***@example.com"), {
      claimed: false,
      status: "sent",
      resendId: "re_dbtest",
    });
    assertEquals(await store.listEmails(k), [{
      call_key: k,
      kind: "claim_summary",
      to_masked: "d***@example.com",
      resend_id: "re_dbtest",
      status: "sent",
      error: null,
    }]);

    assertEquals(await store.storedAnalysisStatus(k), null);
    await store.ensureInteraction({
      vapi_call_id: k,
      channel: "webCall",
      started_at: "2026-10-12T14:00:00Z",
      outcome: "in_progress",
    });
    assertEquals(await store.storedAnalysisStatus(k), "pending");
    await store.ensureInteraction({ vapi_call_id: k, channel: "chat", outcome: "in_progress" });
    await store.upsertInteraction({
      vapi_call_id: k,
      customer_id: f.customerId,
      caller_name: "Dbtest Customer",
      summary: "Round trip.",
      sentiment: "neutral",
      sentiment_source: "vapi",
      outcome: "resolved",
      ended_at: "2026-10-12T14:02:00Z",
      duration_seconds: 120,
      flags: [],
      messages: [{ role: "user", text: "hi", t: "00:01" }],
      analysis_status: "ok",
    });
    assertEquals(await store.storedAnalysisStatus(k), "ok");
    const [ci] = await sql<{ channel: string; status: string; outcome: string; messages: unknown }>(
      `select channel, status, outcome, messages from call_interactions where vapi_call_id = ${lit(k)}`,
    );
    assertEquals(ci, {
      channel: "webCall",
      status: "completed",
      outcome: "resolved",
      messages: [{ role: "user", text: "hi", t: "00:01" }],
    });
    const prior = await store.priorInteractions(f.customerId, "some-other-call", 3);
    assertEquals(prior.map((p) => [p.vapi_call_id, p.summary]), [[k, "Round trip."]]);
    assert(Number.isFinite(Date.parse(prior[0].started_at)));
    assertEquals(await store.priorInteractions(f.customerId, k, 3), []);

    await store.insertTranscriptLine({
      call_key: k,
      role: "assistant",
      text: "What's the date of birth?",
      ts_ms: 2000,
    });
    await store.insertTranscriptLine({ call_key: k, role: "assistant", text: "Hello", ts_ms: 1000 });
    await store.insertTranscriptLine({ call_key: k, role: "user", text: "[answer withheld]", ts_ms: 3000 });
    await store.insertTranscriptLine({ call_key: k, role: "assistant", text: "retried delivery", ts_ms: 2000 });
    assertEquals(await store.lastAssistantLine(k), "What's the date of birth?");
    const [{ n: lines }] = await sql<{ n: number }>(
      `select count(*)::int n from transcript_lines where call_key = ${lit(k)}`,
    );
    assertEquals(lines, 3);
    await store.deleteTranscriptLines(k);
    assertEquals(await store.lastAssistantLine(k), null);

    // a capture also enforces the 7-day retention on the table
    await sql(`insert into webhook_captures (message_type, call_key, body, received_at)
      values ('status-update', ${lit(k)}, '{"stale":true}', now() - interval '8 days')`);
    await store.captureWebhook("status-update", k, { message: { type: "status-update", status: "in-progress" } });
    const caps = await sql<{ message_type: string; status: string }>(
      `select message_type, body->'message'->>'status' status from webhook_captures where call_key = ${lit(k)}`,
    );
    assertEquals(caps, [{ message_type: "status-update", status: "in-progress" }]);
  } finally {
    const kk = lit(k);
    await sql(`begin;
      delete from transcript_lines where call_key = ${kk};
      delete from call_interactions where vapi_call_id = ${kk} or customer_id = ${lit(f.customerId)};
      delete from emails where call_key = ${kk};
      delete from escalations where call_key = ${kk};
      delete from attempts where call_key = ${kk};
      delete from call_sessions where call_key = ${kk};
      delete from webhook_captures where call_key = ${kk};
      delete from claims where customer_id = ${lit(f.customerId)};
      delete from customers where id = ${lit(f.customerId)};
      commit;`);
  }
});

await test("store.ts round trip: caller contacts and the post-call caller columns", async () => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return "skip";
  const f = fixture("contactrt");
  const k = f.callKey;
  await sql(`begin; ${insertCustomer(f, "dbtest@example.com")} commit;`);
  const store = createStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const jane = {
    callKey: k,
    kind: "new_customer" as const,
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@example.com",
    callbackPhone: "+16025550177",
    callbackSource: "argument" as const,
    customerId: null,
  };
  try {
    assertEquals(await store.getContact(k), null);
    assertEquals(await store.setContactConfirmed(k, true), null);
    assertEquals(await store.upsertContact(jane), {
      call_key: k,
      kind: "new_customer",
      first_name: "Jane",
      last_name: "Doe",
      email: "jane.doe@example.com",
      callback_phone: "+16025550177",
      callback_source: "argument",
      customer_id: null,
      confirmed: false,
      confirmed_at: null,
    });
    const yes = await store.setContactConfirmed(k, true);
    assert(yes?.confirmed && typeof yes.confirmed_at === "string", "confirmed with a time");
    assertEquals((await store.upsertContact(jane)).confirmed, true, "an identical capture keeps the yes");
    const update = await store.upsertContact({ ...jane, kind: "email_update", customerId: f.customerId });
    assertEquals([update.kind, update.customer_id, update.confirmed], ["email_update", f.customerId, false]);
    assertEquals(await store.getContact(k), update);
    assertEquals((await store.setContactConfirmed(k, false))?.confirmed_at, null);
    await assertRejects(() => store.upsertContact({ ...jane, email: "Jane@Example.com" }), Error, "store.upsertContact");

    await store.upsertInteraction({ vapi_call_id: k, caller_type: "new", caller_email: "jane.doe@example.com" });
    await store.upsertInteraction({ vapi_call_id: k, caller_type: "unknown" });
    assertEquals(
      await sql(`select caller_type, caller_email, caller_email_masked from call_interactions where vapi_call_id = ${lit(k)}`),
      [{ caller_type: "new", caller_email: "jane.doe@example.com", caller_email_masked: "j***@example.com" }],
    );
    const mirror = await store.getInteractionForMirror(k);
    assertEquals([mirror?.caller_type, mirror?.caller_email], ["new", "jane.doe@example.com"]);
  } finally {
    await sql(`begin;
      delete from caller_contacts where call_key = ${lit(k)};
      delete from call_interactions where vapi_call_id = ${lit(k)};
      delete from customers where id = ${lit(f.customerId)};
      commit;`);
  }
});

await test("store.ts round trip: the outbox, job runs and the scheduled jobs' reads and writes", async () => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return "skip";
  // Every row sits in 2001 (or carries this run's prefix), so the windowed reads below can only
  // see what this case wrote, and the cleanup can only delete it.
  const k = `dbtest-jobs-${run}`;
  const ended = `${k}-ended`;
  const unqueued = `${k}-unqueued`;
  const stuck = `${k}-stuck`;
  const open = `${k}-open`;
  const chat = `${k}-chat`;
  const claimed = `${k}-claimed`;
  const job = `dbtest-${run}` as JobName; // job_runs.job has no CHECK; ops_health never reads it
  const day = { from: "2001-01-01T00:00:00Z", to: "2001-01-02T00:00:00Z" };
  const store = createStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) as
    & ReturnType<typeof createStore>
    & StoreExtras;
  const like = lit(`${k}%`);
  const ref = { kind: "interaction.completed", refId: ended, destination: "airtable" } as const;
  try {
    // outbox: the claim's compare-and-set, the lease and the guarded finish. An insert does not
    // fire the touch trigger, so the row heads the queue (2001) and reads as never written since
    // (both timestamps equal): the one untargeted claim below takes it and no real row. Every
    // later claim names the row.
    await sql(`insert into outbox_events (kind, ref_id, destination, created_at, updated_at)
      values ('interaction.completed', ${lit(ended)}, 'airtable', '2001-01-01T00:00:00Z', '2001-01-01T00:00:00Z')`);
    const [c] = await store.claimOutbox(1);
    assertEquals(
      [c?.ref_id, c?.attempts, c?.kind, c?.destination, c?.delivered_at, c?.external_id],
      [ended, 1, "interaction.completed", "airtable", null, null],
    );
    assert(Date.parse(c.updated_at) > Date.parse(day.to), "the claim returns its own write time");
    assertEquals(await store.claimOutbox(1, ref), [], "a claimed row is held for the lease");
    // eight runners after one fresh row at once: the compare-and-set lets exactly one take it
    const race = `${k}-race`;
    await sql(`insert into outbox_events (kind, ref_id, destination, created_at, updated_at)
      values ('interaction.completed', ${lit(race)}, 'airtable', '2001-01-01T00:00:01Z', '2001-01-01T00:00:01Z')`);
    const raceRef = { ...ref, refId: race };
    const won = (await Promise.all(Array.from({ length: 8 }, () => store.claimOutbox(1, raceRef)))).flat();
    assertEquals(won.map((r) => [r.ref_id, r.attempts]), [[race, 1]]);
    assertEquals(await sql(`select attempts from outbox_events where ref_id = ${lit(race)}`), [{ attempts: 1 }]);
    const outboxRow = async () =>
      (await sql<{ attempts: number; delivered: boolean; last_error: string | null; external_id: string | null }>(
        `select attempts, delivered_at is not null delivered, last_error, external_id from outbox_events
         where ref_id = ${lit(ended)}`,
      ))[0];
    assert(
      await store.finishOutbox(c.id, {
        delivered: false,
        error: "airtable 429: account 98765432101",
        attempt: 1,
        claimedAt: c.updated_at,
      }),
    );
    assertEquals(await outboxRow(), {
      attempts: 1,
      delivered: false,
      last_error: "airtable 429: account [digits]",
      external_id: null,
    });
    assertFalse(await store.finishOutbox(c.id, { delivered: true, externalId: "recX", attempt: 7 }), "attempt guard");
    assertFalse(
      await store.finishOutbox(c.id, { delivered: true, externalId: "recX", attempt: 1, claimedAt: c.updated_at }),
      "write-time guard: the row was written after this claim",
    );
    assert(await store.finishOutbox(c.id, { delivered: true, externalId: "recDB", attempt: 1 }));
    assertEquals(await outboxRow(), { attempts: 1, delivered: true, last_error: null, external_id: "recDB" });
    assert(await store.finishOutbox(c.id, { delivered: false, error: "airtable 401: bad token", refund: true, attempt: 1 }));
    assertEquals((await outboxRow()).attempts, 0, "a refund gives the attempt back");
    assert(await store.finishOutbox(c.id, { delivered: false, error: "airtable 422: bad value", dead: true }));
    assertEquals((await outboxRow()).attempts, 5);
    assertFalse(await store.finishOutbox(crypto.randomUUID(), { delivered: true }));
    await store.enqueueOutbox("interaction.completed", ended);
    assertEquals((await outboxRow()).attempts, 0);
    assertEquals(await store.claimOutbox(1, ref), [], "a re-armed row waits out the lease too");

    await sql(`begin;
      insert into call_interactions (vapi_call_id, channel, caller_name, caller_phone, summary, sentiment, outcome,
        flags, started_at, ended_at, duration_seconds, ended_reason, cost, transcript, analysis_status, created_at)
      values (${lit(ended)}, 'webCall', 'Dbtest Customer', '+19990000000', 'Round trip.', 'positive', 'resolved',
              '{tool_markup_spoken}', '2001-01-01T10:00:00Z', '2001-01-01T10:02:00Z', 120, 'customer-ended-call',
              0.1234, 'AI: not mirrored', 'ok', '2001-01-01T10:00:00Z'),
             (${lit(unqueued)}, 'webCall', 'Dbtest Customer', null, 'Unqueued.', 'neutral', 'resolved', '{}',
              '2001-01-01T10:03:00Z', '2001-01-01T10:05:00Z', 120, 'customer-ended-call', 0.01, null, 'ok',
              '2001-01-01T10:03:00Z'),
             (${lit(stuck)}, 'webCall', null, null, null, null, 'in_progress', '{}', '2001-01-01T09:00:00Z', null,
              null, null, null, null, 'pending', '2001-01-01T09:00:00Z');
      insert into call_interactions (vapi_call_id, outcome) values (${lit(open)}, 'in_progress');
      insert into escalations (call_key, kind, reason, channel, status, created_at)
      values (${lit(ended)}, 'representative', 'representative_requested', 'webCall', 'open', '2001-01-01T10:01:00Z'),
             (${lit(chat)}, 'representative', 'representative_requested', 'chat', 'open', '2001-01-01T10:01:00Z'),
             (${lit(claimed)}, 'emergency', 'emergency', 'webCall', 'claimed', '2001-01-01T10:01:00Z');
      insert into emails (call_key, kind, to_masked, status, created_at)
      values (${lit(ended)}, 'claim_summary', 'd***@example.com', 'sent', '2001-01-01T11:00:00Z');
      insert into transcript_lines (call_key, role, text, ts_ms, created_at)
      values (${lit(`${k}-orphan`)}, 'user', '[answer withheld]', 1, '2001-01-01T09:01:00Z'),
             (${lit(open)}, 'assistant', 'Hello.', 1, '2001-01-01T09:01:00Z'),
             (${lit(ended)}, 'assistant', 'Hello.', 1, '2001-01-01T10:00:01Z');
      insert into webhook_captures (message_type, call_key, body, received_at)
      values ('status-update', ${lit(ended)}, '{}', '2001-01-01T10:00:00Z');
      insert into job_runs (job, period_key, started_at) values (${lit(job)}, 'old', '2001-01-01T10:00:00Z');
      commit;`);

    const mirror = await store.getInteractionForMirror(ended);
    assert(mirror);
    assertEquals(Object.keys(mirror).sort(), [...MIRROR_COLUMNS].sort());
    assertEquals([mirror.caller_name, mirror.flags, Number(mirror.cost), mirror.duration_seconds], [
      "Dbtest Customer",
      ["tool_markup_spoken"],
      0.1234,
      120,
    ]);
    assertEquals(await store.getInteractionForMirror(`${k}-none`), null);
    assertEquals(
      [await store.interactionEnded(ended), await store.interactionEnded(open), await store.interactionEnded(`${k}-none`)],
      [true, false, false],
    );

    // the call-log sweep: the ended row whose outbox row was delivered before the record last
    // changed, and the one with no outbox row at all, oldest end first; a pending row is no gap
    await sql(`update outbox_events set delivered_at = '2001-01-01T10:30:00Z' where ref_id = ${lit(ended)}`);
    assertEquals(await store.listOutboxGaps(day.from, day.to), [ended, unqueued]);
    await sql(`update outbox_events set delivered_at = null where ref_id = ${lit(ended)}`);
    assertEquals(await store.listOutboxGaps(day.from, day.to), [unqueued]);
    await sql(`update outbox_events set delivered_at = now() where ref_id = ${lit(ended)}`);
    assertEquals(await store.listOutboxGaps(day.from, day.to), [unqueued], "delivered after its last change");

    assert(await store.claimJobRun(job, "p1"));
    assertFalse(await store.claimJobRun(job, "p1"));
    assert(await store.claimJobRun(job, "p2"));
    await store.finishJobRun(job, "p1", { delivered: 2, skipped: "x" });
    // a release gives back only the unfinished run, and the period can be claimed again
    await store.releaseJobRun(job, "p1");
    await store.releaseJobRun(job, "p2");
    assertEquals(
      (await sql<{ period_key: string }>(`select period_key from job_runs where job = ${lit(job)} order by 1`))
        .map((r) => r.period_key),
      ["old", "p1"],
    );
    assertFalse(await store.claimJobRun(job, "p1"));
    assert(await store.claimJobRun(job, "p2"));
    assertEquals(
      await sql(`select period_key, result, finished_at is not null finished from job_runs where job = ${lit(job)}
                 and period_key in ('p1', 'p2') order by period_key`),
      [
        { period_key: "p1", result: { delivered: 2, skipped: "x" }, finished: true },
        { period_key: "p2", result: null, finished: false },
      ],
    );

    const stale = await store.listStaleEscalations(day.to);
    assertEquals(stale.map((e) => [e.call_key, e.kind, e.reason, e.channel, e.verified]), [
      [ended, "representative", "representative_requested", "webCall", false],
    ]);
    assert(await store.markRealerted(stale[0].id));
    const [{ at: first }] = await sql<{ at: string }>(`select realerted_at at from escalations where call_key = ${lit(ended)}`);
    assert(first, "realerted_at set");
    assertFalse(await store.markRealerted(stale[0].id));
    const [{ at: second }] = await sql<{ at: string }>(`select realerted_at at from escalations where call_key = ${lit(ended)}`);
    assertEquals(second, first, "set once");
    assertEquals(await store.listStaleEscalations(day.to), []);
    // a row staff claimed is never marked, so it is never paged
    const [{ id: claimedId }] = await sql<{ id: string }>(`select id from escalations where call_key = ${lit(claimed)}`);
    assertFalse(await store.markRealerted(claimedId));
    assertEquals(
      await sql(`select realerted_at from escalations where call_key = ${lit(claimed)}`),
      [{ realerted_at: null }],
    );

    assertEquals(await store.digestStats(day.from, day.to), {
      calls: 3,
      completed: 2,
      outcomes: { resolved: 2, in_progress: 1 },
      sentiments: { positive: 1, neutral: 1, unknown: 1 },
      flagged: 1,
      escalations: { open: 2, claimed: 1, done: 0 },
      emails_sent: 1,
      total_cost: 0.1334,
    });

    assertEquals((await store.listStuckInteractions(day.to)).map((r) => r.vapi_call_id), [stuck]);
    assert(await store.reapInteraction(stuck));
    assertFalse(await store.reapInteraction(stuck), "a second reap finds nothing to close");
    assertFalse(await store.reapInteraction(ended), "a completed row is never touched");
    assertEquals(
      await sql(`select vapi_call_id, outcome, analysis_status, ended_reason, ended_at is not null ended
                 from call_interactions where vapi_call_id in (${lit(stuck)}, ${lit(ended)}) order by vapi_call_id`),
      [
        { vapi_call_id: ended, outcome: "resolved", analysis_status: "ok", ended_reason: "customer-ended-call", ended: true },
        { vapi_call_id: stuck, outcome: "abandoned", analysis_status: "missing", ended_reason: "reaped", ended: true },
      ],
    );
    assertEquals(await store.listStuckInteractions(day.to), []);

    // every old line goes, the ended call's too
    assertEquals(await store.deleteOldTranscriptLines(day.to), 3);
    assertEquals(await sql(`select call_key from transcript_lines where call_key like ${like} order by call_key`), []);
    assertEquals(await store.pruneWebhookCaptures(day.to), 1);
    assertEquals(await store.pruneJobRuns([job], day.to), 1);
    assertEquals(
      (await sql<{ period_key: string }>(`select period_key from job_runs where job = ${lit(job)} order by 1`))
        .map((r) => r.period_key),
      ["p1", "p2"],
    );
  } finally {
    await sql(`begin;
      delete from outbox_events where ref_id like ${like};
      delete from job_runs where job = ${lit(job)};
      delete from transcript_lines where call_key like ${like};
      delete from webhook_captures where call_key like ${like};
      delete from emails where call_key like ${like};
      delete from escalations where call_key like ${like};
      delete from call_interactions where vapi_call_id like ${like};
      commit;`);
  }
});

console.log(failed ? `\n${failed} case(s) failed` : "\nall cases passed");
Deno.exit(failed ? 1 : 0);
