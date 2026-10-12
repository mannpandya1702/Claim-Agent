// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { ParsedToolCall, VapiMessage } from "./types.ts";

/** Envelope -> tool calls. list = toolCallList ?? toolCalls ?? toolWithToolCallList.map(t => t.toolCall);
 *  name = function.name ?? name; args = function.arguments ?? parameters, as object or JSON string (parsed once);
 *  unparseable -> args null. Calls without id or name are skipped. */
export function parseCalls(message: VapiMessage): ParsedToolCall[] { throw new Error("stub"); }

/** Trust boundary for model-supplied arguments. Strips identity fields (identity_verified, verified,
 *  customer_id, call_key, caller_phone, level; and phone for every tool except lookup_customer).
 *  Refuses (ok:false) when any remaining string value contains "{{" or equals "unknown"/"null"/"undefined"
 *  (case-insensitive, trimmed). */
export function parseToolRequest(toolName: string, args: Record<string, unknown> | null):
  { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } { throw new Error("stub"); }

/** call_key = call.id ?? chat.sessionId ?? chat.id; null when absent. */
export function callKeyOf(message: VapiMessage): string | null { throw new Error("stub"); }
