import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLiveStatus,
  removeRowFromData,
  reportChannelStatus,
  setBrowserOnline,
  startRealtimeSync,
  type ChannelLike,
  type RealtimeClientLike,
} from "./realtime";

type Handler = (payload: unknown) => void;

class FakeChannel implements ChannelLike {
  bindings: { type: string; filter: Record<string, unknown>; cb: Handler }[] = [];
  statusCb: ((status: string) => void) | null = null;
  constructor(public name: string) {}
  on(type: string, filter: Record<string, unknown>, cb: (payload: never) => void): ChannelLike {
    this.bindings.push({ type, filter, cb: cb as Handler });
    return this;
  }
  subscribe(cb: (status: string) => void): ChannelLike {
    this.statusCb = cb;
    return this;
  }
  emitChange(payload: unknown) {
    for (const b of this.bindings) if (b.type === "postgres_changes") b.cb(payload);
  }
  emitSystem(payload: unknown = { extension: "postgres_changes", status: "ok" }) {
    for (const b of this.bindings) if (b.type === "system") b.cb(payload);
  }
  setStatus(s: string) {
    this.statusCb?.(s);
  }
}

class FakeClient implements RealtimeClientLike {
  channels: FakeChannel[] = [];
  removed: FakeChannel[] = [];
  channel(name: string) {
    const ch = new FakeChannel(name);
    this.channels.push(ch);
    return ch;
  }
  removeChannel(ch: ChannelLike) {
    this.removed.push(ch as FakeChannel);
    return Promise.resolve("ok");
  }
}

function setup(opts: { table?: Parameters<typeof startRealtimeSync>[0]["table"]; filter?: string | null; keys?: unknown[][] } = {}) {
  const client = new FakeClient();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  const setData = vi.spyOn(queryClient, "setQueryData");
  const statuses: string[] = [];
  const keys = opts.keys ?? [["calls"], ["metrics"]];
  const stop = startRealtimeSync({
    client,
    queryClient,
    table: opts.table ?? "call_interactions",
    filter: opts.filter,
    channelName: "test-channel",
    getQueryKeys: () => keys,
    onStatus: (s) => statuses.push(s),
  });
  const channel = client.channels[0]!;
  return { client, queryClient, invalidate, setData, statuses, stop, channel };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startRealtimeSync", () => {
  it("opens one named channel bound to the table and filter", () => {
    const { client, channel } = setup({ table: "transcript_lines", filter: "call_key=eq.abc" });
    expect(client.channels).toHaveLength(1);
    expect(channel.name).toBe("test-channel");
    const pg = channel.bindings.find((b) => b.type === "postgres_changes");
    expect(pg?.filter).toEqual({ event: "*", schema: "public", table: "transcript_lines", filter: "call_key=eq.abc" });
  });

  it("omits the filter when watching the whole table", () => {
    const { channel } = setup({ filter: null });
    expect(channel.bindings.find((b) => b.type === "postgres_changes")?.filter).not.toHaveProperty("filter");
  });

  it("INSERT and UPDATE invalidate once per 500 ms window", () => {
    const { channel, invalidate, setData } = setup();
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();

    channel.emitChange({ eventType: "INSERT", new: { id: "1" } });
    channel.emitChange({ eventType: "UPDATE", new: { id: "1", status: "completed" } });
    channel.emitChange({ eventType: "UPDATE", new: { id: "2" } });
    vi.advanceTimersByTime(499);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // one invalidation per query key, not per event
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calls"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["metrics"] });
    // payloads are signals: nothing from them (including the generated status column) is merged
    expect(setData).not.toHaveBeenCalled();

    channel.emitChange({ eventType: "INSERT", new: { id: "3" } });
    vi.advanceTimersByTime(500);
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("a steady stream still refreshes every window instead of starving", () => {
    const { channel, invalidate } = setup({ keys: [["t"]] });
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    for (let i = 0; i < 10; i++) {
      channel.emitChange({ eventType: "INSERT", new: { id: i } });
      vi.advanceTimersByTime(200);
    }
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("DELETE removes the row by primary key from cached lists", () => {
    const { channel, queryClient, invalidate } = setup({ table: "escalations", keys: [["escalations"]] });
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    queryClient.setQueryData(["escalations", "open"], [{ id: "a" }, { id: "b" }]);
    queryClient.setQueryData(["escalations", "paged"], { rows: [{ id: "a" }, { id: "c" }], total: 9 });

    channel.emitChange({ eventType: "DELETE", old: { id: "a" } });

    expect(queryClient.getQueryData(["escalations", "open"])).toEqual([{ id: "b" }]);
    expect(queryClient.getQueryData(["escalations", "paged"])).toEqual({ rows: [{ id: "c" }], total: 8 });
    vi.advanceTimersByTime(1000);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("DELETE invalidates cached lists whose rows carry no primary key instead of keeping deleted rows", () => {
    const { channel, queryClient, invalidate } = setup({ keys: [["calls-by-day"], ["ops"]] });
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    const byDay = [{ day: "2026-10-12", outcome: "resolved", n: 3 }];
    const gap = [{ channel: "telegram", owed: 2, delivered: 2, failed: 0 }];
    queryClient.setQueryData(["calls-by-day", "a", "b"], byDay);
    queryClient.setQueryData(["ops", "gap", 24], gap);

    channel.emitChange({ eventType: "DELETE", old: { id: "call-row-1" } });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calls-by-day", "a", "b"], exact: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ops", "gap", 24], exact: true });
    expect(queryClient.getQueryData(["calls-by-day", "a", "b"])).toBe(byDay);
  });

  it("DELETE drops a call from a search_calls page by id and lowers the total", () => {
    const { channel, queryClient, invalidate } = setup({ keys: [["calls"]] });
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    queryClient.setQueryData(["calls", "list", { p_limit: 25 }], {
      rows: [
        { id: "a", vapi_call_id: "call-a", total: 2 },
        { id: "b", vapi_call_id: "call-b", total: 2 },
      ],
      total: 2,
    });
    // a page cached before the RPC returned ids cannot be edited by key, so it is re-read
    queryClient.setQueryData(["calls", "list", { p_limit: 10 }], { rows: [{ vapi_call_id: "call-a" }], total: 1 });

    channel.emitChange({ eventType: "DELETE", old: { id: "a" } });

    expect(queryClient.getQueryData(["calls", "list", { p_limit: 25 }])).toEqual({
      rows: [{ id: "b", vapi_call_id: "call-b", total: 2 }],
      total: 1,
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calls", "list", { p_limit: 10 }], exact: true });
  });

  it("a filtered channel also binds an unfiltered DELETE, which Realtime cannot filter", () => {
    const { channel, queryClient, invalidate } = setup({
      table: "escalations",
      filter: "call_key=eq.k1",
      keys: [["call", "k1", "escalations"], ["call", "k1", "row"]],
    });
    const pg = channel.bindings.filter((b) => b.type === "postgres_changes").map((b) => b.filter);
    expect(pg).toEqual([
      { event: "*", schema: "public", table: "escalations", filter: "call_key=eq.k1" },
      { event: "DELETE", schema: "public", table: "escalations" },
    ]);

    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    queryClient.setQueryData(["call", "k1", "escalations"], [{ id: "e1", call_key: "k1" }, { id: "e2", call_key: "k1" }]);
    queryClient.setQueryData(["call", "k1", "row"], { id: "row-1", vapi_call_id: "k1" });

    // the DELETE carries only the primary key; it arrives on the unfiltered binding
    const deleteBinding = channel.bindings.filter((b) => b.type === "postgres_changes")[1]!;
    deleteBinding.cb({ eventType: "DELETE", old: { id: "e2" } });
    expect(queryClient.getQueryData(["call", "k1", "escalations"])).toEqual([{ id: "e1", call_key: "k1" }]);

    // another call's delete leaves this page's keyed rows alone and re-reads nothing
    deleteBinding.cb({ eventType: "DELETE", old: { id: "someone-else" } });
    expect(queryClient.getQueryData(["call", "k1", "escalations"])).toEqual([{ id: "e1", call_key: "k1" }]);
    expect(queryClient.getQueryData(["call", "k1", "row"])).toEqual({ id: "row-1", vapi_call_id: "k1" });
    vi.advanceTimersByTime(1000);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("an unfiltered channel has a single binding", () => {
    const { channel } = setup({ filter: null });
    expect(channel.bindings.filter((b) => b.type === "postgres_changes")).toHaveLength(1);
  });

  it("DELETE matches composite keys (attempts)", () => {
    const { channel, queryClient } = setup({ table: "attempts", keys: [["attempts", "k1"]] });
    queryClient.setQueryData(
      ["attempts", "k1"],
      [
        { call_key: "k1", tool_call_id: "t1" },
        { call_key: "k1", tool_call_id: "t2" },
      ],
    );
    channel.emitChange({ eventType: "DELETE", old: { call_key: "k1", tool_call_id: "t2" } });
    expect(queryClient.getQueryData(["attempts", "k1"])).toEqual([{ call_key: "k1", tool_call_id: "t1" }]);
  });

  it("DELETE of a caller contact (keyed by call_key) clears that call's cached contact only", () => {
    const { channel, queryClient } = setup({
      table: "caller_contacts",
      filter: "call_key=eq.k1",
      keys: [["call", "k1", "contact"]],
    });
    queryClient.setQueryData(["call", "k1", "contact"], { call_key: "k1", kind: "new_customer", first_name: "Priya" });
    channel.emitChange({ eventType: "DELETE", old: { call_key: "k2" } });
    expect(queryClient.getQueryData(["call", "k1", "contact"])).toMatchObject({ call_key: "k1" });
    channel.emitChange({ eventType: "DELETE", old: { call_key: "k1" } });
    expect(queryClient.getQueryData(["call", "k1", "contact"])).toBeNull();
  });

  it("DELETE invalidates a query whose shape it cannot edit, or when the key is missing", () => {
    const { channel, queryClient, invalidate } = setup({ keys: [["metrics"]] });
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    queryClient.setQueryData(["metrics", "7d"], { calls: 4, outcomes: {} });

    channel.emitChange({ eventType: "DELETE", old: { id: "x" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["metrics", "7d"], exact: true });

    invalidate.mockClear();
    channel.emitChange({ eventType: "DELETE", old: {} });
    vi.advanceTimersByTime(500);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["metrics"] });
  });

  it("re-selects on SUBSCRIBED and on the first system message only", () => {
    const { channel, invalidate } = setup({ keys: [["k"]] });
    channel.setStatus("SUBSCRIBED");
    expect(invalidate).toHaveBeenCalledTimes(1);
    channel.emitSystem();
    expect(invalidate).toHaveBeenCalledTimes(2);
    channel.emitSystem();
    expect(invalidate).toHaveBeenCalledTimes(2);

    // a reconnect re-arms both
    channel.setStatus("CHANNEL_ERROR");
    channel.setStatus("SUBSCRIBED");
    channel.emitSystem();
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("polls every 5 s until SUBSCRIBED and again after the channel drops", () => {
    const { channel, invalidate, statuses } = setup({ keys: [["k"]] });
    expect(statuses).toEqual(["connecting"]);
    vi.advanceTimersByTime(5000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(invalidate).toHaveBeenCalledTimes(2);

    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(invalidate).not.toHaveBeenCalled();

    channel.setStatus("TIMED_OUT");
    vi.advanceTimersByTime(5000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "SUBSCRIBED", "TIMED_OUT"]);
  });

  it("cleanup removes the channel and cancels pending work", () => {
    const { channel, client, invalidate, stop } = setup({ keys: [["k"]] });
    channel.setStatus("SUBSCRIBED");
    invalidate.mockClear();
    channel.emitChange({ eventType: "INSERT", new: {} });
    stop();
    expect(client.removed).toEqual([channel]);
    vi.advanceTimersByTime(10_000);
    channel.emitChange({ eventType: "INSERT", new: {} });
    channel.setStatus("CLOSED");
    vi.advanceTimersByTime(10_000);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("removeRowFromData", () => {
  it("turns a matching single row into null and leaves others alone", () => {
    expect(removeRowFromData({ id: "a", x: 1 }, ["id"], { id: "a" })).toEqual({ handled: true, data: null });
    expect(removeRowFromData({ id: "b" }, ["id"], { id: "a" })).toEqual({ handled: true, data: { id: "b" } });
    expect(removeRowFromData(undefined, ["id"], { id: "a" })).toEqual({ handled: true, data: undefined });
  });

  it("calls an aggregate or a keyless list an unknown shape", () => {
    expect(removeRowFromData({ calls: 3 }, ["id"], { id: "a" }).handled).toBe(false);
    expect(removeRowFromData([{ day: "2026-10-12", n: 1 }], ["id"], { id: "a" }).handled).toBe(false);
    expect(removeRowFromData({ rows: [{ vapi_call_id: "x" }], total: 1 }, ["id"], { id: "a" }).handled).toBe(false);
    // an empty list has nothing to remove either way
    expect(removeRowFromData([], ["id"], { id: "a" })).toEqual({ handled: true, data: [] });
  });
});

describe("live status aggregate", () => {
  afterEach(() => {
    reportChannelStatus("a", null);
    reportChannelStatus("b", null);
    setBrowserOnline(true);
  });

  it("is idle without channels, live when all joined, reconnecting when any dropped or offline", () => {
    expect(getLiveStatus()).toBe("idle");
    reportChannelStatus("a", "connecting");
    expect(getLiveStatus()).toBe("connecting");
    reportChannelStatus("a", "SUBSCRIBED");
    reportChannelStatus("b", "SUBSCRIBED");
    expect(getLiveStatus()).toBe("live");
    reportChannelStatus("b", "CHANNEL_ERROR");
    expect(getLiveStatus()).toBe("reconnecting");
    reportChannelStatus("b", null);
    expect(getLiveStatus()).toBe("live");
    setBrowserOnline(false);
    expect(getLiveStatus()).toBe("reconnecting");
  });
});

describe("useRealtimeRows", () => {
  it("opens a uniquely named channel per instance and removes it on unmount", async () => {
    vi.resetModules();
    const client = new FakeClient();
    vi.doMock("./supabase", () => ({ supabase: client }));
    const { useRealtimeRows } = await import("./realtime");
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

    const a = renderHook(() => useRealtimeRows("transcript_lines", "call_key=eq.k1", [["transcript", "k1"]]), { wrapper });
    const b = renderHook(() => useRealtimeRows("transcript_lines", "call_key=eq.k1", [["transcript", "k1"]]), { wrapper });
    expect(client.channels).toHaveLength(2);
    expect(client.channels[0]!.name).not.toBe(client.channels[1]!.name);
    expect(a.result.current.status).toBe("connecting");

    act(() => client.channels[0]!.setStatus("SUBSCRIBED"));
    expect(a.result.current).toEqual({ status: "SUBSCRIBED", isLive: true });

    a.unmount();
    b.unmount();
    expect(client.removed).toHaveLength(2);
    vi.doUnmock("./supabase");
  });

  it("does not subscribe while disabled", async () => {
    vi.resetModules();
    const client = new FakeClient();
    vi.doMock("./supabase", () => ({ supabase: client }));
    const { useRealtimeRows } = await import("./realtime");
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    renderHook(() => useRealtimeRows("attempts", "call_key=eq.", [["a"]], { enabled: false }), { wrapper });
    expect(client.channels).toHaveLength(0);
    vi.doUnmock("./supabase");
  });
});
