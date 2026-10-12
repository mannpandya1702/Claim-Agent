// SQL over HTTPS through the Supabase Management API.
// Raw Postgres TCP (5432/6543) is not reachable from every build environment, so migrations,
// DB tests and the demo reset all go through POST /v1/projects/{ref}/database/query.
// The endpoint runs a multi-statement string in one round trip and returns the rows of the
// last statement; an error (including a failed ASSERT) comes back as HTTP 400 with the message.

import { loadEnv, need } from "./env.ts";

export class SqlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function sqlClient(env = loadEnv()) {
  const [token, ref] = need(env, "SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF");
  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  return async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
    for (let attempt = 0;; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      // 429/5xx from the management API are transient; SQL errors are 400 and are never retried
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        let msg = text;
        try {
          msg = JSON.parse(text).message ?? text;
        } catch { /* keep raw text */ }
        throw new SqlError(msg, res.status);
      }
      return text ? JSON.parse(text) as T[] : [];
    }
  };
}

// Literal quoting for the few places scripts build SQL from local, trusted values.
export function lit(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${v.replaceAll("'", "''")}'`;
}
