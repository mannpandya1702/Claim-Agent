// One JSON line per event on stdout (Supabase function logs). Logs are the one sink nobody
// reviews row by row, so the logger itself enforces the rule: identity fields and raw tool
// arguments are dropped by key at any depth, every string is redacted and capped, and a
// caller's own mistake (logging the whole envelope) still cannot leak a phone or DOB.

import type { Logger } from "./types.ts";
import { redactPII } from "./redact.ts";

const DROPPED_KEYS = new Set(["phone", "dob", "date_of_birth", "email", "args", "arguments"]);
const MAX_STRING = 300;
// bound the redaction work on a huge string; only the first MAX_STRING characters survive anyway
const MAX_SCAN = 2000;
const MAX_DEPTH = 6;

function clean(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactPII(value.slice(0, MAX_SCAN)).slice(0, MAX_STRING);
  if (value instanceof Error) return clean(`${value.name}: ${value.message}`, depth);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROPPED_KEYS.has(k)) continue;
    out[k] = clean(v, depth + 1);
  }
  return out;
}

/** One JSON line per event to stdout; drops keys named phone/dob/date_of_birth/email/args. */
export const jsonLogger: Logger = (event) => {
  try {
    console.log(JSON.stringify(clean(event, 0)));
  } catch {
    // a BigInt or a getter that throws must never take the request down with it
    console.log(JSON.stringify({ log_error: "unserialisable event" }));
  }
};
