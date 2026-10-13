import { assert, assertEquals, assertFalse, assertInstanceOf, assertMatch, assertStringIncludes } from "@std/assert";
import {
  callbackRequestEmail,
  claimSummaryEmail,
  digestEmail,
  documentChecklistEmail,
  emergencyEmail,
  escapeHtml,
  howToStartEmail,
  loadEscalationContact,
  loadTeamCaller,
  maskEmail,
  sendEmail,
  slaRealertEmail,
  type TeamCaller,
  teamCallerOf,
  writtenDate,
} from "./email.ts";
import { createFakeStore } from "./fake_store.ts";
import type { CallerContact, Claim, Customer, Deps, Env, Store } from "./types.ts";

const API_KEY = "re_test_key_123";
const TO = "owner@example.com";
const CALL_KEY = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DASHBOARD = "https://ops.observe.test/claims/";
// printable ASCII plus the whitespace HTML uses
const ASCII_ONLY = /^[\t\n\r -~]*$/;

interface Recorded {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
    return await respond(String(input), init ?? {});
  }) as typeof fetch;
  return { fetchFn, calls };
}

const hangingFetch =
  ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;

function makeDeps(env: Partial<Env>, fetchFn: typeof fetch): Deps {
  return {
    store: {} as Store,
    fetch: fetchFn,
    env: { VAPI_ORG_ID: "org", VAPI_WEBHOOK_SECRET: "secret", ...env },
    now: () => new Date("2026-10-12T15:00:00Z"),
    waitUntil: () => {},
    log: () => {},
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MSG = {
  to: TO,
  subject: "Your Observe Insurance claim summary",
  html: "<p>Hello</p>",
  idempotencyKey: `${CALL_KEY}:claim_summary`,
};

// ---------------------------------------------------------------------------------------------
// Fixtures shaped like the seeded demo rows (0002_seed.sql).
// ---------------------------------------------------------------------------------------------
const TOBIAS: Customer = {
  id: "6b0d6f0e-1c11-4c7a-9a01-000000000101",
  phone_e164: "+16025550101",
  first_name: "Tobias",
  last_name: "Halvorsen",
  policy_number: "POL-7301",
  email: TO,
};

function claim(over: Partial<Claim>): Claim {
  return {
    id: crypto.randomUUID(),
    customer_id: TOBIAS.id,
    claim_number: "CLM-000000",
    claim_type: "auto",
    status: "received",
    status_detail: null,
    documents_required: [],
    documents_due: null,
    adjuster_name: null,
    filed_on: "2026-09-02",
    updated_on: "2026-10-08",
    amount_approved: null,
    ...over,
  };
}

const PAID = claim({
  claim_number: "CLM-240115",
  claim_type: "auto",
  status: "payment_issued",
  status_detail: "Payment issued by direct deposit",
  adjuster_name: "Leona Fairbanks",
  filed_on: "2026-09-02",
  updated_on: "2026-10-08",
  amount_approved: 4820,
});
const WAITING = claim({
  claim_number: "CLM-240198",
  claim_type: "home",
  status: "awaiting_documents",
  status_detail: "Water damage in the kitchen; review is paused until the documents arrive",
  documents_required: ["photos of the damage", "a contractor estimate", "proof of ownership for the damaged items"],
  documents_due: "2026-10-24",
  adjuster_name: "Leona Fairbanks",
  filed_on: "2026-09-28",
  updated_on: "2026-10-06",
});

// ---------------------------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------------------------
Deno.test("sendEmail: missing RESEND_API_KEY never fetches", async () => {
  for (const env of [{}, { RESEND_API_KEY: "" }, { RESEND_API_KEY: "   " }]) {
    const { fetchFn, calls } = recordingFetch(() => json({ id: "x" }));
    assertEquals(await sendEmail(makeDeps(env, fetchFn), MSG), { ok: false, error: "resend not configured" });
    assertEquals(calls.length, 0);
  }
});

Deno.test("sendEmail: request carries Bearer, JSON, the exact Idempotency-Key and the default sender", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
  const got = await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), MSG);
  assertEquals(got, { ok: true, id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
  assertEquals(calls.length, 1);
  const { url, init } = calls[0];
  assertEquals(url, "https://api.resend.com/emails");
  assertEquals(init.method, "POST");
  const headers = new Headers(init.headers);
  assertEquals(headers.get("authorization"), `Bearer ${API_KEY}`);
  assertEquals(headers.get("content-type"), "application/json");
  assertEquals(headers.get("idempotency-key"), `${CALL_KEY}:claim_summary`);
  assertEquals(JSON.parse(String(init.body)), {
    from: "onboarding@resend.dev",
    to: [TO],
    subject: MSG.subject,
    html: MSG.html,
  });
  assertInstanceOf(init.signal, AbortSignal);
});

Deno.test("sendEmail: RESEND_FROM_EMAIL overrides the sender", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ id: "abc" }));
  const deps = makeDeps(
    { RESEND_API_KEY: API_KEY, RESEND_FROM_EMAIL: "Observe Claims <claims@observe.test>" },
    fetchFn,
  );
  await sendEmail(deps, { ...MSG, to: `  ${TO} ` });
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.from, "Observe Claims <claims@observe.test>");
  assertEquals(body.to, [TO]);
});

Deno.test("sendEmail: a real template produces an ASCII-only request body", async () => {
  const { fetchFn, calls } = recordingFetch(() => json({ id: "abc" }));
  const customer = { ...TOBIAS, first_name: "Jos\u00e9" };
  const { subject, html } = documentChecklistEmail({ customer, claims: [PAID, WAITING] });
  const got = await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), {
    to: TO,
    subject,
    html,
    idempotencyKey: `${CALL_KEY}:document_checklist`,
  });
  assert(got.ok);
  const raw = String(calls[0].init.body);
  assertMatch(raw, ASCII_ONLY);
  assertStringIncludes(raw, "Jos&#233;");
  assertEquals(new Headers(calls[0].init.headers).get("idempotency-key"), `${CALL_KEY}:document_checklist`);
});

Deno.test("sendEmail: 2xx without an id is not a send", async () => {
  for (const response of [json({}), json({ id: "" }), json({ id: 42 }), new Response("ok", { status: 200 })]) {
    const { fetchFn } = recordingFetch(() => response);
    const got = await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), MSG);
    assertEquals(got, { ok: false, status: 200, error: "resend 200: missing id" });
  }
});

Deno.test("sendEmail: 4xx and 5xx -> ok false with status and Resend's message", async () => {
  const cases: [Response, number, string][] = [
    [
      json({ statusCode: 422, name: "validation_error", message: "Invalid `to` field." }, 422),
      422,
      "resend 422: Invalid `to` field.",
    ],
    [
      json({ statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." }, 401),
      401,
      "resend 401: Missing API key in the authorization header.",
    ],
    [
      json({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." }, 429),
      429,
      "resend 429: Too many requests.",
    ],
    [
      json({
        statusCode: 409,
        name: "invalid_idempotent_request",
        message: "Same idempotency key used with a different request payload.",
      }, 409),
      409,
      "resend 409: Same idempotency key used with a different request payload.",
    ],
    [
      json({ statusCode: 500, name: "internal_server_error", message: "An unexpected error occurred." }, 500),
      500,
      "resend 500: An unexpected error occurred.",
    ],
    [
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      502,
      "resend 502: Bad Gateway",
    ],
    [new Response("", { status: 503 }), 503, "resend 503: error"],
  ];
  for (const [response, status, error] of cases) {
    const { fetchFn } = recordingFetch(() => response);
    assertEquals(await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), MSG), { ok: false, status, error });
  }
});

Deno.test("sendEmail: an error quoting the recipient is stored masked", async () => {
  const { fetchFn } = recordingFetch(() =>
    json({
      statusCode: 403,
      name: "validation_error",
      message:
        `You can only send testing emails to your own email address (${TO}). To send to other recipients, verify a domain.`,
    }, 403)
  );
  const got = await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), {
    ...MSG,
    to: "tobias.halvorsen@example.com",
  });
  assertFalse(got.ok);
  if (!got.ok) {
    assertEquals(got.status, 403);
    assertFalse(got.error.includes(TO));
    assertStringIncludes(got.error, "(o***@example.com)");
  }
});

Deno.test("sendEmail: timeout -> ok false, error 'timeout', no status", async () => {
  const started = Date.now();
  assertEquals(await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, hangingFetch), MSG, 20), {
    ok: false,
    error: "timeout",
  });
  assert(Date.now() - started < 2000);
});

Deno.test("sendEmail: a network error never throws", async () => {
  const fetchFn = (() => {
    throw new TypeError("error sending request for url (https://api.resend.com/emails): connection refused");
  }) as typeof fetch;
  const got = await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), MSG);
  assertFalse(got.ok);
  if (!got.ok) {
    assertEquals(got.status, undefined);
    assert(got.error.startsWith("resend request failed: TypeError"), got.error);
    assertFalse(got.error.includes(API_KEY));
  }
});

Deno.test("sendEmail: refuses a bad recipient or idempotency key without fetching", async () => {
  const bad = [
    { ...MSG, to: "" },
    { ...MSG, to: "not an address" },
    { ...MSG, to: "a@b" },
    { ...MSG, to: "one@example.com, two@example.com" },
    { ...MSG, idempotencyKey: "" },
    { ...MSG, idempotencyKey: "has space:claim_summary" },
    { ...MSG, idempotencyKey: "k".repeat(257) },
    { ...MSG, idempotencyKey: undefined as unknown as string },
  ];
  for (const msg of bad) {
    const { fetchFn, calls } = recordingFetch(() => json({ id: "x" }));
    const got = await sendEmail(makeDeps({ RESEND_API_KEY: API_KEY }, fetchFn), msg);
    assertFalse(got.ok, JSON.stringify(msg));
    assertEquals(calls.length, 0, JSON.stringify(msg));
  }
});

Deno.test("maskEmail", () => {
  assertEquals(maskEmail("owner@example.com"), "o***@example.com");
  assertEquals(maskEmail("  owner+claims@example.com "), "o***@example.com");
  assertEquals(maskEmail("a@b.co"), "a***@b.co");
  assertEquals(maskEmail("@example.com"), "***@example.com");
  assertEquals(maskEmail("no-at-sign"), "***");
  assertEquals(maskEmail(""), "***");
  assertEquals(maskEmail(null as unknown as string), "***");
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
Deno.test("writtenDate: by hand, timezone-independent", () => {
  assertEquals(writtenDate("2026-10-24"), "October 24, 2026");
  assertEquals(writtenDate("2026-01-01"), "January 1, 2026");
  assertEquals(writtenDate("2028-02-29"), "February 29, 2028");
  assertEquals(writtenDate("2026-10-08T00:00:00Z"), "October 8, 2026");
  for (const bad of [null, undefined, "", "2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "10/24/2026"]) {
    assertEquals(writtenDate(bad), null, String(bad));
  }
});

Deno.test("escapeHtml: markup is escaped and the output is ASCII", () => {
  assertEquals(
    escapeHtml(`<b onclick="x">Tom & 'Jerry'</b>`),
    "&lt;b onclick=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/b&gt;",
  );
  assertEquals(escapeHtml("Jos\u00e9 \u2014 caf\u00e9 \u{1F600}"), "Jos&#233; &#8212; caf&#233; &#128512;");
  assertEquals(escapeHtml("a\u0000b\u0007c\u0085d"), "abcd");
  assertEquals(escapeHtml(null), "");
});

// ---------------------------------------------------------------------------------------------
// Customer templates
// ---------------------------------------------------------------------------------------------
function assertAsciiTemplate(t: { subject: string; html: string }) {
  assertMatch(t.subject, ASCII_ONLY);
  assertMatch(t.html, ASCII_ONLY);
  assert(t.subject.trim().length > 0);
  assertStringIncludes(t.html, "<!doctype html>");
}

Deno.test("documentChecklistEmail: documents, due date, the three ways to send and the claim number", () => {
  const t = documentChecklistEmail({ customer: TOBIAS, claims: [PAID, WAITING] });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "Documents needed for claim CLM-240198");
  assertStringIncludes(t.html, "Hello Tobias,");
  for (const doc of ["Photos of the damage", "A contractor estimate", "Proof of ownership for the damaged items"]) {
    assertStringIncludes(t.html, doc);
  }
  assertStringIncludes(t.html, "Please send them by October 24, 2026.");
  assertStringIncludes(t.html, "CLM-240198");
  assertStringIncludes(t.html, "Upload them at observeinsurance.com/claims");
  assertStringIncludes(t.html, "Email them to claimsdocs@observeinsurance.com");
  assertStringIncludes(
    t.html,
    "Mail them to Observe Insurance Claims Department, 100 Market Street, Suite 400, San Francisco, CA 94105",
  );
  assertStringIncludes(t.html, "please include your claim number, CLM-240198,");
  // only the claim that is waiting for documents is listed
  assertFalse(t.html.includes("CLM-240115"));
  // never the account's phone number or date of birth
  assertFalse(t.html.includes("602"));
  assertFalse(t.html.includes("1986"));
});

Deno.test("documentChecklistEmail: several waiting claims each list their own documents", () => {
  const second = claim({
    claim_number: "CLM-240301",
    claim_type: "property",
    status: "awaiting_documents",
    documents_required: ["a police report"],
    documents_due: "2026-11-02",
  });
  const t = documentChecklistEmail({ customer: TOBIAS, claims: [WAITING, second] });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "Documents needed for your claims");
  for (
    const s of [
      "CLM-240198",
      "CLM-240301",
      "A police report",
      "November 2, 2026",
      "October 24, 2026",
      "CLM-240198 or CLM-240301",
    ]
  ) {
    assertStringIncludes(t.html, s);
  }
});

Deno.test("documentChecklistEmail: honest when nothing is outstanding or the list is missing", () => {
  const none = documentChecklistEmail({ customer: TOBIAS, claims: [PAID] });
  assertAsciiTemplate(none);
  assertStringIncludes(none.html, "nothing you need to send");
  assertStringIncludes(none.html, "observeinsurance.com/claims");

  const noList = documentChecklistEmail({
    customer: TOBIAS,
    claims: [
      claim({ claim_number: "CLM-240400", status: "awaiting_documents", documents_required: [], documents_due: null }),
    ],
  });
  assertStringIncludes(noList.html, "We do not have the document list on file yet");
  assertStringIncludes(noList.html, "1-800-555-0142");
  assertFalse(noList.html.includes("Please send them by"));
});

Deno.test("claimSummaryEmail: every claim status in plain words", () => {
  const claims = [
    claim({
      claim_number: "CLM-100001",
      claim_type: "home",
      status: "received",
      filed_on: "2026-10-10",
      updated_on: "2026-10-10",
    }),
    claim({
      claim_number: "CLM-100002",
      status: "under_review",
      adjuster_name: "Bertrand Wexley",
      status_detail: "A decision is expected within 5 business days",
    }),
    WAITING,
    claim({ claim_number: "CLM-100004", status: "approved", amount_approved: 1250.5 }),
    PAID,
    claim({
      claim_number: "CLM-100006",
      claim_type: "property",
      status: "denied",
      status_detail: "The item class is not covered by the policy; there is a 30-day appeal window",
    }),
    claim({ claim_number: "CLM-100007", status: "closed" }),
  ];
  const t = claimSummaryEmail({ customer: TOBIAS, claims });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "Your Observe Insurance claim summary");
  for (const c of claims) assertStringIncludes(t.html, c.claim_number);
  const expected = [
    "Status: Received.",
    "We received your claim on October 10, 2026. It is waiting for an adjuster to be assigned.",
    "Status: Under review.",
    "Your claim is under review with your adjuster, Bertrand Wexley.",
    "A decision is expected within 5 business days.",
    "Status: Waiting for documents from you.",
    "Photos of the damage",
    "Please send them by October 24, 2026.",
    "Status: Approved.",
    "Your claim was approved for $1,250.50.",
    "Status: Payment issued.",
    "Your claim was approved, and a payment of $4,820.00 was issued on October 8, 2026.",
    "Status: Denied.",
    "The reason given: The item class is not covered by the policy; there is a 30-day appeal window.",
    "You have 30 days to appeal.",
    "Status: Closed.",
    "This claim is closed.",
    "How to send your documents",
    "claimsdocs@observeinsurance.com",
  ];
  for (const s of expected) assertStringIncludes(t.html, escapeHtml(s));
  assertStringIncludes(t.html, "the 7 claims on your account");
});

Deno.test("claimSummaryEmail: no claims, and a summary without waiting claims has no send instructions", () => {
  const none = claimSummaryEmail({ customer: TOBIAS, claims: [] });
  assertAsciiTemplate(none);
  assertStringIncludes(none.html, "any claims on file");
  assertStringIncludes(none.html, "1-800-555-0142");

  const paidOnly = claimSummaryEmail({ customer: TOBIAS, claims: [PAID] });
  assertStringIncludes(paidOnly.html, "the claim on your account");
  assertFalse(paidOnly.html.includes("How to send your documents"));
});

Deno.test("claimSummaryEmail: DB text is escaped, never interpreted", () => {
  const hostile = claim({
    claim_number: "CLM-<b>1</b>",
    status: "under_review",
    adjuster_name: "<script>alert(1)</script>",
    status_detail: `Estimate "A" & "B" <img src=x onerror=alert(1)>`,
  });
  const t = claimSummaryEmail({ customer: { ...TOBIAS, first_name: "<i>Tobias</i>" }, claims: [hostile] });
  assertAsciiTemplate(t);
  assertFalse(t.html.includes("<script>"));
  assertFalse(t.html.includes("<img"));
  assertFalse(t.html.includes("<i>Tobias"));
  assertFalse(t.html.includes("<b>1</b>"));
  assertStringIncludes(t.html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(t.html, "&quot;A&quot; &amp; &quot;B&quot;");
});

Deno.test("howToStartEmail: three ways, what to have ready, the five-step process", () => {
  const t = howToStartEmail({ customer: TOBIAS });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "How to start a claim with Observe Insurance");
  for (
    const s of [
      "observeinsurance.com/claims",
      "mobile app",
      "1-800-555-0142",
      "POL-7301",
      "date of the loss",
      "short description",
    ]
  ) {
    assertStringIncludes(t.html, s);
  }
  const steps = /<ol>(.*?)<\/ol>/s.exec(t.html)?.[1] ?? "";
  assertEquals(steps.match(/<li>/g)?.length, 5);
  for (const s of ["filed", "review", "adjuster is assigned", "documents", "decision"]) assertStringIncludes(steps, s);
  assertStringIncludes(t.html, "10 business days");

  const noPolicy = howToStartEmail({ customer: { ...TOBIAS, policy_number: "" } });
  assertStringIncludes(noPolicy.html, "Your policy number</li>");
});

// ---------------------------------------------------------------------------------------------
// Team templates
// ---------------------------------------------------------------------------------------------
Deno.test("callbackRequestEmail: call id, reason, verified flag, callback number, redacted details, link", () => {
  const t = callbackRequestEmail({
    callKey: CALL_KEY,
    reason: "representative_requested",
    verified: false,
    callbackPhone: "+16025550101",
    details: "Caller born March 14, 1986 asked about a second number 602-555-0199 and CLM-240198",
    channel: "webCall",
    dashboardUrl: DASHBOARD,
  });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "Callback requested: call 1a2b3c4d");
  assertStringIncludes(t.html, CALL_KEY);
  assertStringIncludes(t.html, "representative_requested");
  assertStringIncludes(t.html, "UNVERIFIED: do not disclose claim details.");
  assertMatch(t.html, /Identity verified<\/th><td[^>]*>No</);
  assertStringIncludes(t.html, "(602) 555-0101 (+16025550101)");
  assertStringIncludes(t.html, "[date of birth]");
  assertStringIncludes(t.html, "[phone ending 0199]");
  assertFalse(t.html.includes("March 14, 1986"));
  assertFalse(t.html.includes("602-555-0199"));
  assertStringIncludes(t.html, "CLM-240198");
  assertStringIncludes(t.html, `href="${DASHBOARD}#/calls/${CALL_KEY}"`);
  assertStringIncludes(t.html, "webCall");
});

Deno.test("callbackRequestEmail: verified caller, no number yet, no details, no dashboard", () => {
  const t = callbackRequestEmail({
    callKey: CALL_KEY,
    reason: "unsupported_question",
    verified: true,
    callbackPhone: null,
    details: null,
    channel: "inboundPhoneCall",
  });
  assertAsciiTemplate(t);
  assertFalse(t.html.includes("UNVERIFIED"));
  assertMatch(t.html, /Identity verified<\/th><td[^>]*>Yes</);
  assertStringIncludes(t.html, "None given yet");
  assertStringIncludes(t.html, "Dashboard link not configured.");
  assertStringIncludes(t.html, "unsupported_question");
});

Deno.test("emergencyEmail: header, call id, redacted note, link", () => {
  const t = emergencyEmail({
    callKey: CALL_KEY,
    note: "Caller at 602 555 0101 says there is smoke in the kitchen <now>",
    channel: "webCall",
    dashboardUrl: DASHBOARD,
  });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "POSSIBLE EMERGENCY REPORTED: call 1a2b3c4d");
  assertStringIncludes(t.html, "POSSIBLE EMERGENCY REPORTED");
  assertStringIncludes(t.html, CALL_KEY);
  assertStringIncludes(t.html, "[phone ending 0101]");
  assertStringIncludes(t.html, "&lt;now&gt;");
  assertFalse(t.html.includes("602 555 0101"));
  assertStringIncludes(t.html, `${DASHBOARD}#/calls/${CALL_KEY}`);
  const bare = emergencyEmail({ callKey: CALL_KEY, note: null, channel: "webCall" }).html;
  assertStringIncludes(bare, "No note given");
  assertMatch(bare, /Identity verified<\/th><td[^>]*>No</);
  assertStringIncludes(bare, "None known (check the dashboard)");
});

Deno.test("emergencyEmail: the verified flag and the known callback number reach the team", () => {
  const t = emergencyEmail({
    callKey: CALL_KEY,
    note: null,
    channel: "inboundPhoneCall",
    verified: true,
    callbackPhone: "+16025550101",
  });
  assertAsciiTemplate(t);
  assertMatch(t.html, /Identity verified<\/th><td[^>]*>Yes</);
  assertStringIncludes(t.html, "(602) 555-0101 (+16025550101)");
});

Deno.test("slaRealertEmail: minutes open, kind, reason, link", () => {
  const t = slaRealertEmail({
    callKey: CALL_KEY,
    kind: "representative",
    reason: "auth_locked",
    minutesOpen: 42.4,
    dashboardUrl: DASHBOARD,
  });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "Still unclaimed after 42 minutes: representative call 1a2b3c4d");
  assertStringIncludes(t.html, "open for 42 minutes and nobody has claimed it");
  assertStringIncludes(t.html, "auth_locked");
  assertStringIncludes(t.html, `${DASHBOARD}#/calls/${CALL_KEY}`);
  const odd = slaRealertEmail({ callKey: CALL_KEY, kind: "emergency", reason: "emergency", minutesOpen: Number.NaN });
  assertStringIncludes(odd.html, "open for a while");
  assertEquals(odd.subject, "Still unclaimed: emergency call 1a2b3c4d");
});

Deno.test("digestEmail: stats table, nested values, redaction and escaping", () => {
  const t = digestEmail({
    date: "2026-10-12",
    stats: {
      calls_total: 14,
      escalations_open: 2,
      emails_failed: 0,
      verified_rate: 0.71,
      by_outcome: { resolved: 9, escalated: 3, auth_failed: 2 },
      flagged_calls: ["call-1", "call-2"],
      note: "Callback for 602-555-0101 <pending>",
      healthy: true,
    },
  });
  assertAsciiTemplate(t);
  assertEquals(t.subject, "Observe Claims daily digest: 2026-10-12");
  for (
    const s of [
      "Calls total",
      "14",
      "Escalations open",
      "0.71",
      "By outcome",
      "Resolved",
      "Auth failed",
      "call-2",
      "Yes",
    ]
  ) {
    assertStringIncludes(t.html, s);
  }
  assertStringIncludes(t.html, "[phone ending 0101]");
  assertStringIncludes(t.html, "&lt;pending&gt;");
  assertFalse(t.html.includes("602-555-0101"));
  assertStringIncludes(digestEmail({ date: "2026-10-12", stats: {} }).html, "No activity was recorded.");
});

// ---------------------------------------------------------------------------------------------
// Who called: the team emails name the caller, the full callback number and a spelled address.
// ---------------------------------------------------------------------------------------------
const JANE: CallerContact = {
  call_key: CALL_KEY,
  kind: "new_customer",
  first_name: "Jane",
  last_name: "Doe",
  email: "jane.doe@gmail.com",
  callback_phone: "+16025550177",
  callback_source: "argument",
  customer_id: null,
  confirmed: true,
  confirmed_at: "2026-10-12T15:00:00Z",
};

Deno.test("teamCallerOf: the verified name, else the confirmed given name, else unknown; only a confirmed address", () => {
  assertEquals(teamCallerOf(TOBIAS, null), {
    name: "Tobias Halvorsen",
    nameSource: "account",
    email: null,
  });
  assertEquals(teamCallerOf(null, JANE), {
    name: "Jane Doe",
    nameSource: "caller",
    email: "jane.doe@gmail.com",
  });
  // a verified customer's pending address is passed on, labelled as theirs to confirm
  assertEquals(
    teamCallerOf(TOBIAS, {
      ...JANE,
      kind: "email_update",
      first_name: "Tobias",
      last_name: "Halvorsen",
    }),
    {
      name: "Tobias Halvorsen",
      nameSource: "account",
      email: "jane.doe@gmail.com",
    },
  );
  // what the caller said "no" to is not passed on
  assertEquals(
    teamCallerOf(null, { ...JANE, confirmed: false, confirmed_at: null }),
    {
      name: null,
      nameSource: null,
      email: null,
    },
  );
  assertEquals(teamCallerOf(null, null), {
    name: null,
    nameSource: null,
    email: null,
  });
});

Deno.test("loadTeamCaller: reads the session's customer and the contact; a failed read costs only the name", async () => {
  const store = createFakeStore();
  await store.upsertContact({
    callKey: CALL_KEY,
    kind: "new_customer",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@gmail.com",
    callbackPhone: null,
    callbackSource: "none",
    customerId: null,
  });
  await store.setContactConfirmed(CALL_KEY, true);
  assertEquals((await loadTeamCaller(store, CALL_KEY, null)).name, "Jane Doe");
  const verified = {
    call_key: CALL_KEY,
    channel: "webCall",
    caller_number: null,
    level: "verified" as const,
    candidate_customer_id: TOBIAS.id,
    verified_customer_id: TOBIAS.id,
  };
  assertEquals(
    (await loadTeamCaller(store, CALL_KEY, verified)).name,
    "Tobias Halvorsen",
  );
  store.failNext("getContact");
  store.failNext("getCustomer");
  assertEquals(await loadTeamCaller(store, CALL_KEY, verified), {
    name: null,
    nameSource: null,
    email: null,
  });
  assertEquals(await loadTeamCaller({} as Store, CALL_KEY, null), {
    name: null,
    nameSource: null,
    email: null,
  });
});

Deno.test("callbackRequestEmail and emergencyEmail: name, full callback number and the labelled email", () => {
  const caller: TeamCaller = {
    name: "Jane <Doe>",
    nameSource: "caller",
    email: "jane.doe@gmail.com",
  };
  const base = {
    callKey: CALL_KEY,
    channel: "webCall",
    dashboardUrl: DASHBOARD,
  };
  for (
    const t of [
      callbackRequestEmail({
        ...base,
        reason: "not_found",
        verified: false,
        callbackPhone: "+16025550177",
        details: null,
        caller,
      }),
      emergencyEmail({
        ...base,
        note: null,
        callbackPhone: "+16025550177",
        caller,
      }),
    ]
  ) {
    assertAsciiTemplate(t);
    assertMatch(
      t.html,
      /Caller name<\/th><td[^>]*>Jane &lt;Doe&gt; \(caller-provided, unverified\)</,
    );
    assertStringIncludes(t.html, "(602) 555-0177 (+16025550177)");
    assertMatch(
      t.html,
      /Email \(caller-provided, unverified\)<\/th><td[^>]*>jane\.doe@gmail\.com</,
    );
  }
  const verified = callbackRequestEmail({
    ...base,
    reason: "representative_requested",
    verified: true,
    callbackPhone: "+16025550101",
    details: null,
    caller: { name: "Tobias Halvorsen", nameSource: "account", email: null },
  });
  assertMatch(verified.html, /Caller name<\/th><td[^>]*>Tobias Halvorsen</);
  assertFalse(verified.html.includes("caller-provided"));
  // no caller given: an unknown caller, and no email row
  const bare = callbackRequestEmail({
    ...base,
    reason: "representative_requested",
    verified: false,
    callbackPhone: null,
    details: null,
  });
  assertMatch(bare.html, /Caller name<\/th><td[^>]*>Unknown caller</);
  assertFalse(bare.html.includes("Email (caller-provided"));
  assertMatch(
    emergencyEmail({ ...base, note: null }).html,
    /Caller name<\/th><td[^>]*>Unknown caller</,
  );
});

Deno.test("slaRealertEmail: the caller and the callback number when the job passes them", () => {
  const t = slaRealertEmail({
    callKey: CALL_KEY,
    kind: "representative",
    reason: "not_found",
    minutesOpen: 31,
    caller: {
      name: "Jane Doe",
      nameSource: "caller",
      email: "jane.doe@gmail.com",
    },
    callbackPhone: "+16025550177",
  });
  assertAsciiTemplate(t);
  assertStringIncludes(t.html, "Jane Doe (caller-provided, unverified)");
  assertStringIncludes(t.html, "(602) 555-0177 (+16025550177)");
  assertStringIncludes(t.html, "jane.doe@gmail.com");
  const noNumber = slaRealertEmail({
    callKey: CALL_KEY,
    kind: "emergency",
    reason: "emergency",
    minutesOpen: 40,
    callbackPhone: null,
  });
  assertStringIncludes(noNumber.html, "None known (check the dashboard)");
  // without them the re-alert is the same as before
  const plain = slaRealertEmail({
    callKey: CALL_KEY,
    kind: "emergency",
    reason: "emergency",
    minutesOpen: 40,
  });
  assertFalse(plain.html.includes("Caller name"));
  assertFalse(plain.html.includes("Callback number"));
});

Deno.test("howToStartEmail for a new caller: greeted by the given first name, nothing from any account", () => {
  const t = howToStartEmail({
    customer: { first_name: "Jane" },
    newCustomer: true,
  });
  assertAsciiTemplate(t);
  assertStringIncludes(t.html, "Hello Jane,");
  assertStringIncludes(t.html, "Thanks for calling Observe Insurance.");
  assertStringIncludes(t.html, "Your policy number, if you have one");
  // a policy number handed in by mistake is still left out of a new caller's copy
  const leaked = howToStartEmail({
    customer: { first_name: "Jane", policy_number: "POL-7301" },
    newCustomer: true,
  });
  assertFalse(leaked.html.includes("POL-7301"));
  assertStringIncludes(
    howToStartEmail({ customer: {}, newCustomer: true }).html,
    "Hello,",
  );
});

Deno.test("loadEscalationContact: the caller and the escalation's own callback number, for the sla re-alert", async () => {
  const store = createFakeStore();
  await store.ensureSession(CALL_KEY, "webCall", null);
  await store.upsertEscalation({
    callKey: CALL_KEY,
    kind: "representative",
    reason: "not_found",
    details: null,
    callbackPhone: "+16025550177",
    callbackSource: "argument",
    channel: "webCall",
    verified: false,
  });
  await store.upsertContact({
    callKey: CALL_KEY,
    kind: "new_customer",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@gmail.com",
    callbackPhone: "+16025550177",
    callbackSource: "argument",
    customerId: null,
  });
  await store.setContactConfirmed(CALL_KEY, true);
  const found = await loadEscalationContact(store, CALL_KEY, "representative");
  assertEquals(found, {
    caller: {
      name: "Jane Doe",
      nameSource: "caller",
      email: "jane.doe@gmail.com",
    },
    callbackPhone: "+16025550177",
  });
  assertEquals(
    (await loadEscalationContact(store, CALL_KEY, "emergency")).callbackPhone,
    null,
  );
  store.failNext("listEscalations");
  const failed = await loadEscalationContact(store, CALL_KEY, "representative");
  assertEquals([failed.callbackPhone, failed.caller.name], [null, "Jane Doe"]);
});
