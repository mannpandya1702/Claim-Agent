// Minimal VAPI REST client for the scripts (private key; never shipped to the browser).

import { loadEnv, need } from "./env.ts";

export class VapiError extends Error {
  constructor(readonly status: number, readonly body: unknown, path: string) {
    super(`VAPI ${status} on ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export function vapiClient(env = loadEnv()) {
  const [key] = need(env, "VAPI_PRIVATE_KEY");
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`https://api.vapi.ai${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* keep text */ }
    if (!res.ok) throw new VapiError(res.status, parsed, `${method} ${path}`);
    return parsed as T;
  }
  return {
    get: <T = any>(p: string) => call<T>("GET", p),
    post: <T = any>(p: string, b?: unknown) => call<T>("POST", p, b),
    patch: <T = any>(p: string, b: unknown) => call<T>("PATCH", p, b),
    del: <T = any>(p: string) => call<T>("DELETE", p),
    raw: call,
  };
}
