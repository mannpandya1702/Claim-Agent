// capture_contact / confirm_contact and what hangs off them: the new-caller branch (name, spelled
// email, callback number, the read-back, the confirmation), the verified customer's pending email
// update that is never a recipient, the one email a confirmed new caller may get, and the team
// emails that now say who to call back while the Telegram card still carries ids and enums only.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { Channel } from "./enums.ts";
import { createFakeStore, type FakeStore } from "./fake_store.ts";
import { assertSpeakable, sentenceFor } from "./speak.ts";
import { runTool } from "./tools.ts";
import type { Deps, Env, ToolCtx, ToolResult } from "./types.ts";

const CALL_KEY = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const TOKEN = "246810:CONTACT-test-token";
const OUR_LINE = "+15205210277";
const TOBIAS = "6b0d6f0e-1c11-4c7a-9a01-000000000101";
const TEAGUE = "6b0d6f0e-1c11-4c7a-9a01-000000000104";
const NOW = new Date("2026-10-12T15:00:00Z");

const READBACK_JANE =
  "Thanks! Here's what I have. Jane Doe, and your email is J, A, N, E, dot, D, O, E, at gmail dot com. Did I get that right?";
// The number a caller said is read back too; one taken from caller id is not (nobody said it).
const READBACK_JANE_NUMBER =
  "Thanks! Here's what I have. Jane Doe, your email is J, A, N, E, dot, D, O, E, at gmail dot com, and the best number is six zero two, five five five, zero one seven seven. Did I get that right?";
const SAVED_JANE =
  "Your details are saved now. I can take down what happened now, email you the steps to start a claim, or have someone from our claims team call you back. What would you prefer?";

type Responder = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Recorded {
  url: string;
  init: RequestInit;
}

function harness(opts: {
  env?: Partial<Env>;
  resend?: Responder;
  channel?: Channel;
  callerNumber?: string | null;
  isChat?: boolean;
} = {}) {
  const store: FakeStore = createFakeStore(undefined, { now: () => NOW });
  const calls: Recorded[] = [];
  const pending: Promise<unknown>[] = [];
  let resendIds = 0;
  const resend: Responder = opts.resend ??
    (() => json({ id: `re_${++resendIds}` }));
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://api.telegram.org/")) {
      return json({ ok: true, result: { message_id: 7 } });
    }
    if (url === "https://api.resend.com/emails") {
      return await resend(url, init ?? {});
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    store,
    fetch: fetchFn,
    env: {
      VAPI_ORG_ID: "org_test",
      VAPI_WEBHOOK_SECRET: "secret",
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: "4242",
      RESEND_API_KEY: "re_test_key",
      CLAIMS_TEAM_EMAIL: "team@example.com",
      DASHBOARD_URL: "https://ops.example.test/",
      OWN_NUMBERS: OUR_LINE,
      ...opts.env,
    },
    now: () => NOW,
    waitUntil: (p) => {
      pending.push(p);
    },
    log: () => {},
  };
  const ctx: Omit<ToolCtx, "toolCallId"> = {
    callKey: CALL_KEY,
    channel: opts.channel ?? "webCall",
    callerNumber: opts.callerNumber ?? null,
    isChat: opts.isChat ?? false,
    deps,
  };
  let seq = 0;
  async function run(
    name: string,
    args: Record<string, unknown> | null,
    toolCallId?: string,
  ): Promise<ToolResult> {
    const result = await runTool({
      id: toolCallId ?? `tc_${++seq}`,
      name,
      args,
    }, ctx);
    assertSpeakable(result.sentence);
    await Promise.all(pending);
    return result;
  }
  const telegramCalls = () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
  const resendCalls = () => calls.filter((c) => c.url === "https://api.resend.com/emails");
  const contact = () => store.tables.caller_contacts.find((c) => c.call_key === CALL_KEY);
  return { store, deps, calls, run, telegramCalls, resendCalls, contact };
}

type Harness = ReturnType<typeof harness>;

const body = (c: Recorded): Record<string, any> => JSON.parse(String(c.init.body));

async function notFoundTwice(h: Harness): Promise<void> {
  assertEquals(
    (await h.run("lookup_customer", { phone: "6025550199" })).code,
    "not_found",
  );
  const final = await h.run("lookup_customer", { phone: "6025550199" });
  assertEquals(final.code, "not_found_final");
  // the sentence itself asks for the name, since a tool sentence ends the turn
  assertStringIncludes(final.sentence, "Could I get your first and last name?");
}

async function verifyAs(
  h: Harness,
  phone: string,
  dob: [number, number, number],
): Promise<void> {
  assertEquals((await h.run("lookup_customer", { phone })).code, "needs_dob");
  const verified = await h.run("verify_identity", {
    dob_month: dob[0],
    dob_day: dob[1],
    dob_year: dob[2],
  });
  assertEquals(verified.code, "verified");
}

/** A new caller who gave their details and said yes to the read-back. */
async function confirmedNewCaller(
  h: Harness,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await notFoundTwice(h);
  const read = await h.run("capture_contact", {
    first_name: "jane",
    last_name: "doe",
    email: "j a n e dot d o e at gmail dot com",
    callback_phone: "602-555-0177",
    ...extra,
  });
  assertEquals(read.code, "contact_readback");
  assertEquals(
    (await h.run("confirm_contact", { correct: true })).code,
    "contact_saved_new",
  );
}

// ---------------------------------------------------------------------------------------------
// The new-caller branch.
// ---------------------------------------------------------------------------------------------
Deno.test("new caller: not found twice, details read back letter by letter, a yes saves them", async () => {
  const h = harness();
  await notFoundTwice(h);
  const read = await h.run("capture_contact", {
    first_name: "jane",
    last_name: "doe",
    email: "j a n e dot d o e at gmail dot com",
  });
  assertEquals(read, {
    code: "contact_readback",
    sentence: READBACK_JANE,
    data: { first_name: "Jane" },
  });
  assertEquals(h.contact(), {
    call_key: CALL_KEY,
    kind: "new_customer",
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: null, // a web call has no caller id and no number was said
    callback_source: "none",
    customer_id: null,
    confirmed: false,
    confirmed_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  const saved = await h.run("confirm_contact", { correct: true });
  assertEquals(saved, {
    code: "contact_saved_new",
    sentence: SAVED_JANE,
    data: { first_name: "Jane" },
  });
  assertEquals([h.contact()?.confirmed, h.contact()?.confirmed_at], [
    true,
    NOW.toISOString(),
  ]);
  // capture and confirm never page or email anyone
  assertEquals(h.calls.length, 0);
});

Deno.test("new caller: the callback number is the one said, else the caller id, never our own line", async () => {
  const phone = harness({
    channel: "inboundPhoneCall",
    callerNumber: "+16025550166",
  });
  await phone.run("capture_contact", { first_name: "Jane", last_name: "Doe" });
  assertEquals([
    phone.contact()?.callback_phone,
    phone.contact()?.callback_source,
  ], ["+16025550166", "caller_id"]);
  await phone.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    callback_phone: "(602) 555-0177",
  });
  assertEquals([
    phone.contact()?.callback_phone,
    phone.contact()?.callback_source,
  ], ["+16025550177", "argument"]);
  // a number that cannot be dialled back falls back to the caller id
  await phone.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    callback_phone: "555-0177",
  });
  assertEquals([
    phone.contact()?.callback_phone,
    phone.contact()?.callback_source,
  ], ["+16025550166", "caller_id"]);

  const own = harness({ channel: "inboundPhoneCall", callerNumber: OUR_LINE });
  const args = { first_name: "Jane", last_name: "Doe", callback_phone: OUR_LINE };
  // nothing usable to call back on a phone call: the tool asks once for the best number
  const ask = await own.run("capture_contact", args);
  assertEquals([ask.code, ask.sentence], [
    "contact_needs_phone",
    "Sorry, I can't see the number you're calling from. What's the best number to reach you?",
  ]);
  assertEquals(own.contact(), undefined);
  // asked once: a caller who would rather not give one is stored without a number
  assertEquals((await own.run("capture_contact", args)).code, "contact_readback");
  assertEquals(
    [own.contact()?.callback_phone, own.contact()?.callback_source],
    [null, "none"],
  );
});

Deno.test("capture_contact: the number a caller said is read back; a caller id number is not", async () => {
  const h = harness();
  const read = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: "602 555 0177",
  });
  assertEquals(read.sentence, READBACK_JANE_NUMBER);
  // the number is in the sentence only; the result's data carries the first name alone
  assertEquals(read.data, { first_name: "Jane" });
  const nameOnly = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    callback_phone: "6025550177",
  });
  assertEquals(
    nameOnly.sentence,
    "Thanks! So that's Jane Doe, and the best number is six zero two, five five five, zero one seven seven. Did I get that right?",
  );
  const phone = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550166" });
  const fromCallerId = await phone.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
  });
  assertEquals(fromCallerId.sentence, READBACK_JANE);
  assertEquals(phone.contact()?.callback_source, "caller_id");
});

Deno.test("capture_contact: a correction that leaves the number out keeps the number said earlier", async () => {
  const h = harness({ channel: "inboundPhoneCall", callerNumber: "+16025550166" });
  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: "6025550177",
  });
  await h.run("confirm_contact", { correct: false });
  const again = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jayne.doe@gmail.com",
  });
  assertEquals([h.contact()?.callback_phone, h.contact()?.callback_source], ["+16025550177", "argument"]);
  assertStringIncludes(again.sentence, "the best number is six zero two, five five five, zero one seven seven");
  // a number said in the correction replaces it
  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jayne.doe@gmail.com",
    callback_phone: "6025550188",
  });
  assertEquals(h.contact()?.callback_phone, "+16025550188");
});

Deno.test("capture_contact: only a phone call with no usable caller id asks for the number", async () => {
  // a web call or a chat never has a caller id: its prompt asks for the digits, so a capture without
  // a number is a caller who would rather not give one
  for (const opts of [{ channel: "webCall" as Channel }, { channel: "chat" as Channel, isChat: true }]) {
    const h = harness(opts);
    assertEquals((await h.run("capture_contact", { first_name: "Jane", last_name: "Doe" })).code, "contact_readback");
    assertEquals(h.contact()?.callback_source, "none", opts.channel);
  }
  // a withheld or junk caller id on a phone call
  for (const callerNumber of [null, "+10000000000", "anonymous"]) {
    const h = harness({ channel: "inboundPhoneCall", callerNumber });
    assertEquals(
      (await h.run("capture_contact", { first_name: "Jane", last_name: "Doe" })).code,
      "contact_needs_phone",
      String(callerNumber),
    );
    // the number they then say is stored and read back
    const read = await h.run("capture_contact", { first_name: "Jane", last_name: "Doe", callback_phone: "6025550177" });
    assertEquals([read.code, h.contact()?.callback_source], ["contact_readback", "argument"]);
  }
  // a verified caller's email update never asks for a number
  const verified = harness({ channel: "inboundPhoneCall", callerNumber: null });
  await verifyAs(verified, "6025550104", [1, 30, 1965]);
  assertEquals((await verified.run("capture_contact", { email: "teague@gmail.com" })).code, "contact_readback");
});

Deno.test("capture_contact: no email reads back the name only; a full name in first_name is split", async () => {
  const h = harness();
  const read = await h.run("capture_contact", {
    first_name: "Mary-Jane O'Neil",
  });
  assertEquals(
    read.sentence,
    "Thanks! So that's Mary-Jane O'Neil. Did I get that right?",
  );
  assertEquals([
    h.contact()?.first_name,
    h.contact()?.last_name,
    h.contact()?.email,
  ], ["Mary-Jane", "O'Neil", null]);
  const saved = await h.run("confirm_contact", { correct: true });
  // nothing to email the steps to, so the website stands in
  assertEquals(
    saved.sentence,
    sentenceFor("contact_saved_new", {
      first_name: "Mary-Jane",
      has_email: false,
    }, CALL_KEY),
  );
});

Deno.test("capture_contact: an unreadable email or name is asked for again and nothing is stored", async () => {
  const h = harness();
  for (
    const email of [
      "jane at gmail",
      "pat at work at gmail dot com",
      "jane..doe@gmail.com",
      42,
    ]
  ) {
    const r = await h.run("capture_contact", {
      first_name: "Jane",
      last_name: "Doe",
      email,
    });
    assertEquals(r.code, "contact_invalid_email", String(email));
    assertEquals(
      r.sentence,
      "Hmm, I didn't quite catch a full email address. Could you spell it for me, letter by letter?",
    );
  }
  for (
    const names of [
      {},
      { first_name: "Jane" },
      { first_name: "First Name", last_name: "Doe" },
      { first_name: "R2", last_name: "D2" },
      { first_name: "Jane", last_name: "x".repeat(41) },
      { first_name: 7, last_name: "Doe" },
    ]
  ) {
    const r = await h.run("capture_contact", {
      ...names,
      email: "jane@gmail.com",
    });
    assertEquals(r.code, "contact_needs_name", JSON.stringify(names));
    assertEquals(r.sentence, "Sorry, could I get your first and last name?");
  }
  assertEquals(h.store.tables.caller_contacts.length, 0);
  // a placeholder the model filled in is refused at the trust boundary before anything runs
  assertEquals(
    (await h.run("capture_contact", {
      first_name: "unknown",
      last_name: "Doe",
    })).code,
    "bad_args",
  );
});

Deno.test("confirm_contact: not_pending without a capture; a no asks again and leaves it unconfirmed", async () => {
  const h = harness();
  assertEquals(await h.run("confirm_contact", { correct: true }), {
    code: "not_pending",
    sentence: "Sorry about that, let me take your details again. What's your first and last name?",
  });
  assertEquals(h.store.tables.caller_contacts.length, 0);

  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
  });
  // a plain no asks which part was wrong, rather than making them spell an address that was right
  const no = await h.run("confirm_contact", { correct: false });
  assertEquals(no, {
    code: "contact_retry",
    sentence: "Sorry about that. What did I get wrong, your name or your email?",
    data: { has_email: true, has_phone: false },
  });
  assertEquals(h.contact()?.confirmed, false);
  // a yes after the fix saves it; a later no takes the yes back
  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jayne.doe@gmail.com",
  });
  assertEquals(
    (await h.run("confirm_contact", { correct: "yes" })).code,
    "contact_saved_new",
  );
  assertEquals(
    (await h.run("confirm_contact", { correct: false })).code,
    "contact_retry",
  );
  assertEquals([h.contact()?.confirmed, h.contact()?.confirmed_at], [
    false,
    null,
  ]);

  // with a number that was read back, the number is one of the parts
  const withNumber = harness();
  await withNumber.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: "6025550177",
  });
  assertEquals(
    (await withNumber.run("confirm_contact", { correct: false })).sentence,
    "Sorry about that. What did I get wrong, your name, your email or your number?",
  );
  // without an email the retry asks for the name
  const nameOnly = harness();
  await nameOnly.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
  });
  assertEquals(
    (await nameOnly.run("confirm_contact", { correct: false })).sentence,
    "Sorry about that. Could you tell me your first and last name one more time?",
  );
  // the answer must be a yes or a no
  for (const correct of [undefined, "maybe", 1, null]) {
    assertEquals(
      (await h.run("confirm_contact", correct === undefined ? {} : { correct }))
        .code,
      "bad_args",
    );
  }
});

Deno.test("replays of the same toolCallId repeat the answer without a second write", async () => {
  const h = harness();
  const first = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
  }, "cap-1");
  assertEquals(first.sentence, READBACK_JANE);
  assertEquals(
    await h.run("capture_contact", { first_name: "Jane", last_name: "Doe", email: "jane.doe@gmail.com" }, "cap-1"),
    first,
  );
  // a later capture replaces the row; a retry of the first one must not put it back, and reads back
  // the row that is stored, since that is what a yes would confirm
  const second = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jayne.doe@gmail.com",
  }, "cap-2");
  const replay = await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
  }, "cap-1");
  assertEquals(replay, second);
  assertEquals(h.contact()?.email, "jayne.doe@gmail.com");

  const saved = await h.run("confirm_contact", { correct: true }, "conf-1");
  const at = h.contact()?.updated_at;
  const again = await h.run("confirm_contact", { correct: true }, "conf-1");
  assertEquals(again, saved);
  assertEquals(h.contact()?.updated_at, at, "a replay writes nothing");
  assertEquals(
    h.store.tables.attempts.filter((a) => a.call_key === CALL_KEY).map((a) => `${a.tool_call_id}:${a.code}`),
    [
      "cap-1:contact_readback",
      "cap-2:contact_readback",
      "conf-1:contact_saved_new",
    ],
  );
  // the same read-back captured again after the yes stays confirmed
  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jayne.doe@gmail.com",
  });
  assertEquals(h.contact()?.confirmed, true);
});

Deno.test("smuggled identity fields are stripped: an unverified capture is a new customer with no account", async () => {
  const h = harness();
  await h.run("lookup_customer", { phone: "6025550101" }); // phone_found, not verified
  await h.run("capture_contact", {
    first_name: "Tobias",
    last_name: "Halvorsen",
    email: "attacker@example.com",
    customer_id: TOBIAS,
    customerId: TOBIAS,
    identity_verified: true,
    verified: true,
    level: "verified",
    kind: "email_update",
  });
  assertEquals([h.contact()?.kind, h.contact()?.customer_id], [
    "new_customer",
    null,
  ]);
  assertEquals(
    (await h.store.getCustomer(TOBIAS))?.email,
    "owner@example.com",
    "the account is never touched",
  );
});

// ---------------------------------------------------------------------------------------------
// The verified customer with no email on file: a pending update for staff, never a recipient.
// ---------------------------------------------------------------------------------------------
Deno.test("verified with no email: the name comes from the account, the address is a pending update", async () => {
  const h = harness();
  await verifyAs(h, "6025550104", [1, 30, 1965]);
  assertEquals(
    (await h.run("send_info_email", { topic: "claim_summary" })).code,
    "no_email_on_file",
  );
  // the model's name arguments are ignored: the account's name is read back
  const read = await h.run("capture_contact", {
    first_name: "Mallory",
    last_name: "Smith",
    email: "t e a g u e at gmail dot com",
  });
  assertEquals(
    read.sentence,
    "Thanks! Here's what I have. Teague Ashdown, and your email is T, E, A, G, U, E, at gmail dot com. Did I get that right?",
  );
  assertEquals([
    h.contact()?.kind,
    h.contact()?.customer_id,
    h.contact()?.first_name,
  ], ["email_update", TEAGUE, "Teague"]);
  assertEquals(await h.run("confirm_contact", { correct: true }), {
    code: "contact_saved_existing",
    sentence:
      "Got it. I've passed that email to our team to add to your account. Is there anything else I can help with?",
    data: { first_name: "Teague" },
  });
  // never written to the customer, never used to send anything, whatever the topic
  assertEquals((await h.store.getCustomer(TEAGUE))?.email, null);
  for (
    const topic of ["document_checklist", "claim_summary", "how_to_start_claim"]
  ) {
    assertEquals(
      (await h.run("send_info_email", { topic })).code,
      "no_email_on_file",
      topic,
    );
  }
  assertEquals(h.resendCalls().length, 0);
  assertEquals(h.store.tables.emails.length, 0);
});

Deno.test("a replayed capture speaks the stored row, so the address confirmed and emailed is the one heard", async () => {
  const h = harness();
  await notFoundTwice(h);
  await h.run("capture_contact", { first_name: "Jane", last_name: "Jones", email: "jane@gmail.com" }, "cap-1");
  await h.run("confirm_contact", { correct: true });
  // a later capture with another address replaces the row, unconfirmed
  await h.run("capture_contact", { first_name: "Jane", last_name: "Jones", email: "evil@gmail.com" }, "cap-2");
  // a late retry of the first capture reads back what is stored now, not what its arguments said
  const replay = await h.run(
    "capture_contact",
    { first_name: "Jane", last_name: "Jones", email: "jane@gmail.com" },
    "cap-1",
  );
  assertStringIncludes(replay.sentence, "your email is E, V, I, L, at gmail dot com");
  assertFalse(replay.sentence.includes("J, A, N, E, at"));
  await h.run("confirm_contact", { correct: true });
  assertEquals((await h.run("send_info_email", { topic: "how_to_start_claim" })).code, "email_sent");
  assertEquals(
    body(h.resendCalls()[0]).to,
    ["evil@gmail.com"],
    "sent only to the address the caller heard and confirmed",
  );
});

Deno.test("verified with an email on file: no email update is stored, and no team email shows one", async () => {
  const h = harness();
  await verifyAs(h, "6025550101", [3, 14, 1986]); // Tobias: owner@example.com on file
  const r = await h.run("capture_contact", { email: "attacker at evil dot com" });
  assertEquals([r.code, r.sentence], [
    "email_on_file",
    "There's already an email on your account, so I can't change it on this call, but I can have someone from our claims team call you back about it. Would you like that?",
  ]);
  assertEquals(h.store.tables.caller_contacts.length, 0);
  // nothing pending, so a confirm has nothing to save; a verified caller is asked for the address
  const none = await h.run("confirm_contact", { correct: true }, "conf-none");
  assertEquals(none, {
    code: "not_pending",
    sentence: "Sorry, could you spell that email for me one more time, letter by letter?",
  });
  assertEquals(await h.run("confirm_contact", { correct: true }, "conf-none"), none, "a replay says the same");
  assertEquals((await h.store.getCustomer(TOBIAS))?.email, "owner@example.com");
  assertEquals((await h.run("escalate", { reason: "representative_requested" })).code, "rep_queued");
  const mail = teamMail(h);
  assertStringIncludes(mail.html, "Tobias Halvorsen");
  assertFalse(mail.html.includes("Email (caller-provided, unverified)"));
  assertFalse(mail.html.includes("evil"));
});

Deno.test("verified with no email: a no to the read-back asks to spell the address again", async () => {
  const h = harness();
  await verifyAs(h, "6025550104", [1, 30, 1965]);
  await h.run("capture_contact", { email: "teague@gmail.com" });
  assertEquals(
    (await h.run("confirm_contact", { correct: false })).sentence,
    "Sorry about that. Could you spell your email for me one more time, slowly?",
  );
});

Deno.test("verified: a capture without an address asks for one", async () => {
  const h = harness();
  await verifyAs(h, "6025550104", [1, 30, 1965]);
  assertEquals(
    (await h.run("capture_contact", {})).code,
    "contact_invalid_email",
  );
  assertEquals(h.store.tables.caller_contacts.length, 0);
});

// ---------------------------------------------------------------------------------------------
// send_info_email for a new caller.
// ---------------------------------------------------------------------------------------------
Deno.test("new caller: how_to_start goes to the captured address only after the yes, generic and by first name", async () => {
  const h = harness();
  await notFoundTwice(h);
  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
  });
  // before the yes: the read-back again, and nothing is sent
  const early = await h.run("send_info_email", { topic: "how_to_start_claim" });
  assertEquals([early.code, early.sentence], [
    "contact_readback",
    READBACK_JANE,
  ]);
  assertEquals(h.resendCalls().length, 0);

  await h.run("confirm_contact", { correct: true });
  const sent = await h.run("send_info_email", { topic: "how_to_start_claim" });
  assertEquals(sent.code, "email_sent");
  assertEquals(
    sent.sentence,
    "Okay, I've emailed that to the address you gave me, and it should arrive within a few minutes. Can I help with anything else?",
  );
  const [mail] = h.resendCalls();
  const b = body(mail);
  assertEquals(b.to, ["jane.doe@gmail.com"]);
  assertEquals(b.subject, "How to start a claim with Observe Insurance");
  assertStringIncludes(b.html, "Hello Jane,");
  assertStringIncludes(b.html, "Your policy number, if you have one");
  for (
    const leak of ["POL-", "Tobias", "Halvorsen", "CLM-", "owner@example.com"]
  ) assertFalse(b.html.includes(leak), leak);
  assertEquals(
    new Headers(mail.init.headers).get("Idempotency-Key"),
    `${CALL_KEY}:how_to_start_claim`,
  );
  assertEquals(
    h.store.tables.emails.map((e) => [e.kind, e.to_masked, e.status]),
    [
      ["how_to_start_claim", "j***@gmail.com", "sent"],
    ],
  );
  // once per call, as for a verified caller
  assertEquals(
    (await h.run("send_info_email", { topic: "how_to_start_claim" })).code,
    "email_already_sent",
  );
  assertEquals(h.resendCalls().length, 1);
});

Deno.test("new caller: claim details never go to a captured address, whatever the topic", async () => {
  const h = harness();
  await confirmedNewCaller(h);
  for (const topic of ["document_checklist", "claim_summary"]) {
    const r = await h.run("send_info_email", { topic });
    assertEquals([r.code, r.data], ["not_verified", { level: "none" }], topic);
  }
  assertEquals(h.resendCalls().length, 0);
  assertEquals(h.store.tables.emails.length, 0);
});

Deno.test("how_to_start for an unverified caller without a confirmed new-customer address", async () => {
  // confirmed, but no address: ask for one
  const noEmail = harness();
  await notFoundTwice(noEmail);
  await noEmail.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
  });
  await noEmail.run("confirm_contact", { correct: true });
  assertEquals(
    (await noEmail.run("send_info_email", { topic: "how_to_start_claim" }))
      .code,
    "contact_invalid_email",
  );

  // lookups ran out and no details yet: the new-caller details, not another phone number
  const noDetails = harness();
  await notFoundTwice(noDetails);
  assertEquals(
    (await noDetails.run("send_info_email", { topic: "how_to_start_claim" }))
      .code,
    "contact_needs_name",
  );

  // no lookup at all: verification first, as before
  const fresh = harness();
  const r = await fresh.run("send_info_email", { topic: "how_to_start_claim" });
  assertEquals([r.code, r.data], ["not_verified", { level: "none" }]);
  for (const h of [noEmail, noDetails, fresh]) {
    assertEquals(h.resendCalls().length, 0);
  }
});

Deno.test("a replayed new-caller email repeats the given-address sentence without a second send", async () => {
  const h = harness();
  await confirmedNewCaller(h);
  const first = await h.run(
    "send_info_email",
    { topic: "how_to_start_claim" },
    "mail-1",
  );
  const replay = await h.run(
    "send_info_email",
    { topic: "how_to_start_claim" },
    "mail-1",
  );
  assertEquals(replay.sentence, first.sentence);
  assertEquals(h.resendCalls().length, 1);
});

// ---------------------------------------------------------------------------------------------
// Team emails: name, full callback number, the labelled caller-provided address.
// ---------------------------------------------------------------------------------------------
function teamMail(h: Harness): Record<string, any> {
  const mails = h.resendCalls().map(body).filter((b) => b.to[0] === "team@example.com");
  assertEquals(mails.length, 1);
  return mails[0];
}

function telegramText(h: Harness): string {
  const [t] = h.telegramCalls();
  return String(body(t).text);
}

Deno.test("escalate for a new caller: the team email names them with the number and the labelled email", async () => {
  const h = harness();
  await confirmedNewCaller(h);
  const r = await h.run("escalate", { reason: "representative_requested" });
  // the number given with the details is the callback target, so the caller is not asked again
  assertEquals(r.code, "rep_queued");
  assertStringIncludes(
    r.sentence,
    "at the number you gave me, ending in zero one seven seven",
  );
  const row = h.store.tables.escalations[0];
  assertEquals([row.reason, row.callback_phone, row.callback_source], [
    "not_found",
    "+16025550177",
    "argument",
  ]);
  const mail = teamMail(h);
  assertStringIncludes(mail.html, "Jane Doe (caller-provided, unverified)");
  assertStringIncludes(mail.html, "(602) 555-0177 (+16025550177)");
  assertStringIncludes(mail.html, "Email (caller-provided, unverified)");
  assertStringIncludes(mail.html, "jane.doe@gmail.com");
  // Telegram stays ids and enums only
  const text = telegramText(h);
  for (const leak of ["Jane", "Doe", "0177", "555", "@", "gmail"]) {
    assertFalse(text.includes(leak), `${leak} in ${text}`);
  }
});

Deno.test("escalate for a verified customer: the account holder's name and the account's number", async () => {
  const h = harness();
  await verifyAs(h, "6025550101", [3, 14, 1986]);
  assertEquals(
    (await h.run("escalate", { reason: "representative_requested" })).code,
    "rep_queued",
  );
  const mail = teamMail(h);
  assertStringIncludes(mail.html, "Tobias Halvorsen");
  assertFalse(mail.html.includes("caller-provided"));
  assertStringIncludes(mail.html, "(602) 555-0101 (+16025550101)");
  // the account's own email is not the caller-provided one
  assertFalse(mail.html.includes("owner@example.com"));
  for (const leak of ["Tobias", "Halvorsen", "0101"]) {
    assertFalse(telegramText(h).includes(leak), leak);
  }
});

Deno.test("an unconfirmed capture is not passed on as a name or an address", async () => {
  const h = harness();
  await notFoundTwice(h);
  await h.run("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@gmail.com",
    callback_phone: "6025550177",
  });
  await h.run("confirm_contact", { correct: false });
  await h.run("escalate", { reason: "representative_requested" });
  const mail = teamMail(h);
  assertStringIncludes(mail.html, "Unknown caller");
  assertFalse(mail.html.includes("Jane"));
  assertFalse(mail.html.includes("jane.doe@gmail.com"));
  // the number they said is still the best way back to them
  assertStringIncludes(mail.html, "(602) 555-0177 (+16025550177)");
});

Deno.test("report_emergency: the emergency email carries the caller's name, number and email too", async () => {
  const h = harness({
    channel: "inboundPhoneCall",
    callerNumber: "+16025550166",
  });
  await confirmedNewCaller(h);
  assertEquals(
    (await h.run("report_emergency", { note: "smoke in the kitchen" })).code,
    "emergency_logged",
  );
  const mail = teamMail(h);
  assertStringIncludes(mail.subject, "POSSIBLE EMERGENCY REPORTED");
  assertStringIncludes(mail.html, "Jane Doe (caller-provided, unverified)");
  assertStringIncludes(mail.html, "(602) 555-0177 (+16025550177)");
  assertStringIncludes(mail.html, "jane.doe@gmail.com");
  const text = telegramText(h);
  for (const leak of ["Jane", "Doe", "0177", "0166", "@"]) {
    assertFalse(text.includes(leak), leak);
  }
});

Deno.test("chat: capture and confirm work and still page nobody", async () => {
  const h = harness({ isChat: true, channel: "chat" });
  await confirmedNewCaller(h);
  assertEquals(
    (await h.run("escalate", { reason: "representative_requested" })).code,
    "rep_queued",
  );
  assertEquals(h.telegramCalls().length, 0);
  assert(h.store.tables.escalations.every((e) => e.alert_status === "skipped"));
});

Deno.test("a store failure in capture or confirm is the trouble line, never a false read-back", async () => {
  const h = harness();
  h.store.failNext("upsertContact");
  assertEquals(
    (await h.run("capture_contact", { first_name: "Jane", last_name: "Doe" }))
      .code,
    "system_error",
  );
  assertEquals(h.store.tables.caller_contacts.length, 0);
  await h.run("capture_contact", { first_name: "Jane", last_name: "Doe" });
  h.store.failNext("setContactConfirmed");
  assertEquals(
    (await h.run("confirm_contact", { correct: true })).code,
    "system_error",
  );
  assertEquals(h.contact()?.confirmed, false);
});
