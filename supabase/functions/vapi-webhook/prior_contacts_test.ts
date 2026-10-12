import { assert, assertEquals, assertFalse } from "@std/assert";
import { verifiedSentence } from "./prior_contacts.ts";
import { sentenceFor } from "./speak.ts";
import type { PriorInteraction } from "./types.ts";

const NOW = new Date("2026-10-12T15:00:00Z");
const PLAIN = "Thank you, Tobias, you're verified. What can I help you with today?";
const welcome = (date: string) =>
  `Thank you, Tobias, you're verified. Welcome back. I see you called on ${date}. Is this about the same claim as last time, or something else?`;

function row(
  started_at: string,
  summary: string | null = "Tobias asked about his auto claim; no follow-up needed.",
): PriorInteraction {
  return { vapi_call_id: `call-${started_at}`, started_at, summary };
}

Deno.test("verifiedSentence: flag off gives the plain sentence even with history", () => {
  assertEquals(verifiedSentence("Tobias", [row("2026-10-11T02:30:00Z")], false, NOW), PLAIN);
});

Deno.test("verifiedSentence: no history (first call, or the query failed and returned []) gives the plain sentence", () => {
  assertEquals(verifiedSentence("Tobias", [], true, NOW), PLAIN);
});

Deno.test("verifiedSentence: the date is in words in America/New_York, not UTC", () => {
  // 02:30 UTC on the 11th is 22:30 on the 10th in New York (EDT)
  assertEquals(verifiedSentence("Tobias", [row("2026-10-11T02:30:00Z")], true, NOW), welcome("October tenth"));
});

Deno.test("verifiedSentence: Postgres timestamptz text with an offset parses the same way", () => {
  assertEquals(verifiedSentence("Tobias", [row("2026-10-11 02:30:00.123+00:00")], true, NOW), welcome("October tenth"));
});

Deno.test("verifiedSentence: the newest of the rows is the one spoken", () => {
  const rows = [row("2026-09-02T14:00:00Z"), row("2026-10-06T14:00:00Z"), row("2026-09-28T14:00:00Z")];
  assertEquals(verifiedSentence("Tobias", rows, true, NOW), welcome("October sixth"));
});

Deno.test("verifiedSentence: only the first three rows are considered", () => {
  const rows = [
    row("2026-09-01T14:00:00Z"),
    row("2026-09-02T14:00:00Z"),
    row("2026-09-03T14:00:00Z"),
    row("2026-10-09T14:00:00Z"), // a fourth row, even a newer one, is outside the cap
  ];
  assertEquals(verifiedSentence("Tobias", rows, true, NOW), welcome("September third"));
});

Deno.test("verifiedSentence: a call in an earlier year carries the year in words", () => {
  const now = new Date("2026-01-05T15:00:00Z");
  assertEquals(
    verifiedSentence("Tobias", [row("2025-12-03T15:00:00Z")], true, now),
    welcome("December third, twenty twenty five"),
  );
  assertEquals(
    verifiedSentence("Tobias", [row("2009-07-04T15:00:00Z")], true, now),
    welcome("July fourth, two thousand nine"),
  );
});

Deno.test("verifiedSentence: the year boundary is judged in New York too", () => {
  // 03:00 UTC on Jan 1 is still Dec 31 in New York, and 'now' is Jan 1 in New York
  const now = new Date("2026-01-01T18:00:00Z");
  assertEquals(
    verifiedSentence("Tobias", [row("2026-01-01T03:00:00Z")], true, now),
    welcome("December thirty-first, twenty twenty five"),
  );
});

Deno.test("verifiedSentence: ordinal days are spoken as words", () => {
  const cases: [string, string][] = [
    ["2026-10-01T15:00:00Z", "October first"],
    ["2026-10-02T15:00:00Z", "October second"],
    ["2026-10-03T15:00:00Z", "October third"],
    ["2026-10-08T15:00:00Z", "October eighth"],
    ["2026-10-12T12:00:00Z", "October twelfth"],
    ["2026-09-20T15:00:00Z", "September twentieth"],
    ["2026-09-22T15:00:00Z", "September twenty-second"],
    ["2026-09-30T15:00:00Z", "September thirtieth"],
    ["2026-08-31T15:00:00Z", "August thirty-first"],
  ];
  for (const [at, date] of cases) {
    assertEquals(verifiedSentence("Tobias", [row(at)], true, NOW), welcome(date), at);
  }
});

Deno.test("verifiedSentence: never speaks the summary, a phone number, a DOB or digits", () => {
  const rows = [
    row("2026-10-11T02:30:00Z", "Tobias (602-555-0101, born March 14, 1986) asked about CLM-240115 and $4,820."),
  ];
  const s = verifiedSentence("Tobias", rows, true, NOW);
  assertEquals(s, welcome("October tenth"));
  assertFalse(/\d/.test(s), "no digits at all");
  assertFalse(/March|asked|CLM|born/.test(s));
});

Deno.test("verifiedSentence: unusable timestamps are skipped; none usable gives the plain sentence", () => {
  assertEquals(verifiedSentence("Tobias", [row("not a date"), row("2026-10-08")], true, NOW), PLAIN);
  assertEquals(
    verifiedSentence("Tobias", [row(""), row("2026-10-08T15:00:00Z"), row("2026-10-11 02:30:00")], true, NOW),
    welcome("October eighth"),
  );
  assertEquals(verifiedSentence("Tobias", [null as unknown as PriorInteraction], true, NOW), PLAIN);
});

Deno.test("verifiedSentence: spoken text is printable ASCII; names are folded and trimmed", () => {
  assertEquals(
    verifiedSentence("  Jos\u00e9 ", [], true, NOW),
    "Thank you, Jose, you're verified. What can I help you with today?",
  );
  assertEquals(verifiedSentence("", [], true, NOW), "Thank you, you're verified. What can I help you with today?");
  const s = verifiedSentence("Sloane", [row("2026-10-11T02:30:00Z")], true, NOW);
  assert(/^[\x20-\x7e]+$/.test(s));
});

Deno.test("verifiedSentence: the plain sentence is speak.ts's verified sentence, word for word", () => {
  for (const name of ["Tobias", "  Jos\u00e9 ", "", "Mary-Jane", "O'Brien"]) {
    assertEquals(verifiedSentence(name, [], true, NOW), sentenceFor("verified", { first_name: name }), name);
  }
  // The welcome-back variant opens with the same thanks clause.
  const s = verifiedSentence("Tobias", [row("2026-10-11T02:30:00Z")], true, NOW);
  assert(
    s.startsWith(sentenceFor("verified", { first_name: "Tobias" }).replace(" What can I help you with today?", "")),
  );
});
