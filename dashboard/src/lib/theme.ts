import { useSyncExternalStore } from "react";

/*
 * Theme preference: "system" follows the OS; "light"/"dark" pin it via data-theme on <html>,
 * which the token blocks in index.css honor in both directions. Stored per viewer in
 * localStorage, wrapped because storage can be unavailable (private windows, blocked cookies).
 */

export type ThemePreference = "system" | "light" | "dark";
const STORAGE_KEY = "observe-theme";

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let preference: ThemePreference = typeof window === "undefined" ? "system" : readStored();
const listeners = new Set<() => void>();

function systemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

function apply(): void {
  if (typeof document === "undefined") return;
  if (preference === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", preference);
}

export function setTheme(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still applies for this visit.
  }
  apply();
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  mq?.addEventListener?.("change", listener);
  return () => {
    listeners.delete(listener);
    mq?.removeEventListener?.("change", listener);
  };
}

function getSnapshot(): string {
  return `${preference}:${preference === "dark" || (preference === "system" && systemDark()) ? "dark" : "light"}`;
}

export function useTheme(): { preference: ThemePreference; resolved: "light" | "dark"; setTheme: typeof setTheme } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => "system:light");
  const [pref, resolved] = snap.split(":") as [ThemePreference, "light" | "dark"];
  return { preference: pref, resolved, setTheme };
}

apply();
