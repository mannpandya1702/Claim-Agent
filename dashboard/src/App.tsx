import { lazy, Suspense, type ReactNode } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { FullPageLoading, RequireStaff } from "@/components/layout/RequireStaff";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTER_FUTURE } from "@/lib/router";
import Login from "@/pages/Login";

// Pages load on demand so the sign-in page and the public call page stay small.
const Overview = lazy(() => import("@/pages/Overview"));
const Calls = lazy(() => import("@/pages/Calls"));
const CallDetail = lazy(() => import("@/pages/CallDetail"));
const Live = lazy(() => import("@/pages/Live"));
const Escalations = lazy(() => import("@/pages/Escalations"));
const Ops = lazy(() => import("@/pages/Ops"));
const TalkToAva = lazy(() => import("@/pages/TalkToAva"));
const NotFound = lazy(() => import("@/pages/NotFound"));

function PageFallback() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}

/**
 * Routes. HashRouter because GitHub Pages has no rewrites: every link the system emits is
 * <DASHBOARD_URL>#/calls/<vapi call id>. /login and /call are public; everything else sits
 * behind the staff gate.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/call"
        element={
          <Suspense fallback={<FullPageLoading label="Loading call page" />}>
            <TalkToAva />
          </Suspense>
        }
      />
      <Route element={<RequireStaff />}>
        <Route element={<AppShell />}>
          <Route index element={<Page><Overview /></Page>} />
          <Route path="calls" element={<Page><Calls /></Page>} />
          <Route path="calls/:id" element={<Page><CallDetail /></Page>} />
          <Route path="live" element={<Page><Live /></Page>} />
          <Route path="escalations" element={<Page><Escalations /></Page>} />
          <Route path="ops" element={<Page><Ops /></Page>} />
          <Route path="*" element={<Page><NotFound /></Page>} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <HashRouter future={ROUTER_FUTURE}>
      <AppRoutes />
    </HashRouter>
  );
}
