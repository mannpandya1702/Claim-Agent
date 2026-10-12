// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Claim, Customer, Deps } from "./types.ts";

export interface EmailMessage { to: string; subject: string; html: string; idempotencyKey: string }
/** POST https://api.resend.com/emails (Bearer RESEND_API_KEY, Idempotency-Key header), from RESEND_FROM_EMAIL.
 *  AbortSignal.timeout(timeoutMs). Never throws: {ok:true,id} | {ok:false,status?,error}. */
export async function sendEmail(deps: Deps, msg: EmailMessage, timeoutMs = 2500): Promise<{ ok: true; id: string } | { ok: false; status?: number; error: string }> { throw new Error("stub"); }
/** "mann.pandya@gmail.com" -> "m***@gmail.com". */
export function maskEmail(address: string): string { throw new Error("stub"); }

// Templates: plain HTML, ASCII only, rendered from DB facts and already-redacted text, never model text.
export function callbackRequestEmail(p: { callKey: string; reason: string; verified: boolean; callbackPhone: string | null; details: string | null; channel: string; dashboardUrl?: string }): { subject: string; html: string } { throw new Error("stub"); }
export function emergencyEmail(p: { callKey: string; note: string | null; channel: string; dashboardUrl?: string }): { subject: string; html: string } { throw new Error("stub"); }
export function slaRealertEmail(p: { callKey: string; kind: string; reason: string; minutesOpen: number; dashboardUrl?: string }): { subject: string; html: string } { throw new Error("stub"); }
export function documentChecklistEmail(p: { customer: Customer; claims: Claim[] }): { subject: string; html: string } { throw new Error("stub"); }
export function claimSummaryEmail(p: { customer: Customer; claims: Claim[] }): { subject: string; html: string } { throw new Error("stub"); }
export function howToStartEmail(p: { customer: Customer }): { subject: string; html: string } { throw new Error("stub"); }
export function digestEmail(p: { date: string; stats: Record<string, unknown> }): { subject: string; html: string } { throw new Error("stub"); }
