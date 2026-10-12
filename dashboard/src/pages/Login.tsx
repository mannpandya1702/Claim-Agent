import { Loader2, LogIn, Mic, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { APP_NAME } from "@/components/PageHeader";
import { GateLayout } from "@/components/layout/RequireStaff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/supabase";

/** Only same-app paths are honored, so `next` can never send someone off-site. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/login")) return "/";
  return raw;
}

export default function Login() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `Sign in · ${APP_NAME}`;
  }, []);

  // Signed in (staff or not): let the gate decide what to show at the destination.
  if (auth.status === "staff" || auth.status === "not-staff") return <Navigate to={next} replace />;

  const emailMissing = touched && email.trim() === "";
  const passwordMissing = touched && password === "";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (email.trim() === "" || password === "") {
      setError("Enter your email and password.");
      if (email.trim() === "") emailRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const result = await auth.signIn(email, password);
      if (result.error) {
        setError(result.error);
        setPassword("");
      }
    } catch {
      setError("Cannot reach the sign-in service. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <GateLayout>
      <div className="mb-6 flex flex-col items-center text-center">
        <BrandMark className="size-10" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink-1">Sign in to Claims Ops</h1>
        <p className="mt-1 text-sm text-ink-2">Staff accounts only. Sign-ups are off.</p>
      </div>

      <div className="rounded-xl bg-card p-5 shadow-card sm:p-6">
        {!supabaseConfigured && (
          <div
            role="alert"
            className="mb-4 flex gap-2 rounded-md bg-[color-mix(in_oklab,var(--status-warning)_18%,var(--card))] p-3 text-sm text-warning-ink"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>This build has no Supabase URL or anon key, so sign-in cannot work. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</span>
          </div>
        )}

        <form onSubmit={onSubmit} noValidate className="space-y-4" aria-describedby={error ? errorId : undefined}>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={emailMissing || undefined}
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={passwordMissing || undefined}
              disabled={submitting}
            />
          </div>

          <div aria-live="assertive" className="min-h-0">
            {error && (
              <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-critical-ink">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={submitting || auth.status === "loading"}>
            {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}
            {submitting ? "Signing in" : "Sign in"}
          </Button>
        </form>
      </div>

      <p className="mt-6 text-center text-sm text-ink-2">
        Here for the demo?{" "}
        <Link
          to="/call"
          className="inline-flex items-baseline gap-1 font-medium text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Baseline alignment keeps the link text on the sentence's line; only the icon centres. */}
          <Mic className="size-3.5 self-center" aria-hidden="true" />
          Talk to Tessa
        </Link>{" "}
        without signing in.
      </p>
    </GateLayout>
  );
}
