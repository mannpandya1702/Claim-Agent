// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Deps } from "./types.ts";
/** POST https://api.telegram.org/bot<token>/sendMessage {chat_id, text, disable_web_page_preview:true}
 *  with AbortSignal.timeout(timeoutMs). Never throws; ok only on HTTP 200 and body.ok === true. */
export async function sendTelegram(deps: Deps, text: string, timeoutMs = 2500): Promise<{ ok: boolean; error?: string }> { throw new Error("stub"); }
