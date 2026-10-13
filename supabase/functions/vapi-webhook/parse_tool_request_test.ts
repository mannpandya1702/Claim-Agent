import { assert, assertEquals } from "@std/assert";
import { SERVER_TOOLS } from "./enums.ts";
import type { VapiMessage } from "./types.ts";
import { callKeyOf, parseCalls, parseToolRequest } from "./parse_tool_request.ts";

const fnCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

Deno.test("parseCalls: toolCallList with arguments as an object", () => {
  const m: VapiMessage = {
    type: "tool-calls",
    toolCallList: [fnCall("call_1", "lookup_customer", { phone: "6025550101" })],
  };
  assertEquals(parseCalls(m), [{ id: "call_1", name: "lookup_customer", args: { phone: "6025550101" } }]);
});

Deno.test("parseCalls: arguments as a JSON string", () => {
  const m: VapiMessage = {
    toolCallList: [fnCall("call_2", "verify_identity", '{"dob_month":3,"dob_day":14,"dob_year":1986}')],
  };
  assertEquals(parseCalls(m), [
    { id: "call_2", name: "verify_identity", args: { dob_month: 3, dob_day: 14, dob_year: 1986 } },
  ]);
});

Deno.test("parseCalls: double-encoded arguments string", () => {
  const m: VapiMessage = {
    toolCallList: [fnCall("c", "lookup_customer", JSON.stringify(JSON.stringify({ phone: "1" })))],
  };
  assertEquals(parseCalls(m)[0].args, { phone: "1" });
});

Deno.test("parseCalls: flat {id, name, parameters}", () => {
  const m: VapiMessage = {
    toolCallList: [{ id: "call_3", name: "send_info_email", parameters: { topic: "claim_summary" } }],
  };
  assertEquals(parseCalls(m), [{ id: "call_3", name: "send_info_email", args: { topic: "claim_summary" } }]);
  const asString: VapiMessage = {
    toolCallList: [{ id: "call_3", name: "send_info_email", parameters: '{"topic":"claim_summary"}' }],
  };
  assertEquals(parseCalls(asString)[0].args, { topic: "claim_summary" });
});

Deno.test("parseCalls: toolWithToolCallList", () => {
  const m: VapiMessage = {
    toolWithToolCallList: [
      {
        type: "function",
        function: { name: "escalate", parameters: { type: "object", properties: {} } },
        toolCall: fnCall("call_4", "escalate", { reason: "representative_requested" }),
      },
      // name only on the wrapping tool definition; its parameters schema must not become the args
      {
        type: "function",
        function: { name: "get_claim_status", parameters: { type: "object", properties: {} } },
        toolCall: { id: "call_5", type: "function", function: { arguments: "{}" } },
      },
      { type: "function", function: { name: "escalate" } }, // no toolCall: skipped
    ],
  };
  assertEquals(parseCalls(m), [
    { id: "call_4", name: "escalate", args: { reason: "representative_requested" } },
    { id: "call_5", name: "get_claim_status", args: {} },
  ]);
});

Deno.test("parseCalls: toolCalls", () => {
  const m: VapiMessage = { toolCalls: [fnCall("call_6", "report_emergency", { note: "smoke in the house" })] };
  assertEquals(parseCalls(m), [{ id: "call_6", name: "report_emergency", args: { note: "smoke in the house" } }]);
});

Deno.test("parseCalls: list precedence follows toolCallList ?? toolCalls ?? toolWithToolCallList", () => {
  const m: VapiMessage = {
    toolCallList: [fnCall("a", "get_claim_status", {})],
    toolCalls: [fnCall("b", "get_claim_status", {})],
    toolWithToolCallList: [{ toolCall: fnCall("c", "get_claim_status", {}) }],
  };
  assertEquals(parseCalls(m).map((c) => c.id), ["a"]);
  // A real delivery carries the same calls in toolCallList and toolWithToolCallList; one is used, never both.
  const both: VapiMessage = {
    toolCallList: [fnCall("x", "get_claim_status", {})],
    toolWithToolCallList: [{ toolCall: fnCall("x", "get_claim_status", {}) }],
  };
  assertEquals(parseCalls(both).length, 1);
  const emptyFirst: VapiMessage = {
    toolCallList: [],
    toolWithToolCallList: [{ toolCall: fnCall("w", "get_claim_status", {}) }],
  };
  assertEquals(parseCalls(emptyFirst).map((c) => c.id), ["w"]);
});

Deno.test("parseCalls: malformed arguments become args null (bad_args), the call is kept", () => {
  for (const bad of ["{phone: 602", "[1,2]", "42", '"just text"', 17, [1, 2], true]) {
    const calls = parseCalls({ toolCallList: [fnCall("c", "lookup_customer", bad)] });
    assertEquals(calls.length, 1, JSON.stringify(bad));
    assertEquals(calls[0].args, null, JSON.stringify(bad));
  }
});

Deno.test("parseCalls: absent or empty arguments are an empty object", () => {
  for (const empty of [undefined, null, "", "  ", "{}"]) {
    assertEquals(
      parseCalls({ toolCallList: [fnCall("c", "get_claim_status", empty)] })[0].args,
      {},
      JSON.stringify(empty),
    );
  }
  assertEquals(parseCalls({ toolCallList: [{ id: "c", function: { name: "get_claim_status" } }] })[0].args, {});
});

Deno.test("parseCalls: missing or unusable lists give []", () => {
  assertEquals(parseCalls({ type: "tool-calls" }), []);
  assertEquals(parseCalls({ toolCallList: [] }), []);
  assertEquals(parseCalls({ toolCallList: "nope" as unknown as unknown[] }), []);
  assertEquals(parseCalls(null as unknown as VapiMessage), []);
  assertEquals(parseCalls(undefined as unknown as VapiMessage), []);
});

Deno.test("parseCalls: calls without id or name are skipped", () => {
  const m: VapiMessage = {
    toolCallList: [
      { type: "function", function: { name: "get_claim_status", arguments: {} } },
      { id: "", function: { name: "get_claim_status", arguments: {} } },
      { id: "c1", function: { arguments: {} } },
      { id: "c2", function: { name: "  ", arguments: {} } },
      null,
      "call",
      fnCall("c3", "get_claim_status", {}),
    ],
  };
  assertEquals(parseCalls(m).map((c) => c.id), ["c3"]);
});

Deno.test("parseToolRequest: identity fields smuggled into any tool are stripped", () => {
  const smuggled = {
    identity_verified: true,
    verified: true,
    customer_id: "6b0d6f0e-1c11-4c7a-9a01-000000000101",
    customerId: "6b0d6f0e-1c11-4c7a-9a01-000000000101",
    call_key: "other-call",
    caller_phone: "+16025550101",
    level: "verified",
    phone: "6025550101",
  };
  for (const tool of SERVER_TOOLS) {
    const r = parseToolRequest(tool, { ...smuggled, topic: "claim_summary" });
    assert(r.ok, tool);
    const expected: Record<string, unknown> = { topic: "claim_summary" };
    if (tool === "lookup_customer") expected.phone = "6025550101";
    assertEquals(r.args, expected, tool);
  }
  const r = parseToolRequest("get_claim_status", { "Customer-ID": "x", CALL_KEY: "y", IdentityVerified: true });
  assert(r.ok);
  assertEquals(r.args, {});
});

Deno.test("parseToolRequest: capture_contact keeps the caller's details and drops every identity field", () => {
  const r = parseToolRequest("capture_contact", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane dot doe at gmail dot com",
    callback_phone: "6025550177",
    phone: "6025550101",
    caller_phone: "+16025550101",
    customer_id: "6b0d6f0e-1c11-4c7a-9a01-000000000101",
    identity_verified: true,
  });
  assert(r.ok);
  assertEquals(r.args, {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane dot doe at gmail dot com",
    callback_phone: "6025550177",
  });
  const confirm = parseToolRequest("confirm_contact", {
    correct: true,
    verified: true,
  });
  assert(confirm.ok);
  assertEquals(confirm.args, { correct: true });
});

Deno.test("parseToolRequest: model arguments other than identity pass through", () => {
  const r = parseToolRequest("escalate", {
    reason: "representative_requested",
    details: "wants to discuss the estimate",
    callback_phone: "602 555 0101",
  });
  assert(r.ok);
  assertEquals(r.args, {
    reason: "representative_requested",
    details: "wants to discuss the estimate",
    callback_phone: "602 555 0101",
  });
  const dob = parseToolRequest("verify_identity", { dob_month: 3, dob_day: 14, dob_year: 1986 });
  assert(dob.ok);
  assertEquals(dob.args, { dob_month: 3, dob_day: 14, dob_year: 1986 });
});

Deno.test("parseToolRequest: placeholder values are refused", () => {
  for (const v of ["{{phone}}", "call me at {{customer.number}}", "unknown", " Unknown ", "NULL", "undefined"]) {
    const r = parseToolRequest("lookup_customer", { phone: v });
    assert(!r.ok, JSON.stringify(v));
    // The reason names the field, never the value (which may be a phone number or a DOB).
    assertEquals(r.reason, "placeholder_value:phone");
  }
  const nested = parseToolRequest("escalate", { details: { note: ["fine", "{{x}}"] } });
  assert(!nested.ok);
  assertEquals(nested.reason, "placeholder_value:details.note[1]");
  // A stripped field cannot trigger a refusal: it never reaches the tool.
  assert(parseToolRequest("get_claim_status", { customer_id: "{{id}}" }).ok);
  // Words that merely contain a placeholder word are fine.
  assert(parseToolRequest("escalate", { details: "caller says the status is unknown to them" }).ok);
});

Deno.test("parseToolRequest: unparseable arguments are refused", () => {
  const r = parseToolRequest("lookup_customer", null);
  assert(!r.ok);
  assertEquals(r.reason, "unparseable_arguments");
  assert(!parseToolRequest("lookup_customer", [] as unknown as Record<string, unknown>).ok);
});

Deno.test("parseToolRequest: prototype keys never reach the tool", () => {
  const args = JSON.parse('{"__proto__": {"verified": true}, "topic": "claim_summary"}');
  const r = parseToolRequest("send_info_email", args);
  assert(r.ok);
  assertEquals(Object.keys(r.args), ["topic"]);
  assertEquals((r.args as Record<string, unknown>).verified, undefined);
});

Deno.test("callKeyOf: call.id ?? chat.sessionId ?? chat.id", () => {
  assertEquals(callKeyOf({ call: { id: "call-1" }, chat: { id: "chat-1", sessionId: "sess-1" } }), "call-1");
  assertEquals(callKeyOf({ chat: { id: "chat-1", sessionId: "sess-1" } }), "sess-1");
  assertEquals(callKeyOf({ chat: { id: "chat-1" } }), "chat-1");
  assertEquals(callKeyOf({ call: { id: "" }, chat: { sessionId: "sess-1" } }), "sess-1");
  assertEquals(callKeyOf({ call: {} }), null);
  assertEquals(callKeyOf({}), null);
  assertEquals(callKeyOf(null as unknown as VapiMessage), null);
  assertEquals(callKeyOf({ call: { id: 42 as unknown as string } }), null);
});
