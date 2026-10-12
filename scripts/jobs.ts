// deno task jobs <sla|digest|reaper|outbox>
//
// Runs one scheduled job now through the deployed function: the same POST pg_cron makes through
// pg_net (Bearer JOBS_BEARER from .env), to SUPABASE_URL/functions/v1/vapi-webhook/jobs/<name>.
// Prints the JSON answer. A job already run in its period answers {"skipped": true} (one digest
// per Eastern date, one reaper pass per UTC hour). Exit code 1 for any status of 400 or above.
// The bearer is never printed.

import { JOB_NAMES, type JobName } from "../supabase/functions/vapi-webhook/enums.ts";
import { loadEnv, need } from "./lib/env.ts";

const USAGE = `usage: deno task jobs <${JOB_NAMES.join("|")}>`;
// Longer than the function's own 8 s run deadline, so the answer is what the function decided.
const REQUEST_TIMEOUT_MS = 30_000;

export function parseJobName(args: string[]): JobName | null {
  const rest = args.filter((a) => a !== "--");
  if (rest.length !== 1) return null;
  return (JOB_NAMES as readonly string[]).includes(rest[0]) ? rest[0] as JobName : null;
}

export function jobUrl(supabaseUrl: string, name: JobName): string {
  return `${supabaseUrl.trim().replace(/\/+$/, "")}/functions/v1/vapi-webhook/jobs/${name}`;
}

/** POST the job route; the body is whatever the function answered (JSON, else its text). */
export async function runRemoteJob(
  fetchFn: typeof fetch,
  supabaseUrl: string,
  bearer: string,
  name: JobName,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(jobUrl(supabaseUrl, name), {
    method: "POST",
    headers: { "Authorization": `Bearer ${bearer.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ job: name }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a gateway error page is printed as text
  }
  return { status: res.status, body };
}

async function main(): Promise<number> {
  const name = parseJobName(Deno.args);
  if (!name) {
    console.error(USAGE);
    return 2;
  }
  const [supabaseUrl, bearer] = need(loadEnv(), "SUPABASE_URL", "JOBS_BEARER");
  const { status, body } = await runRemoteJob(fetch, supabaseUrl, bearer, name);
  console.log(`HTTP ${status}`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return status >= 400 ? 1 : 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
