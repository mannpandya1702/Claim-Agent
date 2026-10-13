// Smoke test of the deployed webhook before any VAPI traffic: flat VAPI-shaped envelopes with the
// real Bearer, walking every code path the server owns (auth, org check, the identity ladder with
// wrong-DOB-twice and smuggled arguments, the chat escalation, and the post-call writers). Each
// tool answer is checked against the exact speak.ts sentence, so a stale deploy shows up here.
// Then every row written for a smoke-* call key is deleted again.
//
//   deno task smoke                 run every case, verify the rows, clean up
//   deno task smoke --only a,b      run only the named cases (the post-call cases share one call)
//   deno task smoke --keep          leave the rows in place for inspection
//
// Chat envelopes send no Telegram and no team email (alert_status 'skipped'), and no case reaches an
// alerting branch, so a smoke run never pages anyone. The emails a run can send all go to OWNER_EMAIL
// (the address every seeded customer uses): the new-caller case's steps to start a claim, the new
// caller's claim confirmation (both only when OWNER_EMAIL is set; without it those cases check the
// gates and send nothing), and the verified claim's confirmation to the seeded customer's address on file.
// The claims and claim intakes the claim cases file are deleted with everything else.

import { maskEmail } from "../supabase/functions/vapi-webhook/email.ts";
import { CLAIM_DOCUMENTS, type Code, type Level, TIMEZONE } from "../supabase/functions/vapi-webhook/enums.ts";
import { demoSeed } from "../supabase/functions/vapi-webhook/fake_store.ts";
import { normaliseEmail } from "../supabase/functions/vapi-webhook/identity.ts";
import { parseLossDate } from "../supabase/functions/vapi-webhook/loss_date.ts";
import { MASKED_ANSWER } from "../supabase/functions/vapi-webhook/redact.ts";
import {
  assertSpeakable,
  claimDetailSentence,
  claimsSentence,
  documentsSentence,
  MAX_TURN_WORDS,
  sentenceFor,
  spokenWords,
  verifiedFileClaimSentence,
} from "../supabase/functions/vapi-webhook/speak.ts";
import type { Claim } from "../supabase/functions/vapi-webhook/types.ts";
import {
  endOfCallReportEnvelope,
  type EnvelopeRef,
  postEnvelope,
  type PostResult,
  rekey,
  statusUpdateEnvelope,
  toolCallsEnvelope,
  type ToolCallSpec,
  toolReplies,
  type ToolReply,
  transcriptEnvelope,
  type WebhookTarget,
} from "./lib/envelope.ts";
import { loadEnv, need } from "./lib/env.ts";
import { lit, sqlClient } from "./lib/sql.ts";
import { webhookUrl } from "./vapi_sync.ts";

export const SMOKE_PREFIX = "smoke-";

// Seeded fiction (0002_seed.sql). The unknown and callback numbers match nobody on purpose.
const TOBIAS = {
  id: "6b0d6f0e-1c11-4c7a-9a01-000000000101",
  phone: "6025550101",
  dob: { dob_month: 3, dob_day: 14, dob_year: 1986 },
};
const RONAN_PHONE = "6025550102";
const RONAN_DOB = { dob_month: 11, dob_day: 2, dob_year: 1979 }; // one claim, under review: no documents due
const TEAGUE = {
  phone: "6025550104",
  dob: { dob_month: 1, dob_day: 30, dob_year: 1965 },
}; // no email on file
// The claim cases file for Sloane, whose one claim no other case reads.
const SLOANE = {
  id: "6b0d6f0e-1c11-4c7a-9a01-000000000103",
  phone: "6025550103",
  dob: { dob_month: 7, dob_day: 21, dob_year: 1992 },
};
const UNKNOWN_PHONE = "6025550199";
const OTHER_UNKNOWN_PHONES = ["6025550198", "6025550197"];
const CALLBACK_PHONE = "6025550177";
const FIRST_MESSAGE =
  "Hey, thanks for calling Observe Insurance claims. This is Ava, and this call may be recorded. What's the phone number on your account?";
// The new caller the contact cases invent; no customer has these details.
const NEW_CALLER = { first_name: "smoke", last_name: "tester" };
// Spelled the way a caller says it, so the server's spoken-form reading is exercised end to end.
const SPOKEN_EMAIL = "s m o k e dot t e s t at example dot com";
const VERIFIED_PREFIX = "Thank you, Tobias, you're verified.";
// A loss as a caller reports it; loss_date is replaced per step.
const BUMPER = {
  claim_type: "auto",
  description: "Someone backed into my parked car at the grocery store and dented the rear bumper.",
  summary: "a dented rear bumper",
};
const TREE = {
  claim_type: "home",
  loss_date: "yesterday",
  description: "A tree branch came down on the roof in the storm and cracked some shingles.",
  summary: "a branch on the roof",
};
const PHONE_CLAIM_DETAIL = "Reported by phone. An adjuster will be assigned within one business day.";
const SETTLE_MS = 2000;
const ROW_WAIT_MS = 3000;
const ROW_POLL_MS = 250;

/** Read access to the rows a case should have written (SQL live, the fake store in tests). */
export interface SmokeDb {
  attempts(callKey: string): Promise<{ tool_name: string; code: string | null }[]>;
  escalations(callKey: string): Promise<
    {
      kind: string;
      reason: string;
      alert_status: string;
      callback_phone: string | null;
      callback_source: string | null;
      channel: string;
    }[]
  >;
  interaction(callKey: string): Promise<
    {
      outcome: string | null;
      ended_at: string | null;
      summary: string | null;
      sentiment: string | null;
      analysis_status: string;
    } | null
  >;
  transcriptLines(callKey: string): Promise<{ role: string; text: string }[]>;
  contact(callKey: string): Promise<
    {
      kind: string;
      first_name: string;
      last_name: string;
      email: string | null;
      confirmed: boolean;
    } | null
  >;
  emails(
    callKey: string,
  ): Promise<{ kind: string; to_masked: string; status: string }[]>;
  intake(callKey: string): Promise<
    {
      kind: string;
      claim_type: string;
      loss_date: string;
      claim_number: string | null;
      confirmed: boolean;
      customer_id: string | null;
    } | null
  >;
  /** The claims a call filed (claims.reported_call_key). */
  phoneClaims(callKey: string): Promise<
    {
      customer_id: string;
      claim_number: string;
      claim_type: string;
      status: string;
      status_detail: string | null;
      documents_required: string[];
    }[]
  >;
}

export interface SmokeConfig {
  target: WebhookTarget;
  orgId: string;
  runId: string; // makes every call key unique to this run
  db?: SmokeDb; // row checks are skipped without it
  eocrFixture?: unknown; // a captured end-of-call-report body; inline report otherwise
  now?: () => Date;
  /** Tools write some rows in the background (waitUntil), so a row check re-reads for up to this
   *  long before it fails. Default 3000 ms; tests pass 0. */
  rowWaitMs?: number;
  /** OWNER_EMAIL: the only address the new-caller case may email the steps to start a claim. */
  ownerEmail?: string;
}

export interface CaseResult {
  name: string;
  pass: boolean;
  requests: number;
  problems: string[];
}

type Expect = string | RegExp | ((sentence: string) => string | null);

interface ToolStep {
  name: string;
  args?: Record<string, unknown> | string;
  id?: string; // reuse a toolCallId to exercise the replay guard
  code: Code;
  sentence?: Expect; // default: the exact sentenceFor(code)
  // A second answer that also passes (an honest failure of a third party the case cannot control).
  alternative?: { code: Code; sentence: Expect };
  check?: (reply: ToolReply) => string | null;
}

class CaseCtx {
  problems: string[] = [];
  requests = 0;
  private seq = 0;

  constructor(readonly cfg: SmokeConfig, readonly caseName: string) {}

  key(suffix = ""): string {
    return `${SMOKE_PREFIX}${this.cfg.runId}-${this.caseName}${suffix ? `-${suffix}` : ""}`;
  }

  ref(suffix = "", channel: EnvelopeRef["channel"] = "webCall"): EnvelopeRef {
    return { callKey: this.key(suffix), orgId: this.cfg.orgId, channel };
  }

  fail(message: string): void {
    this.problems.push(message);
  }

  /** Reads until problem() returns null or the row wait runs out; returns the last problem. */
  async rows<T>(read: () => Promise<T>, problem: (rows: T) => string | null): Promise<string | null> {
    const deadline = Date.now() + (this.cfg.rowWaitMs ?? ROW_WAIT_MS);
    for (;;) {
      const found = problem(await read());
      if (found === null || Date.now() >= deadline) return found;
      await new Promise((r) => setTimeout(r, ROW_POLL_MS));
    }
  }

  async post(body: unknown, opts: Parameters<typeof postEnvelope>[2] = {}): Promise<PostResult> {
    this.requests++;
    return await postEnvelope(this.cfg.target, body, opts);
  }

  expectStatus(label: string, res: PostResult, status: number): boolean {
    if (res.status === status) return true;
    this.fail(`${label}: HTTP ${res.status}, expected ${status} (${res.text.slice(0, 160)})`);
    return false;
  }

  /** One tool call per request, so each expected code maps to exactly one answer. */
  async tool(ref: EnvelopeRef, step: ToolStep): Promise<ToolReply | null> {
    const id = step.id ?? `${ref.callKey}-${++this.seq}`;
    const call: ToolCallSpec = { id, name: step.name, args: step.args };
    const label = `${step.name} -> ${step.code}`;
    const res = await this.post(toolCallsEnvelope(ref, [call]));
    if (!this.expectStatus(label, res, 200)) return null;
    const replies = toolReplies(res.json);
    if (!replies || replies.length !== 1) {
      this.fail(`${label}: expected one result, got ${res.text.slice(0, 160)}`);
      return null;
    }
    const reply = replies[0];
    if (reply.toolCallId !== id) this.fail(`${label}: toolCallId ${String(reply.toolCallId)} != ${id}`);
    if (reply.name !== step.name) this.fail(`${label}: name ${String(reply.name)} != ${step.name}`);
    const alternative = step.alternative && reply.code === step.alternative.code ? step.alternative : null;
    if (reply.code !== step.code && !alternative) {
      this.fail(`${label}: got code ${String(reply.code)}`);
      return reply;
    }
    const sentence = reply.sentence ?? "";
    try {
      assertSpeakable(sentence);
    } catch (e) {
      this.fail(`${label}: sentence not speakable (${(e as Error).message})`);
    }
    const problem = sentenceProblem(sentence, alternative?.sentence ?? step.sentence ?? sentenceFor(step.code));
    if (problem) this.fail(`${label}: ${problem}`);
    // results[].message is present unless NATIVE_TOOL_MESSAGES=false; when present it must be the
    // same sentence, or VAPI would speak one thing and the model's history would hold another.
    if (reply.nativeContent !== null && reply.nativeContent !== sentence) {
      this.fail(`${label}: results[].message.content differs from result.message`);
    }
    const extra = step.check?.(reply);
    if (extra) this.fail(`${label}: ${extra}`);
    return reply;
  }
}

function sentenceProblem(sentence: string, expect: Expect): string | null {
  if (typeof expect === "string") return sentence === expect ? null : `sentence was "${sentence}"`;
  if (expect instanceof RegExp) return expect.test(sentence) ? null : `sentence "${sentence}" !~ ${expect}`;
  return expect(sentence);
}

const notVerified = (level: Level) => sentenceFor("not_verified", { level });

/** Today in New York (the day loss dates are read against), as YYYY-MM-DD. */
function newYorkToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Tobias's seeded claims (0002_seed.sql, mirrored by fake_store.demoSeed): what every status answer reads. */
function tobiasClaims(): Claim[] {
  return demoSeed().claims.filter((c) => c.customer_id === TOBIAS.id);
}

function tobiasClaim(number: string): Claim {
  const claim = tobiasClaims().find((c) => c.claim_number === number);
  if (!claim) throw new Error(`seed claim ${number} is missing`);
  return claim;
}

/** The claims summary Tobias hears today, alone or after verify_identity's chained opening. */
function tobiasSummary(c: CaseCtx, opening = ""): string {
  const today = newYorkToday(c.cfg.now?.() ?? new Date());
  const status = claimsSentence(tobiasClaims(), today, MAX_TURN_WORDS - spokenWords(opening));
  return opening ? `${opening} ${status}` : status;
}

/** The read-back start_claim gives for these arguments today. */
function claimReadback(c: CaseCtx, args: { claim_type: string; loss_date: string; summary: string }): string {
  const now = c.cfg.now?.() ?? new Date();
  const read = parseLossDate(args.loss_date, now);
  if (!("date" in read)) throw new Error(`smoke loss_date ${args.loss_date} is not a date the server reads`);
  return sentenceFor("claim_readback", {
    claim_type: args.claim_type,
    loss_date: read.date,
    summary: args.summary,
    today: newYorkToday(now),
  });
}

interface SmokeCase {
  name: string;
  run(ctx: CaseCtx): Promise<void>;
}

function inlineReport(ref: EnvelopeRef, now: Date) {
  const at = (s: number) => new Date(now.getTime() - 90_000 + s * 1000).toISOString();
  const needsDob = sentenceFor("needs_dob");
  const verified = sentenceFor("verified", { first_name: "Tobias" });
  const lines: [string, string][] = [
    ["AI", FIRST_MESSAGE],
    ["User", "It's six zero two, five five five, zero one zero one."],
    ["AI", needsDob],
    ["User", "March fourteenth, nineteen eighty-six."],
    ["AI", verified],
    ["User", "That's all I needed, thanks. Bye."],
  ];
  return endOfCallReportEnvelope(ref, {
    startedAt: at(0),
    endedAt: at(88),
    durationSeconds: 88.4,
    cost: 0.0912,
    endedReason: "customer-ended-call",
    summary: "Tobias called about his claims and was verified. He needed nothing else and ended the call.",
    sentiment: "neutral",
    outcome: "resolved",
    callerName: "Tobias",
    successEvaluation: "true",
    assistantName: "Observe Claims Core",
    transcript: lines.map(([who, text]) => `${who}: ${text}`).join("\n"),
    messages: [
      { role: "bot", message: FIRST_MESSAGE, secondsFromStart: 0.4 },
      { role: "user", message: lines[1][1], secondsFromStart: 6.1 },
      {
        role: "tool_calls",
        toolCalls: [{
          id: "call_smoke_1",
          type: "function",
          function: { name: "lookup_customer", arguments: JSON.stringify({ phone: TOBIAS.phone }) },
        }],
        secondsFromStart: 6.9,
      },
      {
        role: "tool_call_result",
        name: "lookup_customer",
        toolCallId: "call_smoke_1",
        result: JSON.stringify({ code: "needs_dob", message: needsDob }),
        secondsFromStart: 7.5,
      },
      { role: "bot", message: needsDob, secondsFromStart: 7.6 },
      { role: "user", message: lines[3][1], secondsFromStart: 12.2 },
      {
        role: "tool_calls",
        toolCalls: [{
          id: "call_smoke_2",
          type: "function",
          function: { name: "verify_identity", arguments: JSON.stringify(TOBIAS.dob) },
        }],
        secondsFromStart: 13.0,
      },
      {
        role: "tool_call_result",
        name: "verify_identity",
        toolCallId: "call_smoke_2",
        result: JSON.stringify({ code: "verified", message: verified, data: { first_name: "Tobias" } }),
        secondsFromStart: 13.6,
      },
      { role: "bot", message: verified, secondsFromStart: 13.7 },
      { role: "user", message: lines[5][1], secondsFromStart: 19.3 },
    ],
  });
}

/** Every case in run order. The three post-call cases share one call key, like one real call. */
export function smokeCases(): SmokeCase[] {
  return [
    {
      name: "health",
      async run(c) {
        for (const method of ["GET", "OPTIONS"]) {
          const res = await c.post(null, { method, path: "/health", auth: null });
          if (!c.expectStatus(`${method} /health`, res, 200)) continue;
          if (JSON.stringify(res.json) !== '{"ok":true}') c.fail(`${method} /health: body ${res.text.slice(0, 80)}`);
          if (res.headers.get("access-control-allow-origin") !== "*") c.fail(`${method} /health: no CORS header`);
        }
      },
    },
    {
      name: "unauthorized",
      async run(c) {
        const body = toolCallsEnvelope(c.ref(), [{
          id: c.key("t1"),
          name: "lookup_customer",
          args: { phone: TOBIAS.phone },
        }]);
        const none = await c.post(body, { auth: null });
        if (c.expectStatus("no Bearer", none, 401) && (none.json as any)?.error !== "unauthorized") {
          c.fail(`no Bearer: body ${none.text.slice(0, 80)}`);
        }
        const wrong = await c.post(body, { auth: `wrong-${crypto.randomUUID()}` });
        c.expectStatus("wrong Bearer", wrong, 401);
      },
    },
    {
      name: "forbidden-org",
      async run(c) {
        const ref = { ...c.ref(), orgId: "00000000-0000-4000-8000-0000000000ff" };
        const res = await c.post(toolCallsEnvelope(ref, [{ id: c.key("t1"), name: "lookup_customer", args: {} }]));
        c.expectStatus("foreign orgId", res, 403);
      },
    },
    {
      name: "malformed",
      async run(c) {
        const bad = await c.post(null, { raw: '{"message":' });
        c.expectStatus("bad JSON", bad, 400);
        const empty = await c.post({
          message: { type: "tool-calls", call: { id: c.key(), orgId: c.cfg.orgId }, toolCallList: [] },
        });
        if (c.expectStatus("empty toolCallList", empty, 200) && JSON.stringify(empty.json) !== '{"results":[]}') {
          c.fail(`empty toolCallList: body ${empty.text.slice(0, 80)}`);
        }
      },
    },
    {
      name: "happy-path",
      async run(c) {
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        await c.tool(ref, {
          name: "verify_identity",
          args: TOBIAS.dob,
          code: "verified",
          // with PRIOR_CONTACTS_ENABLED the welcome-back clause may follow
          sentence: (s) => s.startsWith(VERIFIED_PREFIX) ? null : `sentence was "${s}"`,
        });
        const claimsId = `${ref.callKey}-claims`;
        const first = await c.tool(ref, {
          name: "get_claim_status",
          id: claimsId,
          code: "ok",
          // the short summary, within one turn: the documents and how to send them wait for a detail
          sentence: tobiasSummary(c),
          check: (r) => {
            const claims = r.data?.claims;
            if (!Array.isArray(claims) || claims.length !== 2) return "data.claims should list both claims";
            return /4820|Halvorsen|Fairbanks/.test(JSON.stringify(r.data))
              ? "data carries more than last3 + status"
              : null;
          },
        });
        // A VAPI retry of the same toolCallId must replay the stored answer.
        await c.tool(ref, {
          name: "get_claim_status",
          id: claimsId,
          code: "ok",
          sentence: (s) => first?.sentence === s ? null : "replayed sentence differs from the first answer",
        });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(() => db.attempts(ref.callKey), (rows) => {
            const trail = rows.map((r) => `${r.tool_name}:${r.code}`).join(",");
            return trail === "lookup_customer:needs_dob,verify_identity:verified,get_claim_status:ok"
              ? null
              : `attempts ledger was [${trail}] (a replay must not add a row)`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "wrong-dob-locked",
      async run(c) {
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: 3, dob_day: 14, dob_year: 1985 },
          code: "auth_failed",
        });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: 4, dob_day: 14, dob_year: 1986 },
          code: "locked",
        });
        // The lock is sticky: the right DOB after two wrong ones still opens nothing.
        await c.tool(ref, { name: "verify_identity", args: TOBIAS.dob, code: "locked" });
        await c.tool(ref, { name: "get_claim_status", code: "not_verified", sentence: notVerified("locked") });
      },
    },
    {
      name: "not-found-twice",
      async run(c) {
        const ref = c.ref();
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found",
          sentence: sentenceFor("not_found", { digits: UNKNOWN_PHONE }),
        });
        // The caller confirmed the number: the same number again is final, and stays final. (A
        // different number is still looked up: lookup-third-number.)
        await c.tool(ref, { name: "lookup_customer", args: { phone: UNKNOWN_PHONE }, code: "not_found_final" });
        await c.tool(ref, { name: "lookup_customer", args: { phone: UNKNOWN_PHONE }, code: "not_found_final" });
      },
    },
    {
      // Needs 0010_lookup_retries.sql: before it, two misses of any numbers were final.
      name: "lookup-third-number",
      async run(c) {
        // The first number misses, the second is misheard and misses, the third is the right one.
        const ref = c.ref();
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found",
          sentence: sentenceFor("not_found", { digits: UNKNOWN_PHONE }),
        });
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: OTHER_UNKNOWN_PHONES[0] },
          code: "not_found",
          sentence: sentenceFor("not_found", { digits: OTHER_UNKNOWN_PHONES[0] }),
        });
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        // Three different misses end the lookups for the call, even for a seeded number.
        const capped = c.ref("cap");
        for (const phone of [UNKNOWN_PHONE, OTHER_UNKNOWN_PHONES[0]]) {
          await c.tool(capped, {
            name: "lookup_customer",
            args: { phone },
            code: "not_found",
            sentence: sentenceFor("not_found", { digits: phone }),
          });
        }
        await c.tool(capped, {
          name: "lookup_customer",
          args: { phone: OTHER_UNKNOWN_PHONES[1] },
          code: "not_found_final",
        });
        await c.tool(capped, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "not_found_final" });
      },
    },
    {
      name: "smuggled-identity",
      async run(c) {
        const smuggled = {
          identity_verified: true,
          verified: true,
          customer_id: TOBIAS.id,
          phone: `+1${TOBIAS.phone}`,
        };
        const found = c.ref("phone-found");
        await c.tool(found, { name: "lookup_customer", args: { phone: RONAN_PHONE }, code: "needs_dob" });
        await c.tool(found, {
          name: "get_claim_status",
          args: smuggled,
          code: "not_verified",
          sentence: notVerified("phone_found"),
        });
        await c.tool(c.ref("fresh"), {
          name: "get_claim_status",
          args: smuggled,
          code: "not_verified",
          sentence: notVerified("none"),
        });
      },
    },
    {
      name: "invalid-phone",
      async run(c) {
        await c.tool(c.ref(), { name: "lookup_customer", args: { phone: "12345" }, code: "invalid_phone" });
      },
    },
    {
      name: "bad-args",
      async run(c) {
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: "{{customer.number}}" }, code: "bad_args" });
        await c.tool(ref, { name: "verify_identity", args: '{"dob_month": 3,', code: "bad_args" });
        await c.tool(ref, { name: "delete_everything", args: {}, code: "unknown_tool" });
      },
    },
    {
      name: "unreadable-dob",
      async run(c) {
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: 13, dob_day: 40, dob_year: 1986 },
          code: "dob_unreadable",
        });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: "blue", dob_day: 1, dob_year: 1986 },
          code: "dob_unreadable",
        });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: 2, dob_day: 30, dob_year: 1990 },
          code: "dob_give_up",
        });
      },
    },
    {
      name: "email-unverified",
      async run(c) {
        await c.tool(c.ref(), {
          name: "send_info_email",
          args: { topic: "document_checklist" },
          code: "not_verified",
          sentence: notVerified("none"),
        });
      },
    },
    {
      name: "chat-escalate",
      async run(c) {
        const ref = c.ref("", "chat");
        await c.tool(ref, {
          name: "escalate",
          args: { reason: "representative_requested", details: "Wants a callback about a claim." },
          code: "rep_queued_no_number",
        });
        await c.tool(ref, {
          name: "escalate",
          args: { reason: "representative_requested", callback_phone: CALLBACK_PHONE },
          code: "callback_updated",
          sentence: sentenceFor("callback_updated", { digits: CALLBACK_PHONE }),
        });
        const db = c.cfg.db;
        if (db) {
          const want: Record<string, unknown> = {
            kind: "representative",
            alert_status: "skipped",
            callback_phone: `+1${CALLBACK_PHONE}`,
            callback_source: "argument",
            channel: "chat",
          };
          const problem = await c.rows(() => db.escalations(ref.callKey), (rows) => {
            if (rows.length !== 1) return `expected one escalation row, found ${rows.length}`;
            const row = rows[0] as Record<string, unknown>;
            const wrong = Object.entries(want).filter(([k, v]) => row[k] !== v);
            return wrong.length === 0
              ? null
              : wrong.map(([k, v]) => `escalation.${k} was ${JSON.stringify(row[k])}, expected ${JSON.stringify(v)}`)
                .join("; ");
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "new-caller-contact",
      async run(c) {
        // A chat, so the escalation-free path is all this exercises; the details are fiction.
        const ref = c.ref("", "chat");
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found",
          sentence: sentenceFor("not_found", { digits: UNKNOWN_PHONE }),
        });
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found_final",
        });
        await c.tool(ref, {
          name: "confirm_contact",
          args: { correct: true },
          code: "not_pending",
        });
        await c.tool(ref, {
          name: "capture_contact",
          args: { ...NEW_CALLER, email: "smoke at example" },
          code: "contact_invalid_email",
        });
        await c.tool(ref, {
          name: "capture_contact",
          args: { first_name: "smoke" },
          code: "contact_needs_name",
        });
        const readback = sentenceFor("contact_readback", {
          first_name: "Smoke",
          last_name: "Tester",
          email: "smoke.test@example.com",
        });
        await c.tool(ref, {
          name: "capture_contact",
          args: {
            ...NEW_CALLER,
            email: SPOKEN_EMAIL,
            customer_id: TOBIAS.id,
            identity_verified: true,
          },
          code: "contact_readback",
          sentence: readback,
        });
        // before the yes: the read-back again, nothing sent; claim details never go to this address
        await c.tool(ref, {
          name: "send_info_email",
          args: { topic: "how_to_start_claim" },
          code: "contact_readback",
          sentence: readback,
        });
        await c.tool(ref, {
          name: "confirm_contact",
          args: { correct: false },
          code: "contact_retry",
        });
        await c.tool(ref, {
          name: "capture_contact",
          args: { ...NEW_CALLER, email: SPOKEN_EMAIL },
          code: "contact_readback",
          sentence: readback,
        });
        const confirmId = `${ref.callKey}-confirm`;
        const saved = sentenceFor("contact_saved_new", { first_name: "Smoke" });
        await c.tool(ref, {
          name: "confirm_contact",
          id: confirmId,
          args: { correct: true },
          code: "contact_saved_new",
          sentence: saved,
        });
        // a VAPI retry of the same toolCallId repeats the answer
        await c.tool(ref, {
          name: "confirm_contact",
          id: confirmId,
          args: { correct: true },
          code: "contact_saved_new",
          sentence: saved,
        });
        await c.tool(ref, {
          name: "send_info_email",
          args: { topic: "claim_summary" },
          code: "not_verified",
          sentence: notVerified("none"),
        });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(() => db.contact(ref.callKey), (row) => {
            if (!row) return "no caller_contacts row";
            const got = [
              row.kind,
              row.first_name,
              row.last_name,
              row.email,
              row.confirmed,
            ].join("|");
            return got ===
                "new_customer|Smoke|Tester|smoke.test@example.com|true"
              ? null
              : `caller_contacts row was ${got}`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "new-caller-email",
      async run(c) {
        // The steps to start a claim, sent only to the OWNER_EMAIL address (never to anyone else).
        const owner = normaliseEmail(c.cfg.ownerEmail ?? "");
        const ref = c.ref("", "chat");
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found",
          sentence: sentenceFor("not_found", { digits: UNKNOWN_PHONE }),
        });
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found_final",
        });
        // no details yet: the way forward is the caller's name, and nothing is sent
        await c.tool(ref, {
          name: "send_info_email",
          args: { topic: "how_to_start_claim" },
          code: "contact_needs_name",
        });
        if (!owner) return;
        await c.tool(ref, {
          name: "capture_contact",
          args: { ...NEW_CALLER, email: owner },
          code: "contact_readback",
          sentence: sentenceFor("contact_readback", {
            first_name: "Smoke",
            last_name: "Tester",
            email: owner,
          }),
        });
        await c.tool(ref, {
          name: "confirm_contact",
          args: { correct: true },
          code: "contact_saved_new",
          sentence: sentenceFor("contact_saved_new", { first_name: "Smoke" }),
        });
        const sent = sentenceFor("email_sent", { target: "given" });
        const failed = sentenceFor("email_failed");
        const reply = await c.tool(ref, {
          name: "send_info_email",
          args: { topic: "how_to_start_claim" },
          code: "email_sent",
          sentence: sent,
          // Resend may refuse (its sandbox, or no key in a test): the honest failure is a pass too
          alternative: { code: "email_failed", sentence: failed },
        });
        if (!reply) return;
        const db = c.cfg.db;
        if (db) {
          const want = `how_to_start_claim|${maskEmail(owner)}`;
          const problem = await c.rows(() => db.emails(ref.callKey), (rows) => {
            const got = rows.map((r) => `${r.kind}|${r.to_masked}`).join(",");
            return got === want ? null : `email ledger was [${got}], expected [${want}]`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "email-update",
      async run(c) {
        // A verified customer with no email on file spells one: a pending update, never a recipient.
        const ref = c.ref("", "chat");
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: TEAGUE.phone },
          code: "needs_dob",
        });
        await c.tool(ref, {
          name: "verify_identity",
          args: TEAGUE.dob,
          code: "verified",
          sentence: (s) => s.startsWith("Thank you, Teague, you're verified.") ? null : `sentence was "${s}"`,
        });
        await c.tool(ref, {
          name: "send_info_email",
          args: { topic: "claim_summary" },
          code: "no_email_on_file",
        });
        await c.tool(ref, {
          name: "capture_contact",
          args: {
            first_name: "Mallory",
            last_name: "Smuggled",
            email: SPOKEN_EMAIL,
          },
          code: "contact_readback",
          sentence: sentenceFor("contact_readback", {
            first_name: "Teague",
            last_name: "Ashdown",
            email: "smoke.test@example.com",
          }),
        });
        await c.tool(ref, {
          name: "confirm_contact",
          args: { correct: true },
          code: "contact_saved_existing",
          sentence: sentenceFor("contact_saved_existing", {
            first_name: "Teague",
          }),
        });
        await c.tool(ref, {
          name: "send_info_email",
          args: { topic: "how_to_start_claim" },
          code: "no_email_on_file",
        });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(
            async () => ({
              contact: await db.contact(ref.callKey),
              emails: await db.emails(ref.callKey),
            }),
            (r) => {
              if (
                r.contact?.kind !== "email_update" ||
                r.contact.first_name !== "Teague"
              ) {
                return `caller_contacts row was ${JSON.stringify(r.contact)}`;
              }
              return r.emails.length === 0 ? null : `${r.emails.length} email rows for a pending update`;
            },
          );
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "verify-intent-status",
      async run(c) {
        // The caller asked about their claims before verifying: the verified answer reads them too.
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        const verifyId = `${ref.callKey}-verify`;
        const args = { ...TOBIAS.dob, intent: "claim_status" };
        const first = await c.tool(ref, {
          name: "verify_identity",
          id: verifyId,
          args,
          code: "verified",
          // with PRIOR_CONTACTS_ENABLED the opening adds "Welcome back."; either way, one turn
          sentence: (s) =>
            [tobiasSummary(c, VERIFIED_PREFIX), tobiasSummary(c, `${VERIFIED_PREFIX} Welcome back.`)].includes(s) &&
              spokenWords(s) <= MAX_TURN_WORDS
              ? null
              : `sentence was "${s}"`,
          check: (r) => {
            const claims = r.data?.claims;
            if (r.data?.status_read !== true || !Array.isArray(claims) || claims.length !== 2) {
              return `data should carry status_read and both claims, was ${JSON.stringify(r.data)}`;
            }
            return /4820|Halvorsen|Fairbanks/.test(JSON.stringify(r.data))
              ? "data carries more than last3 + status"
              : null;
          },
        });
        // A VAPI retry of the same toolCallId replays the answer and records no second read.
        await c.tool(ref, {
          name: "verify_identity",
          id: verifyId,
          args,
          code: "verified",
          sentence: (s) => first?.sentence === s ? null : "replayed sentence differs from the first answer",
        });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(() => db.attempts(ref.callKey), (rows) => {
            const trail = rows.map((r) => `${r.tool_name}:${r.code}`).join(",");
            return trail === "lookup_customer:needs_dob,verify_identity:verified,get_claim_status:ok"
              ? null
              : `attempts ledger was [${trail}] (the chained read is one get_claim_status row)`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "status-details",
      async run(c) {
        // The details the summary leaves out, each on request: the documents, one claim by its ending or
        // its type, and the question back when the words name no single claim.
        const today = newYorkToday(c.cfg.now?.() ?? new Date());
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        await c.tool(ref, {
          name: "verify_identity",
          args: TOBIAS.dob,
          code: "verified",
          sentence: (s) => s.startsWith(VERIFIED_PREFIX) ? null : `sentence was "${s}"`,
        });
        const status = (args: Record<string, unknown>, code: Code, sentence: string) =>
          c.tool(ref, {
            name: "get_claim_status",
            args,
            code,
            sentence: (s) => s === sentence && spokenWords(s) <= MAX_TURN_WORDS ? null : `sentence was "${s}"`,
            check: (r) =>
              /4820|Halvorsen|Fairbanks|CLM-/.test(JSON.stringify(r.data ?? {}))
                ? "data carries more than last3 + status"
                : null,
          });
        await status({ detail: "documents" }, "claim_documents", documentsSentence(tobiasClaims(), today));
        await status(
          { detail: "claim", claim_ending: "115" },
          "claim_detail",
          claimDetailSentence(tobiasClaim("CLM-240115"), today),
        );
        await status(
          { detail: "claim", claim_ending: "home" },
          "claim_detail",
          claimDetailSentence(tobiasClaim("CLM-240198"), today),
        );
        // no claim ends in seven seven seven, and two endings name neither: the claims are offered by type
        // and ending, in the order the summary read them
        const which = sentenceFor("claim_not_identified", {
          claims: [
            { claim_number_last3: "198", claim_type: "home", status: "awaiting_documents" },
            { claim_number_last3: "115", claim_type: "auto", status: "payment_issued" },
          ],
        });
        await status({ detail: "claim", claim_ending: "777" }, "claim_not_identified", which);
        await status({ detail: "claim", claim_ending: "198 or 115" }, "claim_not_identified", which);
        await status({ detail: "claim" }, "claim_not_identified", which);
        // Ronan's one claim is under review: nothing to send
        const ronan = c.ref("ronan");
        await c.tool(ronan, { name: "lookup_customer", args: { phone: RONAN_PHONE }, code: "needs_dob" });
        await c.tool(ronan, {
          name: "verify_identity",
          args: RONAN_DOB,
          code: "verified",
          sentence: (s) => s.startsWith("Thank you, Ronan, you're verified.") ? null : `sentence was "${s}"`,
        });
        await c.tool(ronan, { name: "get_claim_status", args: { detail: "documents" }, code: "no_documents_needed" });
        // his only claim is the one he means, even by a type it is not
        await c.tool(ronan, {
          name: "get_claim_status",
          args: { detail: "claim", claim_ending: "home" },
          code: "claim_detail",
          sentence: (s) => s.startsWith("Your auto claim ending in two one one") ? null : `sentence was "${s}"`,
        });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(() => db.attempts(ref.callKey), (rows) => {
            const trail = rows.map((r) => `${r.tool_name}:${r.code}`).join(",");
            const want = [
              "lookup_customer:needs_dob",
              "verify_identity:verified",
              "get_claim_status:claim_documents",
              "get_claim_status:claim_detail",
              "get_claim_status:claim_detail",
              "get_claim_status:claim_not_identified",
              "get_claim_status:claim_not_identified",
              "get_claim_status:claim_not_identified",
            ].join(",");
            return trail === want ? null : `attempts ledger was [${trail}]`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "fnol-verified",
      async run(c) {
        // A chat, so no team alert is paged; the customer's confirmation goes to the address on file.
        const ref = c.ref("", "chat");
        await c.tool(ref, { name: "lookup_customer", args: { phone: SLOANE.phone }, code: "needs_dob" });
        const opening = verifiedFileClaimSentence(sentenceFor("verified", { first_name: "Sloane" }));
        await c.tool(ref, {
          name: "verify_identity",
          args: { ...SLOANE.dob, intent: "file_claim" },
          code: "verified",
          // the welcome-back variant keeps its opening and ends the same way
          sentence: (s) =>
            s.startsWith("Thank you, Sloane, you're verified.") &&
              s.endsWith(opening.slice("Thank you, Sloane, you're verified.".length))
              ? null
              : `sentence was "${s}"`,
        });
        await c.tool(ref, {
          name: "start_claim",
          args: { ...BUMPER, loss_date: "yesterday", description: "car dented" },
          code: "claim_needs_description",
        });
        await c.tool(ref, {
          name: "start_claim",
          args: { ...BUMPER, loss_date: "next Tuesday" },
          code: "claim_bad_date",
        });
        const earlier = { ...BUMPER, loss_date: "the day before yesterday" };
        await c.tool(ref, {
          name: "start_claim",
          args: earlier,
          code: "claim_readback",
          sentence: claimReadback(c, earlier),
        });
        await c.tool(ref, { name: "confirm_claim", args: { correct: false }, code: "claim_retry" });
        const corrected = { ...BUMPER, loss_date: "yesterday" };
        await c.tool(ref, {
          name: "start_claim",
          args: corrected,
          code: "claim_readback",
          sentence: claimReadback(c, corrected),
        });
        const confirmId = `${ref.callKey}-confirm`;
        const filedShape =
          /^You're all set\. Your claim number ends in [a-z]+ [a-z]+ [a-z]+(, and I've emailed the details to the email on file)?\. An adjuster will reach out within one business day\. Is there anything else I can help with\?$/;
        const filed = await c.tool(ref, {
          name: "confirm_claim",
          id: confirmId,
          args: { correct: true },
          code: "claim_filed",
          sentence: filedShape,
          // "emailed" only when Resend returned an id: either answer is honest, and the sentence matches it
          check: (r) =>
            /^\d{3}$/.test(String(r.data?.claim_last3 ?? "")) && r.sentence === sentenceFor("claim_filed", r.data ?? {})
              ? null
              : `data ${JSON.stringify(r.data)} does not match the sentence`,
        });
        // A VAPI retry repeats the answer; nothing is filed or sent twice.
        await c.tool(ref, {
          name: "confirm_claim",
          id: confirmId,
          args: { correct: true },
          code: "claim_filed",
          sentence: (s) => filed?.sentence === s ? null : "replayed sentence differs from the first answer",
        });
        const last3 = String(filed?.data?.claim_last3 ?? "");
        await c.tool(ref, {
          name: "start_claim",
          args: corrected,
          code: "claim_already_filed",
          sentence: sentenceFor("claim_already_filed", last3 ? { claim_last3: last3 } : {}),
        });
        const db = c.cfg.db;
        if (db) {
          const yesterday = parseLossDate("yesterday", c.cfg.now?.() ?? new Date());
          const problem = await c.rows(
            async () => ({
              intake: await db.intake(ref.callKey),
              claims: await db.phoneClaims(ref.callKey),
              emails: await db.emails(ref.callKey),
            }),
            ({ intake, claims, emails }) => {
              if (!intake) return "no claim_intakes row";
              const got = [intake.kind, intake.claim_type, intake.loss_date, intake.confirmed, intake.customer_id].join(
                "|",
              );
              const want = ["claim", "auto", "date" in yesterday ? yesterday.date : "", true, SLOANE.id].join("|");
              if (got !== want) return `claim_intakes row was ${got}, expected ${want}`;
              if (!/^CLM-\d{6}$/.test(intake.claim_number ?? "") || !intake.claim_number!.endsWith(last3)) {
                return `claim number ${intake.claim_number} does not end in the spoken ${last3}`;
              }
              if (claims.length !== 1) return `${claims.length} claims rows filed by the call, expected one`;
              const claim = claims[0];
              const row = [claim.customer_id, claim.claim_number, claim.claim_type, claim.status, claim.status_detail];
              const wantRow = [SLOANE.id, intake.claim_number, "auto", "received", PHONE_CLAIM_DETAIL];
              if (row.join("|") !== wantRow.join("|")) return `claims row was ${row.join("|")}`;
              if (JSON.stringify(claim.documents_required) !== JSON.stringify(CLAIM_DOCUMENTS.auto)) {
                return `documents_required was ${JSON.stringify(claim.documents_required)}`;
              }
              // the customer's confirmation once (the ledger is per call and kind); the team's email is
              // skipped on a chat, like its Telegram card
              const kinds = emails.map((e) => e.kind).join(",");
              return kinds === "claim_received" ? null : `email ledger was [${kinds}], expected [claim_received]`;
            },
          );
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "fnol-lead",
      async run(c) {
        // A new caller's loss, taken once their details are confirmed; a lead for a specialist, never a
        // claims row. The confirmation goes only to the OWNER_EMAIL address, and only when it is set.
        const owner = normaliseEmail(c.cfg.ownerEmail ?? "");
        const ref = c.ref("", "chat");
        await c.tool(ref, {
          name: "lookup_customer",
          args: { phone: UNKNOWN_PHONE },
          code: "not_found",
          sentence: sentenceFor("not_found", { digits: UNKNOWN_PHONE }),
        });
        await c.tool(ref, { name: "lookup_customer", args: { phone: UNKNOWN_PHONE }, code: "not_found_final" });
        // no details yet, and then unconfirmed details: the way in is the caller's name
        await c.tool(ref, { name: "start_claim", args: TREE, code: "claim_needs_contact" });
        // a chat has no caller id: without a number said, the intake would ask for one first
        const details = owner
          ? { ...NEW_CALLER, email: owner, callback_phone: CALLBACK_PHONE }
          : { ...NEW_CALLER, callback_phone: CALLBACK_PHONE };
        await c.tool(ref, {
          name: "capture_contact",
          args: details,
          code: "contact_readback",
          sentence: sentenceFor("contact_readback", {
            first_name: "Smoke",
            last_name: "Tester",
            ...(owner ? { email: owner } : {}),
            callback_phone: CALLBACK_PHONE,
          }),
        });
        await c.tool(ref, { name: "start_claim", args: TREE, code: "claim_needs_contact" });
        // the loss was told before the details, so the yes asks to take that claim down now
        await c.tool(ref, {
          name: "confirm_contact",
          args: { correct: true },
          code: "contact_saved_new",
          sentence: sentenceFor(
            "contact_saved_new",
            owner ? { first_name: "Smoke", resume_claim: true } : {
              first_name: "Smoke",
              has_email: false,
              resume_claim: true,
            },
          ),
        });
        await c.tool(ref, {
          name: "start_claim",
          args: TREE,
          code: "claim_readback",
          sentence: claimReadback(c, TREE),
        });
        const confirmId = `${ref.callKey}-confirm`;
        const plain = sentenceFor("claim_intake_saved", { first_name: "Smoke", emailed: false });
        const emailed = sentenceFor("claim_intake_saved", { first_name: "Smoke", emailed: true });
        const saved = await c.tool(ref, {
          name: "confirm_claim",
          id: confirmId,
          args: { correct: true },
          code: "claim_intake_saved",
          // with an address, Resend may refuse (its sandbox, or no key in a test): the honest answer passes too
          sentence: (s) => s === plain || (owner && s === emailed) ? null : `sentence was "${s}"`,
        });
        await c.tool(ref, {
          name: "confirm_claim",
          id: confirmId,
          args: { correct: true },
          code: "claim_intake_saved",
          sentence: (s) => saved?.sentence === s ? null : "replayed sentence differs from the first answer",
        });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(
            async () => ({
              intake: await db.intake(ref.callKey),
              claims: await db.phoneClaims(ref.callKey),
              emails: await db.emails(ref.callKey),
            }),
            ({ intake, claims, emails }) => {
              if (!intake) return "no claim_intakes row";
              const got = [intake.kind, intake.claim_type, intake.confirmed, intake.claim_number, intake.customer_id];
              if (got.join("|") !== "lead_intake|home|true||") return `claim_intakes row was ${got.join("|")}`;
              if (claims.length !== 0) return `a new caller's intake filed ${claims.length} claims rows`;
              const want = owner ? `claim_received|${maskEmail(owner)}` : "";
              const ledger = emails.map((e) => `${e.kind}|${e.to_masked}`).join(",");
              return ledger === want ? null : `email ledger was [${ledger}], expected [${want}]`;
            },
          );
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "fnol-locked",
      async run(c) {
        // Who may report a loss is decided before any argument is read.
        const args = { ...BUMPER, loss_date: "yesterday" };
        await c.tool(c.ref("fresh"), { name: "start_claim", args, code: "claim_needs_lookup" });
        const ref = c.ref();
        await c.tool(ref, { name: "lookup_customer", args: { phone: TOBIAS.phone }, code: "needs_dob" });
        await c.tool(ref, { name: "start_claim", args, code: "claim_needs_verification" });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: 3, dob_day: 14, dob_year: 1985, intent: "file_claim" },
          code: "auth_failed",
        });
        await c.tool(ref, {
          name: "verify_identity",
          args: { dob_month: 4, dob_day: 14, dob_year: 1986, intent: "file_claim" },
          code: "locked",
        });
        await c.tool(ref, { name: "start_claim", args, code: "claim_locked" });
        // a locked call is refused with no details at all
        await c.tool(ref, { name: "start_claim", args: {}, code: "claim_locked" });
        await c.tool(ref, { name: "confirm_claim", args: { correct: true }, code: "claim_not_pending" });
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(
            async () => ({ intake: await db.intake(ref.callKey), claims: await db.phoneClaims(ref.callKey) }),
            ({ intake, claims }) =>
              intake === null && claims.length === 0 ? null : "a locked call stored an intake or filed a claim",
          );
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "status-update",
      async run(c) {
        const ref = { ...c.ref(), callKey: lifecycleKey(c) };
        const res = await c.post(statusUpdateEnvelope(ref, "in-progress"));
        c.expectStatus("status-update in-progress", res, 200);
        const db = c.cfg.db;
        if (db) {
          const problem = await c.rows(() => db.interaction(ref.callKey), (row) => {
            if (!row) return "no call_interactions stub row";
            return row.outcome === "in_progress" && row.ended_at === null
              ? null
              : `stub row outcome ${row.outcome}, ended_at ${row.ended_at}`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "transcript",
      async run(c) {
        const ref = { ...c.ref(), callKey: lifecycleKey(c) };
        const t0 = (c.cfg.now?.() ?? new Date()).getTime();
        const asked = "To get started, what's the phone number on your account?";
        for (
          const line of [
            { role: "assistant" as const, text: asked, timestamp: t0 },
            {
              role: "user" as const,
              text: "It's six zero two five five five zero one zero one.",
              timestamp: t0 + 4000,
            },
          ]
        ) {
          const res = await c.post(transcriptEnvelope(ref, line));
          c.expectStatus(`transcript ${line.role}`, res, 200);
        }
        const db = c.cfg.db;
        if (db) {
          const want = JSON.stringify([`assistant:${asked}`, `user:${MASKED_ANSWER}`]);
          const problem = await c.rows(() => db.transcriptLines(ref.callKey), (lines) => {
            const got = JSON.stringify(lines.map((l) => `${l.role}:${l.text}`));
            return got === want
              ? null
              : `transcript_lines were ${got}, expected the answer to the phone question masked`;
          });
          if (problem) c.fail(problem);
        }
      },
    },
    {
      name: "end-of-call-report",
      async run(c) {
        const ref = { ...c.ref(), callKey: lifecycleKey(c) };
        const body = c.cfg.eocrFixture ? rekey(c.cfg.eocrFixture, ref) : inlineReport(ref, c.cfg.now?.() ?? new Date());
        const res = await c.post(body);
        c.expectStatus("end-of-call-report", res, 200);
        const db = c.cfg.db;
        if (db) {
          const rowProblem = await c.rows(() => db.interaction(ref.callKey), (row) => {
            if (!row) return "no call_interactions row after the report";
            const problems = [
              row.ended_at ? "" : "row has no ended_at",
              row.summary ? "" : "row has no summary",
              row.analysis_status === "ok" ? "" : `analysis_status ${row.analysis_status}, expected ok`,
              row.outcome && row.outcome !== "in_progress" ? "" : `outcome ${row.outcome}`,
            ].filter(Boolean);
            return problems.length ? problems.join("; ") : null;
          });
          if (rowProblem) c.fail(rowProblem);
          const linesProblem = await c.rows(
            () => db.transcriptLines(ref.callKey),
            (left) => left.length === 0 ? null : `${left.length} live transcript lines left after the report`,
          );
          if (linesProblem) c.fail(linesProblem);
        }
      },
    },
  ];
}

function lifecycleKey(c: CaseCtx): string {
  return `${SMOKE_PREFIX}${c.cfg.runId}-lifecycle`;
}

/** Runs the cases in order; a case that throws is a failure, never an abort of the run. */
export async function runSmoke(cfg: SmokeConfig, only?: string[]): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const sc of smokeCases()) {
    if (only && !only.includes(sc.name)) continue;
    const ctx = new CaseCtx(cfg, sc.name);
    try {
      await sc.run(ctx);
    } catch (e) {
      ctx.fail(`threw ${(e as Error).name}: ${(e as Error).message}`);
    }
    out.push({ name: sc.name, pass: ctx.problems.length === 0, requests: ctx.requests, problems: ctx.problems });
  }
  return out;
}

export function sqlDb(sql: ReturnType<typeof sqlClient>): SmokeDb {
  return {
    attempts: (k) =>
      sql(`select tool_name, code from attempts where call_key = ${lit(k)} order by created_at, tool_call_id`),
    escalations: (k) =>
      sql(
        `select kind, reason, alert_status, callback_phone, callback_source, channel from escalations where call_key = ${
          lit(k)
        }`,
      ),
    interaction: async (k) =>
      (await sql<any>(
        `select outcome, ended_at, summary, sentiment, analysis_status from call_interactions where vapi_call_id = ${
          lit(k)
        }`,
      ))[0] ?? null,
    transcriptLines: (k) => sql(`select role, text from transcript_lines where call_key = ${lit(k)} order by ts_ms`),
    contact: async (k) =>
      (await sql<any>(
        `select kind, first_name, last_name, email, confirmed from caller_contacts where call_key = ${lit(k)}`,
      ))[0] ?? null,
    emails: (k) => sql(`select kind, to_masked, status from emails where call_key = ${lit(k)} order by created_at`),
    intake: async (k) =>
      (await sql<any>(
        `select kind, claim_type, loss_date::text as loss_date, claim_number, confirmed, customer_id from claim_intakes where call_key = ${
          lit(k)
        }`,
      ))[0] ?? null,
    phoneClaims: (k) =>
      sql(
        `select customer_id, claim_number, claim_type, status, status_detail, documents_required from claims where reported_call_key = ${
          lit(k)
        }`,
      ),
  };
}

/** Deletes every row any smoke run wrote (this run's and any interrupted earlier run's), the claims
 *  a smoke call filed included; seeded claims have no reported_call_key, so they are never touched. */
export function cleanupSql(prefix = SMOKE_PREFIX): string {
  if (!/^[a-z]+-$/.test(prefix)) throw new Error("cleanup prefix must be a plain word and a dash");
  const like = lit(`${prefix}%`);
  return `with
  d_attempts as (delete from attempts where call_key like ${like} returning 1),
  d_lookup_numbers as (delete from lookup_numbers where call_key like ${like} returning 1),
  d_sessions as (delete from call_sessions where call_key like ${like} returning 1),
  d_escalations as (delete from escalations where call_key like ${like} returning 1),
  d_emails as (delete from emails where call_key like ${like} returning 1),
  d_lines as (delete from transcript_lines where call_key like ${like} returning 1),
  d_interactions as (delete from call_interactions where vapi_call_id like ${like} returning 1),
  d_captures as (delete from webhook_captures where call_key like ${like} returning 1),
  d_contacts as (delete from caller_contacts where call_key like ${like} returning 1),
  d_intakes as (delete from claim_intakes where call_key like ${like} returning 1),
  d_claims as (delete from claims where reported_call_key like ${like} returning 1)
select
  (select count(*) from d_attempts)::int as attempts,
  (select count(*) from d_sessions)::int as call_sessions,
  (select count(*) from d_escalations)::int as escalations,
  (select count(*) from d_emails)::int as emails,
  (select count(*) from d_lines)::int as transcript_lines,
  (select count(*) from d_interactions)::int as call_interactions,
  (select count(*) from d_captures)::int as webhook_captures,
  (select count(*) from d_contacts)::int as caller_contacts,
  (select count(*) from d_intakes)::int as claim_intakes,
  (select count(*) from d_claims)::int as phone_claims`;
}

/** A captured report from fixtures/eocr/full.json, if it is one that needs no backfill (a backfill
 *  would write the row again after the cleanup). */
export function loadEocrFixture(path = new URL("../fixtures/eocr/full.json", import.meta.url)): unknown {
  try {
    const body = JSON.parse(Deno.readTextFileSync(path));
    const m = body?.message;
    const sentiment = m?.analysis?.structuredData?.sentiment;
    if (m?.type === "end-of-call-report" && typeof m?.analysis?.summary === "string" && sentiment) return body;
    console.log("fixtures/eocr/full.json lacks summary or sentiment; using the inline report");
  } catch {
    // no fixture: the inline report is built from the same OpenAPI shape
  }
  return undefined;
}

function runIdNow(d = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function parseArgs(argv: string[]): { only?: string[]; keep: boolean } {
  const args = argv.filter((a) => a !== "--");
  let only: string[] | undefined;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep") keep = true;
    else if (args[i] === "--only" && args[i + 1]) only = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`unknown argument ${args[i]}\nusage: deno task smoke [--only case,case] [--keep]`);
      Deno.exit(2);
    }
  }
  const known = smokeCases().map((c) => c.name);
  const unknown = (only ?? []).filter((n) => !known.includes(n));
  if (unknown.length) {
    console.error(`unknown case ${unknown.join(", ")}; cases: ${known.join(", ")}`);
    Deno.exit(2);
  }
  return { only, keep };
}

async function main(): Promise<number> {
  const { only, keep } = parseArgs(Deno.args);
  const env = loadEnv();
  const [supabaseUrl, secret, orgId] = need(env, "SUPABASE_URL", "VAPI_WEBHOOK_SECRET", "VAPI_ORG_ID");
  const sql = sqlClient(env);
  const runId = runIdNow();
  const url = webhookUrl(supabaseUrl);
  const eocrFixture = loadEocrFixture();
  console.log(`smoke run ${runId} against ${url}${eocrFixture ? " (end-of-call-report from fixtures/eocr)" : ""}`);

  let results: CaseResult[] = [];
  try {
    const ownerEmail = typeof env.OWNER_EMAIL === "string" && env.OWNER_EMAIL.trim()
      ? env.OWNER_EMAIL.trim()
      : undefined;
    results = await runSmoke({ target: { url, secret }, orgId, runId, db: sqlDb(sql), eocrFixture, ownerEmail }, only);
  } finally {
    if (keep) {
      console.log(`--keep: rows for ${SMOKE_PREFIX}${runId}-* left in place`);
    } else {
      // Background writes (waitUntil) land within a moment; deleting earlier could race them.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      try {
        const [counts] = await sql<Record<string, number>>(cleanupSql());
        const parts = Object.entries(counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
        console.log(`cleanup: deleted ${parts}`);
      } catch (e) {
        console.error(`cleanup FAILED: ${(e as Error).message}`);
        results.push({ name: "cleanup", pass: false, requests: 0, problems: [(e as Error).message] });
      }
    }
  }

  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name} (${r.requests} request${r.requests === 1 ? "" : "s"})`);
    for (const p of r.problems) console.log(`      ${p}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} cases passed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
