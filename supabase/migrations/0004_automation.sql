-- 0004_automation.sql — scheduled housekeeping lives in the database: versioned with the schema,
-- no external scheduler to keep alive. pg_cron fires, pg_net POSTs to the Edge Function's
-- /jobs/<name> route, and the route is guarded by a bearer read from Vault at call time
-- (vault.decrypted_secrets), never written as a literal into SQL or a migration.
--
-- One-time setup by hand (never in a migration), with the same value as the JOBS_BEARER
-- Edge Function secret:
--   select vault.create_secret('<JOBS_BEARER>', 'jobs_bearer');
--
-- Each job writes a job_runs row keyed by (job, period_key), so a re-fire inside the same period
-- is a no-op; the job logic itself is unit-tested in jobs_test.ts.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function invoke_job(p_name text) returns bigint
language plpgsql security invoker set search_path = public as $$
declare
  v_bearer text;
  v_request bigint;
begin
  if p_name not in ('sla', 'digest', 'reaper', 'outbox') then
    raise exception 'unknown job %', p_name;
  end if;
  select decrypted_secret into v_bearer from vault.decrypted_secrets where name = 'jobs_bearer';
  if v_bearer is null then
    raise exception 'vault secret jobs_bearer is missing';
  end if;
  select net.http_post(
    url := 'https://ttlksqialpgurugbxgyw.supabase.co/functions/v1/vapi-webhook/jobs/' || p_name,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_bearer, 'Content-Type', 'application/json'),
    body := jsonb_build_object('job', p_name),
    timeout_milliseconds := 10000
  ) into v_request;
  return v_request;
end $$;

revoke execute on function invoke_job(text) from public, anon, authenticated;

-- sla: unclaimed escalations older than 30 minutes re-alert once (Telegram + email).
select cron.schedule('claims-sla', '*/10 * * * *', $$select public.invoke_job('sla')$$);
-- digest: 08:00 America/New_York. pg_cron runs in UTC; 12:00 UTC is 08:00 EDT (13:00 UTC in
-- EST). The job's period_key is the Eastern date, so the one-hour drift at the DST change can
-- never send two digests for one day.
select cron.schedule('claims-digest', '0 12 * * *', $$select public.invoke_job('digest')$$);
-- reaper: stale in-progress calls get backfilled or closed as abandoned; old live lines pruned.
select cron.schedule('claims-reaper', '7 * * * *', $$select public.invoke_job('reaper')$$);
-- outbox: deliver undelivered post-call events to Airtable (capped at 5 attempts per event).
select cron.schedule('claims-outbox', '* * * * *', $$select public.invoke_job('outbox')$$);
