import { PhoneOff } from "lucide-react";
import { Link } from "react-router-dom";
import { LiveDot } from "@/components/LiveDot";
import { Button } from "@/components/ui/button";
import { isCallActive, stop, useCallState } from "@/lib/vapi";

/** While this tab has a web call open, every route shows a way to end it. */
export function ActiveCallButton() {
  const call = useCallState();
  if (!isCallActive(call)) return null;
  return (
    <div className="flex items-center gap-2">
      {call.callId ? (
        <Link
          to={`/calls/${call.callId}`}
          className="hidden items-center gap-1.5 rounded-sm text-xs font-medium text-ink-2 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
        >
          <LiveDot />
          On a call
        </Link>
      ) : (
        <span className="hidden items-center gap-1.5 text-xs font-medium text-ink-2 sm:inline-flex">
          <LiveDot />
          {call.status === "starting" ? "Connecting" : "On a call"}
        </span>
      )}
      <Button variant="destructive" size="sm" onClick={() => void stop()} disabled={call.status === "ending"}>
        <PhoneOff aria-hidden="true" />
        {call.status === "ending" ? "Ending" : "End call"}
      </Button>
    </div>
  );
}
