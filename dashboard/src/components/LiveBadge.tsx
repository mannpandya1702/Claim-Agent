import { CircleDot, Loader2, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LiveDot } from "@/components/LiveDot";
import { useLiveStatus, type LiveStatus } from "@/lib/realtime";
import { cn } from "@/lib/utils";

const COPY: Record<LiveStatus, { label: string; hint: string }> = {
  live: { label: "Live", hint: "Realtime updates are connected." },
  connecting: { label: "Connecting", hint: "Joining realtime updates; pages refresh every 5 seconds meanwhile." },
  reconnecting: { label: "Reconnecting", hint: "Realtime updates dropped; pages refresh every 5 seconds until they return." },
  idle: { label: "Idle", hint: "No realtime subscription on this page." },
};

/** Header badge for the aggregate realtime connection: green Live, amber Connecting/Reconnecting. */
export function LiveBadge({ status: override, className }: { status?: LiveStatus; className?: string }) {
  const fromStore = useLiveStatus();
  const status = override ?? fromStore;
  const copy = COPY[status];
  const variant = status === "live" ? "good" : status === "idle" ? "muted" : "warning";

  return (
    <Badge
      variant={variant}
      role="status"
      aria-live="polite"
      aria-label={`Realtime: ${copy.label}. ${copy.hint}`}
      title={copy.hint}
      className={cn("gap-1.5", className)}
      data-status={status}
    >
      {status === "live" && <LiveDot />}
      {status === "connecting" && <Loader2 className="animate-spin" aria-hidden="true" />}
      {status === "reconnecting" && <WifiOff aria-hidden="true" />}
      {status === "idle" && <CircleDot aria-hidden="true" />}
      <span>{copy.label}</span>
    </Badge>
  );
}
