import { Activity, LayoutDashboard, LifeBuoy, Menu, Mic, PhoneCall, Radio, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { BrandMark, BrandName } from "@/components/BrandMark";
import { LiveBadge } from "@/components/LiveBadge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { env, shortSha } from "@/lib/env";
import { cn } from "@/lib/utils";
import { ActiveCallButton } from "./ActiveCallButton";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true, description: "KPIs and trends" },
  { to: "/calls", label: "Calls", icon: PhoneCall, description: "Every call, searchable" },
  { to: "/live", label: "Live", icon: Radio, description: "Calls happening now" },
  { to: "/escalations", label: "Escalations", icon: LifeBuoy, description: "Callback queue" },
  { to: "/ops", label: "Ops", icon: Activity, description: "Automation health" },
  { to: "/call", label: "Talk to Ava", icon: Mic, description: "Public call page" },
];

const REPO_URL = "https://github.com/mannpandya1702/Claim-Agent";

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "bg-accent-wash text-ink-1" : "text-ink-2 hover:bg-hover hover:text-ink-1",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary" />}
                <item.icon className={cn("size-4 shrink-0", isActive ? "text-primary" : "text-ink-3 group-hover:text-ink-2")} aria-hidden="true" />
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function Footer() {
  const sha = env.buildSha;
  return (
    <footer className="border-t px-4 py-3 text-xs text-ink-3 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <span>Times shown in Eastern (ET)</span>
        <span>
          Build{" "}
          {sha ? (
            <a
              href={`${REPO_URL}/commit/${sha}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-ink-2 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="build-sha"
            >
              {shortSha(sha)}
            </a>
          ) : (
            <span className="font-mono text-ink-2" data-testid="build-sha">
              {shortSha(sha)}
            </span>
          )}
        </span>
      </div>
    </footer>
  );
}

/** Staff layout: sidebar navigation (a sheet below lg), header with realtime state, build footer. */
export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Route changes move focus to the main region so keyboard and screen-reader users land on the new page.
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh bg-page">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm font-medium shadow-pop focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-card lg:flex" aria-label="Primary">
        <div className="flex h-14 items-center gap-2.5 border-b px-4">
          <BrandMark />
          <BrandName />
        </div>
        <nav className="flex-1 overflow-y-auto p-3" aria-label="Main navigation">
          <NavList />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-card/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/75 sm:px-4 lg:px-6">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="gap-0 p-0">
              <SheetHeader className="flex-row items-center gap-2.5 border-b">
                <BrandMark />
                <div>
                  <SheetTitle className="text-sm">Observe Insurance</SheetTitle>
                  <SheetDescription className="text-xs text-ink-3">Claims assistant ops</SheetDescription>
                </div>
              </SheetHeader>
              <nav className="p-3" aria-label="Main navigation">
                <NavList onNavigate={() => setMenuOpen(false)} />
              </nav>
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2 lg:hidden">
            <BrandMark className="size-7" />
            <span className="hidden text-sm font-semibold min-[420px]:inline">Observe</span>
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <ActiveCallButton />
            <LiveBadge />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 outline-none sm:px-6 sm:py-6 lg:px-8">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
