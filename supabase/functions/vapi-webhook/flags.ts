// Evidence-first call flags, computed once at end of call. Each flag needs both halves of the
// evidence: what the agent actually said (artifact.messages) and the server fact that should
// stand behind it (attempts, escalations, emails, the call's claim intake). Words alone never flag a call, and neither
// does a missing fact the agent never claimed. Pure, so twin fixtures pin every rule.

import { type Flag, INFO_EMAIL_TOPICS, SERVER_TOOLS } from "./enums.ts";
import type { AttemptRow, ClaimIntake, EmailRow, EscalationRow } from "./types.ts";

export interface FlagInput {
  messages: unknown[]; // artifact.messages (role user|bot|assistant|system|tool_calls|tool_call_result)
  attempts: AttemptRow[];
  escalations: EscalationRow[];
  emails: EmailRow[];
  intake?: ClaimIntake | null; // claim_intakes row of the call; absent means none
}

const CALLBACK_PROMISE_RE = /representative (will|is going to) (call|reach)|call you back|someone will call/i;
// An offer is not a promise. The locked, not_found_final and system_error sentences all say
// "I can have a representative call you back, or ..." with no escalation behind them yet; only a
// statement made without an offer word before the phrase counts.
const OFFER_BEFORE_RE = /\b(can|could|may|might|would you|do you want|if you)\b/i;
// A chat escalation sends no alert by design and is stored 'skipped'; the row itself is the
// staff queue entry, and the server answered it with the same callback sentence as a delivered
// alert, so it backs the promise. 'pending' and 'failed' do not. Only a representative row is a
// callback request: an emergency page asks nobody to call the caller back.
const BACKED_ALERT_STATUSES: ReadonlySet<string> = new Set(["sent", "skipped"]);

// The claims summary, the documents answer and one claim's details, in the tools' own wording: a claim
// by its ending ("claims, ending in" when several are read together) or a status said outright. A
// phrase the clause puts after "whether" or "if" is a refusal ("I can't share whether it was paid
// until he's verified"), not a read.
const STATUS_WORDS_RE =
  /(?<!\b(?:whether|if)\b[^.,;:!?]*)(?:claims?,? ending in|was approved|was paid(?:,| on )|payment of|under review|was denied|were (?:both )?received|was received on|needs documents from you)/i;

const EMAIL_PROMISE_RE = /(I've|I have) (emailed|sent (that|it|the))/i;
// What the caller is told was emailed is a send_info_email topic or the confirmation of a claim taken
// on the call; the team's own callback, emergency and claim-intake emails go to staff, so they never
// back "I've emailed that to you".
const CALLER_EMAIL_KINDS: ReadonlySet<string> = new Set([...INFO_EMAIL_TOPICS, "claim_received"]);

// "I've filed your claim", "your claim has been submitted": a claim spoken of as done. Only a filed
// intake (confirm_claim's yes) backs it; "I'll file that" or "can I file a claim" is not a claim made.
const CLAIM_FILED_RE =
  /\b(?:I've|I have|we've|we have) (?:now |just )?(?:filed|submitted|opened|created|started|lodged) (?:your|the|a|that) (?:new )?claim\b|\b(?:your|the) claim (?:has been|is|was) (?:now |already |been )?(?:filed|submitted|opened|created|lodged)\b/i;

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

/** Assistant speech in order, one entry per assistant turn. VAPI writes role "bot" with `message`;
 *  OpenAI-shaped history uses role "assistant" with `content`. On voice calls VAPI splits one
 *  spoken sentence into several bot messages around the tool-call entries ("...I can explain how
 *  to" | tool call | "start a new claim or have a representative call you back."), so fragments
 *  are joined until the caller speaks; judged alone, the second half of an offer reads as a
 *  promise. Typographic apostrophes are folded to ASCII before matching. */
function assistantLines(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const lines: string[] = [];
  let turn: string[] = [];
  const flush = () => {
    if (turn.length) lines.push(turn.join(" ").replace(/[\u2018\u2019\u02bc]/g, "'"));
    turn = [];
  };
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const { role, message, content } = m as Record<string, unknown>;
    if (role === "user") {
      flush();
      continue;
    }
    if (role !== "bot" && role !== "assistant") continue;
    const text = typeof message === "string" ? message : typeof content === "string" ? content : "";
    if (text.trim()) turn.push(text.trim());
  }
  flush();
  return lines;
}

/** A clause that speaks of a claim as filed; a question ("Has your claim been filed?") is not one. */
function claimSpokenOfAsFiled(line: string): boolean {
  return line.split(/(?<=[.?!;])\s+/).some((clause) => !clause.trimEnd().endsWith("?") && CLAIM_FILED_RE.test(clause));
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
 *  tool_markup_spoken, email_promised_without_send, claim_promised_without_filing. Sorted, unique. */
export function computeFlags(input: FlagInput): Flag[] {
  const lines = assistantLines(input.messages);
  const attempts = input.attempts ?? [];
  const escalations = input.escalations ?? [];
  const emails = input.emails ?? [];
  const flags = new Set<Flag>();

  const callbackBacked = escalations.some((e) =>
    e.kind === "representative" && BACKED_ALERT_STATUSES.has(e.alert_status)
  );
  if (lines.some(promisesCallback) && !callbackBacked) {
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
  const emailBacked = emails.some((e) => CALLER_EMAIL_KINDS.has(e.kind) && e.status === "sent");
  if (lines.some((l) => EMAIL_PROMISE_RE.test(l)) && !emailBacked) {
    flags.add("email_promised_without_send");
  }
  if (input.intake?.confirmed !== true && lines.some((l) => claimSpokenOfAsFiled(l))) {
    flags.add("claim_promised_without_filing");
  }
  return [...flags].sort();
}
