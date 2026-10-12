// recording-url: staff-only, short-lived recording link for the dashboard audio player.
//
// The stored recording fields are private stable identifiers, not playable links. This function
// checks is_staff() with the caller's own JWT, then checks that the call is one this caller can
// read (a call_interactions row under RLS), and only then asks VAPI for the mono recording with
// redirect: 'manual' and hands back the presigned Location (minutes-long) as JSON. The private
// key reaches every call in the VAPI org, so the row check keeps this function inside the same
// data the dashboard can see: no org call this system never stored, nothing reset or reaped.
// Nothing is stored. Pure and dependency-injected so the request path is tested without network.

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://mannpandya1702.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
];

export const RECORDING_GONE = "Recording no longer available";

export interface RecordingDeps {
  /** VAPI private key; null when the secret is not set. */
  vapiPrivateKey: string | null;
  /** Resolves the caller's staff status from their Authorization header (true, false, or throws). */
  isStaff: (authorization: string) => Promise<boolean>;
  /** True when the caller can read this call's call_interactions row (RLS, caller's JWT); throws on failure. */
  callVisible: (authorization: string, callId: string) => Promise<boolean>;
  fetch: typeof fetch;
  allowedOrigins?: readonly string[];
  vapiBaseUrl?: string;
  timeoutMs?: number;
}

export function corsHeaders(origin: string | null, allowed: readonly string[] = DEFAULT_ALLOWED_ORIGINS): Headers {
  const h = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  });
  // Echo only known origins; anything else gets no allow-origin and the browser blocks it.
  if (origin && allowed.includes(origin)) h.set("Access-Control-Allow-Origin", origin);
  return h;
}

/** VAPI call ids are UUIDs; accept a conservative id shape and nothing that could alter the path. */
export function validCallId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

export type RecordingResult =
  | { status: 200; body: { url: string } }
  | { status: 404; body: { error: string } }
  | { status: 502 | 504; body: { error: string } };

/** Asks VAPI for the mono recording and turns its answer into our response. */
export async function resolveRecording(
  callId: string,
  key: string,
  fetchFn: typeof fetch,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<RecordingResult> {
  const base = (opts.baseUrl ?? "https://api.vapi.ai").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchFn(`${base}/call/${encodeURIComponent(callId)}/mono-recording`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return timedOut
      ? { status: 504, body: { error: "Recording service timed out" } }
      : { status: 502, body: { error: "Recording service unreachable" } };
  }

  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    return { status: 200, body: { url: location } };
  }
  if (res.status === 404) {
    await res.body?.cancel();
    return { status: 404, body: { error: RECORDING_GONE } };
  }
  if (res.ok) {
    // Some deployments answer 200 with the link in JSON instead of a redirect.
    const data = await res.json().catch(() => null) as { url?: unknown } | null;
    if (data && typeof data.url === "string" && data.url.startsWith("https://")) {
      return { status: 200, body: { url: data.url } };
    }
    return { status: 502, body: { error: "Recording service returned no link" } };
  }
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403) {
    return { status: 502, body: { error: "Recording service rejected the server key" } };
  }
  return { status: 502, body: { error: `Recording service returned ${res.status}` } };
}

function json(status: number, body: unknown, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json");
  // The presigned link expires in minutes and is per-request; never let anything cache it.
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function createHandler(deps: RecordingDeps): (req: Request) => Promise<Response> {
  const allowed = deps.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  return async (req: Request) => {
    const cors = corsHeaders(req.headers.get("origin"), allowed);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json(405, { error: "Use POST" }, cors);

    const authorization = req.headers.get("authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(authorization)) return json(401, { error: "Sign in required" }, cors);

    let staff = false;
    try {
      staff = await deps.isStaff(authorization);
    } catch {
      return json(502, { error: "Could not check staff access" }, cors);
    }
    if (!staff) return json(403, { error: "Staff only" }, cors);

    const body = await req.json().catch(() => null) as { call_id?: unknown } | null;
    if (!body || !validCallId(body.call_id)) {
      return json(400, { error: 'Body must be {"call_id": "<vapi call id>"}' }, cors);
    }

    if (!deps.vapiPrivateKey) return json(500, { error: "Recording service is not configured" }, cors);

    // Same answer as VAPI's own 404: from the player's side, a call we hold no record of has no
    // recording to offer.
    let visible = false;
    try {
      visible = await deps.callVisible(authorization, body.call_id);
    } catch {
      return json(502, { error: "Could not check the call" }, cors);
    }
    if (!visible) return json(404, { error: RECORDING_GONE }, cors);

    const result = await resolveRecording(body.call_id, deps.vapiPrivateKey, deps.fetch, {
      baseUrl: deps.vapiBaseUrl,
      timeoutMs: deps.timeoutMs,
    });
    return json(result.status, result.body, cors);
  };
}

/** ALLOWED_ORIGINS="https://a,https://b" overrides the defaults (for a renamed Pages site). */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_ALLOWED_ORIGINS];
}
