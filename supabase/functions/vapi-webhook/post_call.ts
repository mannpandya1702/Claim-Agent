// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Deps, InteractionRow, VapiMessage } from "./types.ts";
export async function onStatusUpdate(message: VapiMessage, deps: Deps): Promise<void> { throw new Error("stub"); }
export async function onTranscript(message: VapiMessage, deps: Deps): Promise<void> { throw new Error("stub"); }
export async function onEndOfCallReport(message: VapiMessage, deps: Deps): Promise<{ status: number; body: unknown }> { throw new Error("stub"); }
/** Pure: the interaction row from an end-of-call-report plus server facts. */
export function buildInteractionRow(message: VapiMessage, facts: import("./post_call_facts.ts").CallFacts): InteractionRow { throw new Error("stub"); }
