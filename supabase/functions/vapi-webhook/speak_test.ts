import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { CLAIM_DOCUMENTS, CLAIM_STATUSES, type Code, CODES, MAIN_LINE_SPOKEN } from "./enums.ts";
import type { Claim } from "./types.ts";
import { asksForSensitive } from "./redact.ts";
import {
  assertSpeakable,
  byReadingPriority,
  claimDetailSentence,
  claimReadbackOpener,
  claimsSentence,
  claimsUnread,
  documentsSentence,
  MAX_TURN_WORDS,
  numberToWords,
  PHRASINGS,
  sentenceFor,
  speakDate,
  speakDigits,
  speakEmail,
  speakLossDate,
  speakMoney,
  speakPhone,
  spokenName,
  spokenWords,
  variantIndex,
  verifiedFileClaimSentence,
  verifiedStatusSentence,
  verifiedThanks,
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
  ["ok", { claims: SEED_CLAIMS, refDate: TODAY }],
  ["claim_documents", { claims: SEED_CLAIMS, refDate: TODAY }],
  ["claim_detail", { claims: byNumber("CLM-240177"), refDate: TODAY }],
  ["claim_detail", { claims: byNumber("CLM-240198"), refDate: TODAY }],
  ["claim_not_identified", { claims: [{ claim_number_last3: "198" }, { claim_number_last3: "115" }] }],
  ["claim_not_identified", {
    claims: [
      { claim_number_last3: "198", claim_type: "home", status: "awaiting_documents" },
      { claim_number_last3: "115", claim_type: "auto", status: "payment_issued" },
    ],
  }],
  ["claim_not_identified", {
    claims: [
      { claim_number_last3: "198", claim_type: "home", status: "awaiting_documents" },
      { claim_number_last3: "198", claim_type: "home", status: "denied" },
    ],
  }],
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

/** Call keys the way the webhook passes them (the VAPI call id), for the one-phrasing contract. */
const CALL_KEYS = [
  ...Array.from({ length: 30 }, (_, n) => `call-${n}`),
  "5f0c2a9e-7b1d-4c3e-9a8f-1b2c3d4e5f60",
  "019a3b1c-2d4e-7f60-8a9b-0c1d2e3f4a5b",
];

/** Every data variant of every code, as spoken (one phrasing: a call key changes nothing). */
const ALL_SPOKEN: [Code, string][] = VARIANTS.map(([code, data]): [Code, string] => [code, sentenceFor(code, data)]);

Deno.test("every code has a non-empty speakable sentence, with and without data", () => {
  for (const code of CODES) {
    const s = sentenceFor(code);
    assert(s.trim().length > 0, `${code} has no sentence`);
    assertSpeakable(s);
  }
  for (const [code, s] of ALL_SPOKEN) {
    assert(s.trim().length > 0, `${code} has an empty sentence`);
    assertSpeakable(s);
  }
});

Deno.test("no sentence leaks markup, programming words or long digit runs", () => {
  for (const [code, s] of ALL_SPOKEN) {
    for (const bad of ["{{", "<<", "{", "}", "must not", "JSON", "json", "null", "undefined", "tool", "function"]) {
      assert(!s.includes(bad), `${code} contains ${bad}`);
    }
    assert(!/\bdata\b/i.test(s), `${code} says "data"`);
    assert(!/\d{4,}/.test(s.replace(MAIN_LINE_SPOKEN, "")), `${code} has a digit run outside the main line`);
  }
});

Deno.test("exact fixed sentences", () => {
  assertEquals(sentenceFor("bad_args"), "Sorry, I didn't quite catch that. Could you say it again?");
  assertEquals(
    sentenceFor("system_error"),
    "Sorry, I'm having trouble on our end right now. I can have a representative call you back, or you can try again in a few minutes. Which would you prefer?",
  );
  assertEquals(sentenceFor("unknown_tool"), sentenceFor("system_error"));
  assertEquals(sentenceFor("dob_give_up"), sentenceFor("locked"));
  assertEquals(sentenceFor("not_verified", { level: "locked" }), sentenceFor("locked"));
  assertEquals(
    sentenceFor("locked"),
    "I'm sorry, but I'm not able to verify your identity on this call, so I can't share claim details. I can have a representative call you back, or you can call back with your policy number handy. Which would you prefer?",
  );
  assertEquals(
    sentenceFor("needs_dob"),
    "Thanks! And just to keep your account safe, what's the date of birth on the account?",
  );
  assertEquals(
    sentenceFor("no_lookup_yet"),
    "Happy to check that. First, I'll just need the phone number on the account. What's the number?",
  );
  assertEquals(sentenceFor("dob_unreadable"), "Just to be sure, could you give me the month, day and year?");
  assertEquals(
    sentenceFor("rep_unavailable"),
    "I'm sorry, I couldn't record your request just now. Please call our main line at 1-800-555-0142, and someone there will help you. Anything else I can help with?",
  );
  assertEquals(
    sentenceFor("no_email_on_file"),
    "I don't see an email address on your account. If you'd like, you can spell one for me, and I'll pass it to our team to add. Or you can find the same information at observeinsurance dot com slash claims. Which would you prefer?",
  );
  assertEquals(sentenceFor("emergency_logged"), "I've told our team. Are you safe right now?");
  assertEquals(
    sentenceFor("emergency_logged", { db_failed: true }),
    "Please stay on the line. Are you safe right now?",
  );
});

Deno.test("dynamic sentences", () => {
  assertEquals(
    sentenceFor("not_found", { digits: "6025550199" }),
    "I'm not finding an account under six zero two, five five five, zero one nine nine. Is that the right number?",
  );
  assertEquals(
    sentenceFor("verified", { first_name: "Tobias" }),
    "Thanks, Tobias. You're all verified. What can I help you with today?",
  );
  assertEquals(sentenceFor("verified", { first_name: "In\u00e9s" }).includes("Thanks, Ines."), true);
  assertEquals(sentenceFor("verified", { first_name: "{{name}}" }).includes("{"), false);
  assertEquals(
    sentenceFor("not_verified", { level: "phone_found" }),
    "Happy to help with that once you're verified. What's the date of birth?",
  );
  assertEquals(
    sentenceFor("not_verified", { level: "none" }),
    "Happy to help with that once I've verified you. What's the phone number on your account?",
  );
  const queued = (at: string) =>
    `I've passed this to our claims team. Someone will call you back at ${at} within one business day. Anything else I can help with?`;
  assertEquals(sentenceFor("rep_queued", { target: "account" }), queued("the number on your account"));
  assertEquals(
    sentenceFor("rep_queued", { target: "given", digits: "+16025550101" }),
    queued("the number you gave me, ending in zero one zero one,"),
  );
  assertEquals(sentenceFor("rep_queued", { target: "caller_id" }), queued("the number you're calling from"));
  assertEquals(
    sentenceFor("callback_updated", { digits: "6025550101" }),
    "Got it, six zero two, five five five, zero one zero one. Anything else I can help with?",
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

// ---------------------------------------------------------------------------------------------
// get_claim_status: the short summary, then the details on request.
// ---------------------------------------------------------------------------------------------
const TOBIAS_SUMMARY = "You have two claims. " +
  "Your home claim ending in one nine eight needs documents from you by October twenty-fourth. " +
  "Your auto claim ending in one one five was paid, four thousand eight hundred twenty dollars on October eighth. " +
  "Would you like me to go over what's needed, or email you the list?";
const TOBIAS_DOCUMENTS =
  "For your home claim ending in one nine eight, we need photos of the damage, a contractor estimate, and proof of ownership for the damaged items, by October twenty-fourth. " +
  "You can upload them at observeinsurance dot com slash claims, or email them to claims docs at observeinsurance dot com. " +
  "Would you like me to email you this list too?";
const tobiasClaims = () => SEED_CLAIMS.filter((c) => c.customer_id === TOBIAS);
const words = (s: string) => s.trim().split(/\s+/).length;
let seq = 0;
/** A claim like the seeded ones, with its own number and overrides. */
const claim = (over: Partial<Claim>): Claim => ({
  ...SEED_CLAIMS[2],
  id: `c-gen-${++seq}`,
  claim_number: `CLM-25${String(seq).padStart(4, "0")}`,
  ...over,
});

Deno.test("the claims summary for the demo seed: one short clause per claim, in one turn", () => {
  const tobias = claimsSentence(tobiasClaims(), TODAY);
  assertEquals(tobias, TOBIAS_SUMMARY);
  assertEquals(spokenWords(tobias), 52);
  // the list, the instructions and the adjuster wait for a detail
  for (const later of ["contractor estimate", "upload", "Leona", "direct deposit"]) {
    assert(!tobias.includes(later), later);
  }
  assertEquals(
    claimsSentence(byNumber("CLM-240211"), TODAY),
    "Your auto claim ending in two one one is under review with your adjuster, Bertrand Wexley. Do you have any questions about it?",
  );
  assertEquals(
    claimsSentence(byNumber("CLM-240177"), TODAY),
    "Your property claim ending in one seven seven was denied, I'm sorry to say. Would you like to hear the reason and how to appeal?",
  );
  assertEquals(
    claimsSentence(byNumber("CLM-240230"), TODAY),
    "Your home claim ending in two three zero was received on October tenth and is waiting for an adjuster. Do you have any questions about it?",
  );
  assertThrows(() => claimsSentence([], TODAY));
  assertEquals(sentenceFor("ok", { claims: tobiasClaims(), refDate: TODAY }), TOBIAS_SUMMARY);
});

Deno.test("the chained read fits one turn after the verified opening, with or without welcome back", () => {
  const plain = "Thanks, Tobias. You're all verified.";
  const back = "Thanks, Tobias. You're all verified. Welcome back.";
  for (const opening of [plain, back]) {
    const s = verifiedStatusSentence(
      opening,
      claimsSentence(tobiasClaims(), TODAY, MAX_TURN_WORDS - spokenWords(opening)),
    );
    assertEquals(s, `${opening} ${TOBIAS_SUMMARY}`);
    assert(spokenWords(s) <= MAX_TURN_WORDS, `${spokenWords(s)} words`);
  }
  assertEquals(MAX_TURN_WORDS, 60);
});

Deno.test("the summary clause for every status", () => {
  const base = byNumber("CLM-240115")[0];
  const one = (over: Partial<Claim>) => claimsSentence([{ ...base, ...over }], TODAY);
  const it = "Do you have any questions about it?";
  const head = "Your auto claim ending in one one five";
  assertEquals(
    one({ status: "received" }),
    `${head} was received on September second and is waiting for an adjuster. ${it}`,
  );
  assertEquals(one({ status: "under_review" }), `${head} is under review with your adjuster, Leona Fairbanks. ${it}`);
  assertEquals(one({ status: "under_review", adjuster_name: null }), `${head} is under review. ${it}`);
  assertEquals(
    one({ status: "awaiting_documents", documents_due: "2026-10-30" }),
    `${head} needs documents from you by October thirtieth. Would you like me to go over what's needed, or email you the list?`,
  );
  assertStringIncludes(one({ status: "awaiting_documents", documents_due: null }), "needs documents from you. Would");
  assertEquals(
    one({ status: "approved" }),
    `${head} was approved for four thousand eight hundred twenty dollars. ${it}`,
  );
  assertEquals(one({ status: "approved", amount_approved: null }), `${head} was approved. ${it}`);
  assertEquals(
    one({ status: "payment_issued" }),
    `${head} was paid, four thousand eight hundred twenty dollars on October eighth. ${it}`,
  );
  assertEquals(one({ status: "payment_issued", amount_approved: null }), `${head} was paid on October eighth. ${it}`);
  assertEquals(
    one({ status: "denied" }),
    `${head} was denied, I'm sorry to say. Would you like to hear the reason and how to appeal?`,
  );
  assertEquals(one({ status: "closed" }), `${head} is closed. ${it}`);
  // a date outside this year says the year
  assertStringIncludes(
    one({ status: "received", filed_on: "2025-12-30" }),
    "was received on December thirtieth, twenty twenty five and is waiting",
  );
  for (const status of CLAIM_STATUSES) assertSpeakable(one({ status }));
  assertThrows(() => one({ status: "lost" as Claim["status"] }));
});

Deno.test("claims that read the same are read together", () => {
  const received = (n: string, filed: string) =>
    claim({ claim_number: `CLM-24${n}`, status: "received", adjuster_name: null, filed_on: filed });
  const pair = [received("1090", "2026-10-02"), received("0849", "2026-10-05")];
  // a group that is every claim on the account says how many there are, so there is no count before it
  assertEquals(
    claimsSentence(pair, TODAY),
    "Both of your claims, ending in eight four nine and zero nine zero, were received and are waiting for an adjuster. Do you have any questions about either one?",
  );
  const three = [...pair, received("0311", "2026-10-07")];
  assertEquals(
    claimsSentence(three, TODAY),
    "All three of your claims, ending in three one one, eight four nine, and zero nine zero, were received and are waiting for an adjuster. Do you have any questions about any of them?",
  );
  const docs = byNumber("CLM-240198")[0];
  assertEquals(
    claimsSentence([...three, docs], TODAY),
    "You have four claims. Your home claim ending in one nine eight needs documents from you by October twenty-fourth. " +
      "Three of your claims, ending in three one one, eight four nine, and zero nine zero, were received and are waiting for an adjuster. " +
      "Would you like me to go over what's needed, or email you the list?",
  );
  // a pair that is not every claim keeps the count and says "both"
  assertEquals(
    claimsSentence([...pair, docs], TODAY),
    "You have three claims. Your home claim ending in one nine eight needs documents from you by October twenty-fourth. " +
      "Your claims ending in eight four nine and zero nine zero were both received and are waiting for an adjuster. " +
      "Would you like me to go over what's needed, or email you the list?",
  );
  // denials read together, so the summary says it is sorry once (rule 16)
  const denied = byNumber("CLM-240177")[0];
  const deniedToo = { ...denied, id: "c-178", claim_number: "CLM-240178", filed_on: "2026-09-20" };
  assertEquals(
    claimsSentence([denied, deniedToo, docs], TODAY),
    "You have three claims. Your home claim ending in one nine eight needs documents from you by October twenty-fourth. " +
      "Your claims ending in one seven eight and one seven seven were both denied, I'm sorry to say. " +
      "Would you like me to go over what's needed, or email you the list?",
  );
  assertEquals(
    claimsSentence([denied, deniedToo], TODAY),
    "Both of your claims, ending in one seven eight and one seven seven, were denied, I'm sorry to say. Would you like to hear the reason and how to appeal?",
  );
  // a denial that cannot be grouped (no ending to say) is read on its own, without a second apology
  const twice = claimsSentence([denied, { ...deniedToo, claim_number: "X" }], TODAY);
  assertEquals(twice.match(/sorry/g)?.length, 1, twice);
  assertStringIncludes(twice, "Your property claim was denied, I'm sorry to say. Your property claim ending in");
  assertStringIncludes(twice, "one seven seven was denied. Would you like");
  // under review without an adjuster, and closed, read together; an adjuster's name keeps a claim on its own
  const review = (n: string, adjuster: string | null) =>
    claim({ claim_number: `CLM-24${n}`, status: "under_review", adjuster_name: adjuster });
  assertStringIncludes(
    claimsSentence([review("0101", null), review("0202", null)], TODAY),
    "Both of your claims, ending in two zero two and one zero one, are under review.",
  );
  assertStringIncludes(
    claimsSentence([review("0101", null), review("0202", null), docs], TODAY),
    "Your claims ending in two zero two and one zero one are both under review.",
  );
  const named = claimsSentence([review("0101", "Bertrand Wexley"), review("0202", null)], TODAY);
  assertStringIncludes(named, "ending in one zero one is under review with your adjuster, Bertrand Wexley.");
  assertStringIncludes(named, "ending in two zero two is under review.");
  assertStringIncludes(
    claimsSentence([claim({ status: "closed" }), claim({ status: "closed" }), docs], TODAY),
    "are both closed.",
  );
  assertEquals(
    claimsSentence([
      claim({ status: "closed", claim_number: "CLM-240501" }),
      claim({ status: "closed", claim_number: "CLM-240502" }),
    ], TODAY),
    "Both of your claims, ending in five zero two and five zero one, are closed. Do you have any questions about either one?",
  );
  // a claim with no ending to say is never folded into a group it cannot be told apart in
  const bare = claimsSentence([received("1090", "2026-10-02"), {
    ...received("0849", "2026-10-05"),
    claim_number: "X",
  }], TODAY);
  assertStringIncludes(bare, "Your auto claim was received on October fifth");
});

Deno.test("reading order: what needs the caller first, then money, then claims in progress, newest first", () => {
  const claims = [
    claim({ status: "closed", filed_on: "2026-10-11" }),
    claim({ status: "received", adjuster_name: null, filed_on: "2026-10-10" }),
    claim({ status: "approved", amount_approved: null, filed_on: "2026-09-01" }),
    claim({ status: "denied", filed_on: "2026-08-01" }),
    claim({ status: "awaiting_documents", documents_due: null, filed_on: "2026-07-01" }),
  ];
  const s = claimsSentence(claims, TODAY, 500);
  const at = (part: string) => s.indexOf(part);
  assert(at("needs documents") < at("was denied"), s);
  assert(at("was denied") < at("was approved"), s);
  assert(at("was approved") < at("was received"), s);
  // four clauses at most; the fifth claim is counted, not dropped
  assert(!s.includes("is closed"), s);
  assertStringIncludes(s, "There's one more claim on file. Would you like me to go over what's needed");
  // within a status the newest claim is read first
  const older = claim({
    status: "approved",
    amount_approved: null,
    filed_on: "2026-01-01",
    claim_number: "CLM-240111",
  });
  const newer = claim({
    status: "approved",
    amount_approved: null,
    filed_on: "2026-02-01",
    claim_number: "CLM-240222",
  });
  const pair = claimsSentence([older, newer], TODAY);
  assert(pair.indexOf("two two two") < pair.indexOf("one one one"), pair);
  assertEquals(byReadingPriority(older, newer), 1);
});

Deno.test("claims awaiting documents are read earliest due date first, a claim with no due date last", () => {
  const due = (n: string, documents_due: string | null, filed_on: string) =>
    claim({ claim_number: `CLM-240${n}`, status: "awaiting_documents", documents_due, filed_on });
  // 305 was filed later, but 198's documents are due first
  const c198 = due("198", "2026-10-24", "2026-09-28");
  const c305 = due("305", "2026-10-30", "2026-10-02");
  const c306 = due("306", "2026-11-02", "2026-10-05");
  const open = due("307", null, "2026-10-09");
  assertEquals([c305, c198].sort(byReadingPriority), [c198, c305]);
  assertEquals([open, c306, c305, c198].sort(byReadingPriority), [c198, c305, c306, open]);
  // two: the summary reads the earlier deadline first
  const two = claimsSentence([c305, c198], TODAY);
  assert(two.indexOf("one nine eight") < two.indexOf("three zero five"), two);
  // three: the one only counted is the latest deadline, never the earliest
  const three = claimsSentence([c306, c305, c198], TODAY);
  assertEquals(
    three,
    "You have three claims. Your auto claim ending in one nine eight needs documents from you by October twenty-fourth. " +
      "Your auto claim ending in three zero five needs documents from you by October thirtieth. " +
      "There's one more claim on file. Would you like me to go over what's needed, or email you the list?",
  );
  assertEquals(claimsUnread([c306, c305, c198], TODAY), [c306]);
  assertEquals(claimsUnread(tobiasClaims(), TODAY), []);
  // the documents answer gives the earliest deadline its line, and the next its due date
  const docs = { ...byNumber("CLM-240198")[0] };
  const police = { ...c305, documents_required: ["a police report"] };
  assertEquals(
    documentsSentence([police, docs], TODAY),
    "For your home claim ending in one nine eight, we need a few documents, by October twenty-fourth. " +
      "Your auto claim ending in three zero five needs documents by October thirtieth. " +
      "You can upload them at observeinsurance dot com slash claims, or email them to claims docs at observeinsurance dot com. " +
      "Would you like me to email you the full list?",
  );
  const s = documentsSentence([c306, c305, docs], TODAY);
  assert(s.startsWith("For your home claim ending in one nine eight,"), s);
  assertStringIncludes(s, "by October twenty-fourth. Two more claims need documents too.");
});

Deno.test("the summary stays within the words it is given; what does not fit is counted", () => {
  const many = Array.from(
    { length: 6 },
    (_, i) =>
      claim({
        status: "awaiting_documents",
        filed_on: `2026-09-${String(10 + i).padStart(2, "0")}`,
        documents_due: "2026-10-30",
      }),
  );
  const s = claimsSentence(many, TODAY);
  assert(spokenWords(s) <= MAX_TURN_WORDS, `${spokenWords(s)} words`);
  assert(s.startsWith("You have six claims. "), s);
  assertStringIncludes(s, "more claims on file.");
  const tight = claimsSentence(many, TODAY, 40);
  assert(spokenWords(tight) <= 40, `${spokenWords(tight)} words`);
  assert(spokenWords(tight) < spokenWords(s));
  // never fewer than one clause, however small the budget
  assertStringIncludes(claimsSentence(many, TODAY, 1), "There are five more claims on file.");
});

// The longest realistic data: a three-word adjuster's name, six-figure amounts with cents, dates in
// another year (which add the year), a long note, and the longest seeded document list.
const WORST: Partial<Claim> = {
  claim_type: "property",
  adjuster_name: "Maximiliana Rosalind Featherstonehaugh",
  amount_approved: 123456.78,
  filed_on: "2025-12-27",
  updated_on: "2025-12-28",
  documents_due: "2025-12-29",
  documents_required: [...CLAIM_DOCUMENTS.home],
  status_detail:
    "The adjuster is reviewing the repair estimates against the photos and the policy limits, and will call you once the inspection report comes back from the field team",
};

Deno.test("every mix of up to four claims fits one turn, and so does the chained read of up to three", () => {
  const opening = "Thanks, Mary Ann. You're all verified. Welcome back.";
  const mixes = (n: number): Claim["status"][][] =>
    n === 0 ? [[]] : mixes(n - 1).flatMap((m) => CLAIM_STATUSES.map((s) => [...m, s]));
  let checked = 0;
  for (let n = 1; n <= 4; n++) {
    for (const mix of mixes(n)) {
      const claims = mix.map((status, i) => claim({ ...WORST, status, claim_number: `CLM-2${i}9999` }));
      const s = claimsSentence(claims, TODAY);
      assert(spokenWords(s) <= MAX_TURN_WORDS, `${mix.join(",")}: ${spokenWords(s)} words: ${s}`);
      assertEquals(s.split("?").length - 1, 1, s);
      if (n <= 3) {
        const chained = verifiedStatusSentence(opening, claimsSentence(claims, TODAY, MAX_TURN_WORDS - words(opening)));
        assert(spokenWords(chained) <= MAX_TURN_WORDS, `chained ${mix.join(",")}: ${spokenWords(chained)} words`);
      }
      checked++;
    }
  }
  assertEquals(checked, 7 + 49 + 343 + 2401);
});

Deno.test("claim_documents: the list, the due date and how to send it, in one turn", () => {
  assertEquals(documentsSentence(tobiasClaims(), TODAY), TOBIAS_DOCUMENTS);
  assertEquals(spokenWords(TOBIAS_DOCUMENTS), 59);
  assertEquals(sentenceFor("claim_documents", { claims: tobiasClaims(), refDate: TODAY }), TOBIAS_DOCUMENTS);
  const docs = byNumber("CLM-240198")[0];
  assertEquals(
    documentsSentence([{ ...docs, documents_required: ["a police report"], documents_due: null }], TODAY),
    "For your home claim ending in one nine eight, we need a police report. " +
      "You can upload them at observeinsurance dot com slash claims, or email them to claims docs at observeinsurance dot com. " +
      "Would you like me to email you this list too?",
  );
  // a list that cannot be said whole is "a few documents", and the email carries the full list
  const fullList = "Would you like me to email you the full list?";
  for (
    const documents_required of [
      [],
      ["photos of the damage", "data {x}"],
      Array(12).fill("a signed statement of loss"),
    ]
  ) {
    const s = documentsSentence([{ ...docs, documents_required }], TODAY);
    assertStringIncludes(s, "we need a few documents, by October twenty-fourth.");
    assert(s.endsWith(fullList), s);
  }
  // a due date in another year makes the longest seeded list too long for the turn
  const late = documentsSentence([{ ...docs, documents_due: "2025-12-29" }], TODAY);
  assertStringIncludes(late, "we need a few documents, by December twenty-ninth, twenty twenty five.");
  assert(spokenWords(late) <= MAX_TURN_WORDS);
  // only claims awaiting documents are read; none is an error, never an invented list
  assertThrows(() => documentsSentence(byNumber("CLM-240115"), TODAY));
  assertEquals(
    sentenceFor("claim_documents", { claims: byNumber("CLM-240115"), refDate: TODAY }),
    sentenceFor("system_error"),
  );
});

Deno.test("claim_documents with several claims: lists while they fit, the rest mentioned, never dropped", () => {
  const docs = byNumber("CLM-240198")[0];
  const police = claim({
    claim_number: "CLM-240305",
    status: "awaiting_documents",
    documents_required: ["a police report"],
    documents_due: "2026-10-30",
    filed_on: "2026-10-02",
  });
  // two short lists both fit
  const photos = claim({
    claim_number: "CLM-240306",
    status: "awaiting_documents",
    documents_required: ["photos"],
    documents_due: null,
    filed_on: "2026-10-01",
  });
  assertEquals(
    documentsSentence([police, photos], TODAY),
    "For your auto claim ending in three zero five, we need a police report, by October thirtieth. " +
      "For your auto claim ending in three zero six, we need photos. " +
      "You can upload them at observeinsurance dot com slash claims, or email them to claims docs at observeinsurance dot com. " +
      "Would you like me to email you this list too?",
  );
  // the longest seeded list leaves no room for a second: the first is listed in brief, the second mentioned
  const two = documentsSentence([docs, police], TODAY);
  assert(spokenWords(two) <= MAX_TURN_WORDS, `${spokenWords(two)} words: ${two}`);
  assertStringIncludes(two, "ending in three zero five");
  assertStringIncludes(two, "ending in one nine eight");
  assert(two.endsWith("Would you like me to email you the full list?"), two);
  // a third claim awaiting documents is always mentioned
  const third = claim({ status: "awaiting_documents", documents_required: ["a receipt"], filed_on: "2026-09-01" });
  const s = documentsSentence([police, photos, third], TODAY);
  assertEquals(
    s,
    "For your auto claim ending in three zero five, we need a police report, by October thirtieth. Two more claims need documents too. " +
      "You can upload them at observeinsurance dot com slash claims, or email them to claims docs at observeinsurance dot com. " +
      "Would you like me to email you the full list?",
  );
  const four = documentsSentence([police, photos, third, { ...third, id: "x", claim_number: "CLM-240999" }], TODAY);
  assertStringIncludes(four, "Three more claims need documents too.");
  assert(spokenWords(four) <= MAX_TURN_WORDS, `${spokenWords(four)} words`);
  // worst case: two claims with the longest seeded list, due in another year
  const worst = [claim({ ...WORST, status: "awaiting_documents" }), claim({ ...WORST, status: "awaiting_documents" })];
  const tight = documentsSentence(worst, TODAY);
  assert(spokenWords(tight) <= MAX_TURN_WORDS, `${spokenWords(tight)} words`);
  assertStringIncludes(tight, "One more claim needs documents too.");
});

const TOBIAS_HOME_DETAIL =
  "For your home claim ending in one nine eight, we need photos of the damage, a contractor estimate, and proof of ownership for the damaged items, by October twenty-fourth. " +
  "Your adjuster is Leona Fairbanks. Would you like to hear how to send them, or have me email you this list?";
const SLOANE_DETAIL =
  "Your property claim ending in one seven seven was denied because the item class is not covered by the policy. " +
  "Your adjuster is Leona Fairbanks. " +
  "To appeal, send us a short letter within thirty days, saying why you disagree, with any new photos or estimates. " +
  "Is there anything else I can help with?";

Deno.test("claim_detail: the whole story of one claim, in one turn", () => {
  const anything = "Is there anything else I can help with?";
  // how the payment went out is said in the payment's own clause, not repeated as a second sentence
  assertEquals(
    claimDetailSentence(byNumber("CLM-240115")[0], TODAY),
    "Your auto claim ending in one one five was approved, and a payment of four thousand eight hundred twenty dollars was issued by direct deposit on October eighth. " +
      `Your adjuster is Leona Fairbanks. ${anything}`,
  );
  // a claim awaiting documents: its list, its due date and its adjuster, then how to send them on request
  assertEquals(claimDetailSentence(byNumber("CLM-240198")[0], TODAY), TOBIAS_HOME_DETAIL);
  assertEquals(spokenWords(TOBIAS_HOME_DETAIL), 50);
  assertEquals(
    claimDetailSentence(byNumber("CLM-240211")[0], TODAY),
    `Your auto claim ending in two one one is under review with your adjuster, Bertrand Wexley. A decision is expected within five business days. ${anything}`,
  );
  // a denial: the reason first (the summary already said sorry), the adjuster, and how to appeal
  assertEquals(claimDetailSentence(byNumber("CLM-240177")[0], TODAY), SLOANE_DETAIL);
  assertEquals(spokenWords(SLOANE_DETAIL), 53);
  assert(!/sorry/i.test(SLOANE_DETAIL));
  assertEquals(
    claimDetailSentence(byNumber("CLM-240230")[0], TODAY),
    `Your home claim ending in two three zero was received on October tenth and is waiting for an adjuster to be assigned. ${anything}`,
  );
  const base = byNumber("CLM-240115")[0];
  assertEquals(
    claimDetailSentence({ ...base, status: "approved", status_detail: null, adjuster_name: null }, TODAY),
    `Your auto claim ending in one one five was approved for four thousand eight hundred twenty dollars. ${anything}`,
  );
  // a closed claim names its adjuster too
  assertEquals(
    claimDetailSentence({ ...base, status: "closed", status_detail: "Closed at your request" }, TODAY),
    `Your auto claim ending in one one five is closed. Closed at your request. Your adjuster is Leona Fairbanks. ${anything}`,
  );
  // a payment note that says something else is kept as its own sentence
  assertEquals(
    claimDetailSentence({ ...base, status_detail: "Mailed to the address on file", adjuster_name: null }, TODAY),
    "Your auto claim ending in one one five was approved, and a payment of four thousand eight hundred twenty dollars was issued on October eighth. " +
      `Mailed to the address on file. ${anything}`,
  );
  assertStringIncludes(
    claimDetailSentence({ ...base, status_detail: "Payment was issued via check.", adjuster_name: null }, TODAY),
    "dollars was issued by check on October eighth. Is there",
  );
  const denied = byNumber("CLM-240177")[0];
  assertEquals(
    claimDetailSentence({ ...denied, status_detail: null, adjuster_name: null }, TODAY),
    "Your property claim ending in one seven seven was denied. " +
      `To appeal, send us a short letter within thirty days, saying why you disagree, with any new photos or estimates. ${anything}`,
  );
  assertStringIncludes(
    claimDetailSentence({ ...denied, status_detail: "ACV limits apply." }, TODAY),
    "was denied because ACV limits apply. Your adjuster",
  );
  // without an adjuster the claim awaiting documents says how to send them itself
  assertEquals(
    claimDetailSentence({ ...byNumber("CLM-240198")[0], adjuster_name: null }, TODAY),
    TOBIAS_DOCUMENTS,
  );
  assertEquals(
    sentenceFor("claim_detail", { claims: byNumber("CLM-240230"), refDate: TODAY }),
    claimDetailSentence(byNumber("CLM-240230")[0], TODAY),
  );
  assertEquals(sentenceFor("claim_detail", { claims: tobiasClaims(), refDate: TODAY }), sentenceFor("system_error"));
  assertThrows(() => claimDetailSentence({ ...base, status: "lost" as Claim["status"] }, TODAY));
});

Deno.test("claim_detail: optional parts are said while they fit; the status and the appeal window always are", () => {
  for (const status of CLAIM_STATUSES) {
    const s = claimDetailSentence(claim({ ...WORST, status }), TODAY);
    assert(spokenWords(s) <= MAX_TURN_WORDS, `${status}: ${spokenWords(s)} words: ${s}`);
    assert(s.endsWith("?"), s);
    assertEquals(s.split("?").length - 1, 1, s);
  }
  const paid = claimDetailSentence(claim({ ...WORST, status: "payment_issued" }), TODAY);
  // the long note does not fit next to the payment; the adjuster's name still does
  assert(!paid.includes("inspection report"), paid);
  assertStringIncludes(paid, "Your adjuster is Maximiliana Rosalind Featherstonehaugh.");
  // the appeal window is always said; how to appeal is said before the adjuster's name when only one fits
  const longReason = { ...WORST, status: "denied" as const, status_detail: WORST.status_detail };
  const denied = claimDetailSentence(claim(longReason), TODAY);
  assertStringIncludes(denied, "thirty days");
  const reasonless = claimDetailSentence(claim({ ...WORST, status: "denied", status_detail: null }), TODAY);
  assertStringIncludes(reasonless, "To appeal, send us a short letter within thirty days");
  assertStringIncludes(reasonless, "Your adjuster is Maximiliana Rosalind Featherstonehaugh.");
  // a tight budget keeps the status and the window, in their short forms
  assertEquals(
    claimDetailSentence(byNumber("CLM-240177")[0], TODAY, 20),
    "Your property claim ending in one seven seven was denied. You have thirty days to appeal. Is there anything else I can help with?",
  );
  // the claim awaiting documents: the adjuster and the instructions while both fit, else the adjuster
  // and the offer to hear how; with the list too long, "a few documents" and the full list by email
  const home = byNumber("CLM-240198")[0];
  assertEquals(
    claimDetailSentence({ ...home, documents_required: ["a police report"] }, TODAY),
    "For your home claim ending in one nine eight, we need a police report, by October twenty-fourth. Your adjuster is Leona Fairbanks. " +
      "You can upload them at observeinsurance dot com slash claims, or email them to claims docs at observeinsurance dot com. " +
      "Would you like me to email you this list too?",
  );
  const worst = claimDetailSentence(claim({ ...WORST, status: "awaiting_documents" }), TODAY);
  assert(spokenWords(worst) <= MAX_TURN_WORDS, `${spokenWords(worst)} words: ${worst}`);
  assertStringIncludes(worst, "Your adjuster is Maximiliana Rosalind Featherstonehaugh.");
});

Deno.test("claim free text is made speakable, or left out when it cannot be said whole", () => {
  const base = byNumber("CLM-240211")[0];
  const read = (detail: string | null, adjuster: string | null = "Bertrand Wexley") =>
    claimDetailSentence({ ...base, status_detail: detail, adjuster_name: adjuster }, TODAY);
  assertStringIncludes(read("Expected by 2026-10-30"), "Expected by October thirtieth.");
  assertStringIncludes(
    read("An offer of $12,500.50 is pending"),
    "twelve thousand five hundred dollars and fifty cents",
  );
  assertStringIncludes(read("Inspection on the 5th"), "Inspection on the fifth.");
  assertStringIncludes(read("Depreciation of 12% applies"), "twelve percent");
  assertStringIncludes(read("Linked to CLM-240115"), "Linked to CLM-two four zero one one five.");
  assertStringIncludes(read("Covers 12,000 miles and 2.5 days"), "twelve thousand miles and two point five days");
  assertStringIncludes(read("Repair shop — “pending”"), 'Repair shop - "pending".');
  // An unsafe or overlong detail is dropped, never spoken or cut, and the rest of the answer still goes out.
  assertEquals(read("waiting on data {x}"), read(null));
  const long = `The adjuster is ${"still reviewing the repair estimates and the photos, ".repeat(6)}and will call you.`;
  assertEquals(read(long), read(null));
  assertStringIncludes(read(null, null), "is under review. Is there");
  assertStringIncludes(read(null, "A".repeat(80)), "is under review. Is there");
});

Deno.test("claim_not_identified offers the claims by type and ending, never asking for a number", () => {
  const offer = (claim_number_last3: string, claim_type?: string, status = "received") => ({
    claim_number_last3,
    claim_type,
    status,
  });
  assertEquals(
    sentenceFor("claim_not_identified", { claims: [offer("198", "home"), offer("115", "auto")] }),
    "Which claim do you mean, your home claim ending in one nine eight or your auto claim ending in one one five?",
  );
  // the same type: said once
  assertEquals(
    sentenceFor("claim_not_identified", { claims: [offer("777", "auto"), offer("115", "auto")] }),
    "Which auto claim do you mean, the one ending in seven seven seven or one one five?",
  );
  // the same ending: told apart by type, or by where they stand when the type is the same too
  assertEquals(
    sentenceFor("claim_not_identified", { claims: [offer("198", "home"), offer("198", "property")] }),
    "Which claim do you mean, your home claim ending in one nine eight or your property claim ending in one nine eight?",
  );
  assertEquals(
    sentenceFor("claim_not_identified", {
      claims: [offer("198", "home", "awaiting_documents"), offer("198", "home", "denied")],
    }),
    "Which home claim do you mean, the one ending in one nine eight that needs documents or the one ending in one nine eight that was denied?",
  );
  assertEquals(
    sentenceFor("claim_not_identified", {
      claims: [offer("198", "home"), offer("115", "auto"), offer("090", "property"), offer("849", "auto")],
    }),
    "Which claim do you mean, your home claim ending in one nine eight, your auto claim ending in one one five, " +
      "your property claim ending in zero nine zero, or your auto claim ending in eight four nine?",
  );
  // more than four: the first four are offered
  const five = sentenceFor("claim_not_identified", {
    claims: ["1", "2", "3", "4", "5"].map((n) => offer(`10${n}`, "auto")),
  });
  assertEquals(
    five,
    "Which auto claim do you mean, the one ending in one zero one, one zero two, one zero three, or one zero four?",
  );
  // without types (older data) the endings alone
  assertEquals(
    sentenceFor("claim_not_identified", { claims: [{ claim_number_last3: "198" }, { claim_number_last3: "115" }] }),
    "Which claim do you mean, the one ending in one nine eight or one one five?",
  );
  // fewer than two endings to offer: by type, never by a number (rule 11)
  const ask = "Which claim do you mean, your auto, home or property claim?";
  assertEquals(sentenceFor("claim_not_identified"), ask);
  assertEquals(sentenceFor("claim_not_identified", { claims: [offer("198", "home")] }), ask);
  assertEquals(sentenceFor("claim_not_identified", { claims: [offer("{{x}}"), offer("12")] }), ask);
  for (const s of [ask, five]) assert(!/digits|number/i.test(s), s);
  assertEquals(
    sentenceFor("no_documents_needed"),
    "None of your claims needs documents right now. Is there anything else I can help with?",
  );
});

Deno.test("speakDigits spaces digits and drops everything else", () => {
  assertEquals(speakDigits("115"), "one one five");
  assertEquals(speakDigits("CLM-240115"), "two four zero one one five");
  assertEquals(speakDigits("0142"), "zero one four two");
  assertEquals(speakDigits(""), "");
});

Deno.test("speakPhone reads three groups with a comma between them", () => {
  const spoken = "six zero two, five five five, zero one nine nine";
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
  assertSpeakable(`Please call our main line at ${MAIN_LINE_SPOKEN}, and someone there will help you.`);
  assertSpeakable("I'm not finding an account under six zero two, five five five, zero one nine nine.");
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
    "Thanks! Let me read that back. John Smith, and your email is J, O, H, N, dot, S, M, I, T, H, four, two, at gmail dot com. Did I get that right?",
  );
  // a callback number the caller said is read back in three groups, the way a person reads one
  assertEquals(
    sentenceFor("contact_readback", {
      first_name: "John",
      last_name: "Smith",
      email: "john.smith42@gmail.com",
      callback_phone: "+16025550177",
    }),
    "Thanks! Let me read that back. John Smith, your email is J, O, H, N, dot, S, M, I, T, H, four, two, at gmail dot com, and the best number is six zero two, five five five, zero one seven seven. Did I get that right?",
  );
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jane", last_name: "O'Brien", callback_phone: "6025550177" }),
    "Thanks! Just to confirm, that's Jane O'Brien, and the best number is six zero two, five five five, zero one seven seven. Did I get that right?",
  );
  // a number that is not ten digits is left out rather than read wrong
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jane", last_name: "O'Brien", callback_phone: "5550177" }),
    "Thanks! Just to confirm, that's Jane O'Brien. Did I get that right?",
  );
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jane", last_name: "O'Brien" }),
    "Thanks! Just to confirm, that's Jane O'Brien. Did I get that right?",
  );
  // accents are folded for speech
  assertEquals(
    sentenceFor("contact_readback", { first_name: "Jos\u00e9", last_name: "Pe\u00f1a" }),
    "Thanks! Just to confirm, that's Jose Pena. Did I get that right?",
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
    "There's already an email on your account, so I can't change it on this call, but I can have someone from our claims team call you back about it. Would you like that?",
  );
  assertEquals(
    sentenceFor("not_pending"),
    "Sorry about that, let me take your details again. What's your first and last name?",
  );
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
    "Perfect, I've saved your details. I can take down what happened now, email you the steps to start a claim, or have someone from our claims team call you back. Which would you like?",
  );
  assertEquals(
    sentenceFor("contact_saved_new", { first_name: "Jane", has_email: false }),
    "Perfect, I've saved your details. I can take down what happened now, have someone from our claims team call you back, or you can find the steps to start a claim at observeinsurance dot com slash claims. Which would you like?",
  );
  // a start_claim already asked for these details: the loss was told, so the claim is taken down now
  for (const has_email of [true, false]) {
    assertEquals(
      sentenceFor("contact_saved_new", { first_name: "Jane", has_email, resume_claim: true }),
      "Perfect, I've saved your details. Shall I go ahead and take down that claim now?",
    );
  }
  assertStringIncludes(sentenceFor("contact_saved_new"), "Perfect, I've saved your details.");
  assertEquals(
    sentenceFor("contact_saved_existing", { first_name: "Teague" }),
    "Got it. I've passed that email to our team to add to your account. Is there anything else I can help with?",
  );
  assertEquals(
    sentenceFor("contact_saved_existing"),
    "Got it. I've passed that email to our team to add to your account. Is there anything else I can help with?",
  );
});

Deno.test("the new-caller sentences lead into the details, and an email to a given address says so", () => {
  assertEquals(
    sentenceFor("not_found_final"),
    "I'm sorry, I still can't find an account for that number. If you're new with us, I'd be glad to help you get started. Could I get your first and last name?",
  );
  assertEquals(
    sentenceFor("email_sent", { target: "given" }),
    "There you go, I've emailed that to the address you gave me. It should arrive within a few minutes. Anything else I can help with?",
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

// The script opens no_lookup_yet and not_verified with "Happy to check that." and "Happy to help
// with that once ..."; only those openers are allowed, and every other "happy to" stays banned.
const OWNER_HAPPY_TO = /^Happy to (check that\.|help with that once (you're|I've) )/;

Deno.test("no spoken string carries banned words or a double dash", () => {
  for (const [code, spoken] of ALL_SPOKEN) {
    assert(!spoken.includes("--"), `${code} has a double dash`);
    const s = spoken.replace(OWNER_HAPPY_TO, "");
    for (
      const banned of [
        /\bgotcha\b/i,
        /\bhoney\b/i,
        /\blove\b/i,
        /\bsweetie\b/i,
        /\bdear\b/i,
        /I understand your concern/i,
        // the reference prompt's call-center phrases and stock reactions
        /\bAbsolutely\b/,
        /\bCertainly\b/,
        /great question/i,
        /happy to (help|assist|check)/i,
        /I understand your frustration/i,
        /\bsystem\b/i,
        /\bdatabase\b/i,
      ]
    ) {
      assert(!banned.test(s), `${code} says ${banned}`);
    }
    assert(!/\bTessa\b/.test(s), `${code} still names the old assistant`);
  }
});

// ---------------------------------------------------------------------------------------------
// The warmth pass: the words got warmer; the facts, the closing questions and the cues did not move.
// ---------------------------------------------------------------------------------------------
const OFFICE_WORDING = [
  /for security purposes/i,
  /please be advised/i,
  /\bkindly\b/i,
  /valued customer/i,
  /apologi[sz]e for (any|the) inconvenience/i,
  /\bat this time\b/i,
  /\bassist you\b/i,
];
// Spelled-out forms a person on the phone would contract.
const UNCONTRACTED =
  /\b(I am|you are|we are|they are|it is|that is|there is|do not|does not|did not|cannot|can not|will not|would not|is not|are not|was not|I will|I have (sent|emailed|recorded|passed|saved|told))\b/i;

Deno.test("spokenWords: a number in figures counts one word per digit, as it is said", () => {
  assertEquals(spokenWords("Call 1-800-555-0142, please."), 13);
  assertEquals(spokenWords("one eight hundred"), 3);
  assertEquals(spokenWords("  "), 0);
  // the main line in rep_unavailable is about eleven spoken words, not one
  assertEquals(spokenWords(sentenceFor("rep_unavailable")), 38);
  // a hyphenated word is still one word
  assertEquals(spokenWords("a ten-digit number"), 3);
});

Deno.test("warm wording: no office phrases, contractions throughout, the caller's first name at most once", () => {
  for (const [code, data] of VARIANTS) {
    const s = sentenceFor(code, data);
    for (const re of OFFICE_WORDING) assert(!re.test(s), `${code} says ${re}: ${s}`);
    // a claim's details quote the claims system's own note ("is not covered by the policy") as written
    if (code !== "claim_detail") assert(!UNCONTRACTED.test(s), `${code} has an uncontracted form: ${s}`);
    const first = typeof data?.first_name === "string" ? spokenName(data.first_name).split(" ")[0] : "";
    if (first) {
      const times = s.split(/[^A-Za-z']+/).filter((w) => w === first).length;
      assert(times <= 1, `${code} says the first name ${times} times: ${s}`);
    }
  }
  // one sympathy per moment: a lock says sorry once, and the lock's claim refusal does not say it again
  assert(/\bsorry\b/i.test(sentenceFor("locked")));
  assert(!/\bsorry\b/i.test(sentenceFor("claim_locked")));
  // nor do the turns before a lock (a wrong DOB, then the lock; an unreadable DOB twice, then the lock)
  assert(!/\bsorry\b/i.test(sentenceFor("auth_failed")), sentenceFor("auth_failed"));
  assert(!/\bsorry\b/i.test(sentenceFor("dob_unreadable")), sentenceFor("dob_unreadable"));
  // a reported loss hears sorry once: in the sentence that starts the claim (or sends them to identify
  // first), never again in the resume question, the read-back or the filed answer after it
  const verified = sentenceFor("verified", { first_name: "Tobias" });
  assert(/\bsorry\b/i.test(verifiedFileClaimSentence(verified)));
  assert(!/\bsorry\b/i.test(verifiedFileClaimSentence(verified, true)));
  for (const code of ["claim_needs_verification", "claim_needs_lookup", "claim_needs_contact"] as const) {
    assert(/^I'm sorry to hear that\./.test(sentenceFor(code)), sentenceFor(code));
  }
  for (
    const s of [
      sentenceFor("contact_saved_new", { first_name: "Dana", resume_claim: true }),
      sentenceFor("claim_readback", { claim_type: "home", loss_date: "2026-10-11", today: "2026-10-13" }),
      sentenceFor("claim_filed", { claim_last3: "412", emailed: true }),
      sentenceFor("claim_intake_saved", { first_name: "Dana" }),
    ]
  ) assert(!/\bsorry\b/i.test(s), s);
  // "Perfect" never opens a verified sentence: a denial or a reported loss can follow it in one breath
  assert(!/\bperfect\b/i.test(verified), verified);
  // no "no documents" answer frames a claim's state as good news (it can follow a denial)
  assert(!/good news/i.test(sentenceFor("no_documents_needed")));
  // a callback queued and an email sent, often back to back, open differently
  const opener = (t: string) => t.split(/[ ,.!]/)[0];
  assertNotEquals(opener(sentenceFor("rep_queued", { target: "account" })), opener(sentenceFor("email_sent")));
  // and never two apologies in one sentence
  for (const [code, s] of ALL_SPOKEN) {
    assert((s.match(/\bsorry\b/gi) ?? []).length <= 1, `${code} apologises twice: ${s}`);
  }
});

// Every sentence still ends on the one question it ended on before the warmth pass, so the prompt's
// routing ("when a sentence asks ...") still holds. The one deliberate change is the shared closer,
// "Is there anything else I can help you with?", now "Anything else I can help with?".
const ANYTHING = "Anything else I can help with?";
const IS_THERE = "Is there anything else I can help with?";
const CLOSINGS: [Code, Record<string, unknown> | undefined, string][] = [
  ["bad_args", undefined, "Could you say it again?"],
  ["system_error", undefined, "Which would you prefer?"],
  ["unknown_tool", undefined, "Which would you prefer?"],
  ["invalid_phone", undefined, "Could you say it again?"],
  ["not_found", { digits: "6025550199" }, "Is that the right number?"],
  ["not_found", undefined, "Is that the right number?"],
  ["not_found_final", undefined, "Could I get your first and last name?"],
  ["needs_dob", undefined, "what's the date of birth on the account?"],
  ["already_verified", undefined, "What can I help you with?"],
  ["locked", undefined, "Which would you prefer?"],
  ["dob_give_up", undefined, "Which would you prefer?"],
  ["verified", { first_name: "Tobias" }, "What can I help you with today?"],
  ["verified", undefined, "What can I help you with today?"],
  ["auth_failed", undefined, "Could you give me your date of birth one more time?"],
  ["no_lookup_yet", undefined, "What's the number?"],
  ["dob_unreadable", undefined, "could you give me the month, day and year?"],
  [
    "ok",
    { claims: SEED_CLAIMS.filter((c) => c.customer_id === TOBIAS), refDate: TODAY },
    "Would you like me to go over what's needed, or email you the list?",
  ],
  ["no_claims", undefined, "Would you like me to explain how to start one?"],
  ["claim_documents", { claims: SEED_CLAIMS, refDate: TODAY }, "Would you like me to email you this list too?"],
  ["no_documents_needed", undefined, IS_THERE],
  ["claim_detail", { claims: byNumber("CLM-240115"), refDate: TODAY }, IS_THERE],
  ["claim_not_identified", undefined, "Which claim do you mean, your auto, home or property claim?"],
  ["not_verified", { level: "none" }, "What's the phone number on your account?"],
  ["not_verified", { level: "phone_found" }, "What's the date of birth?"],
  ["not_verified", { level: "locked" }, "Which would you prefer?"],
  ["rep_queued", { target: "account" }, ANYTHING],
  ["rep_queued", { target: "given", digits: "6025550177" }, ANYTHING],
  ["rep_queued_no_number", undefined, "What's the best number for a representative to reach you?"],
  ["callback_updated", { digits: "6025550177" }, ANYTHING],
  ["rep_recorded", undefined, ANYTHING],
  ["rep_already_queued", undefined, ANYTHING],
  ["rep_unavailable", undefined, ANYTHING],
  ["emergency_logged", undefined, "Are you safe right now?"],
  ["emergency_logged", { db_failed: true }, "Are you safe right now?"],
  ["email_sent", undefined, ANYTHING],
  ["email_sent", { target: "given" }, ANYTHING],
  ["email_already_sent", undefined, ANYTHING],
  ["no_email_on_file", undefined, "Which would you prefer?"],
  ["email_failed", undefined, "Which would you prefer?"],
  ["contact_readback", { first_name: "Jane", last_name: "Doe" }, "Did I get that right?"],
  ["contact_readback", undefined, "did I get your details right?"],
  ["contact_invalid_email", undefined, "Could you spell it for me, letter by letter?"],
  ["contact_needs_name", undefined, "could I get your first and last name?"],
  ["contact_needs_phone", undefined, "What's the best number to reach you?"],
  ["email_on_file", undefined, "Would you like that?"],
  ["not_pending", undefined, "What's your first and last name?"],
  ["not_pending", { verified: true }, "could you spell that email for me one more time, letter by letter?"],
  ["contact_retry", undefined, "What did I get wrong, your name or your email?"],
  ["contact_saved_new", { first_name: "Jane" }, "Which would you like?"],
  ["contact_saved_new", { first_name: "Jane", resume_claim: true }, "Shall I go ahead and take down that claim now?"],
  ["contact_saved_existing", { first_name: "Teague" }, IS_THERE],
  ["claim_readback", { claim_type: "auto", loss_date: "2026-10-10", today: TODAY }, "Is that correct?"],
  ["claim_needs_lookup", undefined, "what's the phone number on your account?"],
  ["claim_needs_contact", undefined, "can I get your first and last name?"],
  ["claim_needs_verification", undefined, "What's the date of birth on the account?"],
  ["claim_locked", undefined, "Would you like that?"],
  ["claim_needs_description", undefined, "Can you tell me briefly what happened?"],
  ["claim_bad_date", undefined, "What day did it happen?"],
  ["claim_date_help", undefined, "Would you like a callback?"],
  ["claim_needs_phone", undefined, "what's the best number for our claims team to reach you?"],
  ["claim_too_old", undefined, "Would you like a callback?"],
  ["claim_already_filed", { claim_last3: "472" }, IS_THERE],
  ["claim_not_pending", undefined, "Can you tell me what happened?"],
  ["claim_retry", undefined, "What should I change?"],
  ["claim_filed", { claim_last3: "472", emailed: true }, IS_THERE],
  ["claim_intake_saved", { first_name: "Jane", emailed: true }, IS_THERE],
];

Deno.test("every sentence ends on the one question it ended on before", () => {
  for (const [code, data, closing] of CLOSINGS) {
    const s = sentenceFor(code, data);
    assertEquals((s.match(/\?/g) ?? []).length, 1, `${code}: one question: ${s}`);
    // the closing sentence itself, from its own opening word (or after a short opener such as "Sorry,")
    assert(s.toLowerCase().endsWith(closing.toLowerCase()), `${code} no longer ends on "${closing}": ${s}`);
  }
  for (const code of CODES) assert(CLOSINGS.some(([c]) => c === code), `${code} has no closing pinned`);
  const verified = sentenceFor("verified", { first_name: "Tobias" });
  assert(verifiedFileClaimSentence(verified).endsWith("Can you tell me a little more about what happened?"));
  assert(verifiedFileClaimSentence(verified, true).endsWith("Shall I go ahead and take down that claim now?"));
});

Deno.test("every question for a date of birth, a phone number or an email is one the transcript masks", () => {
  // post_call masks the caller's answer to these questions whole (redact.ts asksForSensitive), so the
  // warmer wording must still carry the words it keys on.
  const asks: [Code, Record<string, unknown> | undefined][] = [
    ["needs_dob", undefined],
    ["auth_failed", undefined],
    ["dob_unreadable", undefined],
    ["not_verified", { level: "phone_found" }],
    ["claim_needs_verification", undefined],
    ["invalid_phone", undefined],
    ["not_found", { digits: "6025550199" }],
    ["not_found", undefined],
    ["no_lookup_yet", undefined],
    ["not_verified", { level: "none" }],
    ["rep_queued_no_number", undefined],
    ["contact_needs_phone", undefined],
    ["claim_needs_lookup", undefined],
    ["claim_needs_phone", undefined],
    ["contact_invalid_email", undefined],
    ["not_pending", { verified: true }],
    ["contact_retry", { part: "email" }],
    ["no_email_on_file", undefined],
    ["contact_readback", { first_name: "Jane", last_name: "Doe", email: "jane.doe@gmail.com" }],
  ];
  for (const [code, data] of asks) {
    const s = sentenceFor(code, data);
    assert(asksForSensitive(s), `${code} no longer reads as a question for a DOB, number or email: ${s}`);
  }
  // and an answer to "anything else" is not masked
  assert(!asksForSensitive(sentenceFor("email_sent")), sentenceFor("email_sent"));
  assert(!asksForSensitive(sentenceFor("rep_recorded")));
});

// ---------------------------------------------------------------------------------------------
// First notice of loss.
// ---------------------------------------------------------------------------------------------
Deno.test("claim sentences: exact wording", () => {
  assertEquals(
    sentenceFor("claim_needs_lookup"),
    "I'm sorry to hear that. I can help you start a claim. First, what's the phone number on your account?",
  );
  assertEquals(
    sentenceFor("claim_needs_contact"),
    "I'm sorry to hear that. I can take down the details for our claims team. First, can I get your first and last name?",
  );
  assertEquals(
    sentenceFor("claim_needs_verification"),
    "I'm sorry to hear that. I'll just need to verify you first. What's the date of birth on the account?",
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
    "Your claim is already filed, with a number ending in four seven two. Is there anything else I can help with?",
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
  assertEquals(codes.length, 18);
  for (const [code, s] of ALL_SPOKEN.filter(([c]) => c.startsWith("claim_"))) {
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

// Read-backs that spell an address letter by letter are the only sentences allowed past one turn.
const SPELLING_READBACKS: ReadonlySet<Code> = new Set(["contact_readback"]);
const MAX_READBACK_WORDS = 75;

Deno.test("every spoken sentence fits one turn: sixty words at most, seventy-five for a spelled read-back", () => {
  // The worst realistic data for every dynamic sentence: the longest names, four claims, the longest
  // seeded document list, six-figure amounts and dates in another year.
  const worst = (status: Claim["status"], i: number) =>
    claim({ ...WORST, status, claim_number: `CLM-2${i}9999`, filed_on: `2025-12-${10 + i}` });
  const four = (["awaiting_documents", "denied", "payment_issued", "under_review"] as const).map(worst);
  const cases: [Code, Record<string, unknown> | undefined][] = [
    ...VARIANTS,
    ["verified", { first_name: "Mary Ann" }],
    ["ok", { claims: four, refDate: TODAY }],
    ["ok", { claims: tobiasClaims(), refDate: TODAY }],
    ["claim_documents", { claims: [worst("awaiting_documents", 1), worst("awaiting_documents", 2)], refDate: TODAY }],
    ["claim_documents", { claims: tobiasClaims(), refDate: TODAY }],
    ...CLAIM_STATUSES.map((status, i): [Code, Record<string, unknown>] => [
      "claim_detail",
      { claims: [worst(status, i)], refDate: TODAY },
    ]),
    ["claim_not_identified", { claims: ["198", "115", "090", "849"].map((n) => ({ claim_number_last3: n })) }],
    // four claims offered with a type each, all with the same ending: told apart by where they stand
    ...[true, false].map((sameType): [Code, Record<string, unknown>] => [
      "claim_not_identified",
      {
        claims: (["awaiting_documents", "under_review", "payment_issued", "denied", "closed"] as const).map((
          status,
          i,
        ) => ({ claim_number_last3: "999", claim_type: sameType || i % 2 ? "property" : "home", status })),
      },
    ]),
    ["contact_readback", {
      first_name: "Mary Ann",
      last_name: "Featherstonehaugh-Whitley",
      email: "maryann.featherstonehaugh@outlook.com",
      callback_phone: "+16025550177",
    }],
    ["contact_saved_new", { first_name: "Mary Ann", has_email: false }],
    ["contact_saved_existing", { first_name: "Mary Ann" }],
    ["contact_retry", { has_email: true, has_phone: true }],
    ["claim_readback", {
      claim_type: "property",
      loss_date: "2025-12-24",
      // the longest summary the read-back says is 80 characters
      summary: "a tree branch through the back porch roof during the big thunderstorm last week",
      today: TODAY,
    }],
    ["claim_intake_saved", { first_name: "Mary Ann", emailed: true }],
    ["claim_filed", { claim_last3: "472", emailed: true }],
  ];
  for (const [code, data] of cases) {
    const s = sentenceFor(code, data);
    const limit = SPELLING_READBACKS.has(code) ? MAX_READBACK_WORDS : MAX_TURN_WORDS;
    assert(spokenWords(s) <= limit, `${code} has ${spokenWords(s)} words: ${s}`);
  }
  // every code is covered, and the seeded account's answers fit with room to spare
  for (const code of CODES) assert(cases.some(([c]) => c === code), `${code} has no representative case`);
  assert(spokenWords(claimsSentence(tobiasClaims(), TODAY)) <= MAX_TURN_WORDS);
  const opening = "Thanks, Tobias. You're all verified. Welcome back.";
  assert(
    spokenWords(`${opening} ${claimsSentence(tobiasClaims(), TODAY, MAX_TURN_WORDS - spokenWords(opening))}`) <=
      MAX_TURN_WORDS,
  );
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
  const plain = "Thanks, Tobias. You're all verified. What can I help you with today?";
  const welcome =
    "Thanks, Tobias. You're all verified. Welcome back. I see you called on October tenth. Is this about the same claim as last time, or something else?";
  assertEquals(withoutTrailingQuestion(plain), "Thanks, Tobias. You're all verified.");
  assertEquals(
    withoutTrailingQuestion(welcome),
    "Thanks, Tobias. You're all verified. Welcome back. I see you called on October tenth.",
  );
  assertEquals(withoutTrailingQuestion("No question here."), "No question here.");
  assertEquals(
    withoutTrailingQuestion(sentenceFor("verified", { first_name: "St. John" })),
    "Thanks, St. John. You're all verified.",
  );
  // the caller has usually described the loss already, so the question asks for more, not for it again
  assertEquals(
    verifiedFileClaimSentence(plain),
    "Thanks, Tobias. You're all verified. I'm sorry you're dealing with this. Let's get your claim started. Can you tell me a little more about what happened?",
  );
  assertEquals(
    verifiedFileClaimSentence(welcome),
    "Thanks, Tobias. You're all verified. Welcome back. I see you called on October tenth. I'm sorry you're dealing with this. Let's get your claim started. Can you tell me a little more about what happened?",
  );
  // the loss was told to a start_claim that asked for verification first: take it down now
  assertEquals(
    verifiedFileClaimSentence(plain, true),
    "Thanks, Tobias. You're all verified. Shall I go ahead and take down that claim now?",
  );
  assertEquals(
    verifiedFileClaimSentence(welcome, true),
    "Thanks, Tobias. You're all verified. Welcome back. I see you called on October tenth. Shall I go ahead and take down that claim now?",
  );
  const status = claimsSentence(byNumber("CLM-240115"), TODAY);
  assertEquals(verifiedStatusSentence(plain, status), `Thanks, Tobias. You're all verified. ${status}`);
  assertEquals(
    verifiedStatusSentence(plain, sentenceFor("no_claims")),
    "Thanks, Tobias. You're all verified. I'm not seeing any claims on file for your account. Would you like me to explain how to start one?",
  );
});

// ---------------------------------------------------------------------------------------------
// One phrasing: the most-heard sentences in the warm script, the same words for every call key.
// ---------------------------------------------------------------------------------------------
const ANYTHING_ELSE_ASK = /\banything else\b[^?]*\?$/i;
// [code, data, how it ends, words it says, words it never says]
const MOST_HEARD: [Code, Record<string, unknown> | undefined, RegExp, string[], string[]][] = [
  ["needs_dob", undefined, /date of birth on the account\?$/, ["Thanks!", "safe", "date of birth on the account"], []],
  [
    "not_found",
    { digits: "6025550199" },
    /\. Is that the right number\?$/,
    ["an account under six zero two, five five five, zero one nine nine."],
    [],
  ],
  ["not_found", undefined, /\. Is that the right number\?$/, ["an account under that number."], []],
  [
    "not_found_final",
    undefined,
    /\. Could I get your first and last name\?$/,
    ["still", "account", "that number", "If you're new with us", "get", "started"],
    [],
  ],
  ["verified", { first_name: "Tobias" }, /\. What can I help you with today\?$/, ["Thanks, Tobias.", "verified."], []],
  ["verified", undefined, /\. What can I help you with today\?$/, ["Thanks.", "verified."], []],
  [
    "ok",
    { claims: SEED_CLAIMS.filter((c) => c.customer_id === TOBIAS), refDate: TODAY },
    /\bgo over what's needed, or email you the list\?$/,
    [
      "You have two claims.",
      "Your home claim ending in one nine eight needs documents from you by October twenty-fourth.",
      "Your auto claim ending in one one five was paid, four thousand eight hundred twenty dollars on October eighth.",
    ],
    [],
  ],
  [
    "ok",
    { claims: byNumber("CLM-240177"), refDate: TODAY },
    /\bthe reason and how to appeal\?$/,
    ["Your property claim ending in one seven seven was denied, I'm sorry to say."],
    [],
  ],
  [
    "ok",
    { claims: SEED_CLAIMS, refDate: TODAY },
    /\bgo over what's needed, or email you the list\?$/,
    ["You have five claims.", "more claims on file."],
    [],
  ],
  ["ok", { claims: byNumber("CLM-240230"), refDate: TODAY }, /\babout it\?$/, [
    "Your home claim ending in two three zero was received on October tenth and is waiting for an adjuster.",
  ], []],
  [
    "rep_queued",
    { target: "account" },
    ANYTHING_ELSE_ASK,
    [
      "I've passed this to our claims team.",
      "Someone will call you back at the number on your account within one business day.",
    ],
    [],
  ],
  [
    "rep_queued",
    { target: "given", digits: "6025550177" },
    ANYTHING_ELSE_ASK,
    ["Someone will call you back at the number you gave me, ending in zero one seven seven, within one business day."],
    [],
  ],
  [
    "rep_queued",
    { target: "caller_id" },
    ANYTHING_ELSE_ASK,
    ["Someone will call you back at the number you're calling from within one business day."],
    [],
  ],
  ["rep_queued", undefined, ANYTHING_ELSE_ASK, ["Someone will call you back within one business day."], []],
  [
    "email_sent",
    undefined,
    ANYTHING_ELSE_ASK,
    ["I've emailed that to the address on your account", "within a few minutes"],
    ["address you gave me"],
  ],
  [
    "email_sent",
    { target: "given" },
    ANYTHING_ELSE_ASK,
    ["I've emailed that to the address you gave me", "within a few minutes"],
    ["on your account"],
  ],
  [
    "claim_filed",
    { claim_last3: "472", emailed: true },
    ANYTHING_ELSE_ASK,
    [
      "Your claim number ends in four seven two, and I've emailed the details to the email on file.",
      "An adjuster will reach out within one business day.",
    ],
    [],
  ],
  [
    "claim_filed",
    { claim_last3: "472", emailed: false },
    ANYTHING_ELSE_ASK,
    ["Your claim number ends in four seven two.", "An adjuster will reach out within one business day."],
    ["email"],
  ],
  ["claim_filed", {}, ANYTHING_ELSE_ASK, ["Your claim is filed."], ["email"]],
  [
    "claim_intake_saved",
    { first_name: "Jane", emailed: true },
    ANYTHING_ELSE_ASK,
    [
      "Jane",
      "claim details",
      "our claims team",
      "a confirmation to your email.",
      "A specialist will call you within one business day to finish setting it up.",
    ],
    [],
  ],
  [
    "claim_intake_saved",
    { first_name: "Jane", emailed: false },
    ANYTHING_ELSE_ASK,
    ["Jane", "claim details", "our claims team", "A specialist will call you within one business day"],
    ["confirmation", "email"],
  ],
  [
    "contact_saved_new",
    { first_name: "Jane" },
    /\. Which would you like\?$/,
    [
      "Perfect, I've saved your details.",
      "I can take down what happened now, email you the steps to start a claim, or have someone from our claims team call you back.",
    ],
    ["Jane"],
  ],
  [
    "contact_saved_new",
    { first_name: "Jane", has_email: false },
    /\. Which would you like\?$/,
    ["or you can find the steps to start a claim at observeinsurance dot com slash claims."],
    ["Jane", "email you"],
  ],
  [
    "contact_saved_new",
    { first_name: "Jane", resume_claim: true },
    /\. Shall I go ahead and take down that claim now\?$/,
    ["Perfect, I've saved your details."],
    ["Jane"],
  ],
  [
    "claim_readback",
    { claim_type: "auto", loss_date: "2026-10-10", summary: "a cracked windshield", today: TODAY },
    /\. An auto claim, for a cracked windshield, from Saturday, October tenth\. Is that correct\?$/,
    [],
    [],
  ],
  [
    "claim_readback",
    { claim_type: "home", loss_date: "2025-12-24", today: TODAY },
    /\. A home claim from Wednesday, December twenty-fourth, twenty twenty five\. Is that correct\?$/,
    [],
    [],
  ],
  [
    "contact_readback",
    { first_name: "Jane", last_name: "Doe", email: "jane.doe42@gmail.com", callback_phone: "+16025550177" },
    /\bDid I get that right\?$/,
    [
      " Jane Doe, your email is J, A, N, E, dot, D, O, E, four, two, at gmail dot com, and the best number is six zero two, five five five, zero one seven seven.",
    ],
    [],
  ],
  [
    "contact_readback",
    { first_name: "Jane", last_name: "Doe", email: "jane.doe42@gmail.com" },
    /\bDid I get that right\?$/,
    [" Jane Doe, and your email is J, A, N, E, dot, D, O, E, four, two, at gmail dot com."],
    [],
  ],
  [
    "contact_readback",
    { first_name: "Jane", last_name: "Doe", callback_phone: "+16025550177" },
    /\bDid I get that right\?$/,
    [" Jane Doe, and the best number is six zero two, five five five, zero one seven seven."],
    [],
  ],
  ["contact_readback", { first_name: "Jane", last_name: "Doe" }, /\bDid I get that right\?$/, [" Jane Doe."], []],
];

Deno.test("one phrasing: every call key, and so every replay of a call, hears the words no call key hears", () => {
  assertEquals(PHRASINGS, 1);
  const cases: [Code, Record<string, unknown> | undefined][] = [
    ...VARIANTS,
    ...MOST_HEARD.map(([code, data]): [Code, Record<string, unknown> | undefined] => [code, data]),
    // a second number that misses and a corrected read-back hear the same frame as the first
    ["not_found", { digits: "6025550198" }],
    ["claim_readback", { claim_type: "home", loss_date: "2026-10-09", summary: "a burst pipe", today: TODAY }],
  ];
  for (const [code, data] of cases) {
    const plain = sentenceFor(code, data);
    assertEquals(sentenceFor(code, data, ""), plain, code);
    for (const key of CALL_KEYS) {
      assertEquals(sentenceFor(code, data, key), plain, `${code} ${key} ${JSON.stringify(data)}`);
    }
  }
  // the verified opening every verified answer shares, and the chained claims read after it
  const opening = "Thanks, Tobias. You're all verified.";
  for (const key of CALL_KEYS) {
    assertEquals(verifiedThanks("Tobias", key), opening, key);
    assertEquals(claimsSentence(tobiasClaims(), TODAY, MAX_TURN_WORDS - spokenWords(opening), key), TOBIAS_SUMMARY);
    assertEquals(claimsSentence(SEED_CLAIMS, TODAY, MAX_TURN_WORDS, key), claimsSentence(SEED_CLAIMS, TODAY), key);
  }
});

Deno.test("variantIndex: a pure function of the call key and the code, spread over an explicit count", () => {
  // pinned: the same key and code pick the same index in every process, on every replay of the call
  assertEquals(
    ["needs_dob", "not_found", "verified", "ok", "rep_queued", "email_sent"].map((c) =>
      variantIndex("5f0c2a9e-7b1d-4c3e-9a8f-1b2c3d4e5f60", c, 3)
    ),
    [1, 2, 0, 2, 1, 0],
  );
  // with three choices, three hundred keys land on each of them
  for (const code of ["needs_dob", "verified", "rep_queued", "contact_readback"]) {
    const counts = [0, 0, 0];
    for (let n = 0; n < 300; n++) counts[variantIndex(`call-${n}`, code, 3)]++;
    assert(counts.every((c) => c > 50), `${code}: ${counts}`);
  }
  // one choice (the default, PHRASINGS), no key or a count that is not a whole number: the first
  assertEquals(variantIndex("any", "needs_dob"), 0);
  assertEquals(variantIndex("any", "needs_dob", 1), 0);
  assertEquals(variantIndex(undefined, "needs_dob", 3), 0);
  assertEquals(variantIndex("", "needs_dob", 3), 0);
  assertEquals(variantIndex("any", "needs_dob", 2.5), 0);
});

Deno.test("the most-heard sentences: their facts, their honest result and one question, in one turn", () => {
  for (const [code, data, ending, says, never] of MOST_HEARD) {
    const s = sentenceFor(code, data);
    const where = `${code} ${JSON.stringify(data)}: ${s}`;
    assert(ending.test(s), `${where} does not end like ${ending}`);
    assertEquals((s.match(/\?/g) ?? []).length, 1, `${where}: one question`);
    for (const part of says) assertStringIncludes(s, part, where);
    for (const part of never) assert(!s.includes(part), `${where} says "${part}"`);
    assertSpeakable(s);
    const limit = SPELLING_READBACKS.has(code) ? MAX_READBACK_WORDS : MAX_TURN_WORDS;
    assert(spokenWords(s) <= limit, `${where}: ${spokenWords(s)} words`);
  }
});

Deno.test("the read-back opener the battery embeds is the server's", () => {
  for (const key of [undefined, ...CALL_KEYS]) {
    const s = sentenceFor("claim_readback", { claim_type: "home", loss_date: "2026-10-11", today: TODAY }, key);
    assert(s.startsWith(`${claimReadbackOpener(key, "2026-10-11", "")} A home claim`), s);
    const pipe = sentenceFor("claim_readback", {
      claim_type: "home",
      loss_date: "2026-10-11",
      summary: "A burst pipe.",
      today: TODAY,
    }, key);
    assert(pipe.startsWith(`${claimReadbackOpener(key, "2026-10-11", "a burst pipe")} A home claim`), pipe);
  }
  assertEquals(claimReadbackOpener(), "Let me make sure I have this right.");
});

// A new caller hears the contact read-back, the saved answer and then the claim read-back a few turns
// apart: no opener is heard twice, and no two turns in a row open with the same word.
Deno.test("the contact and claim read-backs never share an opener", () => {
  const readback = sentenceFor("contact_readback", {
    first_name: "Dana",
    last_name: "Whitfield",
    email: "dana@example.com",
  });
  const contactOpener = readback.replace(/^Thanks! /, "").replace(/ Dana Whitfield.*$/, "");
  const claim = sentenceFor("claim_readback", {
    claim_type: "home",
    loss_date: "2026-10-12",
    summary: "a tree branch on the roof",
    today: TODAY,
  });
  const claimOpener = claim.replace(/ A home claim.*$/, "");
  assertNotEquals(claimOpener, contactOpener);
  assert(!/read that back|what I have/i.test(claimOpener), claim);
  const saved = sentenceFor("contact_saved_new", { first_name: "Dana" });
  assertNotEquals(readback.split(/[ ,.!]/)[0], saved.split(/[ ,.!]/)[0], `${readback} | ${saved}`);
});

// Calm, not cheerful: a fire, a flood or an injury is often what was just filed or taken down.
Deno.test("nothing cheerful after a reported loss is filed or taken down", () => {
  for (const emailed of [true, false]) {
    for (
      const s of [
        sentenceFor("claim_filed", { claim_last3: "472", emailed }),
        sentenceFor("claim_intake_saved", { first_name: "Dana", emailed }),
      ]
    ) assert(!/\b(all done|perfect|great)\b/i.test(s), s);
  }
});
