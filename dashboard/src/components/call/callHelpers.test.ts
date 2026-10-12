import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCallError } from "./callErrors";
import { micProblemFromError, preflightMicrophone } from "./microphone";

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(window, "isSecureContext");
});

function named(name: string) {
  return Object.assign(new Error(name), { name });
}

describe("micProblemFromError", () => {
  it("maps getUserMedia rejections to what the caller can fix", () => {
    expect(micProblemFromError(named("NotAllowedError"))).toBe("denied");
    expect(micProblemFromError(named("SecurityError"))).toBe("denied");
    expect(micProblemFromError(named("NotFoundError"))).toBe("no-device");
    expect(micProblemFromError(named("NotReadableError"))).toBe("busy");
    expect(micProblemFromError(named("NotSupportedError"))).toBe("unsupported");
    // Unknown failures still stop the start: the SDK would fail on the same microphone.
    expect(micProblemFromError(named("SomethingElse"))).toBe("failed");
    expect(micProblemFromError(null)).toBe("failed");
  });
});

describe("preflightMicrophone", () => {
  it("refuses on an insecure page and where the browser has no microphone API", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    expect(await preflightMicrophone()).toBe("insecure");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    expect(await preflightMicrophone()).toBe("unsupported");
  });

  it("releases the test stream at once when access is granted", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    expect(await preflightMicrophone()).toBeNull();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("trusts a site-level block from the Permissions API without opening the microphone", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: vi.fn(async () => ({ state: "denied" })) } });
    expect(await preflightMicrophone()).toBe("denied");
    expect(getUserMedia).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "permissions");
  });

  it("reports a denial", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => Promise.reject(named("NotAllowedError"))) },
    });
    expect(await preflightMicrophone()).toBe("denied");
  });
});

describe("describeCallError", () => {
  it("titles each sentence the store produces", () => {
    expect(describeCallError("Microphone access is blocked. Allow the microphone for this site, then try again.", "error").kind).toBe("microphone");
    expect(describeCallError("The voice account is out of credit, so the call could not start.", "error")).toMatchObject({
      kind: "credit",
      title: "Voice account out of credit",
    });
    const origin = describeCallError("This site is not on the voice key's allowed list, so the call was refused.", "error", "https://demo.example");
    expect(origin.kind).toBe("origin");
    expect(origin.hint).toContain("https://demo.example");
    expect(describeCallError("The Squad mode is not configured in this build yet.", "error").kind).toBe("config");
    expect(describeCallError("The configured assistant was not found. The VAPI ids may be out of date.", "error").kind).toBe("assistant");
    expect(describeCallError("Network problem while starting the call.", "error").kind).toBe("network");
  });

  it("falls back to a title that depends on whether the call is running", () => {
    expect(describeCallError("Something odd.", "error").title).toBe("The call did not start");
    expect(describeCallError("Something odd.", "active").title).toBe("Problem during the call");
  });
});
