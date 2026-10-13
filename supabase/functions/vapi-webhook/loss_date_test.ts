// parseLossDate: every phrase shape the contract lists, read against a fixed "today" in New York,
// plus the edges that move a date by a day in careless code (the DST change on 2026-11-01, a UTC date
// that is already tomorrow, the year boundary) and everything that must stay unreadable.
import { assertEquals } from "@std/assert";
import { type LossDateResult, MAX_LOSS_AGE_DAYS, parseLossDate } from "./loss_date.ts";

// Tuesday, October 13, 2026, 11:00 in New York (EDT).
const NOW = new Date("2026-10-13T15:00:00Z");

function expectDate(cases: [string, string][], now = NOW, tz?: string): void {
  for (const [text, date] of cases) {
    assertEquals(parseLossDate(text, now, tz), { date }, JSON.stringify(text));
  }
}

function expectError(cases: string[], error: "unreadable" | "future" | "too_old", now = NOW): void {
  for (const text of cases) {
    assertEquals(parseLossDate(text, now), { error } as LossDateResult, JSON.stringify(text));
  }
}

Deno.test("ISO dates are taken as written", () => {
  expectDate([
    ["2026-10-10", "2026-10-10"],
    ["2026/10/10", "2026-10-10"],
    ["2026-1-5", "2026-01-05"],
    [" 2026-10-13 ", "2026-10-13"],
    ["It happened on 2026-10-01.", "2026-10-01"],
  ]);
  expectError(["2026-02-30", "2026-13-01", "2026-00-10", "2026-10-32"], "unreadable");
  expectError(["2026-10-14", "2027-01-01"], "future");
});

Deno.test("today, tonight, this morning and the like are today", () => {
  expectDate(
    [
      "today",
      "Today.",
      "tonight",
      "this morning",
      "This afternoon",
      "this evening",
      "earlier today",
      "just now",
      "it happened this morning",
      "it was today at 9 am",
      "today around 10:30",
    ].map((t): [string, string] => [t, "2026-10-13"]),
  );
});

Deno.test("yesterday, last night and the day before yesterday", () => {
  expectDate(
    [
      "yesterday",
      "Yesterday!",
      "last night",
      "yesterday afternoon",
      "yesterday morning",
      "yesterday evening",
      "yesterday at 3 pm",
      "yesterday at 3 p.m.",
      "it happened yesterday around noon",
    ].map((t): [string, string] => [t, "2026-10-12"]),
  );
  expectDate([
    ["the day before yesterday", "2026-10-11"],
    ["day before yesterday", "2026-10-11"],
  ]);
});

Deno.test("N days ago in digits or words up to thirty, and whole weeks up to four", () => {
  expectDate([
    ["3 days ago", "2026-10-10"],
    ["three days ago", "2026-10-10"],
    ["a day ago", "2026-10-12"],
    ["1 day ago", "2026-10-12"],
    ["ten days ago", "2026-10-03"],
    ["twenty one days ago", "2026-09-22"],
    ["twenty-one days ago", "2026-09-22"],
    ["thirty days ago", "2026-09-13"],
    ["30 days ago", "2026-09-13"],
    ["a week ago", "2026-10-06"],
    ["two weeks ago", "2026-09-29"],
    ["4 weeks ago", "2026-09-15"],
  ]);
  expectError(
    ["31 days ago", "thirty one days ago", "zero days ago", "0 days ago", "five weeks ago", "days ago"],
    "unreadable",
  );
});

Deno.test("weekdays: the most recent past one; today's name is today, 'last' today's name a week ago", () => {
  // today is a Tuesday
  expectDate([
    ["Tuesday", "2026-10-13"],
    ["tues", "2026-10-13"],
    ["last Tuesday", "2026-10-06"],
    ["this past Tuesday", "2026-10-06"],
    ["past tuesday", "2026-10-06"],
    ["Monday", "2026-10-12"],
    ["last Monday", "2026-10-12"],
    ["Sunday", "2026-10-11"],
    ["Saturday", "2026-10-10"],
    ["this past Saturday", "2026-10-10"],
    ["Friday", "2026-10-09"],
    ["Thursday", "2026-10-08"],
    ["Wednesday", "2026-10-07"],
    ["last wednesday", "2026-10-07"],
    ["on Friday night", "2026-10-09"],
    ["Sunday morning", "2026-10-11"],
    ["it was on Saturday", "2026-10-10"],
    ["Saturday at around 8 pm", "2026-10-10"],
    ["this Sunday", "2026-10-11"],
  ]);
});

Deno.test("month and day in any order, ordinals in digits or words, with an optional year", () => {
  expectDate([
    ["October 10", "2026-10-10"],
    ["Oct 10th", "2026-10-10"],
    ["Oct. 10th", "2026-10-10"],
    ["october tenth", "2026-10-10"],
    ["October ten", "2026-10-10"],
    ["October the 10th", "2026-10-10"],
    ["the tenth of October", "2026-10-10"],
    ["tenth of October", "2026-10-10"],
    ["10th of October", "2026-10-10"],
    ["10 October", "2026-10-10"],
    ["October 1st", "2026-10-01"],
    ["October first", "2026-10-01"],
    ["September thirtieth", "2026-09-30"],
    ["Sept 3rd", "2026-09-03"],
    ["August twenty-second", "2026-08-22"],
    ["the twenty first of September", "2026-09-21"],
    ["October 10, 2026", "2026-10-10"],
    ["October 10th 2026", "2026-10-10"],
    ["10th of October 2026", "2026-10-10"],
    ["October 12th two thousand twenty six", "2026-10-12"],
    ["October twelfth, twenty twenty six", "2026-10-12"],
    ["October 13", "2026-10-13"],
    ["Saturday, October 10th", "2026-10-10"],
    ["last Saturday, October 10", "2026-10-10"],
    ["yesterday, October 12th", "2026-10-12"],
    ["on May 5th", "2026-05-05"],
  ]);
});

Deno.test("a month and day still to come this year is last year's; an explicit future year is future", () => {
  expectDate([
    ["October 14", "2025-10-14"],
    ["October twenty first", "2025-10-21"],
    ["December 25", "2025-12-25"],
    ["November 1st", "2025-11-01"],
  ]);
  expectError(["October 10, 2027", "October 14 2026", "December 25th, 2026"], "future");
  expectError(["October 10th 2025", "October tenth, twenty twenty five", "January 5, 2024"], "too_old");
});

Deno.test("February 29th only in a leap year", () => {
  expectError(["February 29", "February 29th 2026", "2/29"], "unreadable");
  expectDate([["February 29"]].map(([t]): [string, string] => [t, "2028-02-29"]), new Date("2028-03-01T15:00:00Z"));
});

Deno.test("'the 10th' is this month, else last month when this month's is still to come", () => {
  expectDate([
    ["the 10th", "2026-10-10"],
    ["the tenth", "2026-10-10"],
    ["on the 5th", "2026-10-05"],
    ["10th", "2026-10-10"],
    ["tenth", "2026-10-10"],
    ["the 13th", "2026-10-13"],
    ["the 20th", "2026-09-20"],
    ["the twentieth", "2026-09-20"],
    ["the ten", "2026-10-10"],
  ]);
  // October 31st is still to come and September has no 31st
  expectError(["the 31st", "ten", "the fortieth"], "unreadable");
});

Deno.test("numeric month/day in US order, with a two- or four-digit year", () => {
  expectDate([
    ["10/10", "2026-10-10"],
    ["10-10", "2026-10-10"],
    ["10 / 10", "2026-10-10"],
    ["10.10", "2026-10-10"],
    ["10/10/26", "2026-10-10"],
    ["10/10/2026", "2026-10-10"],
    ["9/7", "2026-09-07"],
    ["12/25", "2025-12-25"],
    ["10/14", "2025-10-14"],
    ["on 10/12 at 5 pm", "2026-10-12"],
  ]);
  expectError(["13/10", "2/30", "0/10", "10/0"], "unreadable");
  expectError(["10/10/2027", "10/14/26"], "future");
  expectError(["1/5/25", "10/12/2025"], "too_old");
});

Deno.test("the oldest loss the phone intake takes is exactly a year back", () => {
  assertEquals(MAX_LOSS_AGE_DAYS, 365);
  expectDate([["2025-10-13", "2025-10-13"], ["October 13 2025", "2025-10-13"]]);
  expectError(["2025-10-12", "October 12, 2025"], "too_old");
});

Deno.test("last night, tonight, this evening and earlier today, said the natural way", () => {
  expectDate([
    ["last night", "2026-10-12"],
    ["Last night.", "2026-10-12"],
    ["late last night", "2026-10-12"],
    ["it was last night around 11", "2026-10-12"],
    ["the night before last", "2026-10-11"],
    ["tonight", "2026-10-13"],
    ["this evening", "2026-10-13"],
    ["earlier today", "2026-10-13"],
    ["early this morning", "2026-10-13"],
  ]);
});

Deno.test("a hedged day is the caller's best guess, read as that day (the read-back checks it)", () => {
  expectDate([
    ["Saturday I think", "2026-10-10"],
    ["Saturday, I think", "2026-10-10"],
    ["I\u2019m not sure, maybe Saturday", "2026-10-10"],
    ["I'm not sure, maybe Saturday", "2026-10-10"],
    ["Saturday maybe", "2026-10-10"],
    ["I'd say Saturday", "2026-10-10"],
    ["um, last Saturday", "2026-10-10"],
    ["uh yesterday", "2026-10-12"],
    ["yesterday I think", "2026-10-12"],
    ["last night, I think", "2026-10-12"],
    ["Saturday night I think", "2026-10-10"],
    ["late Saturday night", "2026-10-10"],
    ["early Sunday morning", "2026-10-11"],
    ["two days ago or so", "2026-10-11"],
    ["October 10th, I'm pretty sure", "2026-10-10"],
    ["the tenth I think", "2026-10-10"],
  ]);
  expectError(["I'm not sure", "not sure", "maybe", "I think"], "unreadable");
});

Deno.test("nights ago, a couple of days or weeks ago, and a weekend read as its Saturday", () => {
  expectDate([
    ["two nights ago", "2026-10-11"],
    ["3 nights ago", "2026-10-10"],
    ["a couple days ago", "2026-10-11"],
    ["a couple of days ago", "2026-10-11"],
    ["a couple of nights ago", "2026-10-11"],
    ["a couple weeks ago", "2026-09-29"],
    // today is a Tuesday: the weekend just gone
    ["last weekend", "2026-10-10"],
    ["this past weekend", "2026-10-10"],
    ["over the weekend", "2026-10-10"],
    ["on the weekend", "2026-10-10"],
    ["sometime last weekend", "2026-10-10"],
  ]);
  // on the weekend itself: "over the weekend" is this one, "last weekend" the one before (Saturday the 10th)
  const saturday = new Date("2026-10-10T15:00:00Z");
  expectDate([["over the weekend", "2026-10-10"], ["last weekend", "2026-10-03"]], saturday);
  const sunday = new Date("2026-10-11T15:00:00Z");
  expectDate([["over the weekend", "2026-10-10"], ["last weekend", "2026-10-10"]], sunday);
  // "this weekend" may be the coming one; "a few" is no count
  expectError(["this weekend", "a few days ago", "a few weeks ago", "the other day"], "unreadable");
});

Deno.test("anything that is not a date it can read for certain is unreadable, never a guess", () => {
  expectError(
    [
      "",
      "   ",
      "a while back",
      "last week",
      "recently",
      "sometime in October",
      "October",
      "10",
      "next Tuesday",
      "tomorrow",
      "October 10 or 11",
      "the 10th or the 11th",
      "I don't remember",
      "{{loss_date}}",
      "x".repeat(200),
    ],
    "unreadable",
  );
  for (const bad of [42, null, undefined, {}, ["yesterday"]]) {
    assertEquals(parseLossDate(bad, NOW), { error: "unreadable" });
  }
  assertEquals(parseLossDate("yesterday", new Date("not a date")), { error: "unreadable" });
  assertEquals(parseLossDate("yesterday", NOW, "Not/AZone"), { error: "unreadable" });
});

Deno.test("today is New York's calendar day, not the server's or UTC's", () => {
  // 22:00 EDT on the 13th is already the 14th in UTC
  const late = new Date("2026-10-14T02:00:00Z");
  expectDate([["today", "2026-10-13"], ["yesterday", "2026-10-12"], ["Tuesday", "2026-10-13"]], late);
  expectError(["October 14 2026"], "future", late);
  // another zone, when asked for
  expectDate([["today", "2026-10-14"]], NOW, "Pacific/Auckland");
  expectDate([["today", "2026-10-13"]], NOW, "UTC");
});

Deno.test("the DST change on 2026-11-01 never moves a date", () => {
  // 00:30 EDT, 01:30 EDT, 01:30 EST (after the clocks go back) and 23:30 EST, all on Sunday November 1
  for (const iso of ["2026-11-01T04:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-02T04:30:00Z"]) {
    const now = new Date(iso);
    expectDate(
      [
        ["today", "2026-11-01"],
        ["yesterday", "2026-10-31"],
        ["Sunday", "2026-11-01"],
        ["last Sunday", "2026-10-25"],
        ["Saturday night", "2026-10-31"],
        ["a week ago", "2026-10-25"],
        ["the 1st", "2026-11-01"],
        ["the 31st", "2026-10-31"],
        ["October 31", "2026-10-31"],
      ],
      now,
    );
  }
  // and the spring change (2027-03-14, 02:00 EST -> 03:00 EDT)
  const spring = new Date("2027-03-15T03:30:00Z"); // 23:30 EDT on Sunday the 14th
  expectDate([["today", "2027-03-14"], ["yesterday", "2027-03-13"], ["3 days ago", "2027-03-11"]], spring);
});

Deno.test("year boundaries: the last day of a year and the first of the next", () => {
  // 00:30 EST on January 1, 2027
  const newYear = new Date("2027-01-01T05:30:00Z");
  expectDate(
    [
      ["yesterday", "2026-12-31"],
      ["December 31", "2026-12-31"],
      ["12/31", "2026-12-31"],
      ["the 31st", "2026-12-31"],
      ["January 1", "2027-01-01"],
      ["January 2", "2026-01-02"],
      ["the day before yesterday", "2026-12-30"],
      ["Thursday", "2026-12-31"],
    ],
    newYear,
  );
  // 23:30 EST on December 31, 2026 (already January 1 in UTC)
  const eve = new Date("2027-01-01T04:30:00Z");
  expectDate([["today", "2026-12-31"], ["December 31", "2026-12-31"], ["January 1", "2026-01-01"]], eve);
  expectError(["2027-01-01"], "future", eve);
});
