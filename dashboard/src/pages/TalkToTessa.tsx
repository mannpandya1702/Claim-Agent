import { LayoutDashboard, LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { CallPanel } from "@/components/call/CallPanel";
import { CheatSheet } from "@/components/call/CheatSheet";
import { preflightMicrophone, useMicPermission, type MicProblem } from "@/components/call/microphone";
import { WatchPane } from "@/components/call/WatchPane";
import { ActiveCallButton } from "@/components/layout/ActiveCallButton";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { env, shortSha } from "@/lib/env";
import { CALL_MODES, isCallActive, parseMode, preloadVapi, start, stop, useCallState, type CallMode } from "@/lib/vapi";

/**
 * Public call page (#/call, no sign-in): start and end a browser web call with Tessa, see the
 * caller-side transcript, and keep the demo identities at hand. The right pane links to the
 * call's detail page and, for staff, shows the server's live view of the same call.
 *
 * The call itself lives in the module store in src/lib/vapi.ts, so leaving this page or a
 * StrictMode remount never drops or duplicates it; this component only reads it and calls
 * start() from the button handler.
 */
export default function TalkToTessa() {
  const [params, setParams] = useSearchParams();
  const call = useCallState();
  const micPermission = useMicPermission();
  const [preparing, setPreparing] = useState(false);
  const [micProblem, setMicProblem] = useState<MicProblem | null>(null);
  const mounted = useRef(true);

  const busy = isCallActive(call);
  const urlMode = parseMode(params.get("mode"));
  // While a call runs, show the mode it was started with, whatever the URL says.
  const mode: CallMode = busy && call.mode ? call.mode : urlMode;

  useEffect(() => {
    mounted.current = true;
    preloadVapi();
    return () => {
      mounted.current = false;
    };
  }, []);

  const onModeChange = useCallback(
    (next: CallMode) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("mode", next);
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const onStart = useCallback(async () => {
    if (preparing || isCallActive()) return;
    setMicProblem(null);
    // Check the microphone even when the permission reads "granted": a missing or busy device
    // also only surfaces as a Daily side event after the call has connected (and is billing).
    setPreparing(true);
    const problem = await preflightMicrophone();
    if (!mounted.current) return;
    setPreparing(false);
    if (problem) {
      setMicProblem(problem);
      return;
    }
    await start(mode);
  }, [preparing, mode]);

  const returnTo = `/call?mode=${mode}`;

  return (
    <div className="flex min-h-dvh flex-col bg-page">
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
      <PublicHeader returnTo={returnTo} />

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 lg:py-8">
        <PageHeader
          title="Talk to Tessa"
          description="Observe Insurance's claims assistant. Start a web call, give one of the demo phone numbers and its date of birth, then ask about the claim."
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
            <CallPanel
              call={call}
              mode={mode}
              modes={CALL_MODES}
              onModeChange={onModeChange}
              onStart={() => void onStart()}
              onStop={() => void stop()}
              preparing={preparing}
              micProblem={micProblem}
              micPermission={micPermission}
              voiceConfigured={Boolean(env.vapiPublicKey)}
            />
            <CheatSheet phoneNumber={env.phoneNumber} />
          </div>
          <WatchPane callId={call.callId} status={call.status} returnTo={returnTo} className="lg:sticky lg:top-20" />
        </div>
      </main>

      <footer className="border-t px-4 py-3 text-xs text-ink-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <span>Calls are recorded and transcribed. Use the demo identities, not real personal details.</span>
          <span>
            Build <span className="font-mono text-ink-2">{shortSha()}</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

function PublicHeader({ returnTo }: { returnTo: string }) {
  const auth = useAuth();
  // Mid-call, sign-in opens in a new tab: leaving this page would hide the call controls and the
  // caller transcript while the call keeps running.
  const inCall = isCallActive(useCallState());
  return (
    <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        <Link
          to={returnTo}
          className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Observe Insurance, Talk to Tessa"
        >
          <BrandMark />
          <span className="hidden min-w-0 flex-col leading-tight min-[400px]:flex">
            <span className="truncate text-sm font-semibold text-ink-1">Observe Insurance</span>
            <span className="truncate text-xs text-ink-3">Claims assistant</span>
          </span>
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* The app-wide End control, so ending stays one tap away after scrolling. */}
          <ActiveCallButton />
          <ThemeToggle />
          {auth.status === "staff" ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/">
                <LayoutDashboard aria-hidden="true" />
                <span className="hidden sm:inline">Dashboard</span>
                <span className="sr-only sm:hidden">Dashboard</span>
              </Link>
            </Button>
          ) : auth.status === "signed-out" ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/login?next=${encodeURIComponent(returnTo)}`} {...(inCall ? { target: "_blank", rel: "noopener" } : {})}>
                <LogIn aria-hidden="true" />
                <span className="hidden sm:inline">Staff sign in</span>
                <span className="sr-only sm:hidden">Staff sign in</span>
                {inCall && <span className="sr-only"> (opens in a new tab)</span>}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
