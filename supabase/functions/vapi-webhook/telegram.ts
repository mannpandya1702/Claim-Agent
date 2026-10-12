// Telegram Bot API transport for escalation alerts. The result is honest: ok only when Telegram
// accepted the message (HTTP 200 and body.ok === true), because the spoken sentence and the
// escalation row's alert_status depend on it. The bot token lives in the request URL, so no
// error string may echo the URL or a raw fetch error without scrubbing it first.

import type { Deps } from "./types.ts";

const API_BASE = "https://api.telegram.org";
// Telegram rejects longer texts outright; alert cards are far shorter, so this only bounds misuse.
const MAX_TEXT = 4096;
const MAX_ERROR = 200;

function scrub(message: string, token: string): string {
  const hidden = token ? message.split(token).join("<token>") : message;
  return hidden.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException ? e.name === "TimeoutError" || e.name === "AbortError" : false;
}

/** POST https://api.telegram.org/bot<token>/sendMessage {chat_id, text, disable_web_page_preview:true}
 *  with AbortSignal.timeout(timeoutMs). Never throws; ok only on HTTP 200 and body.ok === true. */
export async function sendTelegram(
  deps: Deps,
  text: string,
  timeoutMs = 2500,
): Promise<{ ok: boolean; error?: string }> {
  let token = "";
  try {
    token = deps.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    const chatId = deps.env.TELEGRAM_CHAT_ID?.trim() ?? "";
    if (!token || !chatId) return { ok: false, error: "telegram not configured" };
    const res = await deps.fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, MAX_TEXT), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: { ok?: unknown; description?: unknown } | null = null;
    try {
      body = await res.json();
    } catch (e) {
      if (isTimeout(e)) return { ok: false, error: "timeout" };
      body = null;
    }
    if (res.status === 200 && body?.ok === true) return { ok: true };
    // A 200 status text ("OK") next to a refused message would read as success on the dashboard.
    const description = typeof body?.description === "string" && body.description.trim()
      ? body.description
      : res.status !== 200 && res.statusText
      ? res.statusText
      : "response not ok";
    return { ok: false, error: `telegram ${res.status}: ${scrub(description, token)}` };
  } catch (e) {
    if (isTimeout(e)) return { ok: false, error: "timeout" };
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: `telegram request failed: ${scrub(detail, token)}` };
  }
}
