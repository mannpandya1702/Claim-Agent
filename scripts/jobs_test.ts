import { assertEquals } from "@std/assert";
import { jobUrl, parseJobName, runRemoteJob } from "./jobs.ts";

Deno.test("jobs: only one known job name is accepted", () => {
  assertEquals(parseJobName(["digest"]), "digest");
  assertEquals(parseJobName(["--", "outbox"]), "outbox");
  for (const args of [[], ["drop_tables"], ["sla", "digest"], ["SLA"]]) assertEquals(parseJobName(args), null);
});

Deno.test("jobs: the URL is the function's job route whatever the trailing slash", () => {
  assertEquals(
    jobUrl("https://abc.supabase.co/", "reaper"),
    "https://abc.supabase.co/functions/v1/vapi-webhook/jobs/reaper",
  );
  assertEquals(jobUrl("https://abc.supabase.co", "sla"), "https://abc.supabase.co/functions/v1/vapi-webhook/jobs/sla");
});

Deno.test("jobs: POSTs with the jobs bearer as pg_cron does and returns the JSON answer", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchFn = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(
      new Response(JSON.stringify({ job: "digest", period_key: "2026-10-12", skipped: true }), { status: 200 }),
    );
  }) as unknown as typeof fetch;
  const out = await runRemoteJob(fetchFn, "https://abc.supabase.co", " jobs-bearer \n", "digest");
  assertEquals(out, { status: 200, body: { job: "digest", period_key: "2026-10-12", skipped: true } });
  const s = seen as unknown as { url: string; init: RequestInit };
  assertEquals(s.url, "https://abc.supabase.co/functions/v1/vapi-webhook/jobs/digest");
  assertEquals(s.init.method, "POST");
  assertEquals((s.init.headers as Record<string, string>).Authorization, "Bearer jobs-bearer");
  assertEquals(JSON.parse(String(s.init.body)), { job: "digest" });
});

Deno.test("jobs: a non-JSON answer comes back as text with its status", async () => {
  const fetchFn = (() => Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;
  assertEquals(await runRemoteJob(fetchFn, "https://abc.supabase.co", "b", "sla"), { status: 502, body: "Bad Gateway" });
});
