import { useCallback, useEffect, useRef, useState } from "react";
import type { CallSummary } from "@/lib/queries";
import type { EndedCall } from "./EndedAndStuck";
import { endedSince } from "./liveCalls";

const KEEP = 6;

/**
 * Remembers calls that left the live list while the page was open (newest first, at most six).
 * Page-local on purpose: it is a "you just missed this" hint, not a record.
 */
export function useJustEnded(calls: readonly CallSummary[] | undefined): { ended: EndedCall[]; clear: () => void } {
  const prev = useRef<readonly CallSummary[] | undefined>(undefined);
  const [ended, setEnded] = useState<EndedCall[]>([]);

  useEffect(() => {
    if (!calls) return;
    const gone = endedSince(prev.current, calls);
    prev.current = calls;
    const live = new Set(calls.map((c) => c.vapi_call_id));
    setEnded((list) => {
      // A call that reappears (a late stub upsert) is live again, not ended.
      const kept = list.filter((e) => !live.has(e.call.vapi_call_id) && !gone.some((g) => g.vapi_call_id === e.call.vapi_call_id));
      if (gone.length === 0 && kept.length === list.length) return list;
      const seenAt = new Date();
      return [...gone.map((call) => ({ call, seenAt })), ...kept].slice(0, KEEP);
    });
  }, [calls]);

  const clear = useCallback(() => setEnded([]), []);
  return { ended, clear };
}
