-- 0003_dashboard.sql — the ops dashboard is a least-privilege client.
-- Supabase Auth (email + password, sign-ups off) plus the staff allowlist; explicit grants and
-- one select policy per granted table; customers and claims are never granted (no DOB column is
-- browser-readable); the only browser write is staff_notes, plus the two escalation transition
-- functions that the dashboard and the service role share.

-- is_staff() is called as (select is_staff()) in every policy so Postgres evaluates it once per
-- statement (initPlan) instead of once per row. No policy on staff calls it (that would recurse).
create function is_staff() returns boolean
language sql stable security invoker set search_path = public as $$
  select exists (select 1 from public.staff where user_id = (select auth.uid()))
$$;

grant select on staff to authenticated;
create policy staff_self_select on staff for select to authenticated using (user_id = (select auth.uid()));

grant select on call_interactions, attempts, call_sessions, escalations, emails, job_runs, transcript_lines
  to authenticated;
create policy staff_select on call_interactions for select to authenticated using ((select is_staff()));
create policy staff_select on attempts for select to authenticated using ((select is_staff()));
create policy staff_select on call_sessions for select to authenticated using ((select is_staff()));
create policy staff_select on escalations for select to authenticated using ((select is_staff()));
create policy staff_select on emails for select to authenticated using ((select is_staff()));
create policy staff_select on job_runs for select to authenticated using ((select is_staff()));
create policy staff_select on transcript_lines for select to authenticated using ((select is_staff()));

-- The one browser-writable column. A policy denial updates zero rows and PostgREST still answers
-- success, so the client selects the row back after saving.
grant update (staff_notes) on call_interactions to authenticated;
create policy staff_notes_update on call_interactions for update to authenticated
  using ((select is_staff())) with check ((select is_staff()));

-- List views (calls, live cards, escalation queue) read these instead of the raw columns, so a
-- list response never carries a full phone number or the stored recording reference; only the
-- call detail page selects caller_phone and callback_phone. The mask matches the dashboard's
-- maskPhone ("+1 602 ... 0101"). Inline rather than a helper function: a generated column may
-- only call immutable functions, and a new function would need its own grants.
alter table call_interactions
  add column caller_phone_masked text generated always as (case
    when nullif(caller_phone, '') is null then null
    when regexp_replace(caller_phone, '\D', '', 'g') ~ '^1[0-9]{10}$'
      then '+1 ' || substr(regexp_replace(caller_phone, '\D', '', 'g'), 2, 3) || ' ... '
           || right(regexp_replace(caller_phone, '\D', '', 'g'), 4)
    when regexp_replace(caller_phone, '\D', '', 'g') ~ '^[0-9]{10}$'
      then '+1 ' || left(regexp_replace(caller_phone, '\D', '', 'g'), 3) || ' ... '
           || right(regexp_replace(caller_phone, '\D', '', 'g'), 4)
    when length(regexp_replace(caller_phone, '\D', '', 'g')) >= 4
      then '... ' || right(regexp_replace(caller_phone, '\D', '', 'g'), 4)
    else '...' end) stored,
  add column has_recording boolean generated always as (recording_url is not null) stored;

alter table escalations
  add column callback_phone_masked text generated always as (case
    when nullif(callback_phone, '') is null then null
    when regexp_replace(callback_phone, '\D', '', 'g') ~ '^1[0-9]{10}$'
      then '+1 ' || substr(regexp_replace(callback_phone, '\D', '', 'g'), 2, 3) || ' ... '
           || right(regexp_replace(callback_phone, '\D', '', 'g'), 4)
    when regexp_replace(callback_phone, '\D', '', 'g') ~ '^[0-9]{10}$'
      then '+1 ' || left(regexp_replace(callback_phone, '\D', '', 'g'), 3) || ' ... '
           || right(regexp_replace(callback_phone, '\D', '', 'g'), 4)
    when length(regexp_replace(callback_phone, '\D', '', 'g')) >= 4
      then '... ' || right(regexp_replace(callback_phone, '\D', '', 'g'), 4)
    else '...' end) stored;

-- ---------------------------------------------------------------------------------------------
-- Escalation transitions: the only write path for escalations from outside the Edge Function.
-- security definer because authenticated has no UPDATE on escalations; the staff check inside is
-- the control (the accepted get_advisors WARN 0029, recorded in docs/decisions.md).
-- A staff caller's p_actor is ignored: the actor is the JWT email, so a client never chooses it.
-- ---------------------------------------------------------------------------------------------
create function claim_escalation(p_id uuid, p_actor text default null) returns public.escalations
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_actor text;
  v_row public.escalations;
begin
  if v_role <> 'service_role' and not exists (select 1 from public.staff where user_id = auth.uid()) then
    raise exception 'not staff' using errcode = '42501';
  end if;
  v_actor := case when v_role = 'service_role' then coalesce(p_actor, 'service') else auth.jwt() ->> 'email' end;

  update public.escalations
     set status = 'claimed', claimed_by = v_actor, claimed_at = now()
   where id = p_id and status = 'open'
  returning * into v_row;

  if not found then
    -- already claimed or done: return the existing row, so a second claim shows the first claimer
    select * into v_row from public.escalations where id = p_id;
  end if;
  return v_row;
end $$;

create function close_escalation(p_id uuid, p_note text default null, p_actor text default null)
returns public.escalations
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_actor text;
  v_row public.escalations;
begin
  if v_role <> 'service_role' and not exists (select 1 from public.staff where user_id = auth.uid()) then
    raise exception 'not staff' using errcode = '42501';
  end if;
  v_actor := case when v_role = 'service_role' then coalesce(p_actor, 'service') else auth.jwt() ->> 'email' end;

  update public.escalations
     set status = 'done', closed_by = v_actor, closed_at = now(), close_note = left(p_note, 1000),
         claimed_by = coalesce(claimed_by, v_actor), claimed_at = coalesce(claimed_at, now())
   where id = p_id and status in ('open', 'claimed')
  returning * into v_row;

  if not found then
    select * into v_row from public.escalations where id = p_id;
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Read RPCs: security invoker, so the caller's grants and RLS apply (a non-staff session sees
-- zeros). All aggregation happens here, never client-side over a capped page. Days are Eastern.
-- ---------------------------------------------------------------------------------------------
create function dashboard_metrics(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  with c as (
    select * from call_interactions
    where coalesce(started_at, created_at) >= p_from and coalesce(started_at, created_at) < p_to
  ), s as (
    select cs.* from call_sessions cs
    where cs.created_at >= p_from and cs.created_at < p_to
  ), e as (
    select * from escalations where created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'calls', (select count(*) from c),
    'completed', (select count(*) filter (where ended_at is not null) from c),
    'in_progress', (select count(*) filter (where ended_at is null) from c),
    'resolved', (select count(*) filter (where outcome = 'resolved') from c),
    'containment_rate', (select round(avg(case when outcome = 'resolved' and not escalated then 1.0 else 0.0 end)
                                      filter (where ended_at is not null), 3) from c),
    'verification_attempted', (select count(*) filter (where level <> 'none') from s),
    'verification_success', (select count(*) filter (where level = 'verified') from s),
    'auth_failed', (select count(*) filter (where outcome = 'auth_failed') from c),
    'not_found', (select count(*) filter (where outcome = 'not_found') from c),
    'escalated', (select count(*) filter (where escalated) from c),
    'emergencies', (select count(*) filter (where emergency) from c),
    'escalation_rate', (select round(avg(case when escalated then 1.0 else 0.0 end)
                                     filter (where ended_at is not null), 3) from c),
    'avg_handle_seconds', (select round(avg(duration_seconds)) from c),
    'avg_cost', (select round(avg(cost), 4) from c),
    'avg_latency_ms', (select round(avg(latency_avg_ms)) from c),
    'flagged', (select count(*) filter (where cardinality(flags) > 0) from c),
    'outcomes', (select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb)
                 from (select coalesce(outcome, 'unknown') outcome, count(*) n from c group by 1) x),
    'sentiments', (select coalesce(jsonb_object_agg(sentiment, n), '{}'::jsonb)
                   from (select coalesce(sentiment, 'unknown') sentiment, count(*) n from c group by 1) x),
    'emails_sent', (select count(*) from emails m where m.status = 'sent' and m.created_at >= p_from and m.created_at < p_to),
    'open_escalations', (select count(*) from escalations where status = 'open'),
    'sla_breaches', (select count(*) from escalations where status = 'open' and created_at < now() - interval '30 minutes'),
    'escalations_in_range', (select count(*) from e)
  )
$$;

create function calls_by_day(p_from timestamptz, p_to timestamptz)
returns table (day date, outcome text, n bigint)
language sql stable security invoker set search_path = public as $$
  select (coalesce(started_at, created_at) at time zone 'America/New_York')::date as day,
         coalesce(outcome, 'unknown') as outcome,
         count(*) as n
  from call_interactions
  where coalesce(started_at, created_at) >= p_from and coalesce(started_at, created_at) < p_to
  group by 1, 2
  order by 1, 2
$$;

-- List query for the Calls table. Never selects transcript, messages or a full phone number
-- (detail page only). id is returned so a Realtime DELETE can drop the row from the cached page;
-- emailed marks calls with at least one sent email (emails is unique on (call_key, kind)).
create function search_calls(
  p_q text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_outcome text default null, p_sentiment text default null, p_channel text default null,
  p_flagged boolean default null, p_escalated boolean default null,
  p_limit int default 25, p_offset int default 0
) returns table (
  id uuid, vapi_call_id text, channel text, caller_name text, caller_phone_masked text, outcome text,
  sentiment text, escalated boolean, emergency boolean, emailed boolean, flags text[],
  started_at timestamptz, ended_at timestamptz, duration_seconds int, cost numeric, latency_avg_ms int,
  summary text, assistant_name text, created_at timestamptz, total bigint
)
language sql stable security invoker set search_path = public as $$
  select ci.id, ci.vapi_call_id, ci.channel, ci.caller_name, ci.caller_phone_masked, ci.outcome, ci.sentiment,
         ci.escalated, ci.emergency,
         exists (select 1 from emails m where m.call_key = ci.vapi_call_id and m.status = 'sent') as emailed,
         ci.flags, ci.started_at, ci.ended_at, ci.duration_seconds, ci.cost,
         ci.latency_avg_ms, left(ci.summary, 280), ci.assistant_name, ci.created_at,
         count(*) over () as total
  from call_interactions ci
  where (p_from is null or coalesce(ci.started_at, ci.created_at) >= p_from)
    and (p_to is null or coalesce(ci.started_at, ci.created_at) < p_to)
    and (p_outcome is null or ci.outcome = p_outcome)
    and (p_sentiment is null or ci.sentiment = p_sentiment)
    and (p_channel is null or ci.channel = p_channel)
    and (p_flagged is null or (cardinality(ci.flags) > 0) = p_flagged)
    and (p_escalated is null or ci.escalated = p_escalated)
    and (nullif(trim(p_q), '') is null
         or ci.search_tsv @@ websearch_to_tsquery('english', p_q)
         or ci.vapi_call_id like trim(p_q) || '%'
         or ci.caller_name ilike '%' || trim(p_q) || '%')
  order by coalesce(ci.started_at, ci.created_at) desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)
$$;

-- Alert rows are written before the transport hop, so owed vs delivered is two counts.
create function escalation_delivery_gap(p_hours int default 24)
returns table (channel text, owed bigint, delivered bigint, failed bigint)
language sql stable security invoker set search_path = public as $$
  select 'telegram'::text,
         count(*) filter (where alert_status <> 'skipped'),
         count(*) filter (where alert_status = 'sent'),
         count(*) filter (where alert_status = 'failed')
  from escalations where created_at > now() - make_interval(hours => p_hours)
  union all
  select 'email'::text,
         count(*),
         count(*) filter (where status = 'sent'),
         count(*) filter (where status = 'failed')
  from emails where created_at > now() - make_interval(hours => p_hours)
$$;

create view ops_health with (security_invoker = true) as
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
  (select count(*) from call_interactions where analysis_status = 'missing' and created_at > now() - interval '24 hours') as analysis_missing_24h;

revoke all on ops_health from anon, authenticated;
grant select on ops_health to authenticated, service_role;

revoke execute on function is_staff() from public, anon;
revoke execute on function claim_escalation(uuid, text) from public, anon;
revoke execute on function close_escalation(uuid, text, text) from public, anon;
revoke execute on function dashboard_metrics(timestamptz, timestamptz) from public, anon;
revoke execute on function calls_by_day(timestamptz, timestamptz) from public, anon;
revoke execute on function search_calls(text, timestamptz, timestamptz, text, text, text, boolean, boolean, int, int) from public, anon;
revoke execute on function escalation_delivery_gap(int) from public, anon;
grant execute on function is_staff() to authenticated, service_role;
grant execute on function claim_escalation(uuid, text) to authenticated, service_role;
grant execute on function close_escalation(uuid, text, text) to authenticated, service_role;
grant execute on function dashboard_metrics(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function calls_by_day(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function search_calls(text, timestamptz, timestamptz, text, text, text, boolean, boolean, int, int) to authenticated, service_role;
grant execute on function escalation_delivery_gap(int) to authenticated, service_role;

-- Realtime: events are signals to re-read, not rows (RLS applies per subscriber to INSERT and
-- UPDATE; DELETE carries only the primary key; generated columns and unchanged TOASTed values
-- never arrive). attempts stores no arguments, and its primary key is its replica identity.
alter publication supabase_realtime add table call_interactions, call_sessions, escalations, emails, transcript_lines, attempts;
