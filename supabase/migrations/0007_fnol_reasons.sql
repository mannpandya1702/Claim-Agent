-- 0007_fnol_reasons.sql — first notice of loss by voice (claim_intakes and the three functions that
-- write it), the claims a call files (claims.reported_call_key), the two new email kinds, and why
-- each call happened (call_interactions.call_reason, its source, and the claim number it filed).
--
-- Principle kept: the LLM carries words; the server owns truth. start_claim validates and normalises
-- what the model heard, stores it here unconfirmed, and reads it back; confirm_claim files it. Two
-- kinds:
--   claim        a verified customer: filing writes a claims row with a fresh claim number
--   lead_intake  a new caller whose details were confirmed (caller_contacts): no claims row; a
--                specialist calls back to set the claim up
-- One intake per call (the call key), replaced by a corrected read-back until it is filed; a filed
-- intake is never rewritten or un-filed. Additive only: every existing function keeps its signature,
-- so the webhook deployed before this migration keeps working against it.

-- ---------------------------------------------------------------------------------------------
-- Claims filed by phone carry the call that filed them, so a reset, the smoke cleanup and the DB
-- suite can remove every phone-filed claim (delete from claims where reported_call_key is not null)
-- and leave the seed data. At most one claim per call.
-- ---------------------------------------------------------------------------------------------
alter table claims add column reported_call_key text;
create unique index claims_reported_call_key_idx on claims (reported_call_key) where reported_call_key is not null;

create table claim_intakes (
  call_key text primary key,            -- the call_sessions key (message.call.id ?? chat session id)
  kind text not null check (kind in ('claim', 'lead_intake')),
  claim_type text not null check (claim_type in ('auto', 'home', 'property')),
  loss_date date not null,
  summary text not null check (char_length(summary) between 1 and 80),          -- short read-back phrase, sanitised
  description text not null check (char_length(description) between 1 and 500), -- the caller's words, redacted
  customer_id uuid references customers(id) on delete set null,  -- the verified customer of a claim
  claim_id uuid references claims(id) on delete set null,        -- the claims row filing wrote
  claim_number text check (claim_number is null or claim_number ~ '^CLM-[0-9]{6}$'),
  confirmed boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (confirmed = (confirmed_at is not null))
);
create index claim_intakes_created_idx on claim_intakes (created_at desc);

alter table claim_intakes enable row level security;
revoke all on claim_intakes from anon, authenticated;
grant select, insert, update, delete on claim_intakes to service_role;
create trigger claim_intakes_touch before update on claim_intakes for each row execute function touch_updated_at();

-- Dashboard visibility (staff read-only), like caller_contacts: the call detail's "Claim reported" card.
grant select on claim_intakes to authenticated;
create policy staff_select on claim_intakes for select to authenticated using ((select is_staff()));
alter publication supabase_realtime add table claim_intakes;

-- ---------------------------------------------------------------------------------------------
-- Emails: the customer's claim confirmation and the team's new-claim notice. The list is the 0001
-- list plus the two kinds, in enums.ts order (enums_test.ts reads it from here).
-- ---------------------------------------------------------------------------------------------
alter table emails drop constraint emails_kind_check;
alter table emails add constraint emails_kind_check check (kind in
  ('callback_request', 'emergency_alert', 'sla_realert', 'document_checklist', 'claim_summary', 'how_to_start_claim',
   'claim_received', 'claim_intake'));

-- ---------------------------------------------------------------------------------------------
-- start_claim's write: insert or replace the call's unconfirmed intake. A filed (confirmed) intake is
-- returned unchanged: a correction after filing can never rewrite a claim that exists.
-- ---------------------------------------------------------------------------------------------
create function upsert_claim_intake(
  p_call_key text, p_kind text, p_claim_type text, p_loss_date date, p_summary text, p_description text,
  p_customer_id uuid
) returns setof claim_intakes
language plpgsql security invoker set search_path = public as $$
begin
  return query
  insert into claim_intakes as ci (call_key, kind, claim_type, loss_date, summary, description, customer_id)
  values (p_call_key, p_kind, p_claim_type, p_loss_date, p_summary, p_description, p_customer_id)
  on conflict (call_key) do update set
    kind = excluded.kind,
    claim_type = excluded.claim_type,
    loss_date = excluded.loss_date,
    summary = excluded.summary,
    description = excluded.description,
    customer_id = excluded.customer_id
  where not ci.confirmed
  returning ci.*;
  if not found then
    return query select * from claim_intakes where call_key = p_call_key;
  end if;
end $$;

-- confirm_claim's "yes": files the intake in one transaction. The row lock makes a retried or
-- parallel delivery wait and then find it filed, so it is filed once. No row: no row. A claim
-- (verified customer) gets a claims row with a new claim number (CLM- and six digits, drawn until
-- unused); a lead intake gets none. Both are confirmed now.
create function file_claim_intake(p_call_key text) returns setof claim_intakes
language plpgsql security invoker set search_path = public as $$
declare
  v claim_intakes;
  v_claim uuid;
  v_number text;
  v_constraint text;
  v_today date := (now() at time zone 'America/New_York')::date;
begin
  select * into v from claim_intakes where call_key = p_call_key for update;
  if not found then
    return;
  end if;
  if v.confirmed then
    return next v;   -- already filed: the same row, nothing written
    return;
  end if;

  if v.kind = 'claim' then
    if v.customer_id is null then
      raise exception 'claim intake % has no customer', p_call_key using errcode = '23502';
    end if;
    for i in 1..20 loop
      v_number := 'CLM-' || lpad(floor(random() * 1000000)::int::text, 6, '0');
      continue when exists (select 1 from claims where claim_number = v_number);
      begin
        insert into claims (customer_id, claim_number, claim_type, status, status_detail, documents_required,
                            filed_on, updated_on, reported_call_key)
        values (v.customer_id, v_number, v.claim_type, 'received',
                'Reported by phone. An adjuster will be assigned within one business day.',
                case v.claim_type
                  when 'auto' then array['photos of the damage', 'the police report, if one was filed',
                                         'a repair estimate']
                  else array['photos of the damage', 'a contractor estimate',
                             'proof of ownership for the damaged items']
                end,
                v_today, v_today, p_call_key)
        returning id into v_claim;
        exit;
      exception when unique_violation then
        -- only a claim number drawn by a concurrent filing is retried; anything else is a real error
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'claims_claim_number_key' then
          raise;
        end if;
      end;
    end loop;
    if v_claim is null then
      raise exception 'no unused claim number after 20 draws' using errcode = '23505';
    end if;
  end if;

  update claim_intakes
     set claim_id = v_claim,
         claim_number = case when v_claim is null then null else v_number end,
         confirmed = true,
         confirmed_at = now()
   where call_key = p_call_key
  returning * into v;
  return next v;
end $$;

-- confirm_claim's "no": the intake stays unconfirmed for the corrected start_claim. A filed intake is
-- never un-filed; it is returned as it is, so the tool can say it is already filed. No row: no row.
create function reject_claim_intake(p_call_key text) returns setof claim_intakes
language plpgsql security invoker set search_path = public as $$
begin
  return query
  update claim_intakes set confirmed = false, confirmed_at = null
   where call_key = p_call_key and not confirmed
  returning *;
  if not found then
    return query select * from claim_intakes where call_key = p_call_key;
  end if;
end $$;

revoke execute on function upsert_claim_intake(text, text, text, date, text, text, uuid) from public, anon, authenticated;
revoke execute on function file_claim_intake(text) from public, anon, authenticated;
revoke execute on function reject_claim_intake(text) from public, anon, authenticated;
grant execute on function upsert_claim_intake(text, text, text, date, text, text, uuid) to service_role;
grant execute on function file_claim_intake(text) to service_role;
grant execute on function reject_claim_intake(text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Post-call record: why the call happened. call_reason is set from server facts (an emergency, a
-- filed intake), else the structured output, else derived from what the tools did, else left null
-- for the backfill; call_reason_source says which. claim_number is the claim this call filed (a
-- verified customer's intake only). The dashboard reads them through its table-level select on
-- call_interactions (0003), which covers columns added later, as it did for 0006's caller columns.
-- ---------------------------------------------------------------------------------------------
alter table call_interactions
  add column call_reason text check (call_reason in
    ('claim_status', 'file_claim', 'documents', 'general_question', 'speak_to_agent', 'update_details', 'emergency',
     'other')),
  add column call_reason_source text check (call_reason_source in ('server', 'structured_output', 'derived')),
  add column claim_number text;

-- Same signature and merge rules as 0006, plus the three columns: call_reason is replaced only by a
-- non-null reason whose source ranks at least as high as the stored one (server 3 > structured_output
-- 2 > derived 1 > none 0), and its source moves with it; claim_number keeps the stored value when the
-- new one is empty. Forward-only as before.
create or replace function upsert_interaction(p jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare
  r call_interactions%rowtype;
begin
  r := jsonb_populate_record(null::call_interactions, p);
  insert into call_interactions as ci (
    vapi_call_id, channel, customer_id, caller_name, caller_phone, summary, sentiment, sentiment_source, outcome,
    escalated, emergency, flags, started_at, ended_at, duration_seconds, ended_reason, transcript, recording_url,
    cost, success_evaluation, analysis_raw, messages, latency_avg_ms, cost_breakdown, assistant_name, analysis_status,
    caller_type, caller_email, call_reason, call_reason_source, claim_number)
  values (
    r.vapi_call_id, r.channel, r.customer_id, r.caller_name, r.caller_phone, r.summary, r.sentiment,
    r.sentiment_source, r.outcome, coalesce(r.escalated, false), coalesce(r.emergency, false),
    coalesce(r.flags, '{}'), r.started_at, r.ended_at, r.duration_seconds, r.ended_reason, r.transcript,
    r.recording_url, r.cost, r.success_evaluation, r.analysis_raw, r.messages, r.latency_avg_ms, r.cost_breakdown,
    r.assistant_name, coalesce(r.analysis_status, 'pending'), coalesce(r.caller_type, 'unknown'),
    nullif(r.caller_email, ''), r.call_reason, case when r.call_reason is null then null else r.call_reason_source end,
    nullif(r.claim_number, ''))
  on conflict (vapi_call_id) do update set
    channel = coalesce(nullif(excluded.channel, ''), ci.channel),
    customer_id = coalesce(excluded.customer_id, ci.customer_id),
    caller_name = coalesce(nullif(excluded.caller_name, ''), ci.caller_name),
    caller_phone = coalesce(nullif(excluded.caller_phone, ''), ci.caller_phone),
    summary = coalesce(nullif(excluded.summary, ''), ci.summary),
    sentiment = coalesce(excluded.sentiment, ci.sentiment),
    sentiment_source = coalesce(excluded.sentiment_source, ci.sentiment_source),
    outcome = case when excluded.outcome is null or excluded.outcome = 'in_progress' then coalesce(ci.outcome, excluded.outcome)
                   else excluded.outcome end,
    escalated = ci.escalated or excluded.escalated,
    emergency = ci.emergency or excluded.emergency,
    flags = case when cardinality(excluded.flags) > 0 then excluded.flags else ci.flags end,
    started_at = coalesce(excluded.started_at, ci.started_at),
    ended_at = coalesce(excluded.ended_at, ci.ended_at),
    duration_seconds = coalesce(excluded.duration_seconds, ci.duration_seconds),
    ended_reason = coalesce(nullif(excluded.ended_reason, ''), ci.ended_reason),
    transcript = coalesce(nullif(excluded.transcript, ''), ci.transcript),
    recording_url = coalesce(nullif(excluded.recording_url, ''), ci.recording_url),
    cost = coalesce(excluded.cost, ci.cost),
    success_evaluation = coalesce(nullif(excluded.success_evaluation, ''), ci.success_evaluation),
    analysis_raw = coalesce(excluded.analysis_raw, ci.analysis_raw),
    messages = coalesce(excluded.messages, ci.messages),
    latency_avg_ms = coalesce(excluded.latency_avg_ms, ci.latency_avg_ms),
    cost_breakdown = coalesce(excluded.cost_breakdown, ci.cost_breakdown),
    assistant_name = coalesce(nullif(excluded.assistant_name, ''), ci.assistant_name),
    analysis_status = case when excluded.analysis_status = 'pending' then ci.analysis_status
                           else excluded.analysis_status end,
    caller_type = case when excluded.caller_type = 'unknown' then ci.caller_type else excluded.caller_type end,
    caller_email = coalesce(excluded.caller_email, ci.caller_email),
    call_reason = case
      when excluded.call_reason is not null
       and (case excluded.call_reason_source when 'server' then 3 when 'structured_output' then 2 when 'derived' then 1
            else 0 end)
        >= (case ci.call_reason_source when 'server' then 3 when 'structured_output' then 2 when 'derived' then 1
            else 0 end)
      then excluded.call_reason else ci.call_reason end,
    call_reason_source = case
      when excluded.call_reason is not null
       and (case excluded.call_reason_source when 'server' then 3 when 'structured_output' then 2 when 'derived' then 1
            else 0 end)
        >= (case ci.call_reason_source when 'server' then 3 when 'structured_output' then 2 when 'derived' then 1
            else 0 end)
      then excluded.call_reason_source else ci.call_reason_source end,
    claim_number = coalesce(excluded.claim_number, ci.claim_number)
  where ci.ended_at is null or excluded.ended_at is not null;
end $$;

revoke execute on function upsert_interaction(jsonb) from public, anon, authenticated;
grant execute on function upsert_interaction(jsonb) to service_role;

-- The Calls list gains call_reason. A function's result columns cannot change in place, so it is
-- dropped and created again with 0006's columns plus the new one; the parameters are unchanged.
drop function search_calls(text, timestamptz, timestamptz, text, text, text, boolean, boolean, int, int);
create function search_calls(
  p_q text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_outcome text default null, p_sentiment text default null, p_channel text default null,
  p_flagged boolean default null, p_escalated boolean default null,
  p_limit int default 25, p_offset int default 0
) returns table (
  id uuid, vapi_call_id text, channel text, caller_name text, caller_phone_masked text, caller_type text,
  caller_email_masked text, outcome text, call_reason text, sentiment text, escalated boolean, emergency boolean,
  emailed boolean, flags text[], started_at timestamptz, ended_at timestamptz, duration_seconds int, cost numeric,
  latency_avg_ms int, summary text, assistant_name text, created_at timestamptz, total bigint
)
language sql stable security invoker set search_path = public as $$
  select ci.id, ci.vapi_call_id, ci.channel, ci.caller_name, ci.caller_phone_masked, ci.caller_type,
         ci.caller_email_masked, ci.outcome, ci.call_reason, ci.sentiment, ci.escalated, ci.emergency,
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

revoke execute on function search_calls(text, timestamptz, timestamptz, text, text, text, boolean, boolean, int, int) from public, anon;
grant execute on function search_calls(text, timestamptz, timestamptz, text, text, text, boolean, boolean, int, int) to authenticated, service_role;

-- The Overview's "Top call reasons": calls per reason in [p_from, p_to), most first. A call with no
-- reason yet is left out rather than counted under a reason it does not have. Security invoker like
-- every dashboard read: RLS applies, so a non-staff session counts nothing.
create function call_reason_counts(p_from timestamptz, p_to timestamptz)
returns table (call_reason text, calls bigint)
language sql stable security invoker set search_path = public as $$
  select ci.call_reason, count(*) as calls
  from call_interactions ci
  where coalesce(ci.started_at, ci.created_at) >= p_from and coalesce(ci.started_at, ci.created_at) < p_to
    and ci.call_reason is not null
  group by ci.call_reason
  order by 2 desc, 1
$$;

revoke execute on function call_reason_counts(timestamptz, timestamptz) from public, anon;
grant execute on function call_reason_counts(timestamptz, timestamptz) to authenticated, service_role;
