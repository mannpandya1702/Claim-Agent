// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { ParsedToolCall, ToolCtx, ToolResult } from "./types.ts";
/** Dispatch one parsed tool call. Never throws: errors become system_error with its sentence. */
export async function runTool(call: ParsedToolCall, ctx: Omit<ToolCtx, "toolCallId">): Promise<ToolResult> { throw new Error("stub"); }
