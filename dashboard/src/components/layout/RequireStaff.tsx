import { Loader2, LogOut, Mic, ShieldX } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { ActiveCallButton } from "./ActiveCallButton";

/**
 * The app-wide End control for screens without a header (sign-in, the gates, loading): a web
 * call started on /call keeps running and billing on any route, so a way to end it must be
 * on every one. Renders nothing while no call is active.
 */
function CallBar() {
  return (
    <div className="fixed right-3 top-3 z-50 sm:right-4 sm:top-4">
      <ActiveCallButton />
    </div>
  );
}

/** Centered card used by the gate screens and the sign-in page. */
export function GateLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-page px-4 py-16">
      <CallBar />
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

export function FullPageLoading({ label = "Checking access" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-page">
      <CallBar />
      <div role="status" aria-live="polite">
        <Loader2 className="size-6 animate-spin text-ink-3" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}

export function NotStaffScreen() {
  const { email, signOut } = useAuth();
  return (
    <GateLayout>
      <div className="rounded-xl bg-card p-6 shadow-card" data-testid="not-staff">
        <span className="flex size-10 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--status-warning)_18%,var(--card))] text-warning-ink">
          <ShieldX className="size-5" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-ink-1">Not on the staff list</h1>
        <p className="mt-1.5 text-sm text-ink-2">
          You are signed in as <span className="font-medium text-ink-1">{email ?? "this account"}</span>, but it is not on the
          staff allowlist, so the dashboard has nothing to show it. Ask an admin to add this address with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">deno task staff</code>.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => void signOut()} className="sm:flex-1">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
          <Button variant="outline" asChild className="sm:flex-1">
            <Link to="/call">
              <Mic aria-hidden="true" />
              Talk to Ava
            </Link>
          </Button>
        </div>
      </div>
    </GateLayout>
  );
}

function AuthErrorScreen() {
  const { error, recheck, signOut } = useAuth();
  return (
    <GateLayout>
      <div className="rounded-xl bg-card shadow-card">
        <ErrorState title="Could not check staff access" error={error} onRetry={recheck} />
        <div className="border-t px-6 py-3 text-center">
          <Button variant="link" size="sm" onClick={() => void signOut()}>
            Sign out instead
          </Button>
        </div>
      </div>
    </GateLayout>
  );
}

/**
 * Staff gate for every route except /login and /call. Loading shows a spinner, signed-out goes
 * to /login (remembering where it was headed), and a signed-in non-staff account gets an
 * explicit screen instead of a dashboard of empty tables.
 */
export function RequireStaff() {
  const auth = useAuth();
  const location = useLocation();

  switch (auth.status) {
    case "loading":
      return <FullPageLoading />;
    case "signed-out": {
      const next = `${location.pathname}${location.search}`;
      const to = next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
      return <Navigate to={to} replace />;
    }
    case "not-staff":
      return <NotStaffScreen />;
    case "error":
      return <AuthErrorScreen />;
    case "staff":
      return <Outlet />;
  }
}

