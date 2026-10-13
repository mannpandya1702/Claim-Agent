// Escalation and claim-intake alerts for the team's phone. The card is built from a closed type that
// can only express ids and enums (and, for a filed claim, the last three digits of its number), so a
// name, a phone number, a full claim number or the caller's own words cannot reach Telegram even by
// mistake; the details stay behind the dashboard link (staff-only,
// already redacted). Every field is re-checked at runtime because a cast or a bad row can still
// hand this module a string the type never allowed.

import {
  ALERT_SINKS,
  type AlertSink,
  type Channel,
  CHANNELS,
  CLAIM_INTAKE_KINDS,
  CLAIM_TYPES,
  type ClaimIntakeKind,
  type ClaimType,
  ESCALATION_KINDS,
  ESCALATION_REASONS,
  type EscalationKind,
  type EscalationReason,
} from "./enums.ts";
import { sendTelegram } from "./telegram.ts";
import type { Deps, Env } from "./types.ts";

/** Closed alert type: ids and enums only. No name, phone, caller words or summary can be expressed. */
export interface EscalationAlert {
  kind: EscalationKind;
  reason: EscalationReason;
  callKey: string;
  channel: Channel;
  verified: boolean;
  event?: "created" | "sla_realert"; // default created
}

/** Closed claim-intake alert (confirm_claim filed it): ids, enums and at most the claim number's last
 *  three digits. A lead intake (a new caller) has no claim number. */
export interface ClaimIntakeAlert {
  kind: "claim_intake";
  intakeKind: ClaimIntakeKind;
  claimType: ClaimType;
  callKey: string;
  channel: Channel;
  verified: boolean;
  claimLast3?: string | null; // exactly three digits, else left out
}

export type TeamAlert = EscalationAlert | ClaimIntakeAlert;

const PREFIX = "[Observe Claims]";
const UNVERIFIED_HEADER = "UNVERIFIED: do not disclose claim details";
const EMERGENCY_HEADER = "POSSIBLE EMERGENCY REPORTED";
const REALERT_HEADER = "RE-ALERT: still unclaimed";
const DEFAULT_SINKS = "telegram,email";
const SHORT_ID_LENGTH = 8;

// Call keys are VAPI call ids or chat session ids (UUIDs). Anything else is refused outright
// rather than trimmed, so a malformed key cannot smuggle words into the card or the link.
const CALL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function oneOf<T extends string>(list: readonly T[], value: unknown): T | "unknown" {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : "unknown";
}

/** The call key when it has the shape of an id, else null. */
export function safeCallKey(callKey: unknown): string | null {
  return typeof callKey === "string" && CALL_KEY_RE.test(callKey) ? callKey : null;
}

/** First 8 characters of a well-formed call key; "unknown" otherwise. */
export function shortCallId(callKey: unknown): string {
  return safeCallKey(callKey)?.slice(0, SHORT_ID_LENGTH) ?? "unknown";
}

/** DASHBOARD_URL + "#/calls/" + callKey, or null when either part is unusable. Credentials and
 *  any existing fragment are never carried into a message. */
export function dashboardLink(dashboardUrl: string | undefined, callKey: unknown): string | null {
  const key = safeCallKey(callKey);
  const base = typeof dashboardUrl === "string" ? dashboardUrl.trim().replace(/#.*$/, "") : "";
  if (!key || !base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  if (/[\s<>"]/.test(base)) return null;
  return `${base}#/calls/${encodeURIComponent(key)}`;
}

/** The enabled alert sinks from ALERT_SINKS (comma list, default "telegram,email"); unknown names are ignored. */
export function alertSinks(env: Pick<Env, "ALERT_SINKS">): AlertSink[] {
  const raw = typeof env.ALERT_SINKS === "string" ? env.ALERT_SINKS : DEFAULT_SINKS;
  const names = raw.split(",").map((s) => s.trim().toLowerCase());
  return ALERT_SINKS.filter((sink) => names.includes(sink));
}

const CLAIM_INTAKE_HEADER = "NEW CLAIM REPORTED BY PHONE";
const LEAD_INTAKE_HEADER = "NEW CALLER: call back to set up the claim";

/** "[Observe Claims] claim_intake | <claim|lead_intake> | <auto|home|property> | normal | call <id short> |
 *  <channel> | claim ending <ddd> | <dashboard link>"; the claim number part only for three digits. */
function renderClaimIntake(alert: ClaimIntakeAlert, dashboardUrl?: string): string {
  const intakeKind = oneOf(CLAIM_INTAKE_KINDS, alert?.intakeKind);
  const claimType = oneOf(CLAIM_TYPES, alert?.claimType);
  const channel = oneOf(CHANNELS, alert?.channel);
  const headers = [intakeKind === "lead_intake" ? LEAD_INTAKE_HEADER : CLAIM_INTAKE_HEADER];
  if (alert?.verified !== true) headers.push(UNVERIFIED_HEADER);
  const parts = [
    `${PREFIX} claim_intake`,
    intakeKind,
    claimType,
    "normal",
    `call ${shortCallId(alert?.callKey)}`,
    channel,
  ];
  const last3 = typeof alert?.claimLast3 === "string" && /^\d{3}$/.test(alert.claimLast3) ? alert.claimLast3 : null;
  if (last3) parts.push(`claim ending ${last3}`);
  const link = dashboardLink(dashboardUrl, alert?.callKey);
  if (link) parts.push(link);
  return [...headers, parts.join(" | ")].join("\n");
}

/** "[Observe Claims] <kind> | <reason> | <severity> | call <id short> | <channel> | <dashboard link>",
 *  severity high for emergency else normal; unverified adds header line "UNVERIFIED: do not disclose claim details";
 *  emergency adds "POSSIBLE EMERGENCY REPORTED" header. Link = DASHBOARD_URL + "#/calls/" + callKey (omitted if unset).
 *  A claim_intake alert renders its own card (renderClaimIntake). */
export function renderAlert(alert: TeamAlert, dashboardUrl?: string): string {
  if (alert?.kind === "claim_intake") return renderClaimIntake(alert, dashboardUrl);
  const kind = oneOf(ESCALATION_KINDS, alert?.kind);
  const reason = oneOf(ESCALATION_REASONS, alert?.reason);
  const channel = oneOf(CHANNELS, alert?.channel);
  const severity = kind === "emergency" ? "high" : "normal";
  const headers: string[] = [];
  if (kind === "emergency") headers.push(EMERGENCY_HEADER);
  if (alert?.event === "sla_realert") headers.push(REALERT_HEADER);
  // Only an explicit true counts as verified; anything else gets the warning.
  if (alert?.verified !== true) headers.push(UNVERIFIED_HEADER);
  const parts = [`${PREFIX} ${kind}`, reason, severity, `call ${shortCallId(alert?.callKey)}`, channel];
  const link = dashboardLink(dashboardUrl, alert?.callKey);
  if (link) parts.push(link);
  return [...headers, parts.join(" | ")].join("\n");
}

/** Telegram fan-out per ALERT_SINKS (telegram only here; email is sent by the tools). Never throws. */
export async function sendAlert(deps: Deps, alert: TeamAlert): Promise<{ ok: boolean; error?: string }> {
  let result: { ok: boolean; error?: string };
  try {
    // A sink switched off by configuration is not a delivery failure worth a log line, but it is
    // still not a delivered alert, so it never counts toward "the team was notified".
    if (!alertSinks(deps.env).includes("telegram")) return { ok: false, error: "telegram disabled by ALERT_SINKS" };
    result = await sendTelegram(deps, renderAlert(alert, deps.env.DASHBOARD_URL));
  } catch (e) {
    result = { ok: false, error: `alert failed: ${e instanceof Error ? e.name : "error"}` };
  }
  if (!result.ok) {
    try {
      deps.log({ event: "alert_failed", sink: "telegram", call_key: safeCallKey(alert?.callKey), error: result.error });
    } catch {
      // a logging fault must not change the delivery result
    }
  }
  return result;
}
