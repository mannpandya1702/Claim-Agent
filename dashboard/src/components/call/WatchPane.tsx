import { ArrowUpRight, Eye, LogIn, ShieldX, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { callHref } from "@/components/calls/CallTable";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import type { CallStatus } from "@/lib/vapi";
import { cn } from "@/lib/utils";
import { CompactLiveView } from "./CompactLiveView";
import { CopyButton } from "./CopyButton";

interface WatchPaneProps {
  /** The VAPI call id start() resolved to (= call_key everywhere); null before it is known. */
  callId: string | null;
  status: CallStatus;
  /** Where sign-in should come back to when there is no call yet ("/call?mode=squad"). */
  returnTo: string;
  className?: string;
}

/**
 * The right pane: once the call has an id, a link to its detail page and, for a staff session,
 * the server's live view of the same call. Everyone else is told to sign in; the data itself is
 * protected by RLS, not by this check.
 */
export function WatchPane({ callId, status, returnTo, className }: WatchPaneProps) {
  return (
    <Card role="region" aria-labelledby="watch-pane-title" className={cn("min-w-0", className)}>
      <CardHeader className="border-b">
        <CardTitle id="watch-pane-title" className="flex items-center gap-2 text-base">
          <Eye className="size-4 text-ink-3" aria-hidden="true" />
          Watch this call
        </CardTitle>
        <CardDescription className="text-ink-2">
          The server&apos;s view: identity check, tool results and the stored transcript.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 sm:pt-5">
        {callId ? <WithCall callId={callId} /> : <BeforeCall status={status} returnTo={returnTo} />}
      </CardContent>
    </Card>
  );
}

function BeforeCall({ status, returnTo }: { status: CallStatus; returnTo: string }) {
  const auth = useAuth();
  const inCall = status === "active" || status === "ending";
  if (status === "starting") {
    return (
      <div className="space-y-3" role="status" aria-live="polite">
        <span className="sr-only">Creating the call</span>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm text-ink-2">
      <p>
        {status === "error"
          ? "The last attempt never got a call id, so there is nothing to watch. Start again and the link appears here."
          : "Start a call and a link to its detail page appears here as soon as VAPI assigns the call id."}
      </p>
      {auth.status === "staff" ? (
        <p className="text-ink-1">You are signed in as staff, so the live view will open in this pane.</p>
      ) : auth.status === "signed-out" ? (
        // A call can be active before its id is known (start() still resolving); sign-in then
        // opens in a new tab so the call and its controls stay on screen.
        <Button variant="outline" size="sm" asChild>
          <Link to={`/login?next=${encodeURIComponent(returnTo)}`} {...(inCall ? { target: "_blank", rel: "noopener" } : {})}>
            <LogIn aria-hidden="true" />
            Staff sign in
            {inCall && <span className="sr-only"> (opens in a new tab)</span>}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

function WithCall({ callId }: { callId: string }) {
  const href = callHref(callId);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-xs text-ink-3">Call id</span>
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-ink-1" title={callId} data-testid="call-id">
            {callId}
          </code>
          <CopyButton value={callId} label="call id" />
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to={href} target="_blank" rel="noopener">
            Open call detail
            <ArrowUpRight aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </Link>
        </Button>
      </div>
      <Viewer callId={callId} />
    </div>
  );
}

function Viewer({ callId }: { callId: string }) {
  const auth = useAuth();
  switch (auth.status) {
    case "loading":
      return (
        <div className="space-y-3" role="status" aria-live="polite">
          <span className="sr-only">Checking staff access</span>
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-48 w-full" />
        </div>
      );
    case "staff":
      return <CompactLiveView callId={callId} />;
    case "not-staff":
      return (
        <Gate
          icon={ShieldX}
          title="Not on the staff list"
          body={
            <>
              You are signed in as <span className="font-medium text-ink-1">{auth.email ?? "this account"}</span>, which is not on the staff
              allowlist, so the live view is not available.
            </>
          }
        />
      );
    case "error":
      return <ErrorState compact title="Could not check staff access" error={auth.error} onRetry={auth.recheck} />;
    case "signed-out":
      return (
        <Gate
          icon={LogIn}
          title="Sign in to watch this call"
          body="Staff see the identity check, tool results and transcript here while the call runs. Sign-in opens in a new tab, so this call keeps going; this pane updates once you are in."
          action={
            <Button size="sm" asChild>
              <Link to={`/login?next=${encodeURIComponent(callHref(callId))}`} target="_blank" rel="noopener">
                <LogIn aria-hidden="true" />
                Staff sign in
                <span className="sr-only">(opens in a new tab)</span>
              </Link>
            </Button>
          }
        />
      );
  }
}

function Gate({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
      <span className="flex size-9 items-center justify-center rounded-full bg-muted text-ink-3">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-ink-1">{title}</h3>
        <p className="text-sm text-ink-2">{body}</p>
      </div>
      {action}
    </div>
  );
}
