import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { CLAIM_STATUSES, type Code, CODES, MAIN_LINE_SPOKEN } from "./enums.ts";
import type { Claim } from "./types.ts";
import {
  assertSpeakable,
  claimsSentence,
  MAX_SPOKEN_CHARS,
  numberToWords,
  sentenceFor,
  speakDate,
  speakDigits,
  speakEmail,
  speakLossDate,
  speakMoney,
  speakPhone,
  spokenName,
  verifiedFileClaimSentence,
  verifiedStatusSentence,
  withoutTrailingQuestion,
} from "./speak.ts";

// The demo claims exactly as 0002_seed.sql writes them.
const TOBIAS = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
const SEED_CLAIMS: Claim[] = [
  {
    id: "c-115",
    customer_id: TOBIAS,
    claim_number: "CLM-240115",
    claim_type: "auto",
    status: "payment_issued",
    status_detail: "Payment issued by direct deposit",
    documents_required: [],
    documents_due: null,
    adjuster_name: "Leona Fairbanks",
    filed_on: "2026-09-02",
    updated_on: "2026-10-08",
    amount_approved: 4820,
  },
  {
    id: "c-198",
    customer_id: TOBIAS,
    claim_number: "CLM-240198",
    claim_type: "home",
    status: "awaiting_documents",
    status_detail: "Water damage in the kitchen; review is paused until the documents arrive",
    documents_required: ["photos of the damage", "a contractor estimate", "proof of ownership for the damaged items"],
    documents_due: "2026-10-24",
    adjuster_name: "Leona Fairbanks",
    filed_on: "2026-09-28",
    updated_on: "2026-10-06",
    amount_approved: null,
  },
  {
    id: "c-211",
    customer_id: "6b0d6f0e-1c11-4c7a-9a01-000000000102",
    claim_number: "CLM-240211",
    claim_type: "auto",
    status: "under_review",
    status_detail: "A decision is expected within 5 business days",
    documents_required: [],
    documents_due: null,
    adjuster_name: "Bertrand Wexley",
    filed_on: "2026-10-01",
    updated_on: "2026-10-09",
    amount_approved: null,
  },
  {
    id: "c-177",
    customer_id: "6b0d6f0e-1c11-4c7a-9a01-000000000103",
    claim_number: "CLM-240177",
    claim_type: "property",
    status: "denied",
    status_detail: "The item class is not covered by the policy; there is a 30-day appeal window",
    documents_required: [],
    documents_due: null,
    adjuster_name: "Leona Fairbanks",
    filed_on: "2026-09-15",
    updated_on: "2026-10-03",
    amount_approved: null,
  },
  {
    id: "c-230",
    customer_id: "6b0d6f0e-1c11-4c7a-9a01-000000000104",
    claim_number: "CLM-240230",
    claim_type: "home",
    status: "received",
    status_detail: "Received and waiting for an adjuster to be assigned",
    documents_required: [],
    documents_due: null,
    adjuster_name: null,
    filed_on: "2026-10-10",
    updated_on: "2026-10-10",
    amount_approved: null,
  },
];
const TODAY = "2026-10-12";
const byNumber = (n: string) => SEED_CLAIMS.filter((c) => c.claim_number === n);

// Data variants that exercise every dynamic branch of sentenceFor.
const VARIANTS: [Code, Record<string, unknown> | undefined][] = [
  ...CODES.map((c): [Code, undefined] => [c, undefined]),
  ["not_found", { digits: "6025550199" }],
  ["verified", { first_name: "Tobias" }],
  ["not_verified", { level: "none" }],
  ["not_verified", { level: "phone_found" }],
  ["not_verified", { level: "locked" }],
  ["ok", { claims: byNumber("CLM-240115"), refDate: TODAY }],
  ["rep_queued", { target: "account" }],
  ["rep_queued", { target: "given", digits: "6025550101" }],
  ["rep_queued", { target: "caller_id" }],
  ["callback_updated", { digits: "6025550101" }],
  ["emergency_logged", { db_failed: true }],
  ["email_sent", { target: "given" }],
  ["contact_readback", { first_name: "Jane", last_name: "Doe", email: "jane.doe42@gmail.com" }],
  ["contact_readback", { first_name: "Jane", last_name: "Doe" }],
  ["contact_readback", { first_name: "{{name}}", last_name: "Doe", email: "jane@example.com" }],
  ["contact_readback", { first_name: "Jane", last_name: "Doe", email: "not an address" }],
  ["contact_retry", { has_email: false }],
  ["contact_retry", { has_email: true, has_phone: true }],
  ["contact_retry", { part: "email" }],
  ["contact_readback", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe42@gmail.com",
    callback_phone: "+16025550177",
  }],
  ["not_pending", { verified: true }],
  ["contact_saved_new", { first_name: "Jane" }],
  ["contact_saved_new", { first_name: "Jane", has_email: false }],
  ["contact_saved_new", { first_name: "Jane", resume_claim: true }],
  ["contact_saved_existing", { first_name: "Teague" }],
  ["claim_readback", { claim_type: "auto", loss_date: "2026-10-10", summary: "a cracked windshield", today: TODAY }],
  ["claim_readback", { claim_type: "home", loss_date: "2025-12-24", today: TODAY }],
  ["claim_readback", { claim_type: "property", loss_date: "2026-10-10", summary: "{{summary}}" }],
  ["claim_readback", { claim_type: "boat", loss_date: "2026-10-10" }],
  ["claim_readback", { claim_type: "auto", loss_date: "10/10/2026" }],
  ["claim_already_filed", { claim_last3: "472" }],
  ["claim_filed", { claim_last3: "472", emailed: true }],
  ["claim_filed", { claim_last3: "472", emailed: false }],
  ["claim_filed", { claim_last3: "CLM-482472" }],
  ["claim_intake_saved", { first_name: "Jane", emailed: true }],
  ["claim_intake_saved", { first_name: "{{first}}" }],
];

Deno.test("every code has a non-empty speakable sentence, with and without data", () => {
  for (const code of CODES) {
    const s = sentenceFor(code);
    assert(s.trim().length > 0, `${code} has no sentence`);
    assertSpeakable(s);
  }
  for (const [code, data] of VARIANTS) assertSpeakable(sentenceFor(code, data));
});

Deno.test("no sentence leaks markup, programming words or long digit runs", () => {
  for (const [code, data] of VARIANTS) {
    const s = sentenceFor(code, data);
    for (const bad of ["{{", "<<", "{", "}", "must not", "JSON", "json", "null", "undefined", "tool", "function"]) {
      assert(!s.includes(bad), `${code} contains ${bad}`);
    }
    assert(!/\bdata\b/i.test(s), `${code} says "data"`);
    assert(!/\d{4,}/.test(s.replace(MAIN_LINE_SPOKEN, "")), `${code} has a digit run outside the main line`);
  }
});

Deno.test("exact fixed sentences", () => {
  assertEquals(sentenceFor("bad_args"), "Sorry, I didn't catch that. Could you say it again?");
  assertEquals(
    sentenceFor("system_error"),
    "I'm having trouble reaching our claims system right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?",
  );
  assertEquals(sentenceFor("unknown_tool"), sentenceFor("system_error"));
  assertEquals(sentenceFor("dob_give_up"), sentenceFor("locked"));
  assertEquals(sentenceFor("not_verified", { level: "locked" }), sentenceFor("locked"));
  assertEquals(
    sentenceFor("locked"),
    "I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?",
  );
  assertEquals(sentenceFor("needs_dob"), "Thanks. For security, what's the date of birth on the account?");
  assertEquals(sentenceFor("dob_unreadable"), "Could you give me the month, day and year?");
  assertEquals(
    sentenceFor("rep_unavailable"),
    "I'm sorry, I couldn't record your request just now. Please call our main line at 1-800-555-0142, and someone will help you. Is there anything else I can help you with?",
  );
  assertEquals(
    sentenceFor("no_email_on_file"),
    "I don't see an email address on your account. If you'd like, you can spell one for me and I'll pass it to our team to add. Or you can find the same information at observeinsurance dot com slash claims. Which would you prefer?",
  );
  assertEquals(sentenceFor("emergency_logged"), "Our team has been told. Are you safe right now?");
  assertEquals(
    sentenceFor("emergency_logged", { db_failed: true }),
    "Please stay on the line. Are you safe right now?",
  );
});

Deno.test("dynamic sentences", () => {
  assertEquals(
    sentenceFor("not_found", { digits: "6025550199" }),
    "I'm not finding an account under six zero two... five five five... zero one nine nine. Is that the right number?",
  );
  assertEquals(
    sentenceFor("verified", { first_name: "Tobias" }),
    "Thank you, Tobias, you're verified. What can I help you with today?",
  );
  assertEquals(sentenceFor("verified", { first_name: "In\u00e9s" }).includes("Thank you, Ines,"), true);
  assertEquals(sentenceFor("verified", { first_name: "{{name}}" }).includes("{"), false);
  assertEquals(
    sentenceFor("not_verified", { level: "phone_found" }),
    "For security, I need the date of birth on the account before I can share that. What's the date of birth?",
  );
  assertEquals(
    sentenceFor("not_verified", { level: "none" }),
    "I need to verify your identity before I can share that. What's the phone number on your account?",
  );
  const queued = (at: string) =>
    `I've sent your request and a summary to our claims team. A representative will call you back at ${at} within one business day. Is there anything else I can help you with?`;
  assertEquals(sentenceFor("rep_queued", { target: "account" }), queued("the number on your account"));
  assertEquals(
    sentenceFor("rep_queued", { target: "given", digits: "+16025550101" }),
    queued("the number you gave me, ending in zero one zero one"),
  );
  assertEquals(sentenceFor("rep_queued", { target: "caller_id" }), queued("the number you're calling from"));
  assertEquals(
    sentenceFor("callback_updated", { digits: "6025550101" }),
    "Got it, six zero two... five five five... zero one zero one. Is there anything else I can help you with?",
  );
  assertEquals(
    sentenceFor("ok", { claims: byNumber("CLM-240230"), refDate: TODAY }),
    claimsSentence(byNumber("CLM-240230"), TODAY),
  );
  // Without claims there is nothing true to say: the trouble line, never an invented status.
  assertEquals(
    sentenceFor("ok", { claims: [{ claim_number_last3: "115", status: "approved" }] }),
    sentenceFor("system_error"),
  );
});

Deno.test("system_error never sounds like not_found", () => {
  assertNotEquals(sentenceFor("system_error"), sentenceFor("not_found"));
  assert(!/can't find|not finding/i.test(sentenceFor("system_error")));
});

Deno.test("claimsSentence over the demo seed reads every fact in words", () => {
  const tobias = claimsSentence(SEED_CLAIMS.filter((c) => c.customer_id === TOBIAS), TODAY);
  for (
    const part of [
      "four thousand eight hundred twenty dollars",
      "October eighth",
      "contractor estimate",
      "October twenty-fourth",
    ]
  ) {
    assertStringIncludes(tobias, part);
  }
  assertEquals(
    tobias,
    "You have two claims on file. " +
      "Your auto claim ending in one one five was approved, and a payment of four thousand eight hundred twenty dollars was issued on October eighth. " +
      "Your home claim ending in one nine eight needs a few documents from you before review can continue: photos of the damage, a contractor estimate, and proof of ownership for the damaged items. " +
      "Please send them by October twenty-fourth. You can upload them at observeinsurance dot com slash claims, email them to claims docs at observeinsurance dot com, or mail them to our claims department, and please include your claim number. " +
      "Do you have any questions about either claim?",
  );
  assertEquals(
    claimsSentence(byNumber("CLM-240211"), TODAY),
    "Your auto claim ending in two one one is under review with your adjuster, Bertrand Wexley. A decision is expected within five business days. Do you have any questions about that claim?",
  );
  assertEquals(
    claimsSentence(byNumber("CLM-240177"), TODAY),
    "Your property claim ending in one seven seven was denied, and I'm sorry about that. The reason given is that the item class is not covered by the policy. You have thirty days to appeal. Do you have any questions about that claim?",
  );
  assertEquals(
    claimsSentence(byNumber("CLM-240230"), TODAY),
    "Your home claim ending in two three zero was received on October tenth and is waiting for an adjuster to be assigned. Do you have any questions about that claim?",
  );
  assertStringIncludes(claimsSentence(SEED_CLAIMS, TODAY), "You have five claims on file. ");
  assertStringIncludes(claimsSentence(SEED_CLAIMS, TODAY), "Do you have any questions about any of them?");
  assertThrows(() => claimsSentence([], TODAY));
});

Deno.test("every claim status has a speakable sentence", () => {
  const base = SEED_CLAIMS[0];
  for (const status of CLAIM_STATUSES) {
    const s = claimsSentence([{ ...base, status }], TODAY);
    assertSpeakable(s);
    assertStringIncludes(s, "Your auto claim ending in one one five ");
  }
  assertEquals(
    claimsSentence([{ ...base, status: "approved" }], TODAY),
    "Your auto claim ending in one one five was approved for four thousand eight hundred twenty dollars. Do you have any questions about that claim?",
  );
  assertStringIncludes(
    claimsSentence([{ ...base, status: "approved", amount_approved: null }], TODAY),
    "was approved. Do",
  );
  assertStringIncludes(claimsSentence([{ ...base, status: "closed" }], TODAY), "is closed.");
});

Deno.test("the documents sentence carries the list, the due date and the submission instructions", () => {
  const docs = byNumber("CLM-240198")[0];
  const s = claimsSentence([docs], TODAY);
  assertStringIncludes(s, "photos of the damage, a contractor estimate, and proof of ownership for the damaged items.");
  assertStringIncludes(s, "Please send them by October twenty-fourth.");
  assertStringIncludes(s, "upload them at observeinsurance dot com slash claims");
  assertStringIncludes(s, "email them to claims docs at observeinsurance dot com");
  assertStringIncludes(s, "mail them to our claims department, and please include your claim number.");
  assertStringIncludes(
    claimsSentence([{ ...docs, documents_required: ["a police report", "photos"] }], TODAY),
    ": a police report and photos.",
  );
  const bare = claimsSentence([{ ...docs, documents_required: [], documents_due: null }], TODAY);
  assertStringIncludes(bare, "before review can continue. You can upload");
});

Deno.test("several claims awaiting documents hear the instructions once, after the last of them", () => {
  const docs = byNumber("CLM-240198")[0];
  const second: Claim = {
    ...docs,
    id: "c-extra",
    claim_number: "CLM-240305",
    claim_type: "auto",
    documents_required: ["a police report"],
    documents_due: "2026-10-30",
  };
  const busy = [docs, byNumber("CLM-240211")[0], second];
  const s = claimsSentence(busy, TODAY);
  assertEquals(s.split("You can upload them at").length - 1, 1);
  assert(s.indexOf("You can upload them at") > s.indexOf("ending in three zero five"), "after the last one");
  assertStringIncludes(s, "Please send them by October twenty-fourth. Your auto claim ending in two one one");
  // VAPI's ToolMessageComplete.content allows at most 1000 characters.
  assert(s.length <= 1000, `${s.length} characters`);
  for (const customer of new Set(SEED_CLAIMS.map((c) => c.customer_id))) {
    const own = SEED_CLAIMS.filter((c) => c.customer_id === customer);
    assert(claimsSentence(own, TODAY).length <= 1000, customer);
  }
});

Deno.test("a busy account stays within VAPI's 1000 characters: open and newest claims first, the rest pointed to", () => {
  assertEquals(MAX_SPOKEN_CHARS, 1000);
  const docs = byNumber("CLM-240198")[0];
  const many: Claim[] = [
    ...SEED_CLAIMS,
    { ...docs, id: "c-301", claim_number: "CLM-240301", filed_on: "2026-10-02", documents_due: "2026-10-28" },
    { ...SEED_CLAIMS[0], id: "c-302", claim_number: "CLM-240302", status: "closed", filed_on: "2026-10-11" },
    { ...byNumber("CLM-240211")[0], id: "c-303", claim_number: "CLM-240303", filed_on: "2026-10-05" },
  ];
  // five seed claims alone already ran past the limit before claims were budgeted
  for (const set of [SEED_CLAIMS, many]) {
    const s = claimsSentence(set, TODAY);
    assert(s.length <= MAX_SPOKEN_CHARS, `${s.length} characters`);
    assertSpeakable(s);
    assertStringIncludes(s, `You have ${numberToWords(set.length)} claims on file. `);
    assertStringIncludes(
      s,
      "more claims on file, and you can find every claim at observeinsurance dot com slash claims.",
    );
    assert(s.endsWith("Do you have any questions about any of them?"));
    assertEquals(s.split("You can upload them at").length - 1, 1, "the instructions are said once");
  }
  const s = claimsSentence(many, TODAY);
  // the newest open claims are read; the closed one waits even though it is the newest
  assertStringIncludes(s, "ending in three zero one");
  assertStringIncludes(s, "ending in two three zero");
  assert(!s.includes("three zero two"), "a closed claim is read last");
  // read in filing order
  assert(s.indexOf("one nine eight") < s.indexOf("three zero one"));
});

Deno.test("claim free text too long to read in full is left out, never cut", () => {
  const base = byNumber("CLM-240211")[0];
  const long = `The adjuster is ${"still reviewing the repair estimates and the photos, ".repeat(6)}and will call you.`;
  assertEquals(
    claimsSentence([{ ...base, status_detail: long }], TODAY),
    claimsSentence([{ ...base, status_detail: null }], TODAY),
  );
  const docs = byNumber("CLM-240198")[0];
  const listed = claimsSentence([{ ...docs, documents_required: Array(12).fill("a signed statement of loss") }], TODAY);
  assertStringIncludes(listed, "needs a few documents from you before review can continue. Please send them by");
  assertStringIncludes(
    claimsSentence([{ ...base, adjuster_name: "A".repeat(80) }], TODAY),
    "is under review. A decision",
  );
});

Deno.test("claim free text is made speakable or left out", () => {
  const base = byNumber("CLM-240211")[0];
  const read = (detail: string | null, adjuster: string | null = "Bertrand Wexley") =>
    claimsSentence([{ ...base, status_detail: detail, adjuster_name: adjuster }], TODAY);
  assertStringIncludes(read("Expected by 2026-10-30"), "Expected by October thirtieth.");
  assertStringIncludes(
    read("An offer of $12,500.50 is pending"),
    "twelve thousand five hundred dollars and fifty cents",
  );
  assertStringIncludes(read("Inspection on the 5th"), "Inspection on the fifth.");
  assertStringIncludes(read("Depreciation of 12% applies"), "twelve percent");
  assertStringIncludes(read("Linked to CLM-240115"), "Linked to CLM-two four zero one one five.");
  assertStringIncludes(read("Covers 12,000 miles and 2.5 days"), "twelve thousand miles and two point five days");
  assertStringIncludes(read("Repair shop \u2014 \u201cpending\u201d"), 'Repair shop - "pending".');
  // An unsafe detail is dropped, never spoken, and the rest of the answer still goes out.
  assertEquals(read("waiting on data {x}"), read(null));
  assertStringIncludes(read(null, null), "is under review. Do you have");
  const denied = byNumber("CLM-240177")[0];
  assertStringIncludes(
    claimsSentence([{ ...denied, status_detail: null }], TODAY),
    "was denied, and I'm sorry about that. You have thirty days to appeal.",
  );
  assertStringIncludes(
    claimsSentence([{ ...denied, status_detail: "ACV limits apply." }], TODAY),
    "The reason given is that ACV limits apply. You have",
  );
});

Deno.test("claim dates outside the current year include the year", () => {
  const s = claimsSentence([{ ...byNumber("CLM-240230")[0], filed_on: "2025-12-30" }], TODAY);
  assertStringIncludes(s, "was received on December thirtieth, twenty twenty five and is waiting");
});

Deno.test("speakDigits spaces digits and drops everything else", () => {
  assertEquals(speakDigits("115"), "one one five");
  assertEquals(speakDigits("CLM-240115"), "two four zero one one five");
  assertEquals(speakDigits("0142"), "zero one four two");
  assertEquals(speakDigits(""), "");
});

Deno.test("speakPhone reads three groups with pauses", () => {
  const spoken = "six zero two... five five five... zero one nine nine";
  assertEquals(speakPhone("+16025550199"), spoken);
  assertEquals(speakPhone("6025550199"), spoken);
  assertEquals(speakPhone("(602) 555-0199"), spoken);
  assertEquals(speakPhone("5550199"), "five five five zero one nine nine");
});

Deno.test("speakDate is pure: ordinals in words, year only when it differs", () => {
  assertEquals(speakDate("2026-10-08"), "October eighth");
  assertEquals(speakDate("2026-10-08", 2026), "October eighth");
  assertEquals(speakDate("2026-10-24"), "October twenty-fourth");
  assertEquals(speakDate("2026-10-10"), "October tenth");
  assertEquals(speakDate("2026-01-01"), "January first");
  assertEquals(speakDate("2026-03-02"), "March second");
  assertEquals(speakDate("2026-05-03"), "May third");
  assertEquals(speakDate("2026-07-12"), "July twelfth");
  assertEquals(speakDate("2026-08-20"), "August twentieth");
  assertEquals(speakDate("2026-12-31"), "December thirty-first");
  assertEquals(speakDate("2026-09-30"), "September thirtieth");
  assertEquals(speakDate("2024-02-29", 2026), "February twenty-ninth, twenty twenty four");
  assertEquals(speakDate("2025-12-01", 2026), "December first, twenty twenty five");
  assertEquals(speakDate("2005-06-15", 2026), "June fifteenth, two thousand five");
  assertEquals(speakDate("2000-06-15", 2026), "June fifteenth, two thousand");
  assertEquals(speakDate("1986-03-14", 2026), "March fourteenth, nineteen eighty six");
  assertEquals(speakDate("1905-03-14", 2026), "March fourteenth, nineteen oh five");
  assertEquals(speakDate("1900-03-14", 2026), "March fourteenth, nineteen hundred");
  for (
    const bad of ["2026-13-01", "2026-02-29", "2026-04-31", "2026-10-00", "10/08/2026", "2026-10-08T00:00:00Z", ""]
  ) {
    assertThrows(() => speakDate(bad), RangeError, undefined, bad);
  }
});

Deno.test("speakDate does not depend on the process time zone", () => {
  const before = Deno.env.get("TZ");
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
      Deno.env.set("TZ", tz);
      assertEquals(speakDate("2026-10-08"), "October eighth");
      assertEquals(speakDate("2026-01-01", 2026), "January first");
    }
  } finally {
    if (before === undefined) Deno.env.delete("TZ");
    else Deno.env.set("TZ", before);
  }
  // The guarantee is structural: no Date object or Date.parse anywhere in the speaker.
  const src = Deno.readTextFileSync(new URL("./speak.ts", import.meta.url));
  assert(!/Date\.parse\s*\(/.test(src), "speak.ts must not call Date.parse");
  assert(!/new Date\s*\(/.test(src), "speak.ts must not construct a Date");
});

Deno.test("speakMoney", () => {
  assertEquals(speakMoney(4820), "four thousand eight hundred twenty dollars");
  assertEquals(speakMoney(4820.0), "four thousand eight hundred twenty dollars");
  assertEquals(speakMoney(12.5), "twelve dollars and fifty cents");
  assertEquals(speakMoney(1), "one dollar");
  assertEquals(speakMoney(1.01), "one dollar and one cent");
  assertEquals(speakMoney(0.75), "seventy five cents");
  assertEquals(speakMoney(0), "zero dollars");
  assertEquals(
    speakMoney(999999.99),
    "nine hundred ninety nine thousand nine hundred ninety nine dollars and ninety nine cents",
  );
  assertEquals(speakMoney(1250000), "one million two hundred fifty thousand dollars");
  for (const bad of [-1, NaN, Infinity]) assertThrows(() => speakMoney(bad), RangeError);
});

Deno.test("numberToWords", () => {
  const cases: [number, string][] = [
    [0, "zero"],
    [7, "seven"],
    [13, "thirteen"],
    [20, "twenty"],
    [21, "twenty one"],
    [99, "ninety nine"],
    [100, "one hundred"],
    [101, "one hundred one"],
    [115, "one hundred fifteen"],
    [999, "nine hundred ninety nine"],
    [1000, "one thousand"],
    [1001, "one thousand one"],
    [4820, "four thousand eight hundred twenty"],
    [10000, "ten thousand"],
    [100000, "one hundred thousand"],
    [999999, "nine hundred ninety nine thousand nine hundred ninety nine"],
  ];
  for (const [n, words] of cases) assertEquals(numberToWords(n), words);
  for (const bad of [-1, 1.5, NaN, 1_000_000_000]) assertThrows(() => numberToWords(bad), RangeError);
});

Deno.test("assertSpeakable accepts plain speech and the main line only", () => {
  assertSpeakable("Your auto claim ending in one one five is closed.");
  assertSpeakable(`Please call our main line at ${MAIN_LINE_SPOKEN}, and someone will help you.`);
  assertSpeakable("I'm not finding an account under six zero two... five five five... zero one nine nine.");
  assertSpeakable("A 30-day window, 1,000 options, 555 people.");
  const rejects = [
    "",
    "   ",
    "Hello {{name}}",
    "Hello <<name>>",
    'Result {"code":"ok"}',
    "a } b",
    "The value is null.",
    "That is undefined here.",
    "Here is the JSON result.",
    "I looked at the data.",
    "Total NaN dollars.",
    "Got [object Object].",
    "Call 6025550101 now.",
    "Ending in 0101.",
    "Call 1-800-555-01420 now.",
    "Caf\u00e9 open",
    "Line one\nline two",
    "Smart \u2019quote\u2019",
  ];
  for (const text of rejects) assertThrows(() => assertSpeakable(text), Error, undefined, JSON.stringify(text));
  // A standalone-word rule: these contain the letters but not the word.
  assertSpeakable("The database team and the nullified form are fine.");
});

// ---------------------------------------------------------------------------------------------
// Contact capture: the email read-back and the capture/confirm sentences.
// ---------------------------------------------------------------------------------------------
Deno.test("speakEmail: letter by letter, digits and symbols as words, known providers and common TLDs as words", () => {
  const table: [string, string][] = [
    ["john.smith42@gmail.com", "J, O, H, N, dot, S, M, I, T, H, four, two, at gmail dot com"],
    ["jane_doe@yahoo.com", "J, A, N, E, underscore, D, O, E, at yahoo dot com"],
    ["mary-jo@outlook.com", "M, A, R, Y, dash, J, O, at outlook dot com"],
    ["pat+claims@hotmail.com", "P, A, T, plus, C, L, A, I, M, S, at hotmail dot com"],
    ["sam@icloud.com", "S, A, M, at i cloud dot com"],
    ["al@aol.com", "A, L, at A, O, L dot com"],
    ["kim@proton.me", "K, I, M, at proton dot me"],
    ["ops@acme-builders.org", "O, P, S, at A, C, M, E, dash, B, U, I, L, D, E, R, S dot org"],
    ["x1@mail.example.co.uk", "X, one, at M, A, I, L dot E, X, A, M, P, L, E dot C, O dot U, K"],
    ["zero0@gmail.io", "Z, E, R, O, zero, at gmail dot I, O"],
    ["  Upper.Case@GMAIL.com ", "U, P, P, E, R, dot, C, A, S, E, at gmail dot com"],
  ];
  // Letters are capitals, so a lone "a" is read as the letter rather than the article.
  assertEquals(speakEmail("a@gmail.com"), "A, at gmail dot com");
  for (const [address, spoken] of table) {
    assertEquals(speakEmail(address), spoken, address);
    assertSpeakable(spoken);
    assert(!spoken.includes("@") && !/[0-9]/.test(spoken), address);
  }
  // A guarded word in an address is spelled, so it can never be spoken as the word.
  assertEquals(speakEmail("null.data@json.com"), "N, U, L, L, dot, D, A, T, A, at J, S, O, N dot com");
  for (const bad of ["", "jane", "jane@example", "a@@b.com", "jane..doe@example.com", 42 as unknown as string]) {
    assertThrows(() => speakEmail(bad), RangeError, undefined, String(bad));
  }
});

Deno.test("contact sentences: exact wording", () => {
  assertEquals(
    sentenceFor("contact_readback", { first_name: "John", last_name: "Smith", email: "john.smith42@gmail.com" }),
    "Thanks, John. Let me read that back. John Smith, and your email is J, O, H, N, dot, S, M, I, T, H, four, two, at gmail dot com. Did I get that right?",
  );
  // a callback number the caller said is read back in three groups, the way a person reads one
  assertEquals(
    sentenceFor("contact_readback", {
      first_name: "John",
      last_name: "Smith",
      email: "john.smith42@gmail.com",
      callback_phone: "+16025550177",
    }),
    "Thanks, John. Let me read that back. John Smith, your email is J, O, H, N, dot, S, M, I, T, H, four, two, at gmail dot com, and the best number is six zero two... five five five... zero one seven seven. Did I get that right?",
  );
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jane", last_name: "O'Brien", callback_phone: "6025550177" }),
    "Thanks, Jane. Just to confirm, that's Jane O'Brien, and the best number is six zero two... five five five... zero one seven seven. Did I get that right?",
  );
  // a number that is not ten digits is left out rather than read wrong
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jane", last_name: "O'Brien", callback_phone: "5550177" }),
    "Thanks, Jane. Just to confirm, that's Jane O'Brien. Did I get that right?",
  );
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jane", last_name: "O'Brien" }),
    "Thanks, Jane. Just to confirm, that's Jane O'Brien. Did I get that right?",
  );
  // accents are folded for speech
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jos\u00e9", last_name: "Pe\u00f1a" }),
    "Thanks, Jose. Just to confirm, that's Jose Pena. Did I get that right?",
  );
  // nothing speakable to read back: the plain question, never a broken sentence
  for (
    const d of [undefined, { first_name: "123", last_name: "Doe" }, {
      first_name: "Jane",
      last_name: "Doe",
      email: "x@y",
    }]
  ) {
    assertEquals(sentenceFor("contact_readback", d), "Just to confirm, did I get your details right?");
  }
  assertEquals(
    sentenceFor("contact_invalid_email"),
    "Hmm, I didn't quite catch a full email address. Could you spell it for me, letter by letter?",
  );
  assertEquals(sentenceFor("contact_needs_name"), "Sorry, could I get your first and last name?");
  assertEquals(
    sentenceFor("contact_needs_phone"),
    "Sorry, I can't see the number you're calling from. What's the best number to reach you?",
  );
  assertEquals(
    sentenceFor("email_on_file"),
    "There's already an email on your account, so I can't change it on this call. I can have someone from our claims team call you back about it. Would you like that?",
  );
  assertEquals(sentenceFor("not_pending"), "Sorry, let me take your details again. What's your first and last name?");
  // a verified caller's name is the account's, so only the address is asked for again
  assertEquals(
    sentenceFor("not_pending", { verified: true }),
    "Sorry, could you spell that email for me one more time, letter by letter?",
  );
  // a plain no asks which part was wrong, among the parts that were read back
  assertEquals(sentenceFor("contact_retry"), "Sorry about that. What did I get wrong, your name or your email?");
  assertEquals(
    sentenceFor("contact_retry", { has_email: true, has_phone: true }),
    "Sorry about that. What did I get wrong, your name, your email or your number?",
  );
  assertEquals(
    sentenceFor("contact_retry", { has_email: false, has_phone: true }),
    "Sorry about that. What did I get wrong, your name or your number?",
  );
  assertEquals(
    sentenceFor("contact_retry", { has_email: false }),
    "Sorry about that. Could you tell me your first and last name one more time?",
  );
  // an email_update read back only the address
  assertEquals(
    sentenceFor("contact_retry", { part: "email" }),
    "Sorry about that. Could you spell your email for me one more time, slowly?",
  );
  // taking the loss down now comes first: a new caller who called to report one is offered exactly that
  assertEquals(
    sentenceFor("contact_saved_new", { first_name: "Jane" }),
    "Perfect, thanks Jane. I've saved your details. I can take down what happened now, email you the steps to start a claim, or have someone from our claims team call you back. Which would you like?",
  );
  assertEquals(
    sentenceFor("contact_saved_new", { first_name: "Jane", has_email: false }),
    "Perfect, thanks Jane. I've saved your details. I can take down what happened now, have someone from our claims team call you back, or you can find the steps to start a claim at observeinsurance dot com slash claims. Which would you like?",
  );
  // a start_claim already asked for these details: the loss was told, so the claim is taken down now
  for (const has_email of [true, false]) {
    assertEquals(
      sentenceFor("contact_saved_new", { first_name: "Jane", has_email, resume_claim: true }),
      "Perfect, thanks Jane. I've saved your details. Shall I go ahead and take down that claim now?",
    );
  }
  assertStringIncludes(sentenceFor("contact_saved_new"), "Perfect, thanks. I've saved your details.");
  assertEquals(
    sentenceFor("contact_saved_existing", { first_name: "Teague" }),
    "Thanks, Teague. I've passed that email to our team to add to your account. Is there anything else I can help with?",
  );
  assertEquals(
    sentenceFor("contact_saved_existing"),
    "Thanks. I've passed that email to our team to add to your account. Is there anything else I can help with?",
  );
});

Deno.test("the new-caller sentences lead into the details, and an email to a given address says so", () => {
  assertEquals(
    sentenceFor("not_found_final"),
    "I'm sorry, I still can't find an account for that number. If you're new with us, I can help you get started. Could I get your first and last name?",
  );
  assertEquals(
    sentenceFor("email_sent", { target: "given" }),
    "Done, I've emailed that to the address you gave me. It should arrive within a few minutes. Is there anything else I can help you with?",
  );
  assertStringIncludes(sentenceFor("email_sent"), "the address on your account");
  // the verified caller with no email on file is offered the spelled-address route, never told it is impossible
  assert(!sentenceFor("no_email_on_file").includes("can't take one"));
  assertStringIncludes(sentenceFor("no_email_on_file"), "spell one for me");
});

Deno.test("spokenName folds accents and refuses what cannot be spoken", () => {
  assertEquals(spokenName("Jos\u00e9"), "Jose");
  assertEquals(spokenName("O\u2019Brien"), "O'Brien");
  assertEquals(spokenName("{{first}}"), "first");
  assertEquals(spokenName("Null"), "");
  assertEquals(spokenName(42), "");
});

Deno.test("no spoken string carries banned words or a double dash", () => {
  for (const [code, data] of VARIANTS) {
    const s = sentenceFor(code, data);
    assert(!s.includes("--"), `${code} has a double dash`);
    for (
      const banned of [
        /\bgotcha\b/i,
        /\bhoney\b/i,
        /\blove\b/i,
        /\bsweetie\b/i,
        /\bdear\b/i,
        /I understand your concern/i,
      ]
    ) {
      assert(!banned.test(s), `${code} says ${banned}`);
    }
    assert(!/\bTessa\b/.test(s), `${code} still names the old assistant`);
  }
});

// ---------------------------------------------------------------------------------------------
// First notice of loss.
// ---------------------------------------------------------------------------------------------
Deno.test("claim sentences: exact wording", () => {
  assertEquals(
    sentenceFor("claim_needs_lookup"),
    "I can help you start a claim. First, what's the phone number on your account?",
  );
  assertEquals(
    sentenceFor("claim_needs_contact"),
    "I can take down the details for our claims team. First, can I get your first and last name?",
  );
  assertEquals(
    sentenceFor("claim_needs_verification"),
    "I'll just need to verify you first. What's the date of birth on the account?",
  );
  assertEquals(
    sentenceFor("claim_locked"),
    "Since I wasn't able to verify your identity, I can't file a claim on this call. I can have a claims specialist call you back to help. Would you like that?",
  );
  assertEquals(sentenceFor("claim_needs_description"), "Can you tell me briefly what happened?");
  assertEquals(sentenceFor("claim_bad_date"), "Sorry, I didn't catch the date. What day did it happen?");
  assertEquals(
    sentenceFor("claim_date_help"),
    "No problem. A claims specialist can help pin down the date. Would you like a callback?",
  );
  assertEquals(
    sentenceFor("claim_needs_phone"),
    "Before I take this down, what's the best number for our claims team to reach you?",
  );
  assertEquals(
    sentenceFor("claim_too_old"),
    "Since that was more than a year ago, a claims specialist will need to help with this one. Would you like a callback?",
  );
  assertEquals(
    sentenceFor("claim_already_filed", { claim_last3: "472" }),
    "Your claim is already filed, number ending in four seven two. Is there anything else I can help with?",
  );
  assertEquals(
    sentenceFor("claim_already_filed"),
    "Your claim is already filed. Is there anything else I can help with?",
  );
  assertEquals(sentenceFor("claim_not_pending"), "I don't have the claim details yet. Can you tell me what happened?");
  assertEquals(sentenceFor("claim_retry"), "No problem. What should I change?");
  assertEquals(
    sentenceFor("claim_filed", { claim_last3: "472", emailed: true }),
    "You're all set. Your claim number ends in four seven two, and I've emailed the details to the email on file. An adjuster will reach out within one business day. Is there anything else I can help with?",
  );
  // "emailed" only on an explicit true (Resend returned an id)
  for (const emailed of [false, undefined, "true", 1]) {
    assertEquals(
      sentenceFor("claim_filed", { claim_last3: "472", emailed }),
      "You're all set. Your claim number ends in four seven two. An adjuster will reach out within one business day. Is there anything else I can help with?",
    );
  }
  assertEquals(
    sentenceFor("claim_intake_saved", { first_name: "Jane", emailed: true }),
    "Thanks, Jane. I've passed your claim details to our claims team, and sent a confirmation to your email. A specialist will call you within one business day to finish setting it up. Is there anything else I can help with?",
  );
  assertEquals(
    sentenceFor("claim_intake_saved"),
    "Thanks. I've passed your claim details to our claims team. A specialist will call you within one business day to finish setting it up. Is there anything else I can help with?",
  );
});

Deno.test("claim_readback: the article, the type, the summary when given and the weekday with the date", () => {
  assertEquals(
    sentenceFor("claim_readback", {
      claim_type: "auto",
      loss_date: "2026-10-10",
      summary: "a cracked windshield",
      today: TODAY,
    }),
    "Let me make sure I have this right. An auto claim, for a cracked windshield, from Saturday, October tenth. Is that correct?",
  );
  assertEquals(
    sentenceFor("claim_readback", { claim_type: "home", loss_date: "2026-10-09", today: TODAY }),
    "Let me make sure I have this right. A home claim from Friday, October ninth. Is that correct?",
  );
  // a summary starting with a capital is lower-cased to read as a clause; an acronym is kept; figures become words
  assertEquals(
    sentenceFor("claim_readback", { claim_type: "property", loss_date: "2026-10-01", summary: "Stolen bike, 2nd one" }),
    "Let me make sure I have this right. A property claim, for stolen bike, second one, from Thursday, October first. Is that correct?",
  );
  assertStringIncludes(
    sentenceFor("claim_readback", { claim_type: "auto", loss_date: "2026-10-01", summary: "SUV hit a pole" }),
    "for SUV hit a pole,",
  );
  // the year only when it is not this year's
  assertStringIncludes(
    sentenceFor("claim_readback", { claim_type: "home", loss_date: "2025-12-24", today: TODAY }),
    "from Wednesday, December twenty-fourth, twenty twenty five.",
  );
  // a summary that cannot be said is left out rather than spoken around
  for (const summary of ["{{summary}}", "null pointer", "x".repeat(81), "1234 5678", "!!!", 42]) {
    assertEquals(
      sentenceFor("claim_readback", { claim_type: "auto", loss_date: "2026-10-10", summary, today: TODAY }),
      "Let me make sure I have this right. An auto claim from Saturday, October tenth. Is that correct?",
      String(summary),
    );
  }
  // nothing true to read back without a type and a calendar date
  for (
    const d of [{ claim_type: "boat", loss_date: "2026-10-10" }, { claim_type: "auto", loss_date: "2026-02-30" }, {}]
  ) {
    assertEquals(
      sentenceFor("claim_readback", d),
      "Let me make sure I have this right. Did I get the details of your claim correct?",
    );
  }
});

Deno.test("claim sentences: one question each, at most sixty words, digits as words and never 'oh'", () => {
  const codes = CODES.filter((c) => c.startsWith("claim_"));
  assertEquals(codes.length, 15);
  for (const [code, data] of VARIANTS.filter(([c]) => c.startsWith("claim_"))) {
    const s = sentenceFor(code, data);
    assertEquals(s.split("?").length - 1, 1, `${code}: ${s}`);
    assert(s.trimEnd().endsWith("?"), `${code} ends on its question`);
    assert(s.split(/\s+/).length <= 60, `${code} has ${s.split(/\s+/).length} words`);
    assert(!/\boh\b/i.test(s), `${code} says oh`);
    assert(!/\bAI\b/.test(s), `${code} says AI`);
    assert(!/\d/.test(s), `${code} has a figure`);
  }
  assertStringIncludes(sentenceFor("claim_filed", { claim_last3: "070" }), "ends in zero seven zero");
  // only the last three digits of a claim number are ever spoken
  assertStringIncludes(sentenceFor("claim_filed", { claim_last3: "CLM-482472" }), "ends in four seven two.");
});

Deno.test("speakLossDate: the weekday and the date, the same in every zone", () => {
  assertEquals(speakLossDate("2026-10-10"), "Saturday, October tenth");
  assertEquals(speakLossDate("2026-10-13", 2026), "Tuesday, October thirteenth");
  assertEquals(speakLossDate("2026-11-01", 2026), "Sunday, November first");
  assertEquals(speakLossDate("2025-12-31", 2026), "Wednesday, December thirty-first, twenty twenty five");
  assertEquals(speakLossDate("2027-01-01", 2027), "Friday, January first");
  assertEquals(speakLossDate("2028-02-29", 2028), "Tuesday, February twenty-ninth");
  assertEquals(speakLossDate("2000-03-01"), "Wednesday, March first");
  for (const bad of ["2026-02-29", "10/10/2026", ""]) assertThrows(() => speakLossDate(bad), RangeError);
});

Deno.test("verify intents: the verified opening without its question, then the shortcut", () => {
  const plain = "Thank you, Tobias, you're verified. What can I help you with today?";
  const welcome =
    "Thank you, Tobias, you're verified. Welcome back. I see you called on October tenth. Is this about the same claim as last time, or something else?";
  assertEquals(withoutTrailingQuestion(plain), "Thank you, Tobias, you're verified.");
  assertEquals(
    withoutTrailingQuestion(welcome),
    "Thank you, Tobias, you're verified. Welcome back. I see you called on October tenth.",
  );
  assertEquals(withoutTrailingQuestion("No question here."), "No question here.");
  assertEquals(
    withoutTrailingQuestion(sentenceFor("verified", { first_name: "St. John" })),
    "Thank you, St. John, you're verified.",
  );
  // the caller has usually described the loss already, so the question asks for more, not for it again
  assertEquals(
    verifiedFileClaimSentence(plain),
    "Thank you, Tobias, you're verified. Let's get your claim started. Can you tell me a little more about what happened?",
  );
  assertEquals(
    verifiedFileClaimSentence(welcome),
    "Thank you, Tobias, you're verified. Welcome back. I see you called on October tenth. Let's get your claim started. Can you tell me a little more about what happened?",
  );
  // the loss was told to a start_claim that asked for verification first: take it down now
  assertEquals(
    verifiedFileClaimSentence(plain, true),
    "Thank you, Tobias, you're verified. Shall I go ahead and take down that claim now?",
  );
  assertEquals(
    verifiedFileClaimSentence(welcome, true),
    "Thank you, Tobias, you're verified. Welcome back. I see you called on October tenth. Shall I go ahead and take down that claim now?",
  );
  const status = claimsSentence(byNumber("CLM-240115"), TODAY);
  assertEquals(verifiedStatusSentence(plain, status), `Thank you, Tobias, you're verified. ${status}`);
  assertEquals(
    verifiedStatusSentence(plain, sentenceFor("no_claims")),
    "Thank you, Tobias, you're verified. I don't see any claims on file for your account. Would you like me to explain how to start one?",
  );
});

Deno.test("claimsSentence honours a smaller limit, so the chained read fits after the verified opening", () => {
  const many: Claim[] = Array.from({ length: 10 }, (_, i) => ({
    ...SEED_CLAIMS[1],
    id: `c-${i}`,
    claim_number: `CLM-25${String(i).padStart(4, "0")}`,
    filed_on: `2026-08-${String(10 + i).padStart(2, "0")}`,
  }));
  const full = claimsSentence(many, TODAY);
  const small = claimsSentence(many, TODAY, 700);
  assert(full.length <= MAX_SPOKEN_CHARS);
  assert(small.length <= 700, `${small.length}`);
  assert(small.length < full.length);
  assertStringIncludes(small, "more claims on file");
});
