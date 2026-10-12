-- 0005_outbox.sql — post-call fan-out to external systems (the Airtable call log) through an
-- outbox, so the webhook path never waits on a third party.
--
-- The post-call writer enqueues one row per completed call in the same request that stores the
-- record (unique (kind, ref_id)); delivery is tried once right away off the request path and then
-- by the every-minute outbox job. Delivery is capped at-least-once: a row is claimed by bumping
-- attempts under "delivered_at is null and attempts < 5", and the receiver's upsert on the call id
-- makes a repeat delivery a no-op. The payload is only the reference: the job reads the current
-- call_interactions row at delivery time, so a backfill that improves the record re-delivers the
-- improved version (the writer resets delivered_at when it re-enqueues).

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('interaction.completed')),
  ref_id text not null,                 -- call_interactions.vapi_call_id
  destination text not null default 'airtable' check (destination in ('airtable')),
  delivered_at timestamptz,
  attempts int not null default 0,
  last_error text,
  external_id text,                     -- Airtable record id after the first successful delivery
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, ref_id, destination)
);
create index outbox_events_pending_idx on outbox_events (created_at) where delivered_at is null;

alter table outbox_events enable row level security;
revoke all on outbox_events from anon, authenticated;
grant select, insert, update, delete on outbox_events to service_role;
create trigger outbox_events_touch before update on outbox_events for each row execute function touch_updated_at();

-- Enqueue or re-arm: a completed call enqueues once; a later improvement (backfill) re-arms the
-- same row for another delivery with a fresh attempt budget.
create function enqueue_outbox(p_kind text, p_ref_id text, p_destination text default 'airtable') returns void
language sql security invoker set search_path = public as $$
  insert into outbox_events (kind, ref_id, destination) values (p_kind, p_ref_id, p_destination)
  on conflict (kind, ref_id, destination) do update
    set delivered_at = null, attempts = 0, last_error = null
$$;

-- Claim up to p_limit undelivered rows for one delivery attempt each (skip locked rows so two
-- overlapping job runs never take the same row).
create function claim_outbox(p_limit int default 20) returns setof outbox_events
language sql security invoker set search_path = public as $$
  update outbox_events o set attempts = o.attempts + 1
  where o.id in (
    select id from outbox_events
    where delivered_at is null and attempts < 5
    order by created_at
    limit greatest(p_limit, 1)
    for update skip locked)
  returning o.*
$$;

revoke execute on function enqueue_outbox(text, text, text) from public, anon, authenticated;
revoke execute on function claim_outbox(int) from public, anon, authenticated;
grant execute on function enqueue_outbox(text, text, text) to service_role;
grant execute on function claim_outbox(int) to service_role;

-- Dashboard visibility (staff read-only), and the outbox backlog on the Ops page.
grant select on outbox_events to authenticated;
create policy staff_select on outbox_events for select to authenticated using ((select is_staff()));
alter publication supabase_realtime add table outbox_events;

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
  (select count(*) from outbox_events where delivered_at is null and attempts < 5) as outbox_pending,
  (select count(*) from outbox_events where delivered_at is null and attempts >= 5) as outbox_dead,
  (select count(*) from outbox_events where delivered_at > now() - interval '24 hours') as outbox_delivered_24h;
