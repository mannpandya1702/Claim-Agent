// The Telegram card is a closed format: ids and enums only. These tests push PII-shaped strings
// (phone numbers, dates of birth, a full name, a claim number, an email address) into every input
// renderAlert accepts and assert none of it reaches the text the team's phone displays.
import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { CHANNELS, ESCALATION_KINDS, ESCALATION_REASONS } from "./enums.ts";
import { dashboardLink, type EscalationAlert, renderAlert, shortCallId } from "./alert.ts";

const CALL_KEY = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DASHBOARD = "https://ops.observe.test/claims/";

const PII = [
  "602-555-0101",
  "(602) 555 0101",
  "+16025550101",
  "6025550101",
  "six zero two five five five zero one zero one",
  "03/14/1986",
  "March 14, 1986",
  "1986-03-14",
  "march fourteenth nineteen eighty six",
  "Tobias Halvorsen",
  "CLM-240198",
  "tobias.halvorsen@example.com",
  "Tobias Halvorsen, DOB 03/14/1986, phone 602-555-0101, claim CLM-240198, tobias.halvorsen@example.com",
];

// Fragments that must never appear in a card, whatever shape the PII arrived in.
const FORBIDDEN = [
  "602",
  "555",
  "0101",
  "6025550101",
  "1986",
  "03/14",
  "March",
  "march",
  "fourteenth",
  "Tobias",
  "Halvorsen",
  "240198",
  "CLM",
  "@",
  "example.com",
  "DOB",
];

function assertNoPII(text: string, context: string) {
  for (const f of FORBIDDEN) assertFalse(text.includes(f), `${context}: "${f}" leaked into ${JSON.stringify(text)}`);
}

const HEADERS = new Set([
  "UNVERIFIED: do not disclose claim details",
  "POSSIBLE EMERGENCY REPORTED",
  "RE-ALERT: still unclaimed",
]);

/** Every line is a fixed header or the one card line whose slots hold only enum values, the short id and the link. */
function assertClosedShape(text: string, callKey: unknown, dashboardUrl: string | undefined) {
  const lines = text.split("\n");
  const card = lines.pop()!;
  for (const h of lines) assert(HEADERS.has(h), `unexpected header line ${JSON.stringify(h)}`);
  const slots = card.split(" | ");
  assert(slots.length === 5 || slots.length === 6, card);
  assertMatch(slots[0], /^\[Observe Claims\] /);
  const kind = slots[0].replace("[Observe Claims] ", "");
  assert([...ESCALATION_KINDS, "unknown"].includes(kind as never), kind);
  assert([...ESCALATION_REASONS, "unknown"].includes(slots[1] as never), slots[1]);
  assert(["high", "normal"].includes(slots[2]), slots[2]);
  assertEquals(slots[3], `call ${shortCallId(callKey)}`);
  assert([...CHANNELS, "unknown"].includes(slots[4] as never), slots[4]);
  if (slots.length === 6) assertEquals(slots[5], dashboardLink(dashboardUrl, callKey));
}

Deno.test("renderAlert: the card carries kind, reason, severity, call id, channel and the link only", () => {
  assertEquals(
    renderAlert({
      kind: "representative",
      reason: "representative_requested",
      callKey: CALL_KEY,
      channel: "webCall",
      verified: true,
    }, DASHBOARD),
    `[Observe Claims] representative | representative_requested | normal | call 1a2b3c4d | webCall | ${DASHBOARD}#/calls/${CALL_KEY}`,
  );
});

Deno.test("renderAlert: unverified header, emergency header and high severity", () => {
  assertEquals(
    renderAlert({
      kind: "representative",
      reason: "auth_locked",
      callKey: CALL_KEY,
      channel: "inboundPhoneCall",
      verified: false,
    }),
    "UNVERIFIED: do not disclose claim details\n" +
      "[Observe Claims] representative | auth_locked | normal | call 1a2b3c4d | inboundPhoneCall",
  );
  assertEquals(
    renderAlert(
      { kind: "emergency", reason: "emergency", callKey: CALL_KEY, channel: "webCall", verified: false },
      DASHBOARD,
    ),
    "POSSIBLE EMERGENCY REPORTED\nUNVERIFIED: do not disclose claim details\n" +
      `[Observe Claims] emergency | emergency | high | call 1a2b3c4d | webCall | ${DASHBOARD}#/calls/${CALL_KEY}`,
  );
  assertEquals(
    renderAlert({ kind: "emergency", reason: "emergency", callKey: CALL_KEY, channel: "webCall", verified: true }),
    "POSSIBLE EMERGENCY REPORTED\n[Observe Claims] emergency | emergency | high | call 1a2b3c4d | webCall",
  );
});

Deno.test("renderAlert: the SLA re-alert adds its own header; created is the default", () => {
  const base: EscalationAlert = {
    kind: "representative",
    reason: "not_found",
    callKey: CALL_KEY,
    channel: "webCall",
    verified: true,
  };
  assertEquals(renderAlert({ ...base, event: "created" }), renderAlert(base));
  assertEquals(
    renderAlert({ ...base, event: "sla_realert" }),
    "RE-ALERT: still unclaimed\n[Observe Claims] representative | not_found | normal | call 1a2b3c4d | webCall",
  );
});

Deno.test("renderAlert: dashboard link rules", () => {
  const alert: EscalationAlert = {
    kind: "representative",
    reason: "transfer_failed",
    callKey: CALL_KEY,
    channel: "webCall",
    verified: true,
  };
  const tail = (url?: string) => renderAlert(alert, url).split(" | ").slice(5).join(" | ");
  assertEquals(tail("https://ops.observe.test"), `https://ops.observe.test#/calls/${CALL_KEY}`);
  assertEquals(tail("  https://ops.observe.test/claims/  "), `${DASHBOARD}#/calls/${CALL_KEY}`);
  // an existing fragment is replaced, never stacked
  assertEquals(tail("https://ops.observe.test/claims/#/escalations"), `${DASHBOARD}#/calls/${CALL_KEY}`);
  assertEquals(tail("http://localhost:5173/"), `http://localhost:5173/#/calls/${CALL_KEY}`);
  // omitted when unset or unusable; credentials never travel in a message
  for (
    const bad of [
      undefined,
      "",
      "   ",
      "not a url",
      "javascript:alert(1)",
      "ftp://ops.observe.test/",
      "https://user:pw@ops.observe.test/",
    ]
  ) {
    assertEquals(tail(bad), "", String(bad));
  }
});

Deno.test("alert PII: injected into every alert field and the dashboard URL, none reaches the text", () => {
  for (const pii of PII) {
    const variants: [string, EscalationAlert, string | undefined][] = [
      ["kind", {
        kind: pii as never,
        reason: "representative_requested",
        callKey: CALL_KEY,
        channel: "webCall",
        verified: true,
      }, DASHBOARD],
      ["reason", {
        kind: "representative",
        reason: pii as never,
        callKey: CALL_KEY,
        channel: "webCall",
        verified: true,
      }, DASHBOARD],
      ["channel", {
        kind: "representative",
        reason: "not_found",
        callKey: CALL_KEY,
        channel: pii as never,
        verified: false,
      }, DASHBOARD],
      ["verified", {
        kind: "emergency",
        reason: "emergency",
        callKey: CALL_KEY,
        channel: "webCall",
        verified: pii as never,
      }, DASHBOARD],
      ["event", {
        kind: "representative",
        reason: "auth_locked",
        callKey: CALL_KEY,
        channel: "chat",
        verified: true,
        event: pii as never,
      }, DASHBOARD],
      ["dashboardUrl", {
        kind: "representative",
        reason: "auth_locked",
        callKey: CALL_KEY,
        channel: "webCall",
        verified: true,
      }, pii],
      ["dashboardUrl fragment", {
        kind: "representative",
        reason: "auth_locked",
        callKey: CALL_KEY,
        channel: "webCall",
        verified: true,
      }, `${DASHBOARD}#${pii}`],
      [
        "all fields at once",
        {
          kind: pii,
          reason: pii,
          callKey: CALL_KEY,
          channel: pii,
          verified: pii,
          event: pii,
        } as unknown as EscalationAlert,
        pii,
      ],
    ];
    for (const [field, alert, url] of variants) {
      const text = renderAlert(alert, url);
      assertNoPII(text, `${field} <- ${pii}`);
      assertClosedShape(text, CALL_KEY, url);
    }
  }
});

Deno.test("alert PII: extra properties on the alert object are never rendered", () => {
  for (const pii of PII) {
    const alert = {
      kind: "representative",
      reason: "representative_requested",
      callKey: CALL_KEY,
      channel: "webCall",
      verified: false,
      name: pii,
      phone: pii,
      callbackPhone: pii,
      details: pii,
      summary: pii,
      note: pii,
      dob: pii,
      email: pii,
      claimNumber: pii,
    } as unknown as EscalationAlert;
    const text = renderAlert(alert, DASHBOARD);
    assertNoPII(text, `extra fields <- ${pii}`);
    assertEquals(
      text,
      "UNVERIFIED: do not disclose claim details\n" +
        `[Observe Claims] representative | representative_requested | normal | call 1a2b3c4d | webCall | ${DASHBOARD}#/calls/${CALL_KEY}`,
    );
  }
});

Deno.test("alert PII: a call key that is not id-shaped is refused whole (no short id, no link)", () => {
  // In production the key is VAPI's call id or chat session id; this guards a caller of renderAlert
  // that passes the wrong value by mistake.
  for (const pii of PII.filter((s) => /[^A-Za-z0-9_-]/.test(s) || /^[^A-Za-z0-9]/.test(s))) {
    const text = renderAlert({
      kind: "representative",
      reason: "not_found",
      callKey: pii,
      channel: "webCall",
      verified: true,
    }, DASHBOARD);
    assertNoPII(text, `callKey <- ${pii}`);
    assertEquals(text, "[Observe Claims] representative | not_found | normal | call unknown | webCall");
  }
  for (const odd of [null, undefined, 42, {}, "", " ", "a".repeat(129), "-leading-dash"]) {
    const text = renderAlert({
      kind: "representative",
      reason: "not_found",
      callKey: odd as never,
      channel: "webCall",
      verified: true,
    }, DASHBOARD);
    assertEquals(text, "[Observe Claims] representative | not_found | normal | call unknown | webCall", String(odd));
  }
});

Deno.test("alert PII: an id-shaped call key only ever fills the short-id slot and the link", () => {
  for (const key of [...PII, CALL_KEY, "call_01HZX", "a"]) {
    const text = renderAlert({
      kind: "emergency",
      reason: "emergency",
      callKey: key,
      channel: "outboundPhoneCall",
      verified: false,
    }, DASHBOARD);
    assertClosedShape(text, key, DASHBOARD);
    const card = text.split("\n").pop()!;
    const slots = card.split(" | ");
    // the short id is at most 8 characters of the key; the full key appears only inside the link
    assert(slots[3].length <= "call ".length + 8, slots[3]);
    const withoutLink = [...text.split("\n").slice(0, -1), slots.slice(0, 5).join(" | ")].join("\n");
    if (key.length > 8 && shortCallId(key) !== "unknown") assertFalse(withoutLink.includes(key));
  }
});
