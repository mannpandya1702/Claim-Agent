import { assert, assertEquals, assertFalse } from "@std/assert";
import { OPTIONAL_KEYS, readEnv } from "./env.ts";
import { ghlConfigured } from "./ghl.ts";

Deno.test("OPTIONAL_KEYS: every optional key declared in Env is read", async () => {
  const types = await Deno.readTextFile(new URL("./types.ts", import.meta.url));
  const body = types.slice(types.indexOf("export interface Env {"));
  const declared = [...body.slice(0, body.indexOf("\n}")).matchAll(/^\s+([A-Z_]+)\?:/gm)].map((m) => m[1]);
  assert(declared.includes("GHL_TOKEN"), "the parse found the Env interface");
  assertEquals([...OPTIONAL_KEYS].sort(), declared.sort());
});

Deno.test("readEnv: the GHL secrets reach env, trimmed; blank is unset", () => {
  const raw: Record<string, string> = {
    VAPI_ORG_ID: "org",
    VAPI_WEBHOOK_SECRET: "s",
    GHL_TOKEN: "pit-token\n",
    GHL_LOCATION_ID: " loc ",
    GHL_ASSIGNEE_USER_ID: "u1",
    GHL_EMERGENCY_USER_ID: "  ",
  };
  const env = readEnv((name) => raw[name]);
  assertEquals([env.GHL_TOKEN, env.GHL_LOCATION_ID, env.GHL_ASSIGNEE_USER_ID], ["pit-token", "loc", "u1"]);
  assertFalse("GHL_EMERGENCY_USER_ID" in env);
  assert(ghlConfigured(env), "the destination turns on from the function's own secrets");
  assertEquals(readEnv(() => undefined), { VAPI_ORG_ID: "", VAPI_WEBHOOK_SECRET: "" });
});
