import { formatStamp } from "./format";

/*
 * Two sources, one view. Stored `call_interactions.messages` (written by the end-of-call writer)
 * and live `transcript_lines` (+ `attempts` as tool chips) both become the same list of bubbles
 * and tool chips. Pure functions: no React, no clock, no network.
 *
 * Vocabularies: stored items use user / assistant (bot from the raw VAPI artifact is accepted
 * too), live lines use user / assistant. system and anything unknown is dropped. Tool arguments
 * are never read, so nothing a caller said into a tool can leak through a chip.
 */

export type Speaker = "caller" | "agent";

export interface Bubble {
  kind: "bubble";
  key: string;
  speaker: Speaker;
  text: string;
  /** Seconds from call start (stored) or from the first live line (live). */
  t: number;
  stamp: string;
  /** Squad member that spoke, when the writer recorded it. */
  name: string | null;
}

export interface ToolChip {
  kind: "tool";
  key: string;
  tool: string;
  code: string | null;
  t: number;
  stamp: string;
}

export type TranscriptItem = Bubble | ToolChip;

/** Live lines of the same speaker closer than this merge into one bubble. */
export const MERGE_GAP_MS = 3000;

function speakerOf(role: unknown): Speaker | null {
  const r = typeof role === "string" ? role.toLowerCase() : "";
  if (r === "user" || r === "customer") return "caller";
  if (r === "assistant" || r === "bot") return "agent";
  return null;
}

function isToolRole(role: unknown): boolean {
  const r = typeof role === "string" ? role.toLowerCase() : "";
  return r === "tool" || r === "tool_call_result";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/** Stable sort by time; items without a usable time keep their written order. */
function sortByTime<T extends { t: number }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.t - b.item.t || a.i - b.i)
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------------------------
// Stored messages
// ---------------------------------------------------------------------------------------------

/**
 * call_interactions.messages -> bubbles and tool chips.
 * Items: { role: 'user'|'assistant'|'bot', text, t, name? } and { role: 'tool', tool, code, t }.
 * `t` is seconds from call start (secondsFromStart is accepted as an alias).
 */
export function fromStoredMessages(messages: unknown): TranscriptItem[] {
  if (!Array.isArray(messages)) return [];
  const out: TranscriptItem[] = [];
  let lastT = 0;
  messages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>;
    const t = num(m.t) ?? num(m.secondsFromStart) ?? lastT;
    lastT = t;

    if (isToolRole(m.role)) {
      const tool = str(m.tool) ?? str(m.name) ?? "tool";
      const code = str(m.code);
      out.push({ kind: "tool", key: `m${index}`, tool, code, t, stamp: formatStamp(t) });
      return;
    }

    const speaker = speakerOf(m.role);
    if (!speaker) return;
    const text = str(m.text) ?? str(m.message) ?? str(m.content);
    if (!text) return;
    const name = speaker === "agent" ? (str(m.name) ?? str(m.assistantName)) : null;
    out.push({ kind: "bubble", key: `m${index}`, speaker, text, t, stamp: formatStamp(t), name });
  });
  return sortByTime(out);
}

// ---------------------------------------------------------------------------------------------
// Live lines
// ---------------------------------------------------------------------------------------------

export interface LiveLineInput {
  id: number | string;
  role: string;
  text: string;
  ts_ms: number | string;
  created_at?: string | null;
}

export interface LiveAttemptInput {
  tool_call_id: string;
  tool_name: string;
  code: string | null;
  created_at: string;
}

interface NormLine {
  id: string;
  speaker: Speaker;
  text: string;
  ts: number;
  created: number;
}

function parseTime(v: string | null | undefined): number {
  if (!v) return Number.NaN;
  return Date.parse(v);
}

/**
 * transcript_lines (+ attempts) -> bubbles and tool chips while a call is live.
 * A bubble's stamp is its ts_ms minus the first line's ts_ms. A chip sits after the last line
 * whose created_at is not later than the chip's created_at (both server clocks), and a chip
 * between two same-speaker lines keeps them as separate bubbles.
 */
export function fromLiveLines(lines: readonly LiveLineInput[], attempts: readonly LiveAttemptInput[] = []): TranscriptItem[] {
  const norm: NormLine[] = [];
  for (const l of lines) {
    const speaker = speakerOf(l.role);
    const text = str(l.text);
    const ts = num(l.ts_ms);
    if (!speaker || !text || ts === null) continue;
    norm.push({ id: String(l.id), speaker, text, ts, created: parseTime(l.created_at) });
  }
  norm.sort((a, b) => a.ts - b.ts || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));

  const chips = attempts
    .map((a) => ({ ...a, created: parseTime(a.created_at) }))
    .sort((a, b) => (a.created || 0) - (b.created || 0) || a.tool_call_id.localeCompare(b.tool_call_id));

  const base = norm.length > 0 ? norm[0]!.ts : 0;
  const firstLineCreated = norm.length > 0 ? norm[0]!.created : Number.NaN;
  const chipOrigin = Number.isFinite(firstLineCreated)
    ? firstLineCreated
    : chips.length > 0 && Number.isFinite(chips[0]!.created)
      ? chips[0]!.created
      : 0;

  // Bucket each chip behind the last line created no later than it (index -1 = before all lines).
  const chipsAfter = new Map<number, typeof chips>();
  for (const chip of chips) {
    let anchor = -1;
    for (let i = 0; i < norm.length; i++) {
      const created = norm[i]!.created;
      if (!Number.isFinite(created) || !Number.isFinite(chip.created) || created <= chip.created) anchor = i;
    }
    const list = chipsAfter.get(anchor) ?? [];
    list.push(chip);
    chipsAfter.set(anchor, list);
  }

  const out: TranscriptItem[] = [];
  let lastLineTs: number | null = null;
  let lastT = 0;

  const pushChips = (anchor: number) => {
    for (const chip of chipsAfter.get(anchor) ?? []) {
      const rel = Number.isFinite(chip.created) ? (chip.created - chipOrigin) / 1000 : lastT;
      const t = Math.max(lastT, rel);
      out.push({ kind: "tool", key: `tool-${chip.tool_call_id}`, tool: chip.tool_name, code: chip.code, t, stamp: formatStamp(t) });
      lastT = t;
    }
  };

  pushChips(-1);
  norm.forEach((line, i) => {
    const t = (line.ts - base) / 1000;
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "bubble" &&
      prev.speaker === line.speaker &&
      lastLineTs !== null &&
      line.ts - lastLineTs < MERGE_GAP_MS
    ) {
      prev.text = `${prev.text} ${line.text}`;
    } else {
      out.push({ kind: "bubble", key: `line-${line.id}`, speaker: line.speaker, text: line.text, t, stamp: formatStamp(t), name: null });
    }
    lastLineTs = line.ts;
    lastT = Math.max(lastT, t);
    pushChips(i);
  });

  return out;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** Plain-text transcript for the copy button: "[00:04] Caller: ..." and "[00:09] tool lookup_customer: needs_dob". */
export function transcriptToText(items: readonly TranscriptItem[]): string {
  return items
    .map((item) => {
      if (item.kind === "tool") return `[${item.stamp}] tool ${item.tool}${item.code ? `: ${item.code}` : ""}`;
      const who = item.speaker === "caller" ? "Caller" : item.name ? `Ava (${item.name})` : "Ava";
      return `[${item.stamp}] ${who}: ${item.text}`;
    })
    .join("\n");
}
