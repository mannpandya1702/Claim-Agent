import { qk } from "@/lib/queries";
import { supabase } from "@/lib/supabase";
import type { EmailKind, EmailRow, EscalationStatus } from "@/lib/types";

/*
 * Reads the queue needs beyond the shared fetchers. Keys sit under ["escalations"], so the
 * page's Realtime hook and the Claim / Done mutations (which invalidate that prefix) refresh
 * them too.
 */

export const ESCALATION_STATUSES = ["open", "claimed", "done"] as const satisfies readonly EscalationStatus[];

export type EscalationCounts = Record<EscalationStatus, number>;

export const escalationKeys = {
  counts: () => [...qk.escalations(), "counts"] as const,
  emailsAll: () => [...qk.escalations(), "emails"] as const,
  emails: (callKeys: readonly string[]) => [...qk.escalations(), "emails", callKeys] as const,
};

/** Exact per-status counts (head requests: no rows travel), so the tabs never count a capped page. */
export async function fetchEscalationCounts(): Promise<EscalationCounts> {
  const results = await Promise.all(
    ESCALATION_STATUSES.map((status) =>
      supabase.from("escalations").select("id", { count: "exact", head: true }).eq("status", status),
    ),
  );
  const counts = { open: 0, claimed: 0, done: 0 } as EscalationCounts;
  results.forEach((res, i) => {
    if (res.error) throw new Error(res.error.message);
    counts[ESCALATION_STATUSES[i]!] = res.count ?? 0;
  });
  return counts;
}

/** The emails an escalation sends (its own alert, plus the SLA re-alert for the call). */
export const ESCALATION_EMAIL_KINDS: readonly EmailKind[] = ["callback_request", "emergency_alert", "sla_realert"];

/** Delivery rows for the escalations on screen; one request for the whole visible page. */
export async function fetchEscalationEmails(callKeys: readonly string[]): Promise<EmailRow[]> {
  if (callKeys.length === 0) return [];
  const { data, error } = await supabase
    .from("emails")
    .select("id,call_key,kind,to_masked,resend_id,status,error,created_at")
    .in("call_key", [...callKeys])
    .in("kind", [...ESCALATION_EMAIL_KINDS])
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as EmailRow[];
}
