import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type Code, CODES } from "./enums.ts";
import {
  callerFirstName,
  callerIdNumber,
  givenCallbackNumber,
  type IdentityEvent,
  type IdentityState,
  initialIdentity,
  isPlainEmail,
  lastFour,
  MAX_CALLER_NAME_CHARS,
  MAX_EMAIL_CHARS,
  MAX_LOOKUP_MISSES,
  normaliseCallbackNumber,
  normaliseCallerName,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  parseDobParts,
  phoneGroups,
  step,
  storedCallbackNumber,
  usableCallbackNumber,
} from "./identity.ts";
import { sentenceFor } from "./speak.ts";

interface Vectors {
  phones: { input: unknown; expected: string | null; note: string }[];
  callbacks: { input: unknown; expected: string | null; note: string }[];
  dobs: { month: unknown; day: unknown; year: unknown; refYear: number; valid: boolean; note: string }[];
  emails: { input: unknown; expected: string | null; note: string }[];
  names: { input: unknown; expected: string | null; note: string }[];
}
const vectors: Vectors = JSON.parse(
  Deno.readTextFileSync(new URL("../../../fixtures/vectors.json", import.meta.url)),
);

Deno.test("normalisePhone: shared phone vectors", () => {
  assert(vectors.phones.length > 0);
  for (const v of vectors.phones) {
    assertEquals(normalisePhone(v.input), v.expected, `${v.note}: ${JSON.stringify(v.input)}`);
  }
});

Deno.test("normalisePhone: non-string inputs", () => {
  for (const raw of [undefined, true, {}, [], ["6025550101"], -6025550101]) assertEquals(normalisePhone(raw), null);
});

Deno.test("parseDobParts: shared DOB vectors", () => {
  assert(vectors.dobs.length > 0);
  for (const v of vectors.dobs) {
    const got = parseDobParts(v.month, v.day, v.year, v.refYear);
    assertEquals(got !== null, v.valid, `${v.note}: ${JSON.stringify([v.month, v.day, v.year])}`);
  }
  assertEquals(parseDobParts("3", "14", "1986", 2026), { year: 1986, month: 3, day: 14 });
  assertEquals(parseDobParts(2, 29, 1988, 2026), { year: 1988, month: 2, day: 29 });
});

Deno.test("usableCallbackNumber: junk filter and our own line", () => {
  const own = ["+16025550100", "602 555 0111"];
  assertEquals(usableCallbackNumber("602-555-0101", own), "+16025550101");
  assertEquals(usableCallbackNumber("(602) 555 0199", own), "+16025550199"); // the fiction range is valid
  assertEquals(usableCallbackNumber(6025550101, own), "+16025550101");
  for (
    const junk of ["Anonymous", "unknown", "RESTRICTED", "private", "", "   ", null, undefined, {}, ["6025550101"]]
  ) {
    assertEquals(usableCallbackNumber(junk, own), null, JSON.stringify(junk));
  }
  assertEquals(usableCallbackNumber("+1 222 222 2222", own), null); // repeated digits
  assertEquals(usableCallbackNumber("2222222", own), null);
  assertEquals(usableCallbackNumber("+16025550100", own), null); // our own line
  assertEquals(usableCallbackNumber("6025550111", own), null); // own list entry written loosely
  assertEquals(usableCallbackNumber("1 (602) 555-0100", own), null); // our own line written another way
  assertEquals(usableCallbackNumber("602-555-0101", undefined as unknown as string[]), "+16025550101");
  // a number that is not North American is kept, never refused for its country or its length
  assertEquals(usableCallbackNumber("+44 20 7946 0958", own), "+442079460958");
  assertEquals(usableCallbackNumber("9601550123", own), "9601550123");
  assertEquals(usableCallbackNumber("1-012-555-0101", own), "10125550101"); // not dialable in NANP: as said
  // our own line is refused whichever list form names it
  assertEquals(usableCallbackNumber("+442079460958", ["+44 20 7946 0958"]), null);
});

Deno.test("normaliseCallbackNumber: every acceptance rule and every refusal", () => {
  const cases: [unknown, string | null][] = [
    // a. North American: 10 digits, or 11 with a leading 1, area code and exchange starting 2-9
    ["602-555-0101", "+16025550101"],
    ["16025550101", "+16025550101"],
    ["+1 602 555 0101", "+16025550101"],
    ["001 602 555 0101", "+16025550101"],
    [6025550101, "+16025550101"],
    // b. international with a country code: "+", "00" or the word "plus" -> E.164 (8 to 15 digits)
    ["+44 20 7946 0958", "+442079460958"],
    ["0044 20 7946 0958", "+442079460958"],
    ["plus 44 20 7946 0958", "+442079460958"],
    ["+61491570156", "+61491570156"],
    ["+61 491 570 156", "+61491570156"],
    ["+86 10 1234 5678 901", "+861012345678901"], // fifteen digits, the most E.164 allows
    // c. anything else of 7 to 15 digits, noted as said
    ["9601550123", "9601550123"],
    ["960 155 0123", "9601550123"],
    ["0125550101", "0125550101"],
    ["+1 012 555 0177", "10125550177"], // a "+1" number that is not North American
    ["+1 602 555 017", "1602555017"], // a "+1" number one digit short
    ["020 7946 0958", "02079460958"],
    ["555-0177", "5550177"],
    ["+4412345", "4412345"], // too short for E.164: as said
    ["+0123456789", "0123456789"], // no country code starts with 0: as said
    ["123456789012345", "123456789012345"],
    // d. refused
    ["555-017", null],
    ["1234567890123456", null],
    ["+44 1234 5678 9012 34", null],
    ["0000000000", null],
    ["+1 222 222 2222", null],
    ["7777777", null],
    ["anonymous", null],
    ["Restricted", null],
    ["", null],
    ["no number", null],
    [null, null],
    [-6025550101, null],
    [60255501.5, null],
    ["9".repeat(65), null],
  ];
  for (const [input, expected] of cases) assertEquals(normaliseCallbackNumber(input), expected, JSON.stringify(input));
});

Deno.test("givenCallbackNumber: a number given on a call from abroad is read against its caller id", () => {
  const own = ["+16025550100"];
  const uk = "+442079460958";
  // the caller's own number in its national form, with or without the trunk 0, or with the country code
  // but no "+": that caller id, so the read-back says the country code
  for (const said of ["020 7946 0958", "02079460958", "2079460958", "44 20 7946 0958", "+44 20 7946 0958"]) {
    assertEquals(givenCallbackNumber(said, own, uk), uk, said);
  }
  assertEquals(givenCallbackNumber("0491 570 156", own, "+61491570156"), "+61491570156");
  assertEquals(givenCallbackNumber("491570156", own, "+61491570156"), "+61491570156");
  // any other number without a country code is noted as said, never made North American
  assertEquals(givenCallbackNumber("602 555 0177", own, uk), "6025550177");
  assertEquals(givenCallbackNumber("1 602 555 0177", own, uk), "16025550177");
  assertEquals(givenCallbackNumber("07700 900123", own, uk), "07700900123");
  assertEquals(givenCallbackNumber("79460958", own, uk), "79460958"); // part of the caller id: as said
  // with its country code ("+", "00" or "plus") it is read as usableCallbackNumber reads it
  assertEquals(givenCallbackNumber("+1 602 555 0177", own, uk), "+16025550177");
  assertEquals(givenCallbackNumber("001 602 555 0177", own, uk), "+16025550177");
  assertEquals(givenCallbackNumber("plus 61 491 570 156", own, uk), "+61491570156");
  // refusals stand: too short, repeated digits, junk, our own line however it is written
  for (const junk of ["555-017", "2222222222", "anonymous", "", null, undefined, "602 555 0100", "+16025550100"]) {
    assertEquals(givenCallbackNumber(junk, own, uk), null, JSON.stringify(junk));
  }
  // no caller id, a North American one, or one that is not usable: the rules without a caller id
  for (const caller of [null, undefined, "+16025550166", "anonymous", "+16025550100", "9601550123"]) {
    assertEquals(givenCallbackNumber("602 555 0177", own, caller), "+16025550177", String(caller));
    assertEquals(givenCallbackNumber("9601550123", own, caller), "9601550123", String(caller));
    assertEquals(givenCallbackNumber("+44 20 7946 0958", own, caller), uk, String(caller));
  }
});

Deno.test("storedCallbackNumber: a stored number is kept exactly as stored, never read again", () => {
  const own = ["+16025550100"];
  for (const stored of ["+16025550177", "+442079460958", "6025550177", "16025550177", "9601550123", "5550177"]) {
    assertEquals(storedCallbackNumber(stored, own), stored, stored);
  }
  // junk and our own line are refused, in whichever form they were stored
  for (const bad of [null, undefined, "", "0000000", "+16025550100", "6025550100", "anonymous"]) {
    assertEquals(storedCallbackNumber(bad, own), null, String(bad));
  }
  // a value in no stored form is read as usableCallbackNumber reads it
  assertEquals(storedCallbackNumber("(602) 555-0177", own), "+16025550177");
  // each form a callback number is stored in comes back unchanged through the rules that wrote it
  for (const said of ["602-555-0177", "+44 20 7946 0958", "960 155 0123", "555-0177"]) {
    const n = usableCallbackNumber(said, own)!;
    assertEquals(storedCallbackNumber(n, own), n, said);
  }
});

Deno.test("normaliseCallbackNumber runs on its own (the chat battery's mocks embed its source)", () => {
  const standalone = new Function(`return (${normaliseCallbackNumber.toString()});`)() as (v: unknown) => string | null;
  for (const v of ["602-555-0101", "+44 20 7946 0958", "9601550123", "555-017", "anonymous"]) {
    assertEquals(standalone(v), normaliseCallbackNumber(v), v);
  }
});

Deno.test("callerIdNumber: envelope caller id, North American or from abroad", () => {
  const own = ["+16025550100"];
  assertEquals(callerIdNumber("+16025550101", own), "+16025550101");
  assertEquals(callerIdNumber(undefined, own), null); // web call: no customer number
  assertEquals(callerIdNumber("anonymous", own), null);
  assertEquals(callerIdNumber("+16025550100", own), null);
  // a caller id from abroad is a callback number like any other
  assertEquals(callerIdNumber("+447700900123", own), "+447700900123");
  assertEquals(callerIdNumber("+61491570156", own), "+61491570156");
  assertEquals(callerIdNumber("sip:user@10.0.0.12:5060", own), null);
  assertEquals(callerIdNumber("sip:22.33.44.55:5060", own), null);
  assertEquals(callerIdNumber("sip:+61491570156@carrier.example", own), null);
  assertEquals(callerIdNumber(6025550101, own), null); // the envelope carries strings only
});

Deno.test("phoneGroups: how a callback number is read back and shown", () => {
  assertEquals(phoneGroups("+16025550101"), {
    kind: "north_american",
    countryCode: "1",
    groups: ["602", "555", "0101"],
  });
  assertEquals(phoneGroups("+442079460958"), {
    kind: "international",
    countryCode: "44",
    groups: ["207", "946", "0958"],
  });
  assertEquals(phoneGroups("+61491570156"), {
    kind: "international",
    countryCode: "61",
    groups: ["491", "570", "156"],
  });
  assertEquals(phoneGroups("+70005550100")?.countryCode, "7");
  assertEquals(phoneGroups("+353005550100")?.countryCode, "353");
  // only a number written with "+" has a country code: bare digits are kept whole, as said
  assertEquals(phoneGroups("16025550177"), { kind: "as_said", countryCode: null, groups: ["160", "255", "501", "77"] });
  assertEquals(phoneGroups("6025550177"), { kind: "as_said", countryCode: null, groups: ["602", "555", "0177"] });
  assertEquals(phoneGroups("9601550123"), { kind: "as_said", countryCode: null, groups: ["960", "155", "0123"] });
  assertEquals(phoneGroups("5550177"), { kind: "as_said", countryCode: null, groups: ["555", "0177"] });
  assertEquals(phoneGroups("02079460958")?.groups, ["020", "794", "609", "58"]);
  assertEquals(phoneGroups(""), null);
});

Deno.test("lastFour never returns more than four digits", () => {
  assertEquals(lastFour("+16025550101"), "0101");
  assertEquals(lastFour("602-555-0199"), "0199");
  assertEquals(lastFour("12"), "12");
});

// ---------------------------------------------------------------------------------------------
// State machine: the same ladder as lookup_customer_attempt / verify_dob_attempt.
// ---------------------------------------------------------------------------------------------
const HIT = "cust-1";
const lookupHit: IdentityEvent = { type: "lookup", phoneE164: "+16025550101", customerId: HIT };
const lookupMiss: IdentityEvent = { type: "lookup", phoneE164: "+16025550199", customerId: null };
const lookupMissB: IdentityEvent = { type: "lookup", phoneE164: "+16025550198", customerId: null };
const lookupMissC: IdentityEvent = { type: "lookup", phoneE164: "+16025550197", customerId: null };
const badPhone: IdentityEvent = { type: "lookup", phoneE164: null, customerId: null };
const dobOk: IdentityEvent = { type: "dob", valid: true, matches: true };
const dobWrong: IdentityEvent = { type: "dob", valid: true, matches: false };
const dobUnreadable: IdentityEvent = { type: "dob", valid: false, matches: false };

function run(
  events: IdentityEvent[],
  from: IdentityState = initialIdentity(),
): { state: IdentityState; codes: Code[] } {
  let state = from;
  const codes: Code[] = [];
  for (const e of events) {
    const r = step(state, e);
    state = r.state;
    codes.push(r.code);
  }
  return { state, codes };
}

Deno.test("initial identity", () => {
  assertEquals(initialIdentity(), {
    level: "none",
    misses: 0,
    missed: [],
    wrong: 0,
    unreadable: 0,
    candidate: null,
    verified: null,
  });
  assert(initialIdentity() !== initialIdentity(), "a fresh object each time");
});

const LADDERS: { name: string; events: IdentityEvent[]; codes: Code[]; level: IdentityState["level"] }[] = [
  { name: "happy path", events: [lookupHit, dobOk], codes: ["needs_dob", "verified"], level: "verified" },
  {
    name: "the same number again (confirmed after the read-back) is final for that number",
    events: [lookupMiss, lookupMiss, lookupMiss],
    codes: ["not_found", "not_found_final", "not_found_final"],
    level: "none",
  },
  {
    name: "a final reached by a repeat is not sticky: a different number is still looked up",
    events: [lookupMiss, lookupMiss, lookupHit, dobOk],
    codes: ["not_found", "not_found_final", "needs_dob", "verified"],
    level: "verified",
  },
  {
    name: "two different numbers miss, the third hits",
    events: [lookupMiss, lookupMissB, lookupHit],
    codes: ["not_found", "not_found", "needs_dob"],
    level: "phone_found",
  },
  {
    name: "three different numbers miss: the third is final, and every lookup after it",
    events: [lookupMiss, lookupMissB, lookupMissC, lookupHit, lookupMiss],
    codes: ["not_found", "not_found", "not_found_final", "not_found_final", "not_found_final"],
    level: "none",
  },
  {
    name: "repeats between different misses do not count toward the cap",
    events: [lookupMiss, lookupMiss, lookupMissB, lookupMissB, lookupHit],
    codes: ["not_found", "not_found_final", "not_found", "not_found_final", "needs_dob"],
    level: "phone_found",
  },
  {
    name: "one miss, then a hit",
    events: [lookupMiss, lookupHit, dobOk],
    codes: ["not_found", "needs_dob", "verified"],
    level: "verified",
  },
  {
    name: "a bad phone is never counted",
    events: [badPhone, badPhone, badPhone, lookupMiss, badPhone, lookupHit],
    codes: ["invalid_phone", "invalid_phone", "invalid_phone", "not_found", "invalid_phone", "needs_dob"],
    level: "phone_found",
  },
  {
    name: "wrong DOB once, then right",
    events: [lookupHit, dobWrong, dobOk],
    codes: ["needs_dob", "auth_failed", "verified"],
    level: "verified",
  },
  {
    name: "wrong DOB twice locks; a later correct DOB still returns locked",
    events: [lookupHit, dobWrong, dobWrong, dobOk, lookupHit],
    codes: ["needs_dob", "auth_failed", "locked", "locked", "locked"],
    level: "locked",
  },
  {
    name: "unreadable never counts against the caller",
    events: [lookupHit, dobUnreadable, dobWrong, dobUnreadable, dobOk],
    codes: ["needs_dob", "dob_unreadable", "auth_failed", "dob_unreadable", "verified"],
    level: "verified",
  },
  {
    name: "third unreadable gives up without locking",
    events: [lookupHit, dobUnreadable, dobUnreadable, dobUnreadable, dobUnreadable],
    codes: ["needs_dob", "dob_unreadable", "dob_unreadable", "dob_give_up", "dob_give_up"],
    level: "phone_found",
  },
  {
    name: "unreadable phones do not feed the DOB give-up counter",
    events: [badPhone, badPhone, badPhone, lookupHit, dobUnreadable],
    codes: ["invalid_phone", "invalid_phone", "invalid_phone", "needs_dob", "dob_unreadable"],
    level: "phone_found",
  },
  {
    name: "DOB before any lookup",
    events: [dobOk, dobWrong, dobUnreadable],
    codes: ["no_lookup_yet", "no_lookup_yet", "no_lookup_yet"],
    level: "none",
  },
  { name: "DOB after a miss only", events: [lookupMiss, dobOk], codes: ["not_found", "no_lookup_yet"], level: "none" },
  {
    name: "already verified",
    events: [lookupHit, dobOk, lookupHit, lookupMiss, badPhone, dobWrong, dobWrong],
    codes: [
      "needs_dob",
      "verified",
      "already_verified",
      "already_verified",
      "already_verified",
      "verified",
      "verified",
    ],
    level: "verified",
  },
  {
    name: "locked refuses lookups and DOBs, bad phone included",
    events: [lookupHit, dobWrong, dobWrong, badPhone, dobUnreadable],
    codes: ["needs_dob", "auth_failed", "locked", "locked", "locked"],
    level: "locked",
  },
];

for (const l of LADDERS) {
  Deno.test(`step: ${l.name}`, () => {
    const { state, codes } = run(l.events);
    assertEquals(codes, l.codes);
    assertEquals(state.level, l.level);
  });
}

Deno.test("step: counters and customer ids", () => {
  const verified = run([lookupMiss, lookupHit, dobUnreadable, dobWrong, dobOk]).state;
  assertEquals(verified, {
    level: "verified",
    misses: 1,
    missed: ["+16025550199"],
    wrong: 1,
    unreadable: 1,
    candidate: HIT,
    verified: HIT,
  });
  const locked = run([lookupHit, dobWrong, dobWrong]).state;
  assertEquals(locked, {
    level: "locked",
    misses: 0,
    missed: [],
    wrong: 2,
    unreadable: 0,
    candidate: HIT,
    verified: null,
  });
  const repeated = run([lookupMiss, lookupMiss, lookupMiss]).state;
  assertEquals([repeated.misses, repeated.missed], [1, ["+16025550199"]], "a repeat is not a new miss");
  const capped = run([lookupMiss, lookupMissB, lookupMissC, lookupMissB, lookupHit]).state;
  assertEquals(capped.misses, MAX_LOOKUP_MISSES, "a capped call does not keep counting");
  assertEquals(capped.candidate, null, "a lookup after the cap sets no candidate");
  // A second hit on another account moves the candidate, as the SQL update does.
  const moved = run([lookupHit, { type: "lookup", phoneE164: "+16025550102", customerId: "cust-2" }, dobOk]).state;
  assertEquals(moved.verified, "cust-2");
});

Deno.test("step: the ledger's number key decides what a repeat is, and keyless old misses still count", () => {
  // fake_store.ts passes attempts.number_hash; two spellings of one key are one number
  const keyed = (phoneE164: string, numberKey: string): IdentityEvent => ({
    type: "lookup",
    phoneE164,
    customerId: null,
    numberKey,
  });
  assertEquals(run([keyed("+16025550199", "k1"), keyed("+16025550199", "k1")]).codes, ["not_found", "not_found_final"]);
  assertEquals(run([keyed("+16025550199", "k1"), keyed("+16025550199", "k2")]).codes, ["not_found", "not_found"]);
  // two misses written before number keys existed: one more different number reaches the cap, and a
  // number among the old ones cannot be recognised, so it counts as different too
  const legacy: IdentityState = { ...initialIdentity(), misses: 2 };
  assertEquals(run([lookupMiss], legacy).codes, ["not_found_final"]);
  assertEquals(run([lookupHit], legacy).codes, ["needs_dob"]);
  assertEquals(run([lookupMiss], { ...initialIdentity(), misses: 1 }).codes, ["not_found"]);
});

Deno.test("step is pure", () => {
  const s = initialIdentity();
  const frozen = structuredClone(s);
  const r = step(s, lookupHit);
  assertEquals(s, frozen);
  assertNotEquals(r.state, s);
  // a miss copies the key list instead of pushing onto the caller's
  const missed = step(s, lookupMiss);
  assertEquals(s, frozen);
  assertEquals(missed.state.missed, ["+16025550199"]);
});

Deno.test("step: invariants over seeded random sequences", () => {
  const events = [lookupHit, lookupMiss, lookupMissB, lookupMissC, badPhone, dobOk, dobWrong, dobUnreadable];
  let seed = 20261015;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 500; run++) {
    let s = initialIdentity();
    for (let i = 0; i < 12; i++) {
      const before = s;
      const r = step(s, events[Math.floor(rand() * events.length)]);
      s = r.state;
      assert((CODES as readonly string[]).includes(r.code));
      if (before.level === "locked") assertEquals(s.level, "locked");
      if (before.level === "verified") assertEquals(s.level, "verified");
      assert(s.misses >= before.misses && s.misses <= MAX_LOOKUP_MISSES);
      assertEquals(s.missed.length, s.misses, "every miss in a fresh run has a key");
      assert(s.wrong >= before.wrong && s.wrong <= 2);
      if (s.level === "verified") assertEquals(s.verified, s.candidate);
      if (r.code === "verified") assertEquals(s.level, "verified");
      if (r.code === "locked") assertEquals(s.level, "locked");
    }
  }
});

Deno.test("system_error is distinct from not_found", () => {
  assertNotEquals(sentenceFor("system_error"), sentenceFor("not_found"));
  assertNotEquals(sentenceFor("system_error"), sentenceFor("not_found_final"));
  assert(!/find/i.test(sentenceFor("system_error")));
});

Deno.test("callback vectors: any number the caller gives is kept; a lookup key stays North American", () => {
  assert(vectors.callbacks.length > 0);
  for (const v of vectors.callbacks) {
    assertEquals(normaliseCallbackNumber(v.input), v.expected, v.note);
    assertEquals(usableCallbackNumber(v.input, []), v.expected, v.note);
  }
  // Ten digits outside the North American plan are looked up as an account number (the database answers
  // not found and the caller can correct a digit), and as a callback number are noted as said.
  assertEquals(normalisePhone("9601550123"), "+19601550123");
  assertEquals(usableCallbackNumber("9601550123", []), "9601550123");
  // an account lookup key is never international
  assertEquals(normalisePhone("+44 20 7946 0958"), null);
});

Deno.test("normaliseEmail: shared email vectors (spoken forms, spacing, and what is refused)", () => {
  assert(vectors.emails.length > 0);
  for (const v of vectors.emails) {
    assertEquals(
      normaliseEmail(v.input),
      v.expected,
      `${v.note}: ${JSON.stringify(v.input)}`,
    );
  }
});

Deno.test("normaliseEmail: every accepted address is a plain address the sender accepts", () => {
  for (const v of vectors.emails.filter((x) => x.expected !== null)) {
    const got = normaliseEmail(v.input)!;
    assert(isPlainEmail(got), v.note);
    assert(
      /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]+$/.test(got),
      `email.ts would refuse ${got}`,
    );
    assertEquals(got, got.toLowerCase());
  }
  // the cap applies to the stored address, not to the spoken input around it
  const local = "a".repeat(64);
  assertEquals(normaliseEmail(`${local}@example.com`), `${local}@example.com`);
  assertEquals(normaliseEmail(`${"a".repeat(65)}@example.com`), null);
  assertEquals(isPlainEmail(`a@${"b".repeat(MAX_EMAIL_CHARS)}.com`), false);
  for (const raw of [undefined, null, true, {}, ["a@b.co"], "x".repeat(1000)]) {
    assertEquals(normaliseEmail(raw), null);
  }
});

Deno.test("normaliseName: shared name vectors", () => {
  assert(vectors.names.length > 0);
  for (const v of vectors.names) {
    assertEquals(
      normaliseName(v.input),
      v.expected,
      `${v.note}: ${JSON.stringify(v.input)}`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The name a caller gives for a callback (escalate's caller_name, escalations.caller_name in 0012).
// ---------------------------------------------------------------------------------------------
Deno.test("normaliseCallerName: a first name, or first and last, as the caller said it", () => {
  const cases: [unknown, string | null][] = [
    ["Priya", "Priya"],
    ["  Priya   Raman  ", "Priya Raman"],
    ["priya raman", "Priya Raman"],
    ["PRIYA", "Priya"],
    ["McDonald", "McDonald"],
    ["van der Berg", "van der Berg"],
    ["dot smith", "Dot Smith"],
    ["Ren\u00e9e", "Ren\u00e9e"],
    ["Jos\u00e9 Mar\u00eda Garc\u00eda", "Jos\u00e9 Mar\u00eda Garc\u00eda"],
    ["O\u2019Brien", "O'Brien"],
    ["Mary - Jane", "Mary-Jane"],
    ["Mary\u2013Jane", "Mary-Jane"],
    ["J.R. Smith", "J.R. Smith"],
    ["Smith Jr.", "Smith Jr."],
    ["Dr. Shah", "Dr. Shah"],
    // a sentence's closing full stop and a lead-in are not part of the name
    ["Priya.", "Priya"],
    ["Priya Raman...", "Priya Raman"],
    ["It's Priya", "Priya"],
    ["my name is Priya Raman", "Priya Raman"],
    ["Call me Al", "Al"],
    ["Ask for Priya", "Priya"],
    // up to five words and 80 characters
    ["Juan Carlos de la Cruz", "Juan Carlos de la Cruz"],
    [`${"A".repeat(40)} ${"b".repeat(39)}`, `${"A".repeat(40)} ${"b".repeat(39)}`],
  ];
  for (const [input, expected] of cases) assertEquals(normaliseCallerName(input), expected, JSON.stringify(input));
  // 80 characters is the most the CHECK takes, counted as Postgres counts them
  for (const [, expected] of cases) {
    if (expected) assert([...expected].length <= MAX_CALLER_NAME_CHARS, expected);
  }
});

Deno.test("normaliseCallerName: junk, numbers, addresses and no-name answers are not a name", () => {
  const refused: unknown[] = [
    undefined,
    null,
    42,
    { name: "Priya" },
    "",
    "   ",
    "unknown",
    "Unknown caller",
    "UNKNOWN",
    "no",
    "No.",
    "none",
    "nope",
    "N/A",
    "anonymous",
    "I'd rather not say",
    "rather not",
    "Prefer not to say",
    "Just call me",
    "call me",
    "no thanks",
    "that's fine",
    "doesn't matter",
    "Mr.",
    "Dr",
    "sir",
    "602 555 0177",
    "Priya 2",
    "+44 20 7946 0958",
    "priya@example.com",
    "priya at example dot com",
    "on this number",
    "the same number",
    "use my phone number",
    "{{caller_name}}",
    "<b>Priya</b>",
    "Priya, thanks",
    "Priya; drop table",
    "x".repeat(81),
    "one two three four five six",
    "...",
    "'-'",
    "a".repeat(201),
  ];
  for (const input of refused) assertEquals(normaliseCallerName(input), null, JSON.stringify(input));
});

Deno.test("callerFirstName: the first word, a title with the name after it, no closing full stop", () => {
  assertEquals(callerFirstName("Priya"), "Priya");
  assertEquals(callerFirstName("Priya Raman"), "Priya");
  assertEquals(callerFirstName("Mary-Jane Watson"), "Mary-Jane");
  assertEquals(callerFirstName("Dr. Shah"), "Dr. Shah");
  assertEquals(callerFirstName("Mrs Okafor Smith"), "Mrs Okafor");
  assertEquals(callerFirstName("J.R. Smith"), "J.R");
  assertEquals(callerFirstName("  Ren\u00e9e  "), "Ren\u00e9e");
  for (const none of ["", "   ", null, undefined, 7]) assertEquals(callerFirstName(none), "", JSON.stringify(none));
});
