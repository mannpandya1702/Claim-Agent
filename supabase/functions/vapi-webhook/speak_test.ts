import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { CLAIM_STATUSES, type Code, CODES, MAIN_LINE_SPOKEN } from "./enums.ts";
import type { Claim } from "./types.ts";
import {
  assertSpeakable,
  claimsSentence,
  numberToWords,
  sentenceFor,
  speakDate,
  speakDigits,
  speakMoney,
  speakPhone,
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
    "I don't have an email address on your account, and I can't take one over the phone. You can find the same information at observeinsurance dot com slash claims. Is there anything else I can help you with?",
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
