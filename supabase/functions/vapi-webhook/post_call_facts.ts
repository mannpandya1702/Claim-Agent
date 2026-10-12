// Server facts the post-call writer reads before building the row (pure data, no I/O).
import type { AttemptRow, Customer, EmailRow, EscalationRow, Session } from "./types.ts";
export interface CallFacts {
  session: Session | null;
  verifiedCustomer: Customer | null;
  attempts: AttemptRow[];
  escalations: EscalationRow[];
  emails: EmailRow[];
}
