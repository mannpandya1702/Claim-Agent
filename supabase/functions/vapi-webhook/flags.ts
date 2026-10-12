// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Flag } from "./enums.ts";
import type { AttemptRow, EmailRow, EscalationRow } from "./types.ts";

export interface FlagInput {
  messages: unknown[]; // artifact.messages (role user|bot|assistant|system|tool_calls|tool_call_result)
  attempts: AttemptRow[];
  escalations: EscalationRow[];
  emails: EmailRow[];
}
/** Evidence-first flags (pure): promised_callback_without_escalation, status_read_without_verified_identity,
 *  tool_markup_spoken, email_promised_without_send. Sorted, unique. */
export function computeFlags(input: FlagInput): Flag[] { throw new Error("stub"); }
