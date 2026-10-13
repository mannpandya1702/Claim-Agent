import { useEffect, useState } from "react";

/*
 * Microphone checks for the call page. Daily (the SDK's transport) reports a blocked, missing or
 * busy microphone on a side event (camera-error) rather than failing start(), so the caller could
 * hear Ava and never be heard. Asking for the microphone ourselves before start() turns that
 * into a clear message and spends no voice credit.
 */

export type MicProblem = "denied" | "no-device" | "busy" | "insecure" | "unsupported" | "failed";

export interface MicProblemCopy {
  title: string;
  body: string;
}

export const MIC_PROBLEM_COPY: Record<MicProblem, MicProblemCopy> = {
  denied: {
    title: "Microphone blocked",
    body: "The browser denied microphone access, so the call did not start. Allow the microphone for this site (the icon at the left of the address bar), then start again.",
  },
  "no-device": {
    title: "No microphone found",
    body: "Connect a microphone or headset, then start again.",
  },
  busy: {
    title: "Microphone in use",
    body: "Another app or tab is holding the microphone. Close it, then start again.",
  },
  insecure: {
    title: "Microphone needs a secure page",
    body: "Browsers only allow the microphone on https:// pages and on localhost. Open the page over https, then start again.",
  },
  unsupported: {
    title: "Microphone unavailable",
    body: "This browser does not give this page a microphone. Use a current version of Chrome, Edge, Firefox or Safari.",
  },
  failed: {
    title: "Microphone did not open",
    body: "The browser could not open the microphone. Check its sound settings, then start again.",
  },
};

/**
 * Maps a getUserMedia rejection to what the caller can fix. Anything unrecognised still stops the
 * start: if the browser cannot open the microphone, the SDK cannot either.
 */
export function micProblemFromError(e: unknown): MicProblem {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    case "NotSupportedError":
      return "unsupported";
    default:
      return "failed";
  }
}

/**
 * Prompts for the microphone (or confirms an earlier grant) and releases it at once; the SDK
 * opens its own stream right after. Call it from the Start click so the prompt has a gesture.
 */
export async function preflightMicrophone(): Promise<MicProblem | null> {
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!devices || typeof devices.getUserMedia !== "function") return "unsupported";
  // A site-level block is certain from the Permissions API, while the getUserMedia rejection
  // for it varies by browser (headless Chromium says NotSupportedError).
  if ((await queryMicPermission()) === "denied") return "denied";
  try {
    const stream = await devices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (e) {
    return micProblemFromError(e);
  }
}

export type MicPermission = PermissionState | "unknown";

async function queryMicPermission(): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return status?.state ?? null;
  } catch {
    // Firefox throws for the "microphone" name.
    return null;
  }
}

/**
 * The site's microphone permission, kept current, so a block shows before the first click.
 * "unknown" where the Permissions API cannot answer (older Safari and Firefox).
 */
export function useMicPermission(): MicPermission {
  const [state, setState] = useState<MicPermission>("unknown");
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => {
      if (status && !cancelled) setState(status.state);
    };
    const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!permissions?.query) return;
    permissions
      .query({ name: "microphone" as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s;
        setState(s.state);
        s.addEventListener?.("change", onChange);
      })
      .catch(() => {
        // Firefox throws for the "microphone" name; keep "unknown".
      });
    return () => {
      cancelled = true;
      status?.removeEventListener?.("change", onChange);
    };
  }, []);
  return state;
}
