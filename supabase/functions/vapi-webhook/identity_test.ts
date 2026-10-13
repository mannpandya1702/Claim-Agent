import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type Code, CODES } from "./enums.ts";
import {
  callerIdNumber,
  type IdentityEvent,
  type IdentityState,
  initialIdentity,
  isPlainEmail,
  lastFour,
  MAX_EMAIL_CHARS,
  MAX_LOOKUP_MISSES,
  normaliseEmail,
  normaliseName,
  normaliseNanp,
  normalisePhone,
  parseDobParts,
  step,
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

Deno.test("usableCallbackNumber: junk filter", () => {
  const own = ["+16025550100", "602 555 0111"];
  assertEquals(usableCallbackNumber("602-555-0101", own), "+16025550101");
  assertEquals(usableCallbackNumber("(602) 555 0199", own), "+16025550199"); // the fiction range is valid
  assertEquals(usableCallbackNumber(6025550101, own), "+16025550101");
  for (const junk of ["Anonymous", "unknown", "RESTRICTED", "private", "", "   ", null, undefined]) {
    assertEquals(usableCallbackNumber(junk, own), null, JSON.stringify(junk));
  }
  assertEquals(usableCallbackNumber("+1 222 222 2222", own), null); // repeated digits
  assertEquals(usableCallbackNumber("1-012-555-0101", own), null); // area code starts with 0
  assertEquals(usableCallbackNumber("+16025550100", own), null); // our own line
  assertEquals(usableCallbackNumber("6025550111", own), null); // own list entry written loosely
  assertEquals(usableCallbackNumber("602-555-0101", undefined as unknown as string[]), "+16025550101");
});

Deno.test("callerIdNumber: envelope caller id", () => {
  const own = ["+16025550100"];
  assertEquals(callerIdNumber("+16025550101", own), "+16025550101");
  assertEquals(callerIdNumber(undefined, own), null); // web call: no customer number
  assertEquals(callerIdNumber("anonymous", own), null);
  assertEquals(callerIdNumber("+16025550100", own), null);
  assertEquals(callerIdNumber("+447700900123", own), null); // outside NANP
  assertEquals(callerIdNumber("sip:user@10.0.0.12:5060", own), null);
  assertEquals(callerIdNumber("sip:22.33.44.55:5060", own), null);
  assertEquals(callerIdNumber(6025550101, own), null); // the envelope carries strings only
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

Deno.test("normaliseNanp and usableCallbackNumber: a callback must be dialable, a lookup key need not be", () => {
  assert(vectors.callbacks.length > 0);
  for (const v of vectors.callbacks) {
    assertEquals(normaliseNanp(v.input), v.expected, v.note);
    assertEquals(usableCallbackNumber(v.input, []), v.expected, v.note);
  }
  // Ten digits that break the numbering plan (a misheard number) are still looked up (the database
  // answers not found and the caller can correct a digit), but never become a callback target.
  assertEquals(normalisePhone("9601550123"), "+19601550123");
  assertEquals(usableCallbackNumber("9601550123", []), null);
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
