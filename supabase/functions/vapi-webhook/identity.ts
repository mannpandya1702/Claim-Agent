// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Code, Level } from "./enums.ts";

/** Caller-stated phone -> E.164 (+1XXXXXXXXXX) or null. Strip non-digits; 11 digits only with a leading 1;
 *  require exactly 10 after that; reject all-same digits and NANP-invalid area/exchange (first digit 0/1). */
export function normalisePhone(raw: unknown): string | null { throw new Error("stub"); }
/** Integers only (numeric strings accepted); impossible dates (month 13, Feb 30, year < 1900 or > refYear) -> null. */
export function parseDobParts(m: unknown, d: unknown, y: unknown, refYear: number): { year: number; month: number; day: number } | null { throw new Error("stub"); }
/** A usable callback number: normalisePhone + junk filter (Anonymous/unknown/restricted, repeated digits, any of ownNumbers). */
export function usableCallbackNumber(raw: unknown, ownNumbers: string[]): string | null { throw new Error("stub"); }
/** Real caller id from the envelope (call.customer.number) or null for web calls / junk. */
export function callerIdNumber(raw: unknown, ownNumbers: string[]): string | null { throw new Error("stub"); }
/** Last four digits for logs and sentences; never more. */
export function lastFour(e164: string): string { throw new Error("stub"); }

/** Pure mirror of the SQL state machine (lookup_customer_attempt / verify_dob_attempt), used by
 *  fake_store.ts and identity_test.ts. The SQL functions remain the source of truth in production. */
export interface IdentityState { level: Level; misses: number; wrong: number; unreadable: number; candidate: string | null; verified: string | null }
export type IdentityEvent =
  | { type: "lookup"; phoneE164: string | null; customerId: string | null }
  | { type: "dob"; valid: boolean; matches: boolean };
export function initialIdentity(): IdentityState { throw new Error("stub"); }
export function step(s: IdentityState, e: IdentityEvent): { state: IdentityState; code: Code } { throw new Error("stub"); }
