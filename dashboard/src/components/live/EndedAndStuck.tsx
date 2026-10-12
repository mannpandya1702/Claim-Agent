import { ArrowUpRight, CircleStop, Hourglass, X } from "lucide-react";
import { Link } from "react-router-dom";
import { callHref } from "@/components/calls/CallTable";
import { Button } from "@/components/ui/button";
import { callerLabel, channelLabel, formatDateTimeLong, formatRelative, formatTime } from "@/lib/format";
import type { CallSummary } from "@/lib/queries";
import { callStart } from "./liveCalls";

export interface EndedCall {
  call: CallSummary;
  /** When this page saw the call leave the live list (the report itself lands moments later). */
  seenAt: Date;
}

/**
 * Calls that closed while this page was open, so a supervisor who looked away can still jump
 * to the finished call (summary, sentiment and flags fill in seconds after hangup).
 */
export function JustEnded({ ended, now, onClear }: { ended: readonly EndedCall[]; now: Date; onClear: () => void }) {
  if (ended.length === 0) return null;
  return (
    <section aria-labelledby="live-ended" className="rounded-xl bg-card shadow-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 id="live-ended" className="flex items-center gap-2 text-sm font-semibold text-ink-1">
          <CircleStop className="size-4 text-ink-3" aria-hidden="true" />
          Ended while you watched
        </h2>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden="true" />
          Clear
        </Button>
      </div>
      <ul className="divide-y">
        {ended.map(({ call, seenAt }) => (
          <li key={call.vapi_call_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-1">{callerLabel(call.caller_name)}</p>
              <p className="text-xs text-ink-2">
                {channelLabel(call.channel)} · started {formatTime(callStart(call))} · ended{" "}
                <time dateTime={seenAt.toISOString()} title={formatDateTimeLong(seenAt)}>
                  {formatRelative(seenAt, now)}
                </time>
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to={callHref(call.vapi_call_id)}>
                Open call
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** In-progress rows older than the reaper's cut-off: no streaming, just a way to the call. */
export function StuckCalls({ calls, now }: { calls: readonly CallSummary[]; now: Date }) {
  if (calls.length === 0) return null;
  return (
    <section aria-labelledby="live-stuck" className="rounded-xl bg-card shadow-card">
      <div className="space-y-0.5 border-b px-4 py-3">
        <h2 id="live-stuck" className="flex items-center gap-2 text-sm font-semibold text-ink-1">
          <Hourglass className="size-4 text-serious-ink" aria-hidden="true" />
          Possibly stuck
          <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular text-ink-2">{calls.length}</span>
        </h2>
        <p className="text-xs text-ink-2">
          No end-of-call report after 2 hours. The hourly reaper backfills these from VAPI or closes them as abandoned.
        </p>
      </div>
      <ul className="divide-y">
        {calls.map((call) => (
          <li key={call.vapi_call_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-1">{callerLabel(call.caller_name)}</p>
              <p className="text-xs text-ink-2">
                {channelLabel(call.channel)} · started{" "}
                <time dateTime={callStart(call)} title={formatDateTimeLong(callStart(call))}>
                  {formatRelative(callStart(call), now)}
                </time>
              </p>
            </div>
            <Button asChild size="sm" variant="ghost">
              <Link to={callHref(call.vapi_call_id)} aria-label={`Open stuck call with ${callerLabel(call.caller_name)}`}>
                Open call
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
