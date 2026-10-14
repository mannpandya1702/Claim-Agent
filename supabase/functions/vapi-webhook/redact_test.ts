import { assert, assertEquals, assertFalse, assertMatch, assertNotStrictEquals } from "@std/assert";
import { asksForSensitive, MASKED_ANSWER, redactDeep, redactPII, redactPIIAsOf } from "./redact.ts";
import { jsonLogger } from "./log.ts";
import { sentenceFor, speakPhone } from "./speak.ts";

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

Deno.test("redactPII: a two-digit birth year after a month and day, written or spoken", () => {
  for (
    const d of [
      "march 14th 86",
      "3 14 86",
      "14 March, 86",
      "March 14 '86",
      "march fourteenth eighty six",
      "march fourteenth eighty-six",
      "the 2nd of May 99",
      "january first oh five",
    ]
  ) {
    assertEquals(redactPIIAsOf(`my birthday is ${d}`, 2026), "my birthday is [date of birth]", d);
  }
  // a recent two-digit year, money and a lone month-and-day stay readable
  for (const t of ["June 1, 22", "May 5, 25,000 dollars", "May 5, 25.50", "October 8 at 10", "on October eighth"]) {
    assertEquals(redactPIIAsOf(t, 2026), t, t);
  }
  // a DOB said right before a phone number: both go, and no digits of either survive
  assertEquals(redactPIIAsOf("3 14 86 602 555 0101", 2026), "[date of birth] [phone ending 0101]");
});

Deno.test("redactPII: written email addresses become [email], before any digit in one is read", () => {
  assertEquals(redactPII("my email is tobias.reyes@example.com."), "my email is [email].");
  assertEquals(redactPII("Email: First.Last+tag@sub.example.co.uk, thanks"), "Email: [email], thanks");
  assertEquals(redactPII("write to 6025550101@vtext.com please"), "write to [email] please");
  assertEquals(
    redactPII("call 602-555-0101 or email me at a.b@example.org"),
    "call [phone ending 0101] or email me at [email]",
  );
  // not an address, and our spoken claims address is words, not an address
  for (const t of ["a@b", "x@y.c", "claims docs at observeinsurance dot com", "[email]"]) {
    assertEquals(redactPII(t), t, t);
  }
});

Deno.test("redactPII: adversarial inputs finish in linear time (no catastrophic backtracking)", () => {
  // Each of these once took seconds or worse: "dot" read both as a label and as the separator gave
  // 2^n ways to split a spelled domain, and an unbounded written local part rescanned a long run
  // from every position. A synchronous regex cannot be cut off by a tool budget's timer, so a stall
  // here would hold the emergency path and the post-call write.
  const inputs = [
    "a, b, at " + Array(200).fill("1").join(" dot "),
    "a, b, at " + Array(800).fill("x").join(" dot ") + "!",
    Array(1300).fill("a").join(", ") + " at",
    Array(1300).fill("a").join(" ") + " at x",
    Array(500).fill("jane dot").join(" ") + " at",
    "x at " + Array(600).fill("ab cd").join(" dot ") + ",",
    Array(600).fill("j underscore").join(" ") + " at foo dot",
    "a.".repeat(8000),
    "q".repeat(16000) + " at",
    "your email is " + "a, ".repeat(400) + "at gmail dot com",
  ];
  redactPII("warm up: j, a, at gmail dot com");
  for (const input of inputs) {
    const started = performance.now();
    redactPII(input);
    asksForSensitive(input);
    const ms = performance.now() - started;
    assert(ms < 500, `${input.slice(0, 24)}... (${input.length} chars) took ${Math.round(ms)} ms`);
  }
});

Deno.test("redactPII: spoken and spelled addresses are redacted whole, our own address is not", () => {
  for (
    const [input, output] of [
      ["it's jane dot doe at gmail dot com", "it's [email]"],
      ["my email is jane underscore doe at hotmail dot com", "my email is [email]"],
      ["it's jsmith at acmecorp dot com", "it's [email]"],
      ["jane at yahoo.com", "[email]"],
      ["your email is a, at gmail dot com.", "your email is [email]."],
      ["your email is T, E, A, G, U, E, at A, O, L dot com.", "your email is [email]."],
    ]
  ) {
    assertEquals(redactPII(input), output, input);
  }
  for (
    const kept of [
      "email them to claims docs at observeinsurance dot com",
      "Sure, at observeinsurance dot com slash claims.",
      "I was at the office, dot com or not.",
    ]
  ) {
    assertEquals(redactPII(kept), kept, kept);
  }
});

Deno.test("asksForSensitive: any question asking for an email masks the answer", () => {
  for (const q of ["What email should I use?", "Could I get your email?", "And your email, please?"]) {
    assert(asksForSensitive(q), q);
  }
  for (const q of ["Would you like me to email the documents?", "I've passed that email to our team. Anything else?"]) {
    assertFalse(asksForSensitive(q), q);
  }
});

Deno.test("asksForSensitive: the model's own wording of a DOB question counts", () => {
  for (
    const q of [
      "When were you born?",
      "Could you confirm the date you were born?",
      "And what year?",
      "Which year was that?",
      "What's your year of birth?",
    ]
  ) {
    assert(asksForSensitive(q), q);
  }
  for (const q of ["I'll escalate this to our team.", "That sounds like a stubborn problem."]) {
    assertFalse(asksForSensitive(q), q);
  }
});

Deno.test("asksForSensitive: a number taken in pieces masks every piece", () => {
  for (
    const q of [
      "Let's take the phone number three digits at a time.",
      "Got it. And the next three digits?",
      "And the last four?",
      "Okay, the first three?",
    ]
  ) {
    assert(asksForSensitive(q), q);
  }
  for (const q of ["Your claim ending in four seven two was approved.", "There are three more claims on file."]) {
    assertFalse(asksForSensitive(q), q);
  }
});

Deno.test("redactPII: a read-back with commas between the groups is a phone", () => {
  assertEquals(
    redactPII(
      "I'm not finding an account under six zero two, five five five, zero one nine nine. Is that the right number?",
    ),
    "I'm not finding an account under [phone ending 0199]. Is that the right number?",
  );
  assertEquals(redactPII("Got it, six zero two, five five five, zero one zero one."), "Got it, [phone ending 0101].");
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

Deno.test("redactPII: a run of 7 to 15 digits is redacted whole; a longer run is not a phone and is never cut", () => {
  // twelve digits may be a number from abroad said without its "+": redacted whole, never in part
  assertEquals(redactPII("ref 123456789012"), "ref [phone ending 9012]");
  assertEquals(redactPII("id 4111 1111 1111 1111"), "id 4111 1111 1111 1111");
  assertEquals(redactPII("1234567890123456"), "1234567890123456");
  assertEquals(redactPII("code 123456"), "code 123456");
});

Deno.test("redactPII: international and as-said numbers, written or spoken, keep only their last four", () => {
  const cases: [string, string][] = [
    ["Call me on +44 20 7946 0958 please.", "Call me on [phone ending 0958] please."],
    ["it's 0044 20 7946 0958", "it's [phone ending 0958]"],
    ["my mobile is +61 491 570 156", "my mobile is [phone ending 0156]"],
    ["+61491570156", "[phone ending 0156]"],
    ["my UK number, 020 7946 0958", "my UK number, [phone ending 0958]"],
    ["plus four four, two zero seven, nine four six, zero nine five eight", "[phone ending 0958]"],
    ["zero zero four four two zero seven nine four six zero nine five eight", "[phone ending 0958]"],
    [
      "Got it, nine six zero, one five five, zero one two three. Anything else?",
      "Got it, [phone ending 0123]. Anything else?",
    ],
    ["nine six zero one double five zero one two three", "[phone ending 0123]"],
    ["my number is 555 0177", "my number is [phone ending 0177]"],
  ];
  for (const [input, output] of cases) {
    assertEquals(redactPIIAsOf(input, 2026), output, input);
    assertEquals(redactPIIAsOf(output, 2026), output, `${input} (idempotent)`);
  }
});

Deno.test("redactPII: what only looks like a number from abroad is kept", () => {
  for (
    const kept of [
      "Claim CLM-240115 was filed on 2026-10-08 at 10:30 for $4,820.",
      "filed on 10-08-2026, written 10 08 2026 or 2026.10.08",
      "the impossible 1986-13-01 stays",
      "Send it to Phoenix, AZ 85004-1234.",
      "a policy held 2019-2026",
      "a rate of 0.0123456",
      "Please call our main line at 1-800-555-0142, and someone there will help you.",
      "our main line is one eight hundred, five five five, zero one four two",
      "call 6b0d6f0e-1c11-4c7a-9a01-000000000101",
      "trace 12345678-1234-4c7a-9a01-000000000101",
      "Which claim do you mean, the one ending in one nine eight, one one five, zero nine zero, or eight four nine?",
      "Your auto claim ending in one one five was paid, four thousand eight hundred twenty dollars on October eighth.",
      "I have 2 cars plus 1 truck, and 12 photos.",
    ]
  ) {
    assertEquals(redactPIIAsOf(kept, 2026), kept, kept);
  }
  // a word between two numbers is not a country code
  assertEquals(redactPII("602 555 0101 plus 2 more"), "[phone ending 0101] plus 2 more");
  assertEquals(redactPII("it's 555 0177 plus 2 extensions"), "it's [phone ending 0177] plus 2 extensions");
});

Deno.test("redactPII: claim numbers, amounts and years next to other numbers are never joined into a phone", () => {
  for (
    const kept of [
      // a sentence end, a list of amounts or years, a counting word, and a policy or claim number
      "My claim is two four zero one nine eight. Two weeks ago I sent the photos.",
      "Claim 240115. 3 photos uploaded.",
      "estimates 1200, 1500.",
      "Caller has 3 claims from 2019, 2021 and 2024.",
      "claims from twenty nineteen, twenty twenty one and twenty twenty four",
      "The deductible is 500. 1000 for comprehensive.",
      "The quotes were 450, 600, 725 and 900.",
      "The policy number is 7301 2244.",
      "claim number 1234 5678",
      "id 4111 1111 1111 1111",
    ]
  ) {
    assertEquals(redactPIIAsOf(kept, 2026), kept, kept);
  }
  // the number itself is still redacted whole, and what follows it stays
  assertEquals(redactPIIAsOf("555 0177. 2 cars", 2026), "[phone ending 0177]. 2 cars");
  assertEquals(redactPIIAsOf("my number is 555 0177, 2 cars", 2026), "my number is [phone ending 0177], 2 cars");
  assertEquals(
    redactPIIAsOf("Six oh two. Five five five. Oh one oh one. Two claims.", 2026),
    "[phone ending 0101]. Two claims.",
  );
});

Deno.test("redactPII: every read-back of a number noted as said, 7 to 15 digits, keeps only its real last four", () => {
  const said = "960155012345678";
  for (let n = 7; n <= 15; n++) {
    const number = said.slice(0, n);
    const last4 = number.slice(-4);
    for (
      const sentence of [
        sentenceFor("callback_updated", { digits: number }),
        sentenceFor("contact_readback", { first_name: "Jane", last_name: "Doe", callback_phone: number }),
        sentenceFor("rep_queued", { target: "given", number }),
      ]
    ) {
      // the whole number, and nothing else, becomes the token
      const redacted = redactPIIAsOf(sentence, 2026);
      assertEquals(redacted, sentence.replace(speakPhone(number), `[phone ending ${last4}]`), sentence);
      assertEquals(redactPIIAsOf(redacted, 2026), redacted, "idempotent");
    }
  }
  // and with a country code: "plus" and every digit go
  for (const number of ["+442079460958", "+61491570156", "+861012345678901"]) {
    const redacted = redactPIIAsOf(sentenceFor("callback_updated", { digits: number }), 2026);
    assertEquals(redacted, `Got it, [phone ending ${number.slice(-4)}]. Anything else I can help with?`, number);
  }
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

Deno.test("jsonLogger: an email address inside a string value is redacted, not only an email key", () => {
  const out = captureLog({ error: "resend 422: invalid recipient owner@example.com" });
  assertEquals(out.error, "resend 422: invalid recipient [email]");
});

Deno.test("jsonLogger: Error values log as name and message", () => {
  const out = captureLog({ error: new TypeError("bad thing") });
  assertEquals(out.error, "TypeError: bad thing");
});

Deno.test("jsonLogger: an unserialisable event never throws", () => {
  const out = captureLog({ n: 1n });
  assertEquals(out, { log_error: "unserialisable event" });
});
