-- 0006_contacts.sql — the name, email and callback number a caller gives on a call, and the two
-- post-call columns that branch on them (caller_type, caller_email).
--
-- Principle kept: the LLM carries words; the server owns truth. capture_contact validates and
-- normalises what the model heard, stores it here unconfirmed, and reads it back; confirm_contact
-- marks it confirmed. Two kinds:
--   new_customer  a caller with no account (two lookup misses, or they said so) gave their details
--   email_update  a verified customer with no email on file spelled one for staff to add; it is
--                 never written to customers and never used to send anything (account-takeover guard)
-- One row per call (the call key), replaced by a new capture. Every address here is caller-provided
-- by voice and unverified.

create table caller_contacts (
  call_key text primary key,            -- the call_sessions key (message.call.id ?? chat session id)
  kind text not null check (kind in ('new_customer', 'email_update')),
  first_name text not null check (char_length(first_name) between 1 and 40),
  last_name text not null check (char_length(last_name) between 1 and 40),
  email text check (email is null or (char_length(email) <= 100 and email ~ '^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,24}$')),
  callback_phone text check (callback_phone is null or callback_phone ~ '^\+1[0-9]{10}$'),
  callback_source text not null default 'none' check (callback_source in ('argument', 'caller_id', 'none')),
  customer_id uuid references customers(id) on delete set null, -- the verified customer of an email_update
  confirmed boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (confirmed = (confirmed_at is not null))
);
create index caller_contacts_created_idx on caller_contacts (created_at desc);

alter table caller_contacts enable row level security;
revoke all on caller_contacts from anon, authenticated;
grant select, insert, update, delete on caller_contacts to service_role;
create trigger caller_contacts_touch before update on caller_contacts for each row execute function touch_updated_at();

-- Dashboard visibility (staff read-only), like every other call table.
grant select on caller_contacts to authenticated;
create policy staff_select on caller_contacts for select to authenticated using ((select is_staff()));
alter publication supabase_realtime add table caller_contacts;

-- ---------------------------------------------------------------------------------------------
-- capture_contact's write: insert or replace the call's row, unconfirmed. A capture that reads
-- back exactly what is stored (same kind, names and email) keeps the confirmation, so a retried
-- delivery, or the model capturing the same details again, never undoes the caller's "yes".
-- ---------------------------------------------------------------------------------------------
create function upsert_caller_contact(
  p_call_key text, p_kind text, p_first_name text, p_last_name text, p_email text,
  p_callback_phone text, p_callback_source text, p_customer_id uuid
) returns setof caller_contacts
language sql security invoker set search_path = public as $$
  insert into caller_contacts as cc
    (call_key, kind, first_name, last_name, email, callback_phone, callback_source, customer_id)
  values (p_call_key, p_kind, p_first_name, p_last_name, p_email, p_callback_phone,
          coalesce(p_callback_source, 'none'), p_customer_id)
  on conflict (call_key) do update set
    kind = excluded.kind,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    email = excluded.email,
    callback_phone = excluded.callback_phone,
    callback_source = excluded.callback_source,
    customer_id = excluded.customer_id,
    confirmed = cc.confirmed and (cc.kind, cc.first_name, cc.last_name, cc.email)
      is not distinct from (excluded.kind, excluded.first_name, excluded.last_name, excluded.email),
    confirmed_at = case when (cc.kind, cc.first_name, cc.last_name, cc.email)
      is not distinct from (excluded.kind, excluded.first_name, excluded.last_name, excluded.email)
      then cc.confirmed_at else null end
  returning cc.*
$$;

-- confirm_contact's write: true keeps the first confirmation time, false clears it. No row for the
-- call returns no row (the tool answers not_pending).
create function set_caller_contact_confirmed(p_call_key text, p_confirmed boolean) returns setof caller_contacts
language sql security invoker set search_path = public as $$
  update caller_contacts
     set confirmed = coalesce(p_confirmed, false),
         confirmed_at = case when coalesce(p_confirmed, false) then coalesce(confirmed_at, now()) else null end
   where call_key = p_call_key
  returning *
$$;

revoke execute on function upsert_caller_contact(text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function set_caller_contact_confirmed(text, boolean) from public, anon, authenticated;
grant execute on function upsert_caller_contact(text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function set_caller_contact_confirmed(text, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Post-call record: who called. caller_type is existing (the session matched an account), new (a
-- new_customer contact was captured) or unknown; caller_email is the confirmed captured address
-- only, never the customer's on-file email. List views read the masked copy (j***@gmail.com, the
-- same mask as email.ts maskEmail); only the call detail page selects caller_email.
-- ---------------------------------------------------------------------------------------------
alter table call_interactions
  add column caller_type text not null default 'unknown' check (caller_type in ('existing', 'new', 'unknown')),
  add column caller_email text;
alter table call_interactions
  add column caller_email_masked text generated always as (case
    when nullif(caller_email, '') is null then null
    when position('@' in caller_email) = 0 then '***'
    else left(caller_email, least(1, position('@' in caller_email) - 1)) || '***'
         || substr(caller_email, position('@' in caller_email)) end) stored;

-- Calls recorded before this migration: a session that reached an account was an existing customer.
update call_interactions ci set caller_type = 'existing'
  from call_sessions s
 where s.call_key = ci.vapi_call_id and s.level <> 'none' and ci.caller_type = 'unknown';

-- Same signature and merge rules as 0001, plus the two columns: caller_type replaces 'unknown' and is
-- never downgraded to it (a stub or a partial report carries none); caller_email keeps the stored
-- value when the new one is empty. Forward-only as before.
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
    caller_type, caller_email)
  values (
    r.vapi_call_id, r.channel, r.customer_id, r.caller_name, r.caller_phone, r.summary, r.sentiment,
    r.sentiment_source, r.outcome, coalesce(r.escalated, false), coalesce(r.emergency, false),
    coalesce(r.flags, '{}'), r.started_at, r.ended_at, r.duration_seconds, r.ended_reason, r.transcript,
    r.recording_url, r.cost, r.success_evaluation, r.analysis_raw, r.messages, r.latency_avg_ms, r.cost_breakdown,
    r.assistant_name, coalesce(r.analysis_status, 'pending'), coalesce(r.caller_type, 'unknown'),
    nullif(r.caller_email, ''))
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
    caller_email = coalesce(excluded.caller_email, ci.caller_email)
  where ci.ended_at is null or excluded.ended_at is not null;
end $$;

revoke execute on function upsert_interaction(jsonb) from public, anon, authenticated;
grant execute on function upsert_interaction(jsonb) to service_role;

-- The Calls list gains caller_type and the masked email. A function's result columns cannot change
-- in place, so it is dropped and created again with 0003's columns plus the two new ones.
drop function search_calls(text, timestamptz, timestamptz, text, text, text, boolean, boolean, int, int);
create function search_calls(
  p_q text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_outcome text default null, p_sentiment text default null, p_channel text default null,
  p_flagged boolean default null, p_escalated boolean default null,
  p_limit int default 25, p_offset int default 0
) returns table (
  id uuid, vapi_call_id text, channel text, caller_name text, caller_phone_masked text, caller_type text,
  caller_email_masked text, outcome text, sentiment text, escalated boolean, emergency boolean, emailed boolean,
  flags text[], started_at timestamptz, ended_at timestamptz, duration_seconds int, cost numeric, latency_avg_ms int,
  summary text, assistant_name text, created_at timestamptz, total bigint
)
language sql stable security invoker set search_path = public as $$
  select ci.id, ci.vapi_call_id, ci.channel, ci.caller_name, ci.caller_phone_masked, ci.caller_type,
         ci.caller_email_masked, ci.outcome, ci.sentiment, ci.escalated, ci.emergency,
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
