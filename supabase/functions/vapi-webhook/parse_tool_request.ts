// Envelope -> tool calls, and the trust boundary for model-supplied arguments. VAPI delivers the
// same call in several shapes (toolCallList / toolCalls / toolWithToolCallList; arguments as an
// object or a JSON string; flat {id, name, parameters}). Every shape is normalised here once, so a
// shape the tools never saw cannot silently drop a call.
import type { ParsedToolCall, VapiMessage } from "./types.ts";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function nameOf(call: Obj): string | null {
  return nonEmpty(isObj(call.function) ? call.function.name : undefined) ?? nonEmpty(call.name);
}

function pickList(m: Obj): unknown[] {
  if (Array.isArray(m.toolCallList) && m.toolCallList.length > 0) return m.toolCallList;
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return m.toolCalls;
  if (Array.isArray(m.toolWithToolCallList)) {
    return m.toolWithToolCallList.map((t) => {
      if (!isObj(t) || !isObj(t.toolCall)) return null;
      // The call itself normally carries the name; the wrapping tool definition is the fallback.
      // Its function.parameters is a JSON schema, never the arguments, so nothing else is merged.
      return nameOf(t.toolCall) ? t.toolCall : { ...t.toolCall, name: nameOf(t) };
    });
  }
  return [];
}

function parseArgs(raw: unknown): Obj | null {
  // A no-argument tool may arrive with arguments absent, null or "": that is an empty object,
  // not an unparseable one.
  if (raw === undefined || raw === null) return {};
  let v: unknown = raw;
  // At most two decodes: some transports double-encode the arguments string.
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    const s = v.trim();
    if (s === "") return {};
    try {
      v = JSON.parse(s);
    } catch {
      return null;
    }
  }
  return isObj(v) ? { ...v } : null;
}

/** Envelope -> tool calls. list = toolCallList ?? toolCalls ?? toolWithToolCallList.map(t => t.toolCall);
 *  name = function.name ?? name; args = function.arguments ?? parameters, as object or JSON string (parsed once);
 *  unparseable -> args null. Calls without id or name are skipped. */
export function parseCalls(message: VapiMessage): ParsedToolCall[] {
  if (!isObj(message)) return [];
  const out: ParsedToolCall[] = [];
  for (const item of pickList(message)) {
    if (!isObj(item)) continue;
    const id = nonEmpty(item.id);
    const name = nameOf(item);
    if (!id || !name) continue;
    const fn = isObj(item.function) ? item.function : {};
    out.push({ id, name, args: parseArgs(fn.arguments ?? item.parameters ?? item.arguments) });
  }
  return out;
}

// Compared after lower-casing and dropping separators, so customerId, customer_id and CUSTOMER-ID
// are all the same smuggled field.
const IDENTITY_FIELDS = new Set(["identityverified", "verified", "customerid", "callkey", "callerphone", "level"]);
const PLACEHOLDER_VALUES = new Set(["unknown", "null", "undefined"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Fields a tool screens itself. escalate's caller_name is the caller's answer to "Who should they ask
// for?": "unknown" there means they gave no name, so it reaches the tool (which stores only a real
// name, identity.ts normaliseCallerName) instead of refusing a request that is already recorded.
const SELF_SCREENED: Readonly<Record<string, ReadonlySet<string>>> = { escalate: new Set(["caller_name"]) };

function fieldKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Returns the path of the first placeholder value (never the value itself, which may be PII).
function findPlaceholder(v: unknown, path: string, depth: number): string | null {
  if (typeof v === "string") {
    return v.includes("{{") || PLACEHOLDER_VALUES.has(v.trim().toLowerCase()) ? path : null;
  }
  if (depth >= 8) return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findPlaceholder(v[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
  } else if (isObj(v)) {
    for (const [k, inner] of Object.entries(v)) {
      const hit = findPlaceholder(inner, path ? `${path}.${k}` : k, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Trust boundary for model-supplied arguments. Strips identity fields (identity_verified, verified,
 *  customer_id, call_key, caller_phone, level; and phone for every tool except lookup_customer).
 *  Refuses (ok:false) when any remaining string value contains "{{" or equals "unknown"/"null"/"undefined"
 *  (case-insensitive, trimmed), except in a field the tool screens itself (escalate's caller_name). */
export function parseToolRequest(
  toolName: string,
  args: Record<string, unknown> | null,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  if (!isObj(args)) return { ok: false, reason: "unparseable_arguments" };
  const clean: Obj = {};
  for (const [k, v] of Object.entries(args)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const key = fieldKey(k);
    if (IDENTITY_FIELDS.has(key)) continue;
    if (key === "phone" && toolName !== "lookup_customer") continue;
    clean[k] = v;
  }
  const screened = SELF_SCREENED[toolName];
  const checked = screened ? Object.fromEntries(Object.entries(clean).filter(([k]) => !screened.has(k))) : clean;
  const hit = findPlaceholder(checked, "", 0);
  if (hit) return { ok: false, reason: `placeholder_value:${hit}` };
  return { ok: true, args: clean };
}

/** call_key = call.id ?? chat.sessionId ?? chat.id; null when absent. */
export function callKeyOf(message: VapiMessage): string | null {
  if (!isObj(message)) return null;
  const call = isObj(message.call) ? message.call : {};
  const chat = isObj(message.chat) ? message.chat : {};
  return nonEmpty(call.id) ?? nonEmpty(chat.sessionId) ?? nonEmpty(chat.id);
}
