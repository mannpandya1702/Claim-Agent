// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Channel, EscalationKind, EscalationReason } from "./enums.ts";
import type { Deps } from "./types.ts";

/** Closed alert type: ids and enums only. No name, phone, caller words or summary can be expressed. */
export interface EscalationAlert {
  kind: EscalationKind;
  reason: EscalationReason;
  callKey: string;
  channel: Channel;
  verified: boolean;
  event?: "created" | "sla_realert"; // default created
}
/** "[Observe Claims] <kind> | <reason> | <severity> | call <id short> | <channel> | <dashboard link>",
 *  severity high for emergency else normal; unverified adds header line "UNVERIFIED: do not disclose claim details";
 *  emergency adds "POSSIBLE EMERGENCY REPORTED" header. Link = DASHBOARD_URL + "#/calls/" + callKey (omitted if unset). */
export function renderAlert(alert: EscalationAlert, dashboardUrl?: string): string { throw new Error("stub"); }
/** Telegram fan-out per ALERT_SINKS (telegram only here; email is sent by the tools). Never throws. */
export async function sendAlert(deps: Deps, alert: EscalationAlert): Promise<{ ok: boolean; error?: string }> { throw new Error("stub"); }
