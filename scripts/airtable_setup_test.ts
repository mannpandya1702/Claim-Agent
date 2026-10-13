// The Call Log schema the setup script creates must hold every field the mirror writes, with the
// select options the enums allow, or a delivery fails with a 422 on the first new value.
import { assert, assertEquals } from "@std/assert";
import { interactionToFields, MERGE_FIELD } from "../supabase/functions/vapi-webhook/airtable.ts";
import { CALL_REASONS, CALLER_TYPES } from "../supabase/functions/vapi-webhook/enums.ts";
import { FIELDS } from "./airtable_setup.ts";

Deno.test("airtable setup: every field the mirror writes exists, the merge key first", () => {
  assertEquals(FIELDS[0].name, MERGE_FIELD);
  const names = new Set(FIELDS.map((f) => f.name));
  assertEquals(names.size, FIELDS.length, "no duplicate field");
  const written = interactionToFields(
    {
      vapi_call_id: "call-1",
      channel: "webCall",
      caller_name: "Jane Doe",
      caller_phone: "+16025550177",
      summary: "s",
      sentiment: "neutral",
      outcome: "not_found",
      escalated: true,
      emergency: false,
      flags: ["tool_markup_spoken"],
      started_at: "2026-10-12T15:00:00Z",
      ended_at: "2026-10-12T15:02:00Z",
      duration_seconds: 120,
      cost: 0.1,
      analysis_status: "ok",
      caller_type: "new",
      caller_email: "jane.doe@gmail.com",
      call_reason: "file_claim",
      claim_number: "CLM-104472",
    },
    new Date("2026-10-12T15:03:00Z"),
    "https://staff.example.com/",
  );
  // the row sets every column, so the newest fields are checked against setup too
  for (const key of ["Call Reason", "Claim Number"]) assert(key in written, `the row never writes "${key}"`);
  for (const key of Object.keys(written)) {
    assert(
      names.has(key),
      `the mirror writes "${key}", which setup never creates`,
    );
  }
});

Deno.test("airtable setup: Caller Type offers exactly the caller types and Email is an email field", () => {
  const callerType = FIELDS.find((f) => f.name === "Caller Type");
  assertEquals(callerType?.type, "singleSelect");
  assertEquals(
    (callerType?.options as { choices: { name: string }[] }).choices.map((c) => c.name),
    [...CALLER_TYPES],
  );
  assertEquals(FIELDS.find((f) => f.name === "Email")?.type, "email");
});

Deno.test("airtable setup: Call Reason offers exactly the call reasons and Claim Number is text", () => {
  const reason = FIELDS.find((f) => f.name === "Call Reason");
  assertEquals(reason?.type, "singleSelect");
  assertEquals(
    (reason?.options as { choices: { name: string }[] }).choices.map((c) => c.name),
    [...CALL_REASONS],
  );
  assertEquals(FIELDS.find((f) => f.name === "Claim Number")?.type, "singleLineText");
});
