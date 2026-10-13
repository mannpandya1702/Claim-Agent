-- 0008_ghl.sql — GoHighLevel, the third outbox destination: one event per completed call, delivered
-- in steps (contact, tags, note, tasks) that each record their result before the next one starts.
--
-- Principle kept: the CRM never sits in the call path. The post-call writer queues a 'ghl' row next
-- to the Airtable one, 90 s out so the analysis backfill has landed, and the every-minute outbox job
-- delivers it. GHL has no upsert we can trust, so idempotency lives here: progress holds what each
-- step already did (the contact id, the note id, a task id per task), a retry repeats only what is
-- missing, and a re-arm never touches it, so a re-armed row never posts a second note.
--
-- Additive for the webhook deployed before this migration: enqueue_outbox keeps its first three
-- parameters (the new delay defaults to 0), and the new columns have defaults.

alter table outbox_events drop constraint outbox_events_destination_check;
alter table outbox_events add constraint outbox_events_destination_check check (destination in ('airtable', 'ghl'));

-- What a delivery's steps have done so far (shallow keys, merged with ||), and when the row may be
-- claimed next: an insert or re-arm sets it to now() + the destination's delay, a retryable failure
-- to now() + the receiver's retry-after or the backoff. A row inserted with no delay holds
-- next_attempt_at = created_at, which store_rules.ts reads as due whatever the caller's clock says.
alter table outbox_events add column progress jsonb not null default '{}'::jsonb
  check (jsonb_typeof(progress) = 'object');
alter table outbox_events add column next_attempt_at timestamptz not null default now();
create index outbox_events_due_idx on outbox_events (destination, next_attempt_at) where delivered_at is null;

-- Enqueue or re-arm with a delay. The re-arm resets the delivery and the attempt budget and moves
-- next_attempt_at; it never touches progress (or external_id).
drop function enqueue_outbox(text, text, text);
create function enqueue_outbox(p_kind text, p_ref_id text, p_destination text default 'airtable', p_delay_s int default 0)
returns void
language sql security invoker set search_path = public as $$
  insert into outbox_events (kind, ref_id, destination, next_attempt_at)
  values (p_kind, p_ref_id, p_destination, now() + make_interval(secs => greatest(coalesce(p_delay_s, 0), 0)))
  on conflict (kind, ref_id, destination) do update
    set delivered_at = null, attempts = 0, last_error = null, next_attempt_at = excluded.next_attempt_at
$$;

-- The SQL claim (0005) now also waits for next_attempt_at. The Edge Function claims through
-- store.ts (a compare-and-set with a lease); this one stays for manual runs and the DB suite.
create or replace function claim_outbox(p_limit int default 20) returns setof outbox_events
language sql security invoker set search_path = public as $$
  update outbox_events o set attempts = o.attempts + 1
  where o.id in (
    select id from outbox_events
    where delivered_at is null and attempts < 5 and next_attempt_at <= now()
    order by created_at
    limit greatest(p_limit, 1)
    for update skip locked)
  returning o.*
$$;

-- One step's result merged into progress (progress || p_patch). The merge always happens, because
-- it records something the receiver already did (a note that exists is a note that exists, whoever
-- holds the row now). held says whether the caller's claim still holds: the row was neither
-- re-armed, re-claimed nor finished since the claim (or the caller's previous save) returned
-- p_attempts and p_claimed_at. saved_at is the row's new write time, the caller's next guard. No
-- row: nothing returned.
create function save_outbox_progress(p_id uuid, p_patch jsonb, p_attempts int, p_claimed_at timestamptz)
returns table (saved_at timestamptz, held boolean)
language plpgsql security invoker set search_path = public as $$
declare
  r outbox_events;
begin
  select * into r from outbox_events o where o.id = p_id for update;
  if not found then
    return;
  end if;
  held := r.attempts = p_attempts and r.updated_at = p_claimed_at and r.delivered_at is null;
  update outbox_events o set progress = o.progress || coalesce(p_patch, '{}'::jsonb)
  where o.id = p_id
  returning o.updated_at into saved_at;
  return next;
end $$;

revoke execute on function enqueue_outbox(text, text, text, int) from public, anon, authenticated;
revoke execute on function save_outbox_progress(uuid, jsonb, int, timestamptz) from public, anon, authenticated;
grant execute on function enqueue_outbox(text, text, text, int) to service_role;
grant execute on function save_outbox_progress(uuid, jsonb, int, timestamptz) to service_role;

-- The Ops page's outbox counts stay the Airtable call log's (the page labels them so); GoHighLevel's
-- come as three new columns at the end.
create or replace view ops_health with (security_invoker = true) as
select
  (select max(finished_at) from job_runs where job = 'sla') as last_sla_run,
  (select max(finished_at) from job_runs where job = 'digest') as last_digest_run,
  (select max(finished_at) from job_runs where job = 'reaper') as last_reaper_run,
  (select count(*) from escalations where status = 'open') as open_escalations,
  (select count(*) from escalations where status = 'open' and created_at < now() - interval '30 minutes') as sla_breaches,
  (select count(*) from escalations where alert_status = 'failed' and created_at > now() - interval '24 hours') as alerts_failed_24h,
  (select count(*) from emails where status = 'failed' and created_at > now() - interval '24 hours') as emails_failed_24h,
  (select count(*) from emails where status = 'sent' and created_at > now() - interval '24 hours') as emails_sent_24h,
  (select count(*) from call_interactions where ended_at is null and created_at < now() - interval '2 hours') as stuck_calls,
  (select count(*) from call_interactions where analysis_status = 'missing' and created_at > now() - interval '24 hours') as analysis_missing_24h,
  (select max(finished_at) from job_runs where job = 'outbox') as last_outbox_run,
  (select count(*) from outbox_events where destination = 'airtable' and delivered_at is null and attempts < 5) as outbox_pending,
  (select count(*) from outbox_events where destination = 'airtable' and delivered_at is null and attempts >= 5) as outbox_dead,
  (select count(*) from outbox_events where destination = 'airtable' and delivered_at > now() - interval '24 hours') as outbox_delivered_24h,
  (select count(*) from outbox_events where destination = 'ghl' and delivered_at is null and attempts < 5) as ghl_pending,
  (select count(*) from outbox_events where destination = 'ghl' and delivered_at is null and attempts >= 5) as ghl_dead,
  (select count(*) from outbox_events where destination = 'ghl' and delivered_at > now() - interval '24 hours') as ghl_delivered_24h;
