// CONTRACT STUB — replaced by the implementation. Signatures are binding.
import type { Customer, Claim, Store } from "./types.ts";
/** In-memory Store with the SQL semantics (state machine via identity.step, replay guard, unique keys,
 *  upsert_interaction merge rules). failNext(method) makes the next call of that method throw. */
export interface FakeStore extends Store {
  customers: (Customer & { date_of_birth: string })[];
  claims: Claim[];
  tables: Record<string, any[]>;
  failNext(method: keyof Store): void;
}
export function createFakeStore(seed?: { customers?: (Customer & { date_of_birth: string })[]; claims?: Claim[] }): FakeStore { throw new Error("stub"); }
/** The seeded demo data (mirrors 0002_seed.sql; emails set to "owner@example.com" except Teague: null). */
export function demoSeed(): { customers: (Customer & { date_of_birth: string })[]; claims: Claim[] } { throw new Error("stub"); }
