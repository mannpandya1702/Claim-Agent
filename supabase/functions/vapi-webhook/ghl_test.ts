// The GoHighLevel adapter against the in-memory GHL twin (ghl_twin.ts) and the in-memory store: who
// the contact is (trusted numbers only), what is written to it (additive tags, one note of server
// facts, the follow-up tasks, a fill-only PUT), how a delivery resumes from its recorded progress,
// how each GHL answer is classified, and how the outbox gives GHL its own queue, delay and loop.
// No network.

import { assert, assertEquals, assertFalse, assertMatch, assertNotMatch, assertStringIncludes } from "@std/assert";
import { type EscalationReason, GHL_TAGS, OUTCOMES } from "./enums.ts";
import { createFakeStore, demoSeed, type FakeStore } from "./fake_store.ts";
import {
  contactBlocked,
  deliverGhl,
  fillMissing,
  GHL_BASE_URL,
  GHL_DELAY_S,
  type GhlFacts,
  ghlRequest,
  loadGhlFacts,
  nextBusinessDayDue,
  pickContact,
  planCaller,
  renderNote,
  tagsFor,
  tasksFor,
} from "./ghl.ts";
import { createGhlTwin, type GhlTwin } from "./ghl_twin.ts";
import { runJob } from "./jobs.ts";
import { deliverOutbox, enqueueInteraction } from "./outbox.ts";
import { onEndOfCallReport } from "./post_call.ts";
import { OUTBOX_LEASE_MS } from "./store_rules.ts";
import type { Deps, Env, OutboxRef, VapiMessage } from "./types.ts";

const NOW = new Date("2026-10-13T15:00:00.000Z"); // a Tuesday, 11:00 Eastern
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TOKEN = "pit-ghl-test-token";
const LOCATION = "locGhlTestOnly01";
const ASSIGNEE = "userAssigneeTest01";
const EMERGENCY_USER = "userEmergencyTest01";
const DASHBOARD = "https://staff.example.com/";
const GHL_ENV: Partial<Env> = {
  GHL_TOKEN: TOKEN,
  GHL_LOCATION_ID: LOCATION,
  GHL_ASSIGNEE_USER_ID: ASSIGNEE,
  DASHBOARD_URL: DASHBOARD,
};
const AIRTABLE_ENV: Partial<Env> = { AIRTABLE_TOKEN: "pat_ghl_test", AIRTABLE_BASE_ID: "appGHLTEST" };

const SEED = demoSeed();
const TOBIAS = SEED.customers[0]; // +16025550101, an email on file
const TEAGUE = SEED.customers[3]; // +16025550104, no email on file
const STRANGER_PHONE = "+16025550177"; // no account
const NEW_CALLER_PHONE = "+16025550188";

const CALL_A = "9b1d2c3e-0000-4000-8000-0000000000a1";
const CALL_B = "9b1d2c3e-0000-4000-8000-0000000000b2";
const CALL_C = "9b1d2c3e-0000-4000-8000-0000000000c3";

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function harness(opts: {
  env?: Partial<Env>;
  at?: Date;
  dndOnCreate?: boolean;
  airtable?: Responder;
  // runs before the twin answers each GHL request (move the clock, re-arm a row, ...)
  beforeGhl?: (path: string, init: RequestInit) => void | Promise<void>;
} = {}) {
  let t = (opts.at ?? NOW).getTime();
  const clock = () => new Date(t);
  const store = createFakeStore(undefined, { now: clock });
  const twin = createGhlTwin({ token: TOKEN, locationId: LOCATION, now: clock, dndOnCreate: opts.dndOnCreate });
  const logs: Record<string, unknown>[] = [];
  const airtable: string[] = [];
  const background: Promise<unknown>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GHL_BASE_URL)) {
      await opts.beforeGhl?.(new URL(url).pathname, init ?? {});
      return await twin.fetch(input, init);
    }
    if (url.startsWith("https://api.airtable.com/")) {
      airtable.push(JSON.parse(String(init?.body)).records[0].fields["Call ID"]);
      const reply: Responder = opts.airtable ?? (() => json({ records: [{ id: `rec${airtable.length}` }] }));
      return await reply(url, init ?? {});
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    store,
    fetch: fetchFn,
    env: { VAPI_ORG_ID: "org", VAPI_WEBHOOK_SECRET: "s", ...(opts.env ?? GHL_ENV) },
    now: clock,
    waitUntil: (p) => {
      background.push(p);
    },
    log: (e) => logs.push(e),
  };
  return {
    store,
    twin,
    deps,
    logs,
    airtable,
    background,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

type H = ReturnType<typeof harness>;

interface CallSpec {
  channel?: "inboundPhoneCall" | "outboundPhoneCall" | "webCall";
  callerId?: string | null;
  identity?: "verified" | "locked" | "phone_found" | "miss" | "none";
  customer?: typeof TOBIAS;
  contact?: {
    kind?: "new_customer" | "email_update";
    first: string;
    last: string;
    email?: string | null;
    phone?: string | null;
    // where the number came from: said by the caller (default) or the call's own caller id
    source?: "argument" | "caller_id";
    confirmed?: boolean;
  };
  escalations?: {
    kind: "representative" | "emergency";
    reason?: EscalationReason;
    phone?: string | null;
  }[];
  intake?: "claim" | "lead_intake";
  outcome?: string;
  reason?: string | null;
  summary?: string | null;
  callerType?: "existing" | "new" | "unknown";
}

/** A finished call in the store, walked through the same store calls the tools make. */
async function seedCall(store: FakeStore, callKey: string, spec: CallSpec = {}): Promise<void> {
  const channel = spec.channel ?? "inboundPhoneCall";
  const customer = spec.customer ?? TOBIAS;
  const callerId = spec.callerId !== undefined ? spec.callerId : channel === "webCall" ? null : customer.phone_e164;
  const identity = spec.identity ?? "verified";
  await store.ensureSession(callKey, channel, callerId);
  let seq = 0;
  const lookup = (phone: string) =>
    store.lookupCustomerAttempt({
      callKey,
      channel,
      phoneE164: phone,
      toolCallId: `${callKey}-t${++seq}`,
      callerNumber: callerId,
    });
  const dob = (y: number, m: number, d: number) =>
    store.verifyDobAttempt({ callKey, year: y, month: m, day: d, toolCallId: `${callKey}-t${++seq}` });
  if (identity === "verified" || identity === "locked" || identity === "phone_found") await lookup(customer.phone_e164);
  if (identity === "verified") {
    const [y, m, d] = customer.date_of_birth.split("-").map(Number);
    await dob(y, m, d);
  }
  if (identity === "locked") {
    await dob(2001, 1, 1);
    await dob(2001, 1, 2);
  }
  if (identity === "miss") {
    await lookup("+16025550199");
    await lookup("+16025550198");
  }
  if (spec.contact) {
    const kind = spec.contact.kind ?? "new_customer";
    await store.upsertContact({
      callKey,
      kind,
      firstName: spec.contact.first,
      lastName: spec.contact.last,
      email: spec.contact.email ?? null,
      callbackPhone: spec.contact.phone ?? null,
      callbackSource: spec.contact.phone ? spec.contact.source ?? "argument" : "none",
      customerId: kind === "email_update" ? customer.id : null,
    });
    if (spec.contact.confirmed !== false) await store.setContactConfirmed(callKey, true);
  }
  for (const e of spec.escalations ?? []) {
    await store.upsertEscalation({
      callKey,
      kind: e.kind,
      reason: e.reason ?? (e.kind === "emergency" ? "emergency" : "representative_requested"),
      details: null,
      callbackPhone: e.phone ?? null,
      callbackSource: e.phone ? "caller_id" : "none",
      channel,
      verified: identity === "verified",
    });
  }
  if (spec.intake) {
    await store.upsertClaimIntake({
      callKey,
      kind: spec.intake,
      claimType: "auto",
      lossDate: "2026-10-10",
      summary: "cracked windshield",
      description: "A rock hit my windshield on the highway and cracked it.",
      customerId: spec.intake === "claim" ? customer.id : null,
    });
    await store.fileClaimIntake(callKey);
  }
  const reason = spec.reason === undefined ? "claim_status" : spec.reason;
  const existing = identity === "verified" || identity === "locked" || identity === "phone_found";
  await store.upsertInteraction({
    vapi_call_id: callKey,
    channel,
    outcome: spec.outcome ?? "resolved",
    call_reason: reason as never,
    call_reason_source: reason ? "derived" : null,
    summary: spec.summary !== undefined
      ? spec.summary
      : "The caller checked on their auto claim and heard it is under review.",
    caller_type: spec.callerType ?? (existing ? "existing" : spec.contact ? "new" : "unknown"),
    caller_phone: callerId,
    started_at: "2026-10-13T14:52:00.000Z",
    ended_at: "2026-10-13T14:58:00.000Z",
    analysis_status: "ok",
  });
}

const ref = (callKey: string): OutboxRef => ({ kind: "interaction.completed", refId: callKey, destination: "ghl" });

async function queue(store: FakeStore, callKey: string): Promise<void> {
  await store.enqueueOutbox("interaction.completed", callKey, "ghl");
}

function row(store: FakeStore, callKey: string, destination = "ghl") {
  return store.tables.outbox_events.find((o) => o.ref_id === callKey && o.destination === destination)!;
}

const deliver = (h: H, callKey: string, deadlineMs = 8000) => deliverOutbox(h.deps, { deadlineMs, ref: ref(callKey) });
const steps = (twin: GhlTwin) => twin.requests.map((r) => `${r.method} ${r.path}`);
const allBodies = (twin: GhlTwin) => JSON.stringify(twin.requests.map((r) => r.body ?? null));

// ---------------------------------------------------------------------------------------------
// The twin is honest.
// ---------------------------------------------------------------------------------------------
Deno.test("ghl twin: POST tags merges, a PUT with tags replaces them, duplicates and unknown ids answer like GHL", async () => {
  const twin = createGhlTwin({ token: TOKEN, locationId: LOCATION });
  const deps = { ...harness().deps, fetch: twin.fetch };
  const created = await ghlRequest(deps, "POST", "/contacts/", { phone: STRANGER_PHONE, firstName: "Ada" });
  assert(created.ok && created.status === 201);
  const id = created.data.contact.id;
  await ghlRequest(deps, "POST", `/contacts/${id}/tags`, { tags: ["oi-voice", "oi-verified"] });
  const again = await ghlRequest(deps, "POST", `/contacts/${id}/tags`, { tags: ["oi-voice", "oi-callback"] });
  assert(again.ok);
  assertEquals(again.data.tagsAdded, ["oi-callback"]);
  assertEquals(twin.contact(id)!.tags, ["oi-voice", "oi-verified", "oi-callback"], "POST tags is additive");
  await ghlRequest(deps, "PUT", `/contacts/${id}`, { tags: ["staff-tag"] });
  assertEquals(
    twin.contact(id)!.tags,
    ["staff-tag"],
    "a PUT carrying tags wipes the others: why ghl.ts never sends one",
  );

  const dup = await ghlRequest(deps, "POST", "/contacts/", { phone: STRANGER_PHONE });
  assert(!dup.ok);
  assertEquals([dup.status, dup.kind, dup.meta], [400, "duplicate", { contactId: id, matchingField: "phone" }]);
  const gone = await ghlRequest(deps, "POST", "/contacts/nope/notes", { body: "x" });
  assert(!gone.ok);
  assertEquals(
    [gone.status, gone.kind],
    [400, "not_found"],
    "an unknown id is a 400 'not found', classified not_found",
  );
  const tenDigits = await ghlRequest(deps, "POST", "/contacts/search", {
    filters: [{ field: "phone", operator: "eq", value: STRANGER_PHONE.slice(2) }],
  });
  assert(tenDigits.ok);
  assertEquals(tenDigits.data.contacts, [], "search matches E.164 only");
  const badToken = await ghlRequest({ ...deps, env: { ...deps.env, GHL_TOKEN: "wrong" } }, "GET", `/contacts/${id}`);
  assert(!badToken.ok);
  assertEquals([badToken.status, badToken.kind, badToken.retryable], [401, "config", false]);
  const noCompleted = await ghlRequest(deps, "POST", `/contacts/${id}/tasks`, {
    title: "t",
    dueDate: NOW.toISOString(),
  });
  assert(!noCompleted.ok);
  assertEquals(noCompleted.kind, "invalid");
});

// ---------------------------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------------------------
Deno.test("ghl wire: Bearer token, Version 2021-07-28, JSON only with a body, locationId only on create and search", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assert(h.twin.requests.length >= 4);
  for (const r of h.twin.requests) {
    assertEquals(r.url, `${GHL_BASE_URL}${r.path}`);
    assertEquals(r.headers.authorization, `Bearer ${TOKEN}`);
    assertEquals(r.headers.version, "2021-07-28");
    assertEquals(r.headers.accept, "application/json");
    assertEquals(r.headers["content-type"], r.body === undefined ? undefined : "application/json", r.path);
    const located = r.path === "/contacts/search" || r.path === "/contacts/";
    assertEquals(r.body?.locationId, located ? LOCATION : undefined, `${r.method} ${r.path}`);
  }
  // the search key is E.164, and only the number we trust
  assertEquals(h.twin.requests[0].body.filters, [{ field: "phone", operator: "eq", value: TOBIAS.phone_e164 }]);
});

// ---------------------------------------------------------------------------------------------
// Verified callers.
// ---------------------------------------------------------------------------------------------
Deno.test("ghl verified, no contact: search, create (no tags key, on-file email, source), tags, note, done", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(steps(h.twin).slice(0, 2), ["POST /contacts/search", "POST /contacts/"]);
  const [contact] = h.twin.contacts;
  assertEquals(steps(h.twin).slice(2), [`POST /contacts/${contact.id}/tags`, `POST /contacts/${contact.id}/notes`]);
  const create = h.twin.requests[1].body;
  assertFalse("tags" in create, "a create never carries tags");
  // a note is the body alone: no userId, so it never reads as written by a staff member
  assertEquals(Object.keys(h.twin.requests[3].body), ["body"]);
  assertEquals(h.twin.notes[0].userId, null);
  assertEquals(
    [create.firstName, create.lastName, create.email, create.phone, create.source],
    ["Tobias", "Halvorsen", TOBIAS.email, TOBIAS.phone_e164, "Observe voice agent"],
  );
  assertEquals(contact.tags, [
    "oi-voice",
    "oi-channel-phone",
    "oi-caller-existing",
    "oi-verified",
    "oi-outcome-resolved",
    "oi-reason-claim_status",
  ]);
  assertEquals(h.twin.notes.length, 1);
  assertEquals(h.twin.tasks.length, 0, "no escalation, no claim: no task");
  const r = row(h.store, CALL_A);
  assertEquals([r.attempts, r.external_id, r.last_error, typeof r.delivered_at], [1, contact.id, null, "string"]);
  assertEquals(r.progress.contact_id, contact.id);
  assertEquals(
    [r.progress.mode, r.progress.contact_created, r.progress.tags_done, r.progress.done],
    ["verified", true, true, true],
  );
  assertEquals(r.progress.note_id, h.twin.notes[0].id);
});

Deno.test("ghl verified, contact found: a name a human edited is kept, an empty email is filled from the account", async () => {
  const h = harness();
  const existing = h.twin.addContact({
    phone: TOBIAS.phone_e164,
    firstName: "Toby",
    lastName: "Halvorsen",
    tags: ["vip"],
  });
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  const puts = h.twin.requests.filter((r) => r.method === "PUT");
  assertEquals(puts.map((r) => [r.path, r.body]), [[`/contacts/${existing.id}`, { email: TOBIAS.email }]]);
  assertEquals([existing.firstName, existing.email], ["Toby", TOBIAS.email]);
  assertEquals(existing.tags[0], "vip", "a staff tag survives: tags are only ever added");
  assert(h.logs.some((l) => l.event === "ghl_enrich_kept" && JSON.stringify(l.fields) === '["firstName"]'));
  assertEquals(h.twin.contacts.length, 1);
  assertEquals(row(h.store, CALL_A).progress.enriched, ["email"]);
});

Deno.test("ghl verified: an address the caller spelled on the call is never written, only shown masked in the note", async () => {
  const h = harness();
  h.twin.addContact({ phone: TEAGUE.phone_e164, firstName: "Teague", lastName: "Ashdown" });
  await seedCall(h.store, CALL_A, {
    customer: TEAGUE,
    contact: { kind: "email_update", first: "Teague", last: "Ashdown", email: "teague.spelled@example.com" },
    reason: "update_details",
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  assertEquals(h.twin.requests.filter((r) => r.method === "PUT"), [], "nothing empty to fill from the account");
  assertFalse(allBodies(h.twin).includes("teague.spelled@example.com"));
  assertStringIncludes(
    h.twin.notes[0].body,
    "Email update requested (caller-provided, not verified): t***@example.com",
  );
});

Deno.test("ghl verified: several contacts on the number: the unique full-name match, else the oldest", () => {
  const plan = planCaller(facts({ level: "verified" }), []);
  const a = { id: "a", firstName: "Someone", lastName: "Else", dateAdded: "2024-01-01T00:00:00Z" };
  const b = { id: "b", firstName: "tobias", lastName: "HALVORSEN", dateAdded: "2025-01-01T00:00:00Z" };
  const c = { id: "c", firstName: "Third", lastName: "Person", dateAdded: "2023-06-01T00:00:00Z" };
  assertEquals(pickContact([a, b, c], plan)?.id, "b");
  assertEquals(pickContact([a, c], plan)?.id, "c", "no name match: the oldest");
  assertEquals(pickContact([a, b, { ...b, id: "b2" }], plan)?.id, "a", "two name matches: the oldest");
  const unverified = planCaller(facts({ level: "phone_found" }), []);
  assertEquals(pickContact([a, b, c], unverified)?.id, "c", "an unverified caller never picks by name");
  assertEquals(pickContact([], plan), null);
});

Deno.test("ghl fillMissing: only empty firstName, lastName and email; never tags, phone or dnd", () => {
  const desired = { firstName: "Tobias", lastName: "Halvorsen", email: "owner@example.com" };
  assertEquals(
    fillMissing({ id: "x", firstName: "", lastName: "Halvorsen", email: null }, desired),
    { patch: { firstName: "Tobias", email: "owner@example.com" }, kept: [] },
  );
  assertEquals(
    fillMissing({ id: "x", firstName: "Toby", lastName: "halvorsen", email: "a@b.co" }, desired),
    { patch: {}, kept: ["firstName", "email"] },
  );
  assertEquals(fillMissing({ id: "x" }, { ...desired, email: null }).patch, {
    firstName: "Tobias",
    lastName: "Halvorsen",
  });
});

// ---------------------------------------------------------------------------------------------
// New callers.
// ---------------------------------------------------------------------------------------------
Deno.test("ghl new caller with a confirmed contact: created with that name and email, oi-lead-new, the intake's tag and task", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: STRANGER_PHONE,
    contact: { first: "Jane", last: "Okafor", email: "jane.okafor@example.com", phone: NEW_CALLER_PHONE },
    intake: "lead_intake",
    reason: "file_claim",
  });
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(h.twin.requests[0].body.filters[0].value, NEW_CALLER_PHONE, "keyed on the confirmed number");
  const [contact] = h.twin.contacts;
  assertEquals(
    [contact.firstName, contact.lastName, contact.email, contact.phone],
    ["Jane", "Okafor", "jane.okafor@example.com", NEW_CALLER_PHONE],
  );
  assertEquals(contact.tags, [
    "oi-voice",
    "oi-channel-phone",
    "oi-caller-new",
    "oi-lead-new",
    "oi-outcome-resolved",
    "oi-reason-file_claim",
    "oi-claim-intake",
  ]);
  assertEquals(h.twin.tasks.map((t) => t.title), ["New claim: auto loss on October 10, 2026"]);
  assertStringIncludes(h.twin.tasks[0].body, "A new caller reported a loss");
  const note = h.twin.notes[0].body;
  assertStringIncludes(note, "Caller: new caller, name and number confirmed on the call");
  assertStringIncludes(note, "Claim details taken for a specialist to set up: auto, loss on October 10, 2026");
  assertStringIncludes(note, "Email (caller-provided, confirmed on the call): j***@example.com");
});

Deno.test("ghl new caller with a number from abroad: created on that E.164 number; one noted as said is never sent", async () => {
  // the number confirmed with its country code is a key like any other
  const h = harness();
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: STRANGER_PHONE,
    contact: { first: "Jane", last: "Okafor", phone: "+442079460958" },
    intake: "lead_intake",
    reason: "file_claim",
  });
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(h.twin.requests[0].body.filters[0].value, "+442079460958");
  assertEquals(h.twin.contacts.map((c) => c.phone), ["+442079460958"]);

  // a number noted as said, without a country code, never goes into GHL's phone field (no 4xx to retry):
  // the phone call's own caller id keys the lead, and the note and the claim task name the number by its
  // last four, as said
  const s = harness();
  await seedCall(s.store, CALL_B, {
    identity: "miss",
    callerId: "+61491570156",
    contact: { first: "Jane", last: "Okafor", phone: "9601550123" },
    intake: "lead_intake",
    reason: "file_claim",
  });
  await queue(s.store, CALL_B);
  assertEquals(await deliver(s, CALL_B), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(s.twin.requests[0].body.filters[0].value, "+61491570156");
  assertEquals(s.twin.contacts.map((c) => [c.phone, c.firstName]), [["+61491570156", "Jane"]]);
  assertFalse(allBodies(s.twin).includes("9601550123"));
  const note = s.twin.notes[0].body;
  assertStringIncludes(note, "Caller: new caller, name confirmed on the call; contact keyed on the caller ID");
  assertStringIncludes(note, "Callback number ending 0123 (as said, no country code)");
  assertEquals(s.twin.tasks.map((t) => t.title), ["New claim: auto loss on October 10, 2026"]);
  assertStringIncludes(s.twin.tasks[0].body, "Callback number ending 0123 (as said, no country code)");
  assertEquals(row(s.store, CALL_B).progress.contact_created, true);

  // a web call has no caller id to key on: the row is done with the reason, nothing sent
  const w = harness();
  await seedCall(w.store, CALL_B, {
    channel: "webCall",
    identity: "miss",
    contact: { first: "Jane", last: "Okafor", phone: "9601550123" },
    intake: "lead_intake",
    reason: "file_claim",
  });
  await queue(w.store, CALL_B);
  assertEquals(await deliver(w, CALL_B), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(w.twin.requests.length, 0);
  assertEquals(row(w.store, CALL_B).progress.skipped, "new_caller_number_without_country_code");
});

Deno.test("ghl new caller whose caller id matches a contact: additive only (tags, note, tasks), oi-phone-matched", async () => {
  const h = harness();
  const existing = h.twin.addContact({ phone: NEW_CALLER_PHONE, firstName: "J", lastName: "O" });
  // the number is the call's own caller id ("the number I'm calling from"), not one the caller said
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: NEW_CALLER_PHONE,
    contact: {
      first: "Jane",
      last: "Okafor",
      email: "jane.okafor@example.com",
      phone: NEW_CALLER_PHONE,
      source: "caller_id",
    },
    escalations: [{ kind: "representative", reason: "not_found", phone: NEW_CALLER_PHONE }],
    outcome: "escalated",
    reason: "speak_to_agent",
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  assertEquals(h.twin.requests.filter((r) => r.method === "PUT" || r.path === "/contacts/"), []);
  assertEquals([existing.firstName, existing.email], ["J", null], "no field of a matched contact is written");
  assert(existing.tags.includes("oi-phone-matched"));
  assertFalse(existing.tags.includes("oi-lead-new"));
  assertEquals(h.twin.tasks.map((t) => t.title), ["Call back: no account found"]);
  assertEquals(row(h.store, CALL_A).external_id, existing.id);
});

Deno.test("ghl new caller whose stated number matches a contact: nothing is written to it (it may be a stranger's)", async () => {
  for (const channel of ["webCall", "inboundPhoneCall"] as const) {
    const h = harness();
    // an existing customer's contact; a web caller says they are new and gives that number
    const stranger = h.twin.addContact({ phone: "+16025550102", firstName: "Maria", lastName: "Lindqvist" });
    await seedCall(h.store, CALL_A, {
      channel,
      identity: "miss",
      callerId: channel === "webCall" ? null : STRANGER_PHONE,
      contact: { first: "Mallory", last: "Smith", email: "m@evil.test", phone: "+16025550102" },
      intake: "lead_intake",
      reason: "file_claim",
    });
    await queue(h.store, CALL_A);
    assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 }, channel);
    assertEquals(steps(h.twin), ["POST /contacts/search"], `${channel}: searched, then nothing written`);
    assertEquals([stranger.tags, h.twin.notes, h.twin.tasks], [[], [], []], channel);
    const r = row(h.store, CALL_A);
    assertEquals([r.progress.skipped, r.external_id], ["lead_number_not_caller_id", null], channel);
    assert(h.logs.some((l) => l.event === "ghl_skipped" && l.reason === "lead_number_not_caller_id"));
  }
  // the search index behind: the duplicate create names the contact, and it is not adopted either
  const h = harness();
  const stranger = h.twin.addContact({ phone: "+16025550102", firstName: "Maria", lastName: "Lindqvist" });
  h.twin.hideFromSearch("+16025550102");
  await seedCall(h.store, CALL_A, {
    channel: "webCall",
    identity: "miss",
    contact: { first: "Mallory", last: "Smith", phone: "+16025550102" },
  });
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(steps(h.twin), ["POST /contacts/search", "POST /contacts/"]);
  assertEquals([stranger.tags, h.twin.notes.length, row(h.store, CALL_A).progress.skipped], [
    [],
    0,
    "lead_number_not_caller_id",
  ]);
});

Deno.test("ghl new caller whose email belongs to another contact: created on the number alone, the other contact untouched", async () => {
  const h = harness();
  const stranger = h.twin.addContact({ phone: "+16025550166", email: "jane.okafor@example.com", firstName: "Other" });
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: STRANGER_PHONE,
    contact: { first: "Jane", last: "Okafor", email: "jane.okafor@example.com", phone: NEW_CALLER_PHONE },
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  const creates = h.twin.requests.filter((r) => r.path === "/contacts/");
  assertEquals(creates.map((r) => r.body.email ?? null), ["jane.okafor@example.com", null]);
  const created = h.twin.contacts.find((c) => c.phone === NEW_CALLER_PHONE)!;
  assertEquals([created.firstName, created.email], ["Jane", null]);
  assertEquals(stranger.tags, [], "a contact is never adopted by email");
  assertEquals(h.twin.notes.map((n) => n.contactId), [created.id]);
});

Deno.test("ghl do-not-contact: a contact the location marks DND gets no oi-lead-new, still the other tags, note and task", async () => {
  const h = harness({ dndOnCreate: true });
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: STRANGER_PHONE,
    contact: { first: "Jane", last: "Okafor", phone: NEW_CALLER_PHONE },
    intake: "lead_intake",
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  const [contact] = h.twin.contacts;
  assertFalse(contact.tags.includes("oi-lead-new"));
  assert(contact.tags.includes("oi-claim-intake"));
  assertEquals([h.twin.notes.length, h.twin.tasks.length], [1, 1]);
  assertEquals(row(h.store, CALL_A).progress.dnd, true);
});

Deno.test("ghl contactBlocked: dnd true, or any channel's dndSettings status other than inactive", () => {
  assert(contactBlocked({ dnd: true }));
  assert(contactBlocked({ dnd: false, dndSettings: { SMS: { status: "active" } } }));
  assert(contactBlocked({ dndSettings: { Call: { status: "permanent" }, SMS: { status: "inactive" } } }));
  assert(contactBlocked({ dndSettings: { Email: {} } }), "no status reads as blocked");
  assertFalse(contactBlocked({ dndSettings: { SMS: { status: "inactive" }, Call: { status: "inactive" } } }));
  assertFalse(contactBlocked({ dnd: false }));
  assertFalse(contactBlocked({}));
  assertFalse(contactBlocked(null));
});

// ---------------------------------------------------------------------------------------------
// Unverified, locked and web callers.
// ---------------------------------------------------------------------------------------------
Deno.test("ghl locked caller: the candidate account's contact is never touched, even on its own number; nothing is created", async () => {
  const h = harness();
  const candidate = h.twin.addContact({ phone: TOBIAS.phone_e164, firstName: "Tobias", lastName: "Halvorsen" });
  await seedCall(h.store, CALL_A, { identity: "locked", outcome: "auth_failed" });
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(h.twin.requests, [], "not even a search");
  assertEquals([candidate.tags, h.twin.contacts.length], [[], 1]);
  const r = row(h.store, CALL_A);
  assertEquals([r.progress.skipped, r.progress.done, r.external_id], ["locked_candidate_number", true, null]);
});

Deno.test("ghl locked caller from another number: that contact gets oi-verify-locked and a note with no name and no summary", async () => {
  const h = harness();
  const other = h.twin.addContact({ phone: STRANGER_PHONE, firstName: "Phone", lastName: "Owner" });
  await seedCall(h.store, CALL_A, {
    identity: "locked",
    callerId: STRANGER_PHONE,
    outcome: "auth_failed",
    reason: "claim_status",
    summary: "Tobias Halvorsen asked about claim CLM-240115 but failed the date of birth check.",
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  assertEquals(h.twin.requests.filter((r) => r.method === "PUT" || r.path === "/contacts/"), []);
  assertEquals(other.tags, [
    "oi-voice",
    "oi-channel-phone",
    "oi-caller-existing",
    "oi-verify-locked",
    "oi-outcome-auth_failed",
    "oi-reason-claim_status",
  ]);
  const note = h.twin.notes[0].body;
  assertStringIncludes(note, "identity verification failed (locked)");
  assertNotMatch(note, /Tobias|Halvorsen|Summary|CLM-/);
  assertEquals(h.twin.tasks, []);
});

Deno.test("ghl unverified phone caller: a caller-id hit gets oi-unverified; a miss is skipped; a stated name is never used", async () => {
  const h = harness();
  const hit = h.twin.addContact({ phone: STRANGER_PHONE });
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: STRANGER_PHONE,
    // a name given but never confirmed on the read-back
    contact: { first: "Stated", last: "Person", phone: STRANGER_PHONE, confirmed: false },
    outcome: "not_found",
    reason: null,
    summary: "Stated Person could not be found.",
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  assert(hit.tags.includes("oi-unverified"));
  assert(hit.tags.includes("oi-caller-new"));
  assertFalse(hit.tags.some((t) => t.startsWith("oi-reason-")), "no reason, no reason tag");
  assertFalse(allBodies(h.twin).includes("Stated"), "the stated name is in no request");

  await seedCall(h.store, CALL_B, { identity: "none", callerId: "+16025550155", reason: null, outcome: "resolved" });
  await queue(h.store, CALL_B);
  const before = h.twin.requests.length;
  await deliver(h, CALL_B);
  assertEquals(steps(h.twin).slice(before), ["POST /contacts/search"], "a miss creates nothing");
  assertEquals(row(h.store, CALL_B).progress.skipped, "no_matching_contact");
});

Deno.test("ghl web caller with no confirmed contact: skipped with the reason, zero requests, delivered with no contact", async () => {
  const h = harness();
  h.twin.addContact({ phone: "+16025550144" });
  await seedCall(h.store, CALL_A, {
    channel: "webCall",
    identity: "miss",
    escalations: [{ kind: "representative", reason: "not_found", phone: "+16025550144" }],
    outcome: "escalated",
  });
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(h.twin.requests, [], "a callback number the model heard finds no contact");
  const r = row(h.store, CALL_A);
  assertEquals([r.progress.skipped, r.external_id, r.last_error], ["web_unverified", null, null]);
  assert(h.logs.some((l) => l.event === "ghl_skipped" && l.reason === "web_unverified"));
});

// ---------------------------------------------------------------------------------------------
// planCaller, tags, the note and the tasks (pure).
// ---------------------------------------------------------------------------------------------
function facts(p: {
  level?: "none" | "phone_found" | "verified" | "locked";
  channel?: string;
  callerNumber?: string | null;
  contact?: Partial<GhlFacts["contact"]> | null;
  escalations?: GhlFacts["escalations"];
  intake?: GhlFacts["intake"];
  interaction?: Partial<GhlFacts["interaction"]>;
} = {}): GhlFacts {
  const level = p.level ?? "verified";
  const candidate = level === "none" ? null : TOBIAS.id;
  return {
    interaction: {
      vapi_call_id: CALL_A,
      channel: p.channel ?? "inboundPhoneCall",
      outcome: "resolved",
      call_reason: "claim_status",
      summary: "Checked on a claim.",
      caller_type: level === "none" ? "unknown" : "existing",
      caller_phone: null,
      started_at: "2026-10-13T14:52:00.000Z",
      ended_at: "2026-10-13T14:58:00.000Z",
      created_at: "2026-10-13T14:52:00.000Z",
      ...p.interaction,
    },
    session: {
      call_key: CALL_A,
      channel: p.channel ?? "inboundPhoneCall",
      caller_number: p.callerNumber !== undefined ? p.callerNumber : TOBIAS.phone_e164,
      level,
      candidate_customer_id: candidate,
      verified_customer_id: level === "verified" ? candidate : null,
    },
    customer: level === "verified"
      ? {
        id: TOBIAS.id,
        phone_e164: TOBIAS.phone_e164,
        first_name: "Tobias",
        last_name: "Halvorsen",
        policy_number: TOBIAS.policy_number,
        email: TOBIAS.email,
      }
      : null,
    candidatePhone: level === "locked" ? TOBIAS.phone_e164 : null,
    contact: p.contact
      ? {
        call_key: CALL_A,
        kind: "new_customer",
        first_name: "Jane",
        last_name: "Okafor",
        email: null,
        callback_phone: NEW_CALLER_PHONE,
        callback_source: "argument",
        customer_id: null,
        confirmed: true,
        confirmed_at: "2026-10-13T14:55:00.000Z",
        ...p.contact,
      }
      : null,
    escalations: p.escalations ?? [],
    intake: p.intake ?? null,
  };
}

Deno.test("ghl planCaller: verified, lead and caller-id search on trusted numbers only; everything else is a skip with a reason", () => {
  const own = ["+18005550142"];
  assertEquals(planCaller(facts(), own).mode, "verified");
  assertEquals(planCaller(facts(), own).key, TOBIAS.phone_e164);
  const lead = planCaller(facts({ level: "none", callerNumber: STRANGER_PHONE, contact: {} }), own);
  assertEquals([lead.mode, lead.key, lead.create?.firstName], ["lead", NEW_CALLER_PHONE, "Jane"]);
  // a number the caller said may create a contact but never writes to one GHL holds; the caller id may
  assertEquals(lead.createOnly, true);
  const ownLine = planCaller(
    facts({
      level: "none",
      callerNumber: NEW_CALLER_PHONE,
      contact: { callback_phone: NEW_CALLER_PHONE, callback_source: "caller_id" },
    }),
    own,
  );
  assertEquals([ownLine.mode, ownLine.key, ownLine.createOnly], ["lead", NEW_CALLER_PHONE, undefined]);
  // an unconfirmed contact is not a lead: the caller id is searched, nothing is created
  const unconfirmed = planCaller(
    facts({ level: "none", callerNumber: STRANGER_PHONE, contact: { confirmed: false } }),
    own,
  );
  assertEquals([unconfirmed.mode, unconfirmed.key, unconfirmed.create], ["search_only", STRANGER_PHONE, null]);
  // a "new caller" contact next to an account the caller did not verify is not trusted as a lead
  const nextToAccount = planCaller(facts({ level: "phone_found", callerNumber: STRANGER_PHONE, contact: {} }), own);
  assertEquals([nextToAccount.mode, nextToAccount.status], ["search_only", "unverified"]);
  assertEquals(planCaller(facts({ level: "locked", callerNumber: STRANGER_PHONE }), own).status, "locked");
  assertEquals(planCaller(facts({ level: "locked" }), own).reason, "locked_candidate_number");
  assertEquals(
    planCaller(facts({ level: "none", channel: "webCall", callerNumber: null }), own).reason,
    "web_unverified",
  );
  assertEquals(planCaller(facts({ level: "none", channel: "chat", callerNumber: null }), own).reason, "web_unverified");
  assertEquals(planCaller(facts({ level: "none", callerNumber: null }), own).reason, "no_caller_id");
  assertEquals(planCaller(facts({ level: "none", callerNumber: "+18005550142" }), own).reason, "no_caller_id");
  assertEquals(
    planCaller(facts({ level: "none", callerNumber: STRANGER_PHONE, contact: { callback_phone: null } }), own).reason,
    "new_caller_without_number",
  );
  assertEquals(planCaller({ ...facts(), customer: null }, own).reason, "verified_customer_missing");
  // no session at all (no tool ran): the record's caller_phone is the caller id
  const noSession = planCaller({
    ...facts({ level: "none" }),
    session: null,
    interaction: { ...facts().interaction, caller_phone: STRANGER_PHONE },
  }, own);
  assertEquals([noSession.mode, noSession.key], ["search_only", STRANGER_PHONE]);
});

Deno.test("ghl planCaller: a caller id from abroad is a trusted key; a number without a country code is never a key", () => {
  const own = ["+18005550142"];
  const abroad = planCaller(facts({ level: "none", callerNumber: "+61491570156" }), own);
  assertEquals([abroad.mode, abroad.key], ["search_only", "+61491570156"]);
  const lead = planCaller(
    facts({ level: "none", callerNumber: null, contact: { callback_phone: "+442079460958" } }),
    own,
  );
  assertEquals([lead.mode, lead.key, lead.createOnly], ["lead", "+442079460958", true]);
  const fromCallerId = planCaller(
    facts({
      level: "none",
      callerNumber: "+61491570156",
      contact: { callback_phone: "+61491570156", callback_source: "caller_id" },
    }),
    own,
  );
  assertEquals([fromCallerId.mode, fromCallerId.key, fromCallerId.createOnly], ["lead", "+61491570156", undefined]);
  // noted as said: GHL's phone field takes E.164 only, so the call's caller id (the caller's own line) keys
  // the lead; a web call has no caller id and is skipped
  const asSaid = planCaller(
    facts({ level: "none", callerNumber: "+61491570156", contact: { callback_phone: "9601550123" } }),
    own,
  );
  assertEquals([asSaid.mode, asSaid.key, asSaid.createOnly], ["lead", "+61491570156", undefined]);
  const asSaidWeb = planCaller(
    facts({ level: "none", channel: "webCall", callerNumber: null, contact: { callback_phone: "9601550123" } }),
    own,
  );
  assertEquals([asSaidWeb.mode, asSaidWeb.reason], ["skip", "new_caller_number_without_country_code"]);
  // the number the caller said is the call's own caller id: their own line, so additive writes are fine
  const ownLine = planCaller(
    facts({ level: "none", callerNumber: "+442079460958", contact: { callback_phone: "+442079460958" } }),
    own,
  );
  assertEquals([ownLine.mode, ownLine.key, ownLine.createOnly], ["lead", "+442079460958", undefined]);
  // a caller id written without its "+" is no key either
  const bare = planCaller(facts({ level: "none", callerNumber: "9601550123" }), own);
  assertEquals([bare.mode, bare.reason], ["skip", "no_caller_id"]);
  // every key planCaller hands out is E.164
  for (const plan of [abroad, lead, fromCallerId, asSaid, ownLine]) assertMatch(plan.key ?? "", /^\+[1-9]\d{7,14}$/);
});

Deno.test("ghl note and callback task: a number from abroad or one noted as said shows its last four only", () => {
  for (const [phone, last4] of [["+442079460958", "0958"], ["9601550123", "0123 (as said, no country code)"]]) {
    const rep = {
      id: crypto.randomUUID(),
      call_key: CALL_A,
      kind: "representative" as const,
      reason: "representative_requested" as const,
      details: null,
      callback_phone: phone,
      channel: "inboundPhoneCall",
      verified: false,
      callback_source: "argument" as const,
      alert_status: "sent" as const,
      delivery_error: null,
      status: "open" as const,
      created_at: "2026-10-13T14:55:00.000Z",
      caller_name: null,
    };
    const f = facts({ level: "none", callerNumber: "+61491570156", escalations: [rep] });
    const plan = planCaller(f, []);
    const note = renderNote(f, plan, DASHBOARD);
    assertStringIncludes(note, `Callback number ending ${last4}`);
    assertFalse(note.includes(phone.replace("+", "")), phone);
    const task = tasksFor(f, plan, { DASHBOARD_URL: DASHBOARD }, NOW).callback!;
    assertStringIncludes(task.body, `Callback number ending ${last4}`);
    assertFalse(task.body.includes(phone.replace("+", "")), phone);
  }
});

Deno.test("ghl tagsFor: every tag it can produce is one of GHL_TAGS", () => {
  const modes = [
    facts(),
    facts({ level: "none", callerNumber: STRANGER_PHONE, contact: {} }),
    facts({ level: "phone_found", callerNumber: STRANGER_PHONE }),
    facts({ level: "locked", callerNumber: STRANGER_PHONE }),
    facts({ level: "none", channel: "webCall", callerNumber: null }),
  ];
  const known: ReadonlySet<string> = new Set(GHL_TAGS);
  const seen = new Set<string>();
  for (const f of modes) {
    for (const outcome of [...OUTCOMES, "bogus", null]) {
      for (const reason of ["file_claim", "emergency", "other", "bogus", null]) {
        const g = { ...f, interaction: { ...f.interaction, outcome, call_reason: reason } };
        for (
          const state of [{ created: true, blocked: false }, {
            created: true,
            blocked: true,
          }, { created: false, blocked: false }]
        ) {
          for (const tag of tagsFor(g, planCaller(g, []), state)) {
            assert(known.has(tag), tag);
            seen.add(tag);
          }
        }
      }
    }
  }
  assert(!seen.has("oi-outcome-bogus") && !seen.has("oi-reason-bogus"));
});

Deno.test("ghl note: header, summary redacted and capped, claim block, callback last four, masked email, link and marker", () => {
  const intake = {
    call_key: CALL_A,
    kind: "claim" as const,
    claim_type: "auto" as const,
    loss_date: "2026-10-10",
    summary: "cracked windshield",
    description: "My number is 602-555-0101 and my birthday is March 14, 1986. A rock cracked the windshield.",
    customer_id: TOBIAS.id,
    claim_id: crypto.randomUUID(),
    claim_number: "CLM-123456",
    confirmed: true,
    confirmed_at: "2026-10-13T14:57:00.000Z",
  };
  const rep = {
    id: crypto.randomUUID(),
    call_key: CALL_A,
    kind: "representative" as const,
    reason: "representative_requested" as const,
    details: null,
    callback_phone: "+16025550123",
    channel: "inboundPhoneCall",
    verified: true,
    callback_source: "argument" as const,
    alert_status: "sent" as const,
    delivery_error: null,
    status: "open" as const,
    created_at: "2026-10-13T14:56:00.000Z",
    caller_name: null,
  };
  const f = facts({
    intake,
    escalations: [rep],
    interaction: {
      outcome: "escalated",
      call_reason: "file_claim",
      summary: `Caller at 602 555 0101, born 3/14/1986, reported a loss. ${"x".repeat(2000)}`,
    },
  });
  const note = renderNote(f, planCaller(f, []), DASHBOARD);
  const lines = note.split("\n");
  assertEquals(
    lines[0],
    "Observe voice agent · Oct 13, 2026, 10:52 AM ET · phone · outcome escalated · reason file_claim",
  );
  assertEquals(lines[1], "Caller: existing customer, identity verified on the call");
  const summary = lines.find((l) => l.startsWith("Summary: "))!;
  assertEquals(summary.length, "Summary: ".length + 1500);
  assert(summary.endsWith("..."));
  assertStringIncludes(note, "Claim filed by phone: auto, loss on October 10, 2026, claim number CLM-123456");
  assertStringIncludes(note, "What happened (caller's words, redacted): ");
  assertStringIncludes(note, "Callback requested: representative requested");
  assertStringIncludes(note, "Callback number ending 0123");
  assertStringIncludes(note, `Dashboard: ${DASHBOARD}#/calls/${CALL_A}`);
  assertEquals(lines.at(-1), `ref oi/interaction.completed/${CALL_A}`);
  assertNotMatch(note, /602.?555.?0101|6025550101|1986|March 14|\+16025550123/);
  assertNotMatch(note, /Tobias|Halvorsen|POL-/);
  assert([...note].every((ch) => ch === "·" || ch.charCodeAt(0) < 0x7f), "no locale spacing character");
});

Deno.test("ghl tasks: completed false, assigned to the configured users; callback +1 h, emergency now, claim next business day", () => {
  const rep = {
    id: crypto.randomUUID(),
    call_key: CALL_A,
    kind: "representative" as const,
    reason: "unsupported_question" as const,
    details: null,
    callback_phone: "+16025550123",
    channel: "inboundPhoneCall",
    verified: true,
    callback_source: "caller_id" as const,
    alert_status: "sent" as const,
    delivery_error: null,
    status: "open" as const,
    created_at: "2026-10-16T21:30:00.000Z", // a Friday, 5:30 PM Eastern
    caller_name: null,
  };
  const emergency = { ...rep, id: crypto.randomUUID(), kind: "emergency" as const, reason: "emergency" as const };
  const intake = {
    call_key: CALL_A,
    kind: "claim" as const,
    claim_type: "home" as const,
    loss_date: "2026-10-15",
    summary: "burst pipe",
    description: "A pipe burst in the kitchen.",
    customer_id: TOBIAS.id,
    claim_id: crypto.randomUUID(),
    claim_number: "CLM-654321",
    confirmed: true,
    confirmed_at: "2026-10-16T21:31:00.000Z",
  };
  const f = facts({ escalations: [rep, emergency], intake });
  const now = new Date("2026-10-16T21:40:00.000Z");
  const env = { GHL_ASSIGNEE_USER_ID: ASSIGNEE, GHL_EMERGENCY_USER_ID: EMERGENCY_USER, DASHBOARD_URL: DASHBOARD };
  const t = tasksFor(f, planCaller(f, []), env, now);
  assertEquals(t.callback?.title, "Call back: question the assistant could not answer");
  assertEquals(t.callback?.dueDate, "2026-10-16T22:30:00.000Z");
  assertEquals(t.callback?.assignedTo, ASSIGNEE);
  assertStringIncludes(t.callback!.body, "Callback number ending 0123");
  assertEquals(t.emergency?.title, "URGENT: emergency reported on call");
  assertEquals([t.emergency?.dueDate, t.emergency?.assignedTo], [now.toISOString(), EMERGENCY_USER]);
  assertEquals(t.claim?.title, "New claim: home loss on October 15, 2026 (CLM-654321)");
  assertEquals(t.claim?.dueDate, "2026-10-19T14:00:00.000Z", "Friday evening: Monday 10:00 Eastern");
  for (const task of Object.values(t)) {
    assertEquals(task.completed, false);
    assertStringIncludes(task.body, `ref oi/interaction.completed/${CALL_A}`);
  }
  // the emergency user defaults to the assignee; no users configured, no assignedTo key at all
  assertEquals(tasksFor(f, planCaller(f, []), { GHL_ASSIGNEE_USER_ID: ASSIGNEE }, now).emergency?.assignedTo, ASSIGNEE);
  for (const task of Object.values(tasksFor(f, planCaller(f, []), {}, now))) {
    assertFalse("assignedTo" in task);
  }
  // a claim only for a contact that is the caller's own
  const locked = facts({ level: "locked", callerNumber: STRANGER_PHONE, intake });
  assertEquals(tasksFor(locked, planCaller(locked, []), env, now).claim, undefined);
});

Deno.test("ghl nextBusinessDayDue: the next weekday at 10:00 Eastern, across weekends, both DST changes and the year end", () => {
  const due = (iso: string) => nextBusinessDayDue(new Date(iso)).toISOString();
  assertEquals(due("2026-10-13T15:00:00Z"), "2026-10-14T14:00:00.000Z", "Tuesday -> Wednesday (EDT)");
  assertEquals(due("2026-10-16T15:00:00Z"), "2026-10-19T14:00:00.000Z", "Friday -> Monday");
  assertEquals(due("2026-10-17T15:00:00Z"), "2026-10-19T14:00:00.000Z", "Saturday -> Monday");
  assertEquals(due("2026-10-18T15:00:00Z"), "2026-10-19T14:00:00.000Z", "Sunday -> Monday");
  // 23:30 Friday Eastern is already Saturday in UTC: the Eastern date decides
  assertEquals(due("2026-10-17T03:30:00Z"), "2026-10-19T14:00:00.000Z");
  assertEquals(due("2026-10-29T15:00:00Z"), "2026-10-30T14:00:00.000Z", "Thursday -> Friday, still EDT");
  assertEquals(due("2026-10-30T15:00:00Z"), "2026-11-02T15:00:00.000Z", "over the 1 Nov fall-back: 10:00 EST");
  assertEquals(due("2026-11-01T06:30:00Z"), "2026-11-02T15:00:00.000Z", "inside the repeated hour");
  assertEquals(due("2026-03-06T15:00:00Z"), "2026-03-09T14:00:00.000Z", "over the 8 Mar spring-forward: 10:00 EDT");
  assertEquals(due("2026-12-31T15:00:00Z"), "2027-01-01T15:00:00.000Z", "no holiday calendar");
  assertEquals(due("2027-01-01T04:30:00Z"), "2027-01-01T15:00:00.000Z", "23:30 on Dec 31 Eastern");
});

// ---------------------------------------------------------------------------------------------
// Delivery: tasks on the wire, resume, replay, errors.
// ---------------------------------------------------------------------------------------------
Deno.test("ghl tasks on the wire: one per kind, completed false, never a contact assignment", async () => {
  const h = harness({ env: { ...GHL_ENV, GHL_EMERGENCY_USER_ID: EMERGENCY_USER } });
  await seedCall(h.store, CALL_A, {
    escalations: [{ kind: "emergency", phone: TOBIAS.phone_e164 }, {
      kind: "representative",
      phone: TOBIAS.phone_e164,
    }],
    intake: "claim",
    outcome: "emergency",
    reason: "emergency",
  });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  const sent = h.twin.requests.filter((r) => r.path.endsWith("/tasks"));
  assertEquals(sent.map((r) => r.body.title.split(":")[0]), ["Call back", "URGENT", "New claim"]);
  for (const r of sent) assertEquals(r.body.completed, false);
  assertEquals(sent.map((r) => r.body.assignedTo), [ASSIGNEE, EMERGENCY_USER, ASSIGNEE]);
  assertEquals(sent[1].body.dueDate, NOW.toISOString(), "the emergency task is due now");
  const contact = h.twin.contacts[0];
  assert(
    contact.tags.includes("oi-claim-filed") &&
      contact.tags.includes("oi-emergency") &&
      contact.tags.includes("oi-callback"),
  );
  for (const r of h.twin.requests.filter((x) => !x.path.endsWith("/tasks"))) {
    assertFalse(JSON.stringify(r.body ?? {}).includes("assignedTo"), `${r.method} ${r.path}`);
  }
  const p = row(h.store, CALL_A).progress;
  assertEquals([p.task_callback_id, p.task_emergency_id, p.task_claim_id], h.twin.tasks.map((t) => t.id));
  const claimNumber = h.store.tables.claim_intakes[0].claim_number;
  assertEquals(h.twin.tasks[2].title, `New claim: auto loss on October 10, 2026 (${claimNumber})`);
});

Deno.test("ghl retry resume: a 500 on the note leaves the row pending; the retry skips contact and tags; one contact, one note", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  h.twin.failNext("POST", /\/notes$/, { status: 502, body: { message: "Bad Gateway" } });
  assertEquals(await deliver(h, CALL_A), { delivered: 0, retried: 1, dead: 0, errors: 0 });
  const r = row(h.store, CALL_A);
  assertEquals([r.attempts, r.delivered_at], [1, null]);
  assertStringIncludes(r.last_error, "ghl 502 POST /contacts/");
  assertEquals(r.next_attempt_at, new Date(NOW.getTime() + 60 * SECOND).toISOString(), "the first backoff: 60 s");
  assertEquals([typeof r.progress.contact_id, r.progress.tags_done, r.progress.note_id], ["string", true, undefined]);

  h.advance(59 * SECOND);
  assertEquals(await deliver(h, CALL_A), { delivered: 0, retried: 0, dead: 0, errors: 0 }, "not due yet");
  h.advance(2 * SECOND);
  const before = h.twin.requests.length;
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(steps(h.twin).slice(before), [`POST /contacts/${r.progress.contact_id}/notes`]);
  assertEquals([h.twin.contacts.length, h.twin.notes.length, r.attempts], [1, 1, 2]);
});

Deno.test("ghl full replay: a re-armed row with complete progress makes zero requests and posts no second note", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A, { escalations: [{ kind: "representative" }] });
  await queue(h.store, CALL_A);
  await deliver(h, CALL_A);
  const made = h.twin.requests.length;
  // the backfill re-arms the call (enqueue_outbox resets delivery and attempts, never progress)
  await enqueueInteraction(h.deps, CALL_A, "backfill");
  const r = row(h.store, CALL_A);
  assertEquals([r.delivered_at, r.attempts, r.progress.done], [null, 0, true]);
  assertEquals(r.next_attempt_at, new Date(Date.parse(r.updated_at) + GHL_DELAY_S * SECOND).toISOString());
  h.advance(GHL_DELAY_S * SECOND + OUTBOX_LEASE_MS);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(h.twin.requests.length, made, "no request at all");
  assertEquals([h.twin.notes.length, h.twin.tasks.length], [1, 1]);
  assertEquals(r.external_id, h.twin.contacts[0].id);
  // and deliverGhl itself, handed the complete row, reads nothing and writes nothing
  const store = { ...h.store, getInteractionForGhl: () => Promise.reject(new Error("no read expected")) };
  const out = await deliverGhl({ ...h.deps, store }, { ...r, attempts: 1 }, NOW.getTime() + MINUTE);
  assertEquals(out.result, { outcome: "delivered", externalId: h.twin.contacts[0].id });
  assertEquals(h.twin.requests.length, made);
});

Deno.test("ghl errors: 401 pauses and gives the attempt back; 429 waits the header's window; a timeout is retryable; 422 is dead", async () => {
  // 401: a revoked token is a setting, not this row
  {
    const h = harness();
    await seedCall(h.store, CALL_A);
    await queue(h.store, CALL_A);
    h.twin.failNext("POST", "/contacts/search", {
      status: 401,
      body: { statusCode: 401, message: "Invalid Private Integration token" },
    });
    const out = await deliver(h, CALL_A);
    assertEquals(out.config_error, "ghl 401 POST /contacts/search: Invalid Private Integration token");
    assertEquals([row(h.store, CALL_A).attempts, row(h.store, CALL_A).delivered_at], [0, null]);
    assert(h.logs.some((l) => l.event === "outbox_paused" && l.destination === "ghl"));
  }
  // 429: next_attempt_at from x-ratelimit-interval-milliseconds
  {
    const h = harness();
    await seedCall(h.store, CALL_A);
    await queue(h.store, CALL_A);
    h.twin.failNext("POST", "/contacts/search", {
      status: 429,
      body: { message: "Too many requests" },
      headers: { "x-ratelimit-interval-milliseconds": "10000" },
    });
    assertEquals(await deliver(h, CALL_A), { delivered: 0, retried: 1, dead: 0, errors: 0 });
    assertEquals(row(h.store, CALL_A).next_attempt_at, new Date(NOW.getTime() + 10 * SECOND).toISOString());
  }
  // a timeout: retryable, and the error names the method and path
  {
    const h = harness();
    await seedCall(h.store, CALL_A);
    await queue(h.store, CALL_A);
    h.twin.failNext("POST", "/contacts/", "timeout");
    assertEquals(await deliver(h, CALL_A), { delivered: 0, retried: 1, dead: 0, errors: 0 });
    assertEquals(row(h.store, CALL_A).last_error, "ghl timeout POST /contacts/");
  }
  // 422: this request's own content; the row is dead at once
  {
    const h = harness();
    await seedCall(h.store, CALL_A);
    await queue(h.store, CALL_A);
    h.twin.failNext("POST", "/contacts/", { status: 422, body: { message: ["phone must be a valid number"] } });
    assertEquals(await deliver(h, CALL_A), { delivered: 0, retried: 0, dead: 1, errors: 0 });
    assertEquals(row(h.store, CALL_A).attempts, 5);
  }
});

Deno.test("ghl stored errors: digit runs GHL quotes back are masked in last_error, which stays short", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  h.twin.failNext("POST", "/contacts/", {
    status: 400,
    body: { message: `Invalid phone number 16025550101 for location ${"z".repeat(400)}` },
  });
  await deliver(h, CALL_A);
  const r = row(h.store, CALL_A);
  assertStringIncludes(r.last_error, "[digits]");
  assertFalse(r.last_error.includes("6025550101"));
  assert(r.last_error.length <= 200);
});

Deno.test("ghl stale contact id: an unknown id (400 not found) clears it and the contact is found again once", async () => {
  const h = harness();
  const real = h.twin.addContact({
    phone: TOBIAS.phone_e164,
    firstName: "Tobias",
    lastName: "Halvorsen",
    email: TOBIAS.email,
  });
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  // an earlier attempt stored a contact that was merged away since
  row(h.store, CALL_A).progress = { mode: "verified", contact_id: "ct-merged-away", contact_created: false };
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(steps(h.twin).slice(0, 3), [
    "POST /contacts/ct-merged-away/tags",
    "POST /contacts/search",
    `POST /contacts/${real.id}/tags`,
  ]);
  assertEquals([row(h.store, CALL_A).progress.contact_id, h.twin.notes[0].contactId], [real.id, real.id]);
  assert(h.logs.some((l) => l.event === "ghl_contact_gone"));
});

Deno.test("ghl stale contact id after the tags: the contact found or created again gets the tags before the note", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A, {
    identity: "miss",
    callerId: STRANGER_PHONE,
    contact: { first: "Jane", last: "Okafor", phone: NEW_CALLER_PHONE },
    intake: "lead_intake",
  });
  await queue(h.store, CALL_A);
  // the first attempt creates and tags the contact; the note gets a 500
  h.twin.failNext("POST", /\/notes$/, { status: 500, body: { message: "Internal server error" } });
  assertEquals((await deliver(h, CALL_A)).retried, 1);
  const first = h.twin.contacts[0];
  assertEquals(row(h.store, CALL_A).progress.tags_done, true);
  // staff delete that contact before the retry
  h.twin.contacts.splice(h.twin.contacts.indexOf(first), 1);
  h.advance(5 * MINUTE);
  const before = h.twin.requests.length;
  assertEquals((await deliver(h, CALL_A)).delivered, 1);
  const second = h.twin.contacts[0];
  assert(second && second.id !== first.id, "a new contact");
  assertEquals(steps(h.twin).slice(before), [
    `POST /contacts/${first.id}/notes`,
    "POST /contacts/search",
    "POST /contacts/",
    `POST /contacts/${second.id}/tags`,
    `POST /contacts/${second.id}/notes`,
    `POST /contacts/${second.id}/tasks`,
  ]);
  assert(second.tags.includes("oi-lead-new") && second.tags.includes("oi-claim-intake"), second.tags.join());
  assertEquals(row(h.store, CALL_A).progress.contact_created, true);
});

Deno.test("ghl duplicate create: the contact the 400 names is adopted; without a name, a second search finds it", async () => {
  for (const withMeta of [true, false]) {
    const h = harness();
    const existing = h.twin.addContact({ phone: TOBIAS.phone_e164, firstName: "Tobias", lastName: "Halvorsen" });
    h.twin.hideFromSearch(TOBIAS.phone_e164); // the search index is behind
    if (!withMeta) {
      h.twin.failNext("POST", "/contacts/", {
        status: 400,
        body: { message: "This location does not allow duplicated contacts." },
      });
    }
    await seedCall(h.store, CALL_A);
    await queue(h.store, CALL_A);
    assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 }, String(withMeta));
    assertEquals(h.twin.contacts.length, 1);
    assertEquals(h.twin.notes[0].contactId, existing.id);
    assertEquals(
      h.twin.requests.filter((r) => r.path === "/contacts/search").length,
      withMeta ? 1 : 2,
      `${withMeta}: a second search only without meta`,
    );
    assertEquals(row(h.store, CALL_A).progress.contact_created, false);
  }
});

Deno.test("ghl duplicate create for a verified caller: the adopted contact is filled where empty, like a search hit", async () => {
  const h = harness();
  const existing = h.twin.addContact({ phone: TOBIAS.phone_e164, firstName: "Tobias", lastName: "Halvorsen" });
  h.twin.hideFromSearch(TOBIAS.phone_e164); // the search index is behind
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 1, retried: 0, dead: 0, errors: 0 });
  assertEquals(steps(h.twin).slice(0, 4), [
    "POST /contacts/search",
    "POST /contacts/",
    `GET /contacts/${existing.id}`,
    `PUT /contacts/${existing.id}`,
  ]);
  assertEquals(h.twin.requests[3].body, { email: TOBIAS.email }, "only the empty email, from the account");
  assertEquals(existing.email, TOBIAS.email);
  assertEquals(row(h.store, CALL_A).progress.dnd, false);
});

Deno.test("ghl paused: the run's deadline between steps gives the attempt back; the next run resumes at the next step", async () => {
  // every GHL request takes 1.5 s of the run: search, create (4.5 s left: its full timeout fits), tags,
  // then 1.5 s left is too little to send the note
  const h: H = harness({ beforeGhl: () => h.advance(1500) });
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  const out = await deliver(h, CALL_A, 6000);
  assertEquals(out, { delivered: 0, retried: 0, dead: 0, errors: 0, paused: 1 });
  const r = row(h.store, CALL_A);
  assertEquals([r.attempts, r.delivered_at, r.progress.tags_done, r.progress.note_id], [0, null, true, undefined]);
  assertEquals(steps(h.twin).length, 3, "search, create, tags");
  h.advance(MINUTE);
  assertEquals((await deliver(h, CALL_A)).delivered, 1);
  assertEquals(steps(h.twin).slice(3), [`POST /contacts/${r.progress.contact_id}/notes`]);
});

Deno.test("ghl paused: a create, a note or a task is never sent with less than its full timeout left", async () => {
  // A request cut short by the run's own deadline may still land in GHL; the retry would then post the
  // note (or the URGENT task) twice. With less than 4 s left such a write waits for the next run.
  const h: H = harness({ beforeGhl: () => h.advance(500) });
  await seedCall(h.store, CALL_A, { escalations: [{ kind: "emergency", phone: TOBIAS.phone_e164 }] });
  await queue(h.store, CALL_A);
  // 4.6 s: search (4.1 s left), create (needs 4 s: sent), tags (3.1 s left: safe to repeat), note held
  assertEquals((await deliver(h, CALL_A, 4600)).paused, 1);
  assertEquals(steps(h.twin), [
    "POST /contacts/search",
    "POST /contacts/",
    `POST /contacts/${h.twin.contacts[0].id}/tags`,
  ]);
  // every write that was sent had the full four seconds to answer
  h.advance(MINUTE);
  assertEquals((await deliver(h, CALL_A, 3900)).paused, 1, "3.9 s: not even the note");
  assertEquals(h.twin.notes.length, 0);
  h.advance(MINUTE);
  assertEquals((await deliver(h, CALL_A, 8000)).delivered, 1);
  assertEquals([h.twin.notes.length, h.twin.tasks.map((t) => t.title)], [1, ["URGENT: emergency reported on call"]]);
  assertEquals(row(h.store, CALL_A).attempts, 1, "a pause gives the attempt back");
});

Deno.test("ghl superseded: a re-arm mid-delivery stops it; what it did is recorded and the next delivery adds only the rest", async () => {
  let rearmed = false;
  const h: H = harness({
    beforeGhl: async (path) => {
      if (path.endsWith("/tags") && !rearmed) {
        rearmed = true;
        await h.store.enqueueOutbox("interaction.completed", CALL_A, "ghl");
      }
    },
  });
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A);
  assertEquals(await deliver(h, CALL_A), { delivered: 0, retried: 0, dead: 0, errors: 0 });
  assert(h.logs.some((l) => l.event === "outbox_superseded"));
  const r = row(h.store, CALL_A);
  assertEquals([r.delivered_at, r.attempts, r.progress.tags_done], [null, 0, true], "the tags it added are recorded");
  h.advance(OUTBOX_LEASE_MS + SECOND);
  const before = h.twin.requests.length;
  assertEquals((await deliver(h, CALL_A)).delivered, 1);
  assertEquals(steps(h.twin).slice(before), [`POST /contacts/${r.progress.contact_id}/notes`]);
});

Deno.test("ghl: a call with no record is dead without a request", async () => {
  const h = harness();
  await queue(h.store, "call-that-was-deleted");
  assertEquals(await deliver(h, "call-that-was-deleted"), { delivered: 0, retried: 0, dead: 1, errors: 0 });
  assertEquals([h.twin.requests.length, row(h.store, "call-that-was-deleted").last_error], [0, "record missing"]);
});

Deno.test("ghl loadGhlFacts: the locked candidate's number is read for comparison; a verified customer only when it matches", async () => {
  const h = harness();
  await seedCall(h.store, CALL_A, { identity: "locked", callerId: STRANGER_PHONE });
  const f = (await loadGhlFacts(h.store, CALL_A))!;
  assertEquals([f.candidatePhone, f.customer, f.session?.level], [TOBIAS.phone_e164, null, "locked"]);
  assertEquals(await loadGhlFacts(h.store, "no-such-call"), null);
});

// ---------------------------------------------------------------------------------------------
// The outbox: queue, delay, configuration and per-destination loops.
// ---------------------------------------------------------------------------------------------
Deno.test("enqueue: GoHighLevel is queued 90 s out next to the call log, only when configured; not claimed before", async () => {
  const h = harness({ env: { ...GHL_ENV, ...AIRTABLE_ENV } });
  await seedCall(h.store, CALL_A);
  assert(await enqueueInteraction(h.deps, CALL_A, "end-of-call-report"));
  const ghl = row(h.store, CALL_A);
  assertEquals(ghl.next_attempt_at, new Date(NOW.getTime() + 90 * SECOND).toISOString());
  assertEquals(row(h.store, CALL_A, "airtable").next_attempt_at, NOW.toISOString(), "the call log waits for nothing");
  assertEquals(
    await deliverOutbox(h.deps, { deadlineMs: 8000, destination: "ghl" }),
    { delivered: 0, retried: 0, dead: 0, errors: 0 },
  );
  assertEquals([ghl.attempts, h.twin.requests.length], [0, 0]);
  h.advance(90 * SECOND);
  assertEquals((await deliverOutbox(h.deps, { deadlineMs: 8000, destination: "ghl" })).delivered, 1);

  const off = harness({ env: AIRTABLE_ENV });
  await enqueueInteraction(off.deps, CALL_B, "end-of-call-report");
  assertEquals(off.store.tables.outbox_events.map((o) => o.destination), ["airtable"]);
});

Deno.test("unconfigured: GoHighLevel rows are never claimed, and the job reports nothing for it", async () => {
  const h = harness({ env: AIRTABLE_ENV });
  await seedCall(h.store, CALL_A);
  await queue(h.store, CALL_A); // queued while it was configured
  assertEquals(
    await deliverOutbox(h.deps, { deadlineMs: 8000, destination: "ghl" }),
    { delivered: 0, retried: 0, dead: 0, errors: 0, skipped: "ghl not configured" },
  );
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals(out.result, { delivered: 0, retried: 0, dead: 0, errors: 0 }, "the call-log loop never takes a ghl row");
  assertEquals([row(h.store, CALL_A).attempts, h.twin.requests.length], [0, 0]);
  for (const blank of [{ GHL_TOKEN: " " }, { GHL_LOCATION_ID: "" }]) {
    const half = harness({ env: { ...GHL_ENV, ...blank } });
    await enqueueInteraction(half.deps, CALL_A, "end-of-call-report");
    assertEquals(half.store.tables.outbox_events.map((o) => o.destination), ["airtable"], JSON.stringify(blank));
  }
});

Deno.test("outbox job: the call log failing never blocks GoHighLevel, and GoHighLevel failing never blocks the call log", async () => {
  // Airtable down: GoHighLevel still delivers in the same run
  {
    const h = harness({ env: { ...GHL_ENV, ...AIRTABLE_ENV }, airtable: () => json({ error: "SERVER_ERROR" }, 503) });
    for (const k of [CALL_A, CALL_B]) {
      await seedCall(h.store, k);
      await h.store.enqueueOutbox("interaction.completed", k, "airtable");
      await queue(h.store, k);
    }
    const out = await runJob("outbox", h.deps);
    assert(!out.skipped);
    assertEquals(out.result, {
      delivered: 0,
      retried: 1,
      dead: 0,
      errors: 0,
      ghl_delivered: 2,
      ghl_retried: 0,
      ghl_dead: 0,
      ghl_errors: 0,
    });
  }
  // GoHighLevel refusing the token: the call log still delivers, and the refusal is reported
  {
    const h = harness({ env: { ...GHL_ENV, ...AIRTABLE_ENV, GHL_TOKEN: "revoked" } });
    for (const k of [CALL_A, CALL_B]) {
      await seedCall(h.store, k);
      await h.store.enqueueOutbox("interaction.completed", k, "airtable");
      await queue(h.store, k);
    }
    const out = await runJob("outbox", h.deps);
    assert(!out.skipped);
    assertEquals(out.result, {
      delivered: 2,
      retried: 0,
      dead: 0,
      errors: 0,
      ghl_delivered: 0,
      ghl_retried: 0,
      ghl_dead: 0,
      ghl_errors: 0,
      ghl_config_error: "ghl 401 POST /contacts/search: Invalid Private Integration token",
    });
    assertEquals(h.store.tables.outbox_events.filter((o) => o.destination === "ghl").map((o) => o.attempts), [0, 0]);
  }
  // a store failure on the call log's first claim: GoHighLevel still runs, and the run is kept
  {
    const h = harness({ env: { ...GHL_ENV, ...AIRTABLE_ENV } });
    await seedCall(h.store, CALL_A);
    await queue(h.store, CALL_A);
    h.store.failNext("claimOutbox");
    const out = await runJob("outbox", h.deps);
    assert(!out.skipped);
    assertEquals([out.result.errors, out.result.ghl_delivered], [1, 1]);
  }
});

Deno.test("outbox job: the call log gets half the run when GoHighLevel is on; GoHighLevel gets the rest", async () => {
  // each Airtable upsert takes 1.5 s: with a 4 s share it stops after two (1 s left), and
  // GoHighLevel still has the 5 s after that
  const h: H = harness({
    env: { ...GHL_ENV, ...AIRTABLE_ENV },
    airtable: () => {
      h.advance(1500);
      return json({ records: [{ id: "rec" }] });
    },
  });
  for (const k of [CALL_A, CALL_B, CALL_C]) {
    await seedCall(h.store, k);
    await h.store.enqueueOutbox("interaction.completed", k, "airtable");
  }
  await queue(h.store, CALL_A);
  const out = await runJob("outbox", h.deps);
  assert(!out.skipped);
  assertEquals([out.result.delivered, out.result.ghl_delivered], [2, 1]);
});

Deno.test("call path: with a GoHighLevel fetch that hangs, the report answers at once; GoHighLevel is only queued, 90 s out", async () => {
  const h = harness({ env: { ...GHL_ENV } });
  // any GHL request would hang until its abort
  h.twin.failNext("POST", /.*/, "hang", 100);
  const message = JSON.parse(
    Deno.readTextFileSync(new URL("../../../fixtures/eocr/full.json", import.meta.url)),
  ).message as VapiMessage;
  const callKey = String((message.call as { id: string }).id);
  const started = performance.now();
  const res = await onEndOfCallReport(message, h.deps, { backfillDelaysMs: [0, 0, 0] });
  for (const p of h.background) await p;
  assertEquals(res.status, 200);
  assert(performance.now() - started < 1000, "answered within its budget");
  assertEquals(h.twin.requests.length, 0, "GoHighLevel is never called on the request path");
  const queued = row(h.store, callKey);
  assertEquals([queued.attempts, queued.next_attempt_at], [0, new Date(NOW.getTime() + 90 * SECOND).toISOString()]);
});

Deno.test("ghl errors are masked and capped at the client", async () => {
  const h = harness();
  h.twin.failNext("POST", "/contacts/search", { status: 500, body: { message: `boom 4805550123 ${"y".repeat(500)}` } });
  const res = await ghlRequest(h.deps, "POST", "/contacts/search", { filters: [] });
  assert(!res.ok);
  assertEquals([res.kind, res.retryable], ["transient", true]);
  assertMatch(res.error, /^ghl 500 POST \/contacts\/search: boom \[digits\] y+$/);
  assertEquals(res.error.length, 200);
  const off = await ghlRequest({ ...h.deps, env: { ...h.deps.env, GHL_TOKEN: undefined } }, "GET", "/contacts/x");
  assert(!off.ok);
  assertEquals([off.kind, h.twin.requests.length], ["config", 1]);
});
