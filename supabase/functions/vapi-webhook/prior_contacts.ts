// Returning-caller memory: the welcome-back clause verify_identity speaks on a DOB match. It is
// composed by the server from the customer's last completed calls, so nothing is disclosed
// before verification and the model never has to remember to fetch history. Only the date of
// the newest prior call reaches the sentence; summaries, phone numbers and dates of birth never do.

import { TIMEZONE } from "./enums.ts";
import { sentenceFor, speakDate, verifiedThanks } from "./speak.ts";
import type { PriorInteraction } from "./types.ts";

const MAX_ROWS = 3;

const nyDate = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar day in New York as YYYY-MM-DD, the input speak.ts reads dates from. */
function nyIsoDate(d: Date): string {
  const parts = nyDate.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "October tenth" in New York, plus ", twenty twenty five" when the year is not this year. */
function spokenCallDate(at: Date, now: Date): string {
  const today = Number(nyIsoDate(now).slice(0, 4));
  return speakDate(nyIsoDate(at), today);
}

// Only full timestamps with an explicit zone: a zone-less string would be read in the runtime's
// local time and could land on the wrong day.
const ZONED_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;

function startedAt(row: PriorInteraction): Date | null {
  const s = typeof row?.started_at === "string" ? row.started_at.trim() : "";
  if (!ZONED_TIMESTAMP_RE.test(s)) return null;
  const d = new Date(s.replace(" ", "T"));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Verified sentence with optional welcome-back clause. rows = last completed interactions (newest first,
 *  already excluding this call). enabled=false, empty rows -> plain sentence. Date in words in America/New_York. */
export function verifiedSentence(firstName: string, rows: PriorInteraction[], enabled: boolean, now: Date): string {
  // The plain sentence is speak.ts's own, so the two verified answers can never drift apart.
  const plain = sentenceFor("verified", { first_name: firstName });
  if (!enabled || !Array.isArray(rows) || rows.length === 0) return plain;

  let newest: Date | null = null;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const at = startedAt(row);
    if (at && (!newest || at.getTime() > newest.getTime())) newest = at;
  }
  if (!newest) return plain;
  return `${verifiedThanks(firstName)} Welcome back. I see you called on ${spokenCallDate(newest, now)}. ` +
    "Is this about the same claim as last time, or something else?";
}
