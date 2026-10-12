// CONTRACT STUB — replaced by the implementation. Signatures are binding.
/** Phone-like digit runs (602-555-0101, (602) 555 0101, +16025550101, 6025550101, spaced digits) -> "[phone ending 0101]";
 *  DOB-shaped dates (March 14, 1986 / 3/14/1986 / 1986-03-14 / 14 March 1986 / march fourteenth nineteen eighty six) -> "[date of birth]".
 *  Claim numbers (CLM-240115) and money stay. Idempotent. null/undefined -> same. */
export function redactPII(text: string): string;
export function redactPII(text: null | undefined): null;
export function redactPII(text: string | null | undefined): string | null { throw new Error("stub"); }
/** True when an assistant line asks for a date of birth or phone number. */
export function asksForSensitive(assistantText: string | null | undefined): boolean { throw new Error("stub"); }
/** The masked replacement for a user turn that answers a sensitive question. */
export const MASKED_ANSWER = "[answer withheld]";
/** Deep-redact every string value in a JSON-like value (for analysis_raw). */
export function redactDeep<T>(value: T): T { throw new Error("stub"); }
