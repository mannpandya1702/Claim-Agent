import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import type { RealtimeTable } from "./types";

/*
 * Realtime events are signals to re-read, never rows to merge: INSERT/UPDATE are filtered per
 * subscriber by RLS but omit generated columns (status, search_tsv) and unchanged TOASTed values
 * (transcript, messages), and DELETE carries only the primary key. So INSERT/UPDATE invalidate the
 * affected queries, DELETE drops the row by key, and the page re-selects whenever the channel
 * (re)connects. While the channel is not SUBSCRIBED the hook polls, so a dead socket degrades to
 * a 5 s refresh instead of a frozen page.
 */

export const DEBOUNCE_MS = 500;
export const POLL_MS = 5000;

export type ChannelStatus = "connecting" | "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

/** Replica identity of each published table (its primary key), which is all a DELETE carries. */
export const PRIMARY_KEYS: Record<RealtimeTable, readonly string[]> = {
  call_interactions: ["id"],
  call_sessions: ["call_key"],
  escalations: ["id"],
  emails: ["id"],
  transcript_lines: ["id"],
  attempts: ["call_key", "tool_call_id"],
};

export interface ChangePayload {
  eventType: "INSERT" | "UPDATE" | "DELETE" | string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

/** The slice of a Supabase realtime channel this module uses (kept structural for tests). */
export interface ChannelLike {
  on(type: string, filter: Record<string, unknown>, callback: (payload: never) => void): ChannelLike;
  subscribe(callback: (status: string, err?: Error) => void): ChannelLike;
}

export interface RealtimeClientLike {
  channel(name: string): ChannelLike;
  removeChannel(channel: ChannelLike): unknown;
}

// ---------------------------------------------------------------------------------------------
// Cache surgery for DELETE
// ---------------------------------------------------------------------------------------------

function matchesKey(row: unknown, pk: readonly string[], old: Record<string, unknown>): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return pk.every((f) => r[f] !== undefined && r[f] !== null && String(r[f]) === String(old[f]));
}

/**
 * Removes the row identified by `old` from a cached value. Understands the shapes the pages
 * cache: a plain array of rows, an object with a `rows` array (optionally a numeric `total`),
 * and a single row (which becomes null). `handled: false` means the shape is unknown and the
 * caller should invalidate instead.
 */
export function removeRowFromData(
  data: unknown,
  pk: readonly string[],
  old: Record<string, unknown>,
): { handled: boolean; data: unknown } {
  if (data === undefined || data === null) return { handled: true, data };
  if (Array.isArray(data)) {
    return { handled: true, data: data.filter((row) => !matchesKey(row, pk, old)) };
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.rows)) {
      const rows = obj.rows.filter((row) => !matchesKey(row, pk, old));
      const removed = obj.rows.length - rows.length;
      const next: Record<string, unknown> = { ...obj, rows };
      if (typeof obj.total === "number" && removed > 0) next.total = Math.max(0, obj.total - removed);
      return { handled: true, data: next };
    }
    if (matchesKey(obj, pk, old)) return { handled: true, data: null };
  }
  return { handled: false, data };
}

// ---------------------------------------------------------------------------------------------
// Core sync (framework-free so the timing rules are unit-testable)
// ---------------------------------------------------------------------------------------------

export interface RealtimeSyncOptions {
  client: RealtimeClientLike;
  queryClient: QueryClient;
  table: RealtimeTable;
  /** PostgREST-style filter such as `call_key=eq.<id>`; omit for the whole table. */
  filter?: string | null;
  channelName: string;
  /** Read at fire time, so callers can change their keys without resubscribing. */
  getQueryKeys: () => readonly QueryKey[];
  onStatus?: (status: ChannelStatus) => void;
  debounceMs?: number;
  pollMs?: number;
}

export function startRealtimeSync(opts: RealtimeSyncOptions): () => void {
  const { client, queryClient, table, filter, channelName, getQueryKeys, onStatus } = opts;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const pk = PRIMARY_KEYS[table];

  let disposed = false;
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let systemSeen = false;

  const invalidateAll = () => {
    if (disposed) return;
    for (const key of getQueryKeys()) void queryClient.invalidateQueries({ queryKey: key });
  };

  // A fixed window rather than a resetting debounce: a steady stream of transcript lines must
  // still refresh at least every `debounceMs`, never starve until the stream pauses.
  const scheduleInvalidate = () => {
    if (disposed || windowTimer) return;
    windowTimer = setTimeout(() => {
      windowTimer = null;
      invalidateAll();
    }, debounceMs);
  };

  const handleDelete = (old: Record<string, unknown> | null | undefined) => {
    if (!old || !pk.every((f) => old[f] !== undefined && old[f] !== null)) {
      scheduleInvalidate();
      return;
    }
    for (const key of getQueryKeys()) {
      for (const query of queryClient.getQueryCache().findAll({ queryKey: key })) {
        const result = removeRowFromData(query.state.data, pk, old);
        if (result.handled) {
          if (result.data !== query.state.data) queryClient.setQueryData(query.queryKey, result.data);
        } else {
          void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
        }
      }
    }
  };

  const startPolling = () => {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(invalidateAll, pollMs);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const binding: Record<string, unknown> = { event: "*", schema: "public", table };
  if (filter) binding.filter = filter;

  const channel = client
    .channel(channelName)
    .on("postgres_changes", binding, ((payload: ChangePayload) => {
      if (disposed) return;
      if (payload.eventType === "DELETE") handleDelete(payload.old);
      else scheduleInvalidate();
    }) as (payload: never) => void)
    .on("system", {}, (() => {
      // SUBSCRIBED means the socket joined; the first system message means the replication
      // listener is actually attached. Rows written between the two would otherwise be missed.
      if (disposed || systemSeen) return;
      systemSeen = true;
      invalidateAll();
    }) as (payload: never) => void);

  onStatus?.("connecting");
  startPolling();

  channel.subscribe((status) => {
    if (disposed) return;
    const s = (["SUBSCRIBED", "TIMED_OUT", "CLOSED", "CHANNEL_ERROR"].includes(status)
      ? status
      : "connecting") as ChannelStatus;
    onStatus?.(s);
    if (s === "SUBSCRIBED") {
      systemSeen = false;
      stopPolling();
      invalidateAll();
    } else {
      startPolling();
    }
  });

  return () => {
    disposed = true;
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = null;
    stopPolling();
    void client.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------------------------
// Connection status shared with the header LiveBadge
// ---------------------------------------------------------------------------------------------

export type LiveStatus = "live" | "connecting" | "reconnecting" | "idle";

const channelStatuses = new Map<string, ChannelStatus>();
const statusListeners = new Set<() => void>();
let browserOnline = typeof navigator === "undefined" ? true : navigator.onLine !== false;
let snapshot: LiveStatus = "idle";

function computeLiveStatus(): LiveStatus {
  if (!browserOnline) return channelStatuses.size > 0 ? "reconnecting" : "idle";
  if (channelStatuses.size === 0) return "idle";
  const values = [...channelStatuses.values()];
  if (values.some((s) => s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED")) return "reconnecting";
  if (values.some((s) => s === "connecting")) return "connecting";
  return "live";
}

function emitStatus() {
  const next = computeLiveStatus();
  if (next === snapshot) return;
  snapshot = next;
  for (const l of statusListeners) l();
}

export function reportChannelStatus(name: string, status: ChannelStatus | null): void {
  if (status === null) channelStatuses.delete(name);
  else channelStatuses.set(name, status);
  emitStatus();
}

export function setBrowserOnline(online: boolean): void {
  browserOnline = online;
  emitStatus();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => setBrowserOnline(true));
  window.addEventListener("offline", () => setBrowserOnline(false));
}

export function getLiveStatus(): LiveStatus {
  return snapshot;
}

function subscribeLiveStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Aggregate connection state of every mounted realtime hook. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(subscribeLiveStatus, getLiveStatus, getLiveStatus);
}

// ---------------------------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------------------------

let channelSeq = 0;

export interface UseRealtimeRowsOptions {
  /** False skips subscribing (for example until the call id is known). Default true. */
  enabled?: boolean;
}

export interface UseRealtimeRowsResult {
  status: ChannelStatus;
  /** True while the channel is joined; pages can show their own indicator from it. */
  isLive: boolean;
}

/**
 * Keeps the given TanStack queries fresh from Realtime changes on one table.
 *
 *   useRealtimeRows("transcript_lines", `call_key=eq.${id}`, [["transcript", id]]);
 *
 * One named channel per hook instance, removed on unmount. The keys are matched as prefixes.
 */
export function useRealtimeRows(
  table: RealtimeTable,
  filter: string | null | undefined,
  queryKeys: readonly QueryKey[],
  options: UseRealtimeRowsOptions = {},
): UseRealtimeRowsResult {
  const enabled = options.enabled ?? true;
  const queryClient = useQueryClient();
  const keysRef = useRef(queryKeys);
  keysRef.current = queryKeys;
  const [status, setStatus] = useState<ChannelStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    // A unique name per effect run: supabase.channel() hands back an existing channel with the
    // same topic, and a StrictMode remount would otherwise reuse the one being removed.
    const name = `dash:${table}:${filter ?? "all"}:${++channelSeq}`;
    const stop = startRealtimeSync({
      client: supabase as unknown as RealtimeClientLike,
      queryClient,
      table,
      filter,
      channelName: name,
      getQueryKeys: () => keysRef.current,
      onStatus: (s) => {
        setStatus(s);
        reportChannelStatus(name, s);
      },
    });
    return () => {
      stop();
      reportChannelStatus(name, null);
    };
  }, [enabled, table, filter, queryClient]);

  return { status, isLive: status === "SUBSCRIBED" };
}

/** Detail and Live pages also poll at this interval while a call is in progress (belt and braces). */
export const IN_PROGRESS_REFETCH_MS = 5000;
