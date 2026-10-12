import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "./supabase";

export type AuthStatus = "loading" | "signed-out" | "not-staff" | "staff" | "error";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  email: string | null;
  /** Set when the staff check itself failed (network, RLS misconfiguration), not when it said no. */
  error: string | null;
}

interface AuthContextValue extends AuthState {
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  /** Re-runs the staff check, for the retry button on the error screen. */
  recheck: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Maps Supabase Auth errors to sentences a staff member can act on. */
export function describeSignInError(message: string, status?: number): string {
  const m = message.toLowerCase();
  if (m.includes("email not confirmed")) return "This account has not been confirmed yet. Ask an admin to re-create it.";
  if (m.includes("rate limit") || status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (m.includes("invalid login credentials") || status === 400) return "Email or password is incorrect.";
  if (m.includes("fetch") || m.includes("network") || m.includes("failed to")) {
    return "Cannot reach the sign-in service. Check your connection and try again.";
  }
  return message || "Sign-in failed. Try again.";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: "loading", session: null, email: null, error: null });
  // The staff answer is cached per user id so token refreshes do not re-run the RPC.
  const checkedFor = useRef<string | null>(null);
  const checkSeq = useRef(0);

  const runStaffCheck = useCallback(async (session: Session) => {
    const seq = ++checkSeq.current;
    setState((s) => ({ ...s, status: s.status === "staff" ? "staff" : "loading", session, error: null }));
    const { data, error } = await supabase.rpc("is_staff");
    if (seq !== checkSeq.current) return; // a newer session superseded this check
    if (error) {
      checkedFor.current = null;
      setState({ status: "error", session, email: session.user.email ?? null, error: error.message });
      return;
    }
    checkedFor.current = session.user.id;
    setState({ status: data === true ? "staff" : "not-staff", session, email: session.user.email ?? null, error: null });
  }, []);

  const applySession = useCallback(
    (session: Session | null) => {
      if (!session) {
        checkSeq.current++;
        checkedFor.current = null;
        setState({ status: "signed-out", session: null, email: null, error: null });
        return;
      }
      if (checkedFor.current === session.user.id) {
        setState((s) => ({ ...s, session }));
        return;
      }
      void runStaffCheck(session);
    },
    [runStaffCheck],
  );

  useEffect(() => {
    // INITIAL_SESSION fires on subscribe, so this one listener covers load, sign-in, refresh and
    // sign-out. Supabase calls are deferred out of the callback: awaiting another supabase-js call
    // inside onAuthStateChange can deadlock the auth lock.
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") queryClient.clear();
      setTimeout(() => applySession(session), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [applySession, queryClient]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { error: describeSignInError(error.message, error.status) };
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    queryClient.clear();
  }, [queryClient]);

  const recheck = useCallback(() => {
    checkedFor.current = null;
    if (state.session) void runStaffCheck(state.session);
  }, [runStaffCheck, state.session]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signIn, signOut, recheck }),
    [state, signIn, signOut, recheck],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** For tests and stories: renders children with a fixed auth state. */
export function AuthTestProvider({ value, children }: { value: Partial<AuthContextValue>; children: ReactNode }) {
  const full: AuthContextValue = {
    status: "staff",
    session: null,
    email: "staff@example.com",
    error: null,
    signIn: async () => ({ error: null }),
    signOut: async () => {},
    recheck: () => {},
    ...value,
  };
  return <AuthContext.Provider value={full}>{children}</AuthContext.Provider>;
}
