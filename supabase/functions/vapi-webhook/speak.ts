// CONTRACT STUB — replaced by the implementation. Signatures are binding.
// Code -> sentence. The server composes every spoken sentence; the model never paraphrases.
import type { Code } from "./enums.ts";
import type { Claim } from "./types.ts";

/** "115" -> "one one five"; non-digits dropped. */
export function speakDigits(digits: string): string { throw new Error("stub"); }
/** "+16025550199" or "6025550199" -> "six zero two... five five five... zero one nine nine". */
export function speakPhone(phone: string): string { throw new Error("stub"); }
/** "2026-10-08" -> "October eighth" (adds ", twenty twenty five" style year only when year differs from refYear). Never Date.parse. */
export function speakDate(isoDate: string, refYear?: number): string { throw new Error("stub"); }
/** 4820 -> "four thousand eight hundred twenty dollars"; 12.5 -> "twelve dollars and fifty cents". */
export function speakMoney(amount: number): string { throw new Error("stub"); }
/** Integer 0..999999 -> words ("four thousand eight hundred twenty"). */
export function numberToWords(n: number): string { throw new Error("stub"); }
/** Throws if the text is not safe to speak: non-printable-ASCII, "{{", "<<", JSON braces, digit runs of 4+, words like "null"/"undefined"/"JSON". */
export function assertSpeakable(text: string): void { throw new Error("stub"); }
/** The full get_claim_status sentence for a verified caller's claims (non-empty list). refDate = today (YYYY-MM-DD) in America/New_York. */
export function claimsSentence(claims: Claim[], refDate: string): string { throw new Error("stub"); }
/** Code -> sentence. data carries the few dynamic parts (see CONTRACTS). */
export function sentenceFor(code: Code, data?: Record<string, unknown>): string { throw new Error("stub"); }
