import { useEffect, useRef, useState } from "react";

/** Tracks a CSS media query. jsdom reports false, so tests get the desktop layout. */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Wall clock that re-renders every `intervalMs` while `enabled`, for elapsed timers on live calls.
 * Disabled, it returns the time of the last render and schedules nothing.
 */
export function useNow(intervalMs = 1000, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * Calls `fn` once input has been quiet for `delayMs`. The latest `fn` is used at fire time, and a
 * pending call is dropped on unmount so a late search never navigates a page that is gone.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const call = useRef({
    run: (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        fnRef.current(...args);
      }, delayRef.current);
    },
    cancel: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
  });
  return call.current;
}
