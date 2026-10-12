import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";

/*
 * The store is module state, so every test imports a fresh copy (resetModules) with its own
 * fake SDK and env. The fake records construction and listener registration so the
 * "listeners attached once" and "second start refused" rules are observable.
 */

type Listener = (...args: unknown[]) => void;

interface FakeVapiInstance {
  key: string;
  listeners: Map<string, Listener[]>;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

const created: FakeVapiInstance[] = [];
let startImpl: (...args: unknown[]) => Promise<unknown> = async () => ({ id: "call-123" });

const baseEnv: Env = {
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon",
  vapiPublicKey: "public-key",
  assistantCoreId: "asst-core",
  assistantSoloId: "asst-solo",
  squadId: "squad-1",
  phoneNumber: null,
  buildSha: null,
};

async function load(envOverride: Partial<Env> = {}) {
  vi.resetModules();
  vi.doMock("./env", () => ({ env: { ...baseEnv, ...envOverride }, shortSha: () => "dev" }));
  vi.doMock("@vapi-ai/web", () => {
    class FakeVapi {
      key: string;
      listeners = new Map<string, Listener[]>();
      on = vi.fn((event: string, cb: Listener) => {
        const list = this.listeners.get(event) ?? [];
        list.push(cb);
        this.listeners.set(event, list);
        return this;
      });
      start = vi.fn((...args: unknown[]) => startImpl(...args));
      stop = vi.fn(async () => {
        this.emit("call-end");
      });
      constructor(key: string) {
        this.key = key;
        created.push(this as unknown as FakeVapiInstance);
      }
      emit(event: string, ...args: unknown[]) {
        for (const cb of this.listeners.get(event) ?? []) cb(...args);
      }
    }
    return { default: FakeVapi };
  });
  return import("./vapi");
}

beforeEach(() => {
  created.length = 0;
  startImpl = async () => ({ id: "call-123" });
});

afterEach(() => {
  vi.doUnmock("./env");
  vi.doUnmock("@vapi-ai/web");
});

describe("vapi store", () => {
  it("creates one instance lazily and attaches each listener exactly once", async () => {
    const vapi = await load();
    expect(created).toHaveLength(0); // nothing until a start

    await vapi.start("solo");
    await vapi.stop();
    vapi.resetCall();
    await vapi.start("core");

    expect(created).toHaveLength(1);
    const inst = created[0]!;
    expect(inst.key).toBe("public-key");
    for (const event of ["call-start", "call-end", "speech-start", "speech-end", "message", "error"]) {
      expect(inst.listeners.get(event)).toHaveLength(1);
    }
  });

  it("starts solo and core with the assistant id and squad as the third argument", async () => {
    const vapi = await load();
    await vapi.start("solo");
    expect(created[0]!.start).toHaveBeenLastCalledWith("asst-solo");
    await vapi.stop();

    await vapi.start("core");
    expect(created[0]!.start).toHaveBeenLastCalledWith("asst-core");
    await vapi.stop();

    await vapi.start("squad");
    expect(created[0]!.start).toHaveBeenLastCalledWith(undefined, undefined, "squad-1");
  });

  it("exposes the returned call id and goes active on call-start", async () => {
    const vapi = await load();
    const id = await vapi.start("solo");
    expect(id).toBe("call-123");
    expect(vapi.getCallState()).toMatchObject({ callId: "call-123", status: "starting", mode: "solo" });
    created[0]!.emit("call-start");
    expect(vapi.getCallState().status).toBe("active");
    expect(vapi.isCallActive()).toBe(true);
  });

  it("refuses a second start while a call is starting or active", async () => {
    const vapi = await load();
    let release: (v: unknown) => void = () => {};
    startImpl = () => new Promise((resolve) => (release = resolve));

    const first = vapi.start("solo");
    const second = await vapi.start("solo"); // double click while the first is still connecting
    expect(second).toBeNull();

    await vi.waitFor(() => expect(created[0]?.start).toHaveBeenCalled());
    release({ id: "call-1" });
    expect(await first).toBe("call-1");
    created[0]!.emit("call-start");
    expect(await vapi.start("squad")).toBeNull();
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
  });

  it("turns a null start into inline error text", async () => {
    const vapi = await load();
    startImpl = async () => null;
    expect(await vapi.start("solo")).toBeNull();
    expect(vapi.getCallState()).toMatchObject({ status: "error" });
    expect(vapi.getCallState().error).toMatch(/could not start/i);
    expect(vapi.isCallActive()).toBe(false);
  });

  it("maps an error event during start to a specific sentence", async () => {
    const vapi = await load();
    startImpl = async () => {
      created[0]!.emit("error", { type: "start-method-error", error: { name: "NotAllowedError", message: "Permission denied" } });
      return null;
    };
    await vapi.start("solo");
    expect(vapi.getCallState().status).toBe("error");
    expect(vapi.getCallState().error).toMatch(/microphone/i);
  });

  it("ignores Daily's normal hang-up error and keeps the call ended, not failed", async () => {
    const vapi = await load();
    await vapi.start("solo");
    const inst = created[0]!;
    inst.emit("call-start");
    inst.emit("error", { errorMsg: "Meeting has ended" });
    inst.emit("call-end");
    expect(vapi.getCallState()).toMatchObject({ status: "ended", error: null });
  });

  it("does not construct anything when the mode has no id yet", async () => {
    const vapi = await load({ squadId: null });
    expect(await vapi.start("squad")).toBeNull();
    expect(vapi.getCallState().error).toMatch(/not configured/i);
    expect(created).toHaveLength(0);
  });

  it("explains a missing public key", async () => {
    const vapi = await load({ vapiPublicKey: null });
    expect(await vapi.start("solo")).toBeNull();
    expect(vapi.getCallState().error).toMatch(/public key/i);
  });

  it("builds the caller-side transcript: finals commit, one partial per role", async () => {
    const vapi = await load();
    await vapi.start("solo");
    const inst = created[0]!;
    inst.emit("call-start");
    inst.emit("message", { type: "transcript", role: "assistant", transcriptType: "partial", transcript: "Hi this" });
    inst.emit("message", { type: "transcript", role: "assistant", transcriptType: "partial", transcript: "Hi this is Tessa" });
    expect(vapi.getCallState().partial.assistant).toBe("Hi this is Tessa");
    inst.emit("message", { type: "transcript", role: "assistant", transcriptType: "final", transcript: "Hi, this is Tessa." });
    inst.emit("message", { type: "transcript", role: "user", transcriptType: "partial", transcript: "my cl" });
    inst.emit("message", { type: "status-update", status: "in-progress" });
    const s = vapi.getCallState();
    expect(s.finals.map((l) => `${l.role}:${l.text}`)).toEqual(["assistant:Hi, this is Tessa."]);
    expect(s.partial).toEqual({ user: "my cl", assistant: null });
  });

  it("tracks assistant speech", async () => {
    const vapi = await load();
    await vapi.start("solo");
    created[0]!.emit("speech-start");
    expect(vapi.getCallState().assistantSpeaking).toBe(true);
    created[0]!.emit("speech-end");
    expect(vapi.getCallState().assistantSpeaking).toBe(false);
  });

  it("stop() hangs up, and pagehide stops an active call", async () => {
    const vapi = await load();
    await vapi.start("solo");
    created[0]!.emit("call-start");
    await vapi.stop();
    expect(created[0]!.stop).toHaveBeenCalledTimes(1);
    expect(vapi.getCallState().status).toBe("ended");

    vapi.resetCall();
    await vapi.start("solo");
    created[0]!.emit("call-start");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(created[0]!.stop).toHaveBeenCalledTimes(2));
  });

  it("parses the ?mode= value with solo as the default", async () => {
    const vapi = await load();
    expect(vapi.parseMode("squad")).toBe("squad");
    expect(vapi.parseMode("core")).toBe("core");
    expect(vapi.parseMode("anything")).toBe("solo");
    expect(vapi.parseMode(null)).toBe("solo");
  });
});

describe("describeVapiError", () => {
  it("names the common start failures", async () => {
    const { describeVapiError } = await load();
    expect(describeVapiError({ error: { message: "Wallet Balance is insufficient", statusCode: 402 } })).toMatch(/credit/);
    expect(describeVapiError({ error: { message: "Origin not allowed", statusCode: 403 } })).toMatch(/allowed list/);
    expect(describeVapiError(new Error("Assistant not found"))).toMatch(/not found/);
    expect(describeVapiError(new TypeError("Failed to fetch"))).toMatch(/Network/);
    expect(describeVapiError(undefined)).toMatch(/could not start/);
  });
});

describe("resolveVapiCtor", () => {
  it("finds the class under either CommonJS interop shape", async () => {
    const { resolveVapiCtor } = await load();
    class Fake {}
    expect(resolveVapiCtor({ default: Fake })).toBe(Fake);
    expect(resolveVapiCtor({ default: { default: Fake } })).toBe(Fake);
    expect(() => resolveVapiCtor({ default: {} })).toThrow(/did not load/);
  });
});
