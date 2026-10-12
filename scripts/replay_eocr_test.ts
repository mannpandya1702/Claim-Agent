// The replay tool resends captured or saved bodies at the live function, so what it changes in a
// body decides what the function does: a chat must stay a chat (no alerts), and a body that acts
// when replayed is refused unless asked for.
import { assertEquals, assertFalse } from "@std/assert";
import { prepareBody, sideEffectOf } from "./replay_eocr.ts";

const ORG = "org-ours";

Deno.test("prepareBody: a call body gets our org and, when asked, the new call id", () => {
  const body = { message: { type: "end-of-call-report", call: { id: "old", orgId: "placeholder" } } };
  assertEquals(prepareBody(body, { orgId: ORG }).message.call, { id: "old", orgId: ORG });
  assertEquals(prepareBody(body, { orgId: ORG, callId: "new" }).message.call, { id: "new", orgId: ORG });
  // the input is never mutated
  assertEquals(body.message.call, { id: "old", orgId: "placeholder" });
});

Deno.test("prepareBody: a chat body replayed under a new id stays a chat envelope", () => {
  const withSession = { message: { type: "tool-calls", chat: { id: "chat-1", sessionId: "s-1", orgId: "x" } } };
  const a = prepareBody(withSession, { orgId: ORG, callId: "fresh" }).message;
  assertFalse("call" in a, "a call object would make the handler alert the team");
  assertEquals(a.chat, { id: "chat-1", sessionId: "fresh", orgId: ORG });

  const noSession = { message: { type: "tool-calls", chat: { id: "chat-2", orgId: "x" } } };
  const b = prepareBody(noSession, { orgId: ORG, callId: "fresh" }).message;
  assertFalse("call" in b);
  assertEquals(b.chat, { id: "fresh", orgId: ORG });

  assertEquals(prepareBody(noSession, { orgId: ORG }).message.chat, { id: "chat-2", orgId: ORG });
});

Deno.test("prepareBody: a body with neither call nor chat gets a call only when an id is asked for", () => {
  assertFalse("call" in prepareBody({ message: { type: "end-of-call-report" } }, { orgId: ORG }).message);
  assertEquals(prepareBody({ message: { type: "end-of-call-report" } }, { orgId: ORG, callId: "k" }).message.call, {
    id: "k",
    orgId: ORG,
  });
});

Deno.test("sideEffectOf: tool calls and a forwarding status-update act when replayed; reports do not", () => {
  assertEquals(typeof sideEffectOf({ type: "tool-calls" }), "string");
  assertEquals(typeof sideEffectOf({ type: "status-update", status: "forwarding" }), "string");
  for (
    const m of [
      { type: "end-of-call-report" },
      { type: "status-update", status: "in-progress" },
      { type: "status-update", status: "ended" },
      { type: "transcript", transcriptType: "final" },
    ]
  ) {
    assertEquals(sideEffectOf(m), null, JSON.stringify(m));
  }
});
