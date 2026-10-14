// Why the call happened and what a claim taken on it does to the record: call_reason's precedence
// (server facts, then the structured output, then what the tools did, else nothing), the outcome of
// a call that filed a claim (resolved, a new caller's lead intake included), claim_number only for a
// verified customer's filed claim, and the merge that never lets a lower-ranked source replace a
// higher one.
import { assert, assertEquals } from "@std/assert";
import { CALL_REASONS } from "./enums.ts";
import { createFakeStore, demoSeed } from "./fake_store.ts";
import { buildInteractionRow, callReasonOf, onEndOfCallReport, type PostCallFacts } from "./post_call.ts";
import { runTool } from "./tools.ts";
import type {
  AttemptRow,
  CallerContact,
  ClaimIntake,
  Customer,
  Deps,
  EmailRow,
  EscalationRow,
  Session,
  VapiMessage,
} from "./types.ts";

const KEY = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const NOW = new Date("2026-10-13T15:00:00Z");
const SEED = demoSeed();
const TOBIAS: Customer = (({ date_of_birth: _dob, ...c }) => c)(SEED.customers[0]);

function report(analysis: Record<string, unknown> = {}, outputs: Record<string, unknown> = {}): VapiMessage {
  return {
    type: "end-of-call-report",
    call: { id: KEY, type: "webCall" },
    startedAt: "2026-10-13T14:50:00Z",
    endedAt: "2026-10-13T14:55:00Z",
    endedReason: "customer-ended-call",
    analysis,
    artifact: {
      structuredOutputs: outputs,
      messages: [{ role: "bot", message: "Hello." }, { role: "user", message: "Hi, I need help." }],
    },
  };
}

function session(level: Session["level"], customer: string | null = null): Session {
  return {
    call_key: KEY,
    channel: "webCall",
    caller_number: null,
    level,
    candidate_customer_id: customer,
    verified_customer_id: level === "verified" ? customer : null,
  };
}

let seq = 0;
function attempt(tool: string, kind: AttemptRow["kind"], code: string | null): AttemptRow {
  return { call_key: KEY, tool_call_id: `tc_${++seq}`, tool_name: tool, kind, code, created_at: NOW.toISOString() };
}

function escalation(kind: EscalationRow["kind"]): EscalationRow {
  return {
    id: crypto.randomUUID(),
    call_key: KEY,
    kind,
    reason: kind === "emergency" ? "emergency" : "representative_requested",
    details: null,
    callback_phone: null,
    channel: "webCall",
    verified: false,
    callback_source: "none",
    alert_status: "sent",
    delivery_error: null,
    status: "open",
    created_at: NOW.toISOString(),
    caller_name: null,
  };
}

function email(kind: EmailRow["kind"], status: EmailRow["status"] = "sent"): EmailRow {
  return {
    call_key: KEY,
    kind,
    to_masked: "o***@example.com",
    resend_id: status === "sent" ? "re_1" : null,
    status,
    error: null,
  };
}

function contact(kind: CallerContact["kind"], confirmed = true): CallerContact {
  return {
    call_key: KEY,
    kind,
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@example.com",
    callback_phone: "+16025550177",
    callback_source: "argument",
    customer_id: kind === "email_update" ? TOBIAS.id : null,
    confirmed,
    confirmed_at: confirmed ? NOW.toISOString() : null,
  };
}

function intake(kind: ClaimIntake["kind"], confirmed: boolean): ClaimIntake {
  return {
    call_key: KEY,
    kind,
    claim_type: "auto",
    loss_date: "2026-10-10",
    summary: "rear-ended",
    description: "Someone rear-ended me at a light.",
    customer_id: kind === "claim" ? TOBIAS.id : null,
    claim_id: confirmed && kind === "claim" ? crypto.randomUUID() : null,
    claim_number: confirmed && kind === "claim" ? "CLM-482472" : null,
    confirmed,
    confirmed_at: confirmed ? NOW.toISOString() : null,
  };
}

function facts(p: Partial<PostCallFacts> = {}): PostCallFacts {
  return { session: null, verifiedCustomer: null, attempts: [], escalations: [], emails: [], ...p };
}

const verified = (extra: AttemptRow[] = []): Partial<PostCallFacts> => ({
  session: session("verified", TOBIAS.id),
  verifiedCustomer: TOBIAS,
  attempts: [
    attempt("lookup_customer", "lookup_hit", "needs_dob"),
    attempt("verify_identity", "dob_ok", "verified"),
    ...extra,
  ],
});

const misses = (): Partial<PostCallFacts> => ({
  session: session("none"),
  attempts: [
    attempt("lookup_customer", "lookup_miss", "not_found"),
    attempt("lookup_customer", "lookup_miss", "not_found_final"),
  ],
});

// ---------------------------------------------------------------------------------------------
// call_reason precedence
// ---------------------------------------------------------------------------------------------
Deno.test("call_reason: an emergency row wins over everything, as a server fact", () => {
  const f = facts({
    ...verified([attempt("get_claim_status", "other", "ok")]),
    escalations: [escalation("representative"), escalation("emergency")],
    intake: intake("claim", true),
  });
  assertEquals(callReasonOf(report({ structuredData: { call_reason: "claim_status" } }), f), {
    reason: "emergency",
    source: "server",
  });
});

Deno.test("call_reason: a filed intake of either kind is file_claim from the server; an unfiled one is not", () => {
  for (const kind of ["claim", "lead_intake"] as const) {
    assertEquals(
      callReasonOf(
        report({ structuredData: { call_reason: "general_question" } }),
        facts({ intake: intake(kind, true) }),
      ),
      { reason: "file_claim", source: "server" },
      kind,
    );
  }
  assertEquals(callReasonOf(report(), facts({ intake: intake("claim", false) })), null);
});

Deno.test("call_reason: the structured output's reason when it is a known value, from either analysis shape", () => {
  for (const reason of CALL_REASONS) {
    assertEquals(callReasonOf(report({ structuredData: { call_reason: reason } }), facts()), {
      reason,
      source: "structured_output",
    });
  }
  assertEquals(
    callReasonOf(report({}, { a: { name: "claims_call", result: { call_reason: "Documents" } } }), facts()),
    { reason: "documents", source: "structured_output" },
  );
  // an output named after the field carries the bare value
  assertEquals(callReasonOf(report({}, { a: { name: "call_reason", result: "speak_to_agent" } }), facts()), {
    reason: "speak_to_agent",
    source: "structured_output",
  });
  // an unknown value is ignored, and the server facts decide
  assertEquals(
    callReasonOf(
      report({ structuredData: { call_reason: "complaint" } }),
      facts(verified([attempt("get_claim_status", "other", "ok")])),
    ),
    { reason: "claim_status", source: "derived" },
  );
  // it outranks what the tools did
  assertEquals(
    callReasonOf(
      report({ structuredData: { call_reason: "general_question" } }),
      facts(verified([attempt("get_claim_status", "other", "ok")])),
    ),
    { reason: "general_question", source: "structured_output" },
  );
});

Deno.test("call_reason: derived from what the tools did, in order", () => {
  const derived = (f: PostCallFacts) => callReasonOf(report(), f);
  // a status read, the separate tool's or the chained one verify_identity records
  assertEquals(derived(facts(verified([attempt("get_claim_status", "other", "ok")]))), {
    reason: "claim_status",
    source: "derived",
  });
  assertEquals(derived(facts(verified([attempt("get_claim_status", "other", "no_claims")]))), {
    reason: "claim_status",
    source: "derived",
  });
  // the details asked for after the summary are status reads too
  for (const code of ["claim_documents", "no_documents_needed", "claim_detail"]) {
    assertEquals(derived(facts(verified([attempt("get_claim_status", "other", code)]))), {
      reason: "claim_status",
      source: "derived",
    }, code);
  }
  // a failed or refused read, or the question back about which claim, is not a status read
  assertEquals(derived(facts(verified([attempt("get_claim_status", "other", "claim_not_identified")]))), null);
  assertEquals(derived(facts(verified([attempt("get_claim_status", "other", "system_error")]))), null);
  assertEquals(derived(facts({ attempts: [attempt("get_claim_status", "other", "not_verified")] })), null);
  // a document checklist that was sent (not one that failed)
  assertEquals(derived(facts({ ...verified(), emails: [email("document_checklist")] })), {
    reason: "documents",
    source: "derived",
  });
  assertEquals(derived(facts({ ...verified(), emails: [email("document_checklist", "failed")] })), null);
  // a representative request
  assertEquals(derived(facts({ escalations: [escalation("representative")] })), {
    reason: "speak_to_agent",
    source: "derived",
  });
  // an email update
  assertEquals(derived(facts({ ...verified(), contact: contact("email_update") })), {
    reason: "update_details",
    source: "derived",
  });
  assertEquals(derived(facts({ ...misses(), contact: contact("new_customer") })), null);
  // the steps to start a claim, sent
  assertEquals(derived(facts({ ...misses(), emails: [email("how_to_start_claim")] })), {
    reason: "file_claim",
    source: "derived",
  });
  // the team's own emails say nothing about why the caller called
  assertEquals(derived(facts({ emails: [email("callback_request"), email("claim_intake")] })), null);
  // the order: status read > documents > representative > email update > how to start
  assertEquals(
    derived(facts({
      ...verified([attempt("get_claim_status", "other", "ok")]),
      emails: [email("document_checklist"), email("how_to_start_claim")],
      escalations: [escalation("representative")],
      contact: contact("email_update"),
    })),
    { reason: "claim_status", source: "derived" },
  );
  assertEquals(
    derived(facts({
      emails: [email("how_to_start_claim"), email("document_checklist")],
      escalations: [escalation("representative")],
    })),
    { reason: "documents", source: "derived" },
  );
  assertEquals(
    derived(facts({ emails: [email("how_to_start_claim")], escalations: [escalation("representative")] })),
    { reason: "speak_to_agent", source: "derived" },
  );
});

Deno.test("call_reason: nothing to go on is null, never a guess", () => {
  assertEquals(callReasonOf(report(), facts()), null);
  assertEquals(callReasonOf(report(), facts(misses())), null);
  const row = buildInteractionRow(report(), facts());
  assertEquals([row.call_reason, row.call_reason_source], [null, null]);
});

// ---------------------------------------------------------------------------------------------
// outcome and claim_number
// ---------------------------------------------------------------------------------------------
Deno.test("outcome: a filed intake resolves the call, a new caller's included; emergency and escalation still win", () => {
  const outcome = (p: Partial<PostCallFacts>, message = report()) => buildInteractionRow(message, facts(p)).outcome;
  assertEquals(
    outcome({ ...misses(), contact: contact("new_customer"), intake: intake("lead_intake", true) }),
    "resolved",
  );
  assertEquals(outcome({ ...verified(), intake: intake("claim", true) }), "resolved");
  // read back but never filed: what it was before
  assertEquals(outcome({ ...misses(), intake: intake("lead_intake", false) }), "not_found");
  assertEquals(
    outcome({ ...misses(), intake: intake("lead_intake", true), escalations: [escalation("representative")] }),
    "escalated",
  );
  assertEquals(
    outcome({ ...verified(), intake: intake("claim", true), escalations: [escalation("emergency")] }),
    "emergency",
  );
  // a filed claim outranks the analysis' guess
  assertEquals(
    outcome({ ...verified(), intake: intake("claim", true) }, report({ structuredData: { outcome: "unsupported" } })),
    "resolved",
  );
});

Deno.test("claim_number: only a verified customer's filed claim; the row carries the reason too", () => {
  const filed = buildInteractionRow(report(), facts({ ...verified(), intake: intake("claim", true) }));
  assertEquals([filed.claim_number, filed.call_reason, filed.call_reason_source], [
    "CLM-482472",
    "file_claim",
    "server",
  ]);
  const lead = buildInteractionRow(
    report(),
    facts({ ...misses(), contact: contact("new_customer"), intake: intake("lead_intake", true) }),
  );
  assertEquals([lead.claim_number, lead.call_reason, lead.caller_type], [null, "file_claim", "new"]);
  const pending = buildInteractionRow(report(), facts({ ...verified(), intake: intake("claim", false) }));
  assertEquals(pending.claim_number, null);
});

Deno.test("flags: a filed claim spoken of without a filed intake is flagged on the record", () => {
  const message = report();
  (message.artifact as Record<string, unknown>).messages = [{ role: "bot", message: "Great, I've filed your claim." }];
  assertEquals(buildInteractionRow(message, facts(verified())).flags, ["claim_promised_without_filing"]);
  assertEquals(buildInteractionRow(message, facts({ ...verified(), intake: intake("claim", true) })).flags, []);
});

// ---------------------------------------------------------------------------------------------
// End to end: tools, then the report, through the fake store.
// ---------------------------------------------------------------------------------------------
function deps(): Deps & { store: ReturnType<typeof createFakeStore>; settle: () => Promise<void> } {
  const store = createFakeStore(undefined, { now: () => NOW, random: () => 0.4824725 });
  const background: Promise<unknown>[] = [];
  const d = {
    store,
    fetch:
      (() => Promise.resolve(new Response(JSON.stringify({ id: "re_1", ok: true }), { status: 200 }))) as typeof fetch,
    env: {
      VAPI_ORG_ID: "org",
      VAPI_WEBHOOK_SECRET: "s",
      RESEND_API_KEY: "re_key",
      CLAIMS_TEAM_EMAIL: "team@example.com",
      ALERT_SINKS: "email",
    },
    now: () => NOW,
    waitUntil: (p: Promise<unknown>) => {
      background.push(p);
    },
    log: () => {},
    settle: async () => {
      while (background.length > 0) await background.shift();
    },
  };
  return d;
}

Deno.test("end to end: a verified FNOL call is stored resolved, file_claim from the server, with its claim number", async () => {
  const d = deps();
  const ctx = { callKey: KEY, channel: "webCall" as const, callerNumber: null, isChat: false, deps: d };
  let n = 0;
  const run = async (name: string, args: Record<string, unknown>) => {
    const r = await runTool({ id: `tc_${++n}`, name, args }, ctx);
    await d.settle();
    return r;
  };
  await run("lookup_customer", { phone: "6025550101" });
  await run("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "file_claim" });
  await run("start_claim", { claim_type: "auto", loss_date: "Saturday", description: "Someone backed into my car." });
  assertEquals((await run("confirm_claim", { correct: true })).code, "claim_filed");

  const res = await onEndOfCallReport(
    report({ summary: "Filed an auto claim.", structuredData: { sentiment: "positive", call_reason: "other" } }),
    d,
    {
      backfillDelaysMs: [],
    },
  );
  assertEquals(res.status, 200);
  await d.settle();
  const row = d.store.tables.call_interactions.find((r) => r.vapi_call_id === KEY);
  assert(row);
  assertEquals(
    [row.outcome, row.call_reason, row.call_reason_source, row.claim_number, row.caller_name],
    ["resolved", "file_claim", "server", "CLM-482472", "Tobias Halvorsen"],
  );
});

Deno.test("end to end: verify with intent claim_status is a resolved claim_status call with no get_claim_status", async () => {
  const d = deps();
  const ctx = { callKey: KEY, channel: "webCall" as const, callerNumber: null, isChat: false, deps: d };
  await runTool({ id: "tc_1", name: "lookup_customer", args: { phone: "6025550101" } }, ctx);
  await runTool({
    id: "tc_2",
    name: "verify_identity",
    args: { dob_month: 3, dob_day: 14, dob_year: 1986, intent: "claim_status" },
  }, ctx);
  await d.settle();
  await onEndOfCallReport(report({ summary: "Checked claims.", structuredData: { sentiment: "neutral" } }), d, {
    backfillDelaysMs: [],
  });
  await d.settle();
  const row = d.store.tables.call_interactions.find((r) => r.vapi_call_id === KEY);
  assertEquals([row?.outcome, row?.call_reason, row?.call_reason_source], ["resolved", "claim_status", "derived"]);
});

Deno.test("merge: a reason from a lower-ranked source never replaces a higher one; an equal or higher one does", async () => {
  const store = createFakeStore(undefined, { now: () => NOW });
  const write = (call_reason: string | null, call_reason_source: string | null, extra: Record<string, unknown> = {}) =>
    store.upsertInteraction({ vapi_call_id: KEY, call_reason, call_reason_source, ...extra } as never);
  const stored = () => {
    const r = store.tables.call_interactions.find((x) => x.vapi_call_id === KEY);
    return [r?.call_reason, r?.call_reason_source, r?.claim_number];
  };
  await write("claim_status", "derived");
  assertEquals(stored(), ["claim_status", "derived", null]);
  await write("documents", "derived");
  assertEquals(stored(), ["documents", "derived", null], "equal rank replaces");
  await write("general_question", "structured_output", { claim_number: "CLM-482472" });
  assertEquals(stored(), ["general_question", "structured_output", "CLM-482472"]);
  await write("claim_status", "derived", { claim_number: "" });
  assertEquals(stored(), ["general_question", "structured_output", "CLM-482472"], "lower rank and empty number keep");
  await write(null, null);
  assertEquals(stored(), ["general_question", "structured_output", "CLM-482472"], "null keeps");
  await write("file_claim", "server");
  assertEquals(stored(), ["file_claim", "server", "CLM-482472"]);
  await write("other", "structured_output");
  assertEquals(stored(), ["file_claim", "server", "CLM-482472"]);
  // a reason without a source ranks lowest: it fills only an empty row
  const other = createFakeStore();
  await other.upsertInteraction({ vapi_call_id: "k2", call_reason: "other" } as never);
  await other.upsertInteraction({ vapi_call_id: "k2", call_reason: "documents" } as never);
  const r = other.tables.call_interactions.find((x) => x.vapi_call_id === "k2");
  assertEquals([r?.call_reason, r?.call_reason_source], ["documents", null]);
  // the CHECKs refuse values off the lists
  let refused = 0;
  for (
    const bad of [{ call_reason: "complaint", call_reason_source: "derived" }, {
      call_reason: "other",
      call_reason_source: "llm",
    }]
  ) {
    try {
      await store.upsertInteraction({ vapi_call_id: KEY, ...bad } as never);
    } catch {
      refused++;
    }
  }
  assertEquals(refused, 2);
});
