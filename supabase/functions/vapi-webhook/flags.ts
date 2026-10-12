// Evidence-first call flags, computed once at end of call. Each flag needs both halves of the
// evidence: what the agent actually said (artifact.messages) and the server fact that should
// stand behind it (attempts, escalations, emails). Words alone never flag a call, and neither
// does a missing fact the agent never claimed. Pure, so twin fixtures pin every rule.

import { type Flag, SERVER_TOOLS } from "./enums.ts";
import type { AttemptRow, EmailRow, EscalationRow } from "./types.ts";

export interface FlagInput {
  messages: unknown[]; // artifact.messages (role user|bot|assistant|system|tool_calls|tool_call_result)
  attempts: AttemptRow[];
  escalations: EscalationRow[];
  emails: EmailRow[];
}

const CALLBACK_PROMISE_RE = /representative (will|is going to) (call|reach)|call you back|someone will call/i;
// An offer is not a promise. The locked, not_found_final and system_error sentences all say
// "I can have a representative call you back, or ..." with no escalation behind them yet; only a
// statement made without an offer word before the phrase counts.
const OFFER_BEFORE_RE = /\b(can|could|may|might|would you|do you want|if you)\b/i;

const STATUS_WORDS_RE = /claim ending in|was approved|payment of|under review|was denied|was received on/i;

const EMAIL_PROMISE_RE = /(I've|I have) (emailed|sent (that|it|the))/i;

// VAPI-native tool names are markup too when spoken.
const NATIVE_TOOLS = ["transferCall", "endCall", "faq_search", "handoff_"];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An identifier-shaped name (snake_case, camelCase) is markup anywhere. A name that is also an
// English word ("escalate") is markup only in call syntax or named as a tool, so "I'll escalate
// this to a representative" stays clean.
const toolNamePattern = (name: string) =>
  /[_A-Z]/.test(name) ? escapeRe(name) : String.raw`\b${escapeRe(name)}\s*\(|\b${escapeRe(name)} tool\b`;
const MARKUP_RE = new RegExp(
  [
    "[{}]",
    "tool_call",
    "function_call",
    String.raw`\bfunctions?\b`,
    String.raw`\bjson\b`,
    ...[...SERVER_TOOLS, ...NATIVE_TOOLS].map(toolNamePattern),
  ].join("|"),
  "i",
);

/** Assistant speech in order. VAPI writes role "bot" with `message`; OpenAI-shaped history uses
 *  role "assistant" with `content`. Typographic apostrophes are folded to ASCII before matching. */
function assistantLines(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const lines: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const { role, message, content } = m as Record<string, unknown>;
    if (role !== "bot" && role !== "assistant") continue;
    const text = typeof message === "string" ? message : typeof content === "string" ? content : "";
    if (text.trim()) lines.push(text.replace(/[\u2018\u2019\u02bc]/g, "'"));
  }
  return lines;
}

function promisesCallback(line: string): boolean {
  for (const clause of line.split(/(?<=[.?!;])\s+/)) {
    const at = clause.search(CALLBACK_PROMISE_RE);
    if (at < 0) continue;
    if (clause.trimEnd().endsWith("?")) continue; // "Would you like someone to call you back?"
    if (OFFER_BEFORE_RE.test(clause.slice(0, at))) continue;
    return true;
  }
  return false;
}

/** Evidence-first flags (pure): promised_callback_without_escalation, status_read_without_verified_identity,
 *  tool_markup_spoken, email_promised_without_send. Sorted, unique. */
export function computeFlags(input: FlagInput): Flag[] {
  const lines = assistantLines(input.messages);
  const attempts = input.attempts ?? [];
  const escalations = input.escalations ?? [];
  const emails = input.emails ?? [];
  const flags = new Set<Flag>();

  if (lines.some(promisesCallback) && !escalations.some((e) => e.alert_status === "sent")) {
    flags.add("promised_callback_without_escalation");
  }
  // Ordering a spoken line against the ledger would compare two clocks (VAPI seconds vs Postgres
  // created_at); a status sentence on a call that never verified is the failure that matters.
  const everVerified = attempts.some((a) => a.tool_name === "verify_identity" && a.code === "verified");
  if (!everVerified && lines.some((l) => STATUS_WORDS_RE.test(l))) {
    flags.add("status_read_without_verified_identity");
  }
  if (lines.some((l) => MARKUP_RE.test(l))) {
    flags.add("tool_markup_spoken");
  }
  if (lines.some((l) => EMAIL_PROMISE_RE.test(l)) && !emails.some((e) => e.status === "sent")) {
    flags.add("email_promised_without_send");
  }
  return [...flags].sort();
}
