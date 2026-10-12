import { assert, assertEquals, assertFalse, assertMatch, assertNotStrictEquals } from "@std/assert";
import { asksForSensitive, MASKED_ANSWER, redactDeep, redactPII, redactPIIAsOf } from "./redact.ts";
import { jsonLogger } from "./log.ts";

interface Vectors {
  ref_year: number;
  redact: { note: string; input: string; output: string }[];
  asks_for_sensitive: { text: string; expected: boolean }[];
}

const vectors: Vectors = JSON.parse(
  await Deno.readTextFile(new URL("../../../fixtures/redact_vectors.json", import.meta.url)),
);

Deno.test("redact vectors: every shape maps to the expected output", () => {
  // a vacuous table would pass silently; the fixture must carry both phone and DOB cases
  assert(vectors.redact.filter((v) => v.output.includes("[phone ending")).length >= 10);
  assert(vectors.redact.filter((v) => v.output.includes("[date of birth]")).length >= 10);
  assert(vectors.redact.filter((v) => v.input === v.output).length >= 10);
  for (const v of vectors.redact) {
    assertEquals(redactPIIAsOf(v.input, vectors.ref_year), v.output, v.note);
  }
});

Deno.test("redact vectors: output is a fixed point (idempotent on redacted text)", () => {
  for (const v of vectors.redact) {
    assertEquals(redactPIIAsOf(v.output, vectors.ref_year), v.output, v.note);
  }
});

Deno.test("redactPII: the PDF shapes, independent of today's date", () => {
  for (const p of ["602-555-0101", "(602) 555 0101", "+16025550101", "6025550101", "6 0 2 5 5 5 0 1 0 1"]) {
    assertEquals(redactPII(`call ${p} please`), "call [phone ending 0101] please", p);
  }
  assertEquals(redactPII("six zero two five five five zero one zero one"), "[phone ending 0101]");
  for (const d of ["March 14, 1986", "march 14th 1986", "3/14/1986", "03-14-1986", "1986-03-14", "14 March 1986"]) {
    assertEquals(redactPII(`born ${d}.`), "born [date of birth].", d);
  }
  for (const d of ["march fourteenth nineteen eighty six", "march fourteen nineteen eighty-six"]) {
    assertEquals(redactPII(d), "[date of birth]", d);
  }
  const untouched =
    "CLM-240115 was approved for $4,820, four thousand eight hundred twenty dollars, on October eighth.";
  assertEquals(redactPII(untouched), untouched);
});

Deno.test("redactPII: null and undefined pass through as null", () => {
  assertEquals(redactPII(null), null);
  assertEquals(redactPII(undefined), null);
  assertEquals(redactPII(""), "");
});

Deno.test("redactPII: the spoken-digit label carries numerals, never more than four", () => {
  const out = redactPII("my number is six oh two five five five oh one nine nine");
  assertEquals(out, "my number is [phone ending 0199]");
  assertFalse(/\d{5,}/.test(out));
});

Deno.test("redactPIIAsOf: the DOB year bound moves with the reference year", () => {
  // a date five or more years back is DOB-shaped; anything more recent is a claim or due date
  assertEquals(redactPIIAsOf("June 1, 2021", 2026), "[date of birth]");
  assertEquals(redactPIIAsOf("June 1, 2022", 2026), "June 1, 2022");
  assertEquals(redactPIIAsOf("June 1, 2022", 2027), "[date of birth]");
  assertEquals(redactPIIAsOf("January first nineteen hundred", 2026), "[date of birth]");
  assertEquals(redactPIIAsOf("January 1, 1899", 2026), "January 1, 1899");
});

Deno.test("redactPII: impossible month/day numerals are left alone", () => {
  assertEquals(redactPIIAsOf("13/32/1986", 2026), "13/32/1986");
  assertEquals(redactPIIAsOf("1986-13-01", 2026), "1986-13-01");
});

Deno.test("redactPII: a long digit run that is not a phone is not partially redacted", () => {
  assertEquals(redactPII("ref 123456789012"), "ref 123456789012");
  assertEquals(redactPII("id 4111 1111 1111 1111"), "id 4111 1111 1111 1111");
});

Deno.test("asksForSensitive vectors", () => {
  assert(vectors.asks_for_sensitive.filter((v) => v.expected).length >= 8);
  for (const v of vectors.asks_for_sensitive) {
    assertEquals(asksForSensitive(v.text), v.expected, v.text);
  }
});

Deno.test("asksForSensitive: null and undefined are not questions", () => {
  assertFalse(asksForSensitive(null));
  assertFalse(asksForSensitive(undefined));
});

Deno.test("MASKED_ANSWER is the stable placeholder and survives redaction", () => {
  assertEquals(MASKED_ANSWER, "[answer withheld]");
  assertEquals(redactPII(MASKED_ANSWER), MASKED_ANSWER);
});

Deno.test("redactDeep: every string at any depth, other values untouched, input not mutated", () => {
  const input = {
    summary: "Tobias called from 602-555-0101; DOB March 14, 1986.",
    structuredData: {
      caller_name: "Tobias",
      sentiment: "positive",
      escalated: false,
      notes: ["callback 602 555 0199", { dob: "1986-03-14" }],
    },
    successEvaluation: true,
    score: 4.5,
    missing: null,
  };
  const before = structuredClone(input);
  const out = redactDeep(input);
  assertEquals(out, {
    summary: "Tobias called from [phone ending 0101]; DOB [date of birth].",
    structuredData: {
      caller_name: "Tobias",
      sentiment: "positive",
      escalated: false,
      notes: ["callback [phone ending 0199]", { dob: "[date of birth]" }],
    },
    successEvaluation: true,
    score: 4.5,
    missing: null,
  });
  assertEquals(input, before);
  assertNotStrictEquals(out, input);
});

Deno.test("redactDeep: scalars and cycles", () => {
  assertEquals(redactDeep("602-555-0101"), "[phone ending 0101]");
  assertEquals(redactDeep(42), 42);
  assertEquals(redactDeep(null), null);
  const cyclic: Record<string, unknown> = { phone: "6025550101" };
  cyclic.self = cyclic;
  const out = redactDeep(cyclic) as Record<string, unknown>;
  assertEquals(out.phone, "[phone ending 0101]");
  assert(out.self === out, "a cycle maps onto the redacted copy");
});

// The logger is where redaction is the last line of defence, so its contract is tested here.
function captureLog(event: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    jsonLogger(event);
  } finally {
    console.log = original;
  }
  assertEquals(lines.length, 1);
  return JSON.parse(lines[0]);
}

Deno.test("jsonLogger: one JSON line, identity keys and raw arguments dropped at any depth", () => {
  const out = captureLog({
    call_key: "call-1",
    type: "tool-calls",
    tool: "lookup_customer",
    code: "needs_dob",
    ms: 12,
    phone: "+16025550101",
    dob: "1986-03-14",
    date_of_birth: "1986-03-14",
    email: "owner@example.com",
    args: { phone: "6025550101" },
    arguments: '{"phone":"6025550101"}',
    nested: { phone: "+16025550101", ok: true },
  });
  assertEquals(out, {
    call_key: "call-1",
    type: "tool-calls",
    tool: "lookup_customer",
    code: "needs_dob",
    ms: 12,
    nested: { ok: true },
  });
});

Deno.test("jsonLogger: strings are redacted and capped at 300 characters", () => {
  const out = captureLog({ error: `duplicate key (phone_e164)=(+16025550101) born 3/14/1986 ${"x".repeat(1000)}` });
  const error = out.error as string;
  assertEquals(error.length, 300);
  assertMatch(error, /^duplicate key \(phone_e164\)=\(\[phone ending 0101\]\) born \[date of birth\] x+$/);
});

Deno.test("jsonLogger: Error values log as name and message", () => {
  const out = captureLog({ error: new TypeError("bad thing") });
  assertEquals(out.error, "TypeError: bad thing");
});

Deno.test("jsonLogger: an unserialisable event never throws", () => {
  const out = captureLog({ n: 1n });
  assertEquals(out, { log_error: "unserialisable event" });
});
