-- 0001_init.sql — every table in its final shape, CHECKs, indexes, RLS, explicit grants,
-- and the server-side identity state machine.
--
-- Principle: the LLM carries words; the server owns truth. Identity level, attempt counts, what
-- may be disclosed and the post-call outcome live here, keyed on the VAPI envelope (call id),
-- never on model arguments or model memory.
--
-- Value lists are text + CHECK (never Postgres enums); supabase/functions/vapi-webhook/enums.ts
-- is the single source and a parity test compares the two.

-- ---------------------------------------------------------------------------------------------
-- Privileges. This project grants anon/authenticated full rights on new public objects by
-- default (pg_default_acl, checked 2026-10-12). Remove that before creating anything, so every
-- browser-reachable privilege below is an explicit, reviewed grant.
-- ---------------------------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;

-- ---------------------------------------------------------------------------------------------
-- Integration #1: the external customer and claims system (read by the tools).
-- ---------------------------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+1[0-9]{10}$'),
  first_name text not null,
  last_name text not null,
  date_of_birth date not null,          -- plain on fictional data; production: HMAC with a server pepper
  policy_number text not null unique,
  email text,                           -- address on file for info emails; never collected by voice
  created_at timestamptz not null default now()
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  claim_number text not null unique,    -- CLM-240115, spoken as "ending in one one five"
  claim_type text not null check (claim_type in ('auto', 'home', 'property')),
  status text not null check (status in
    ('received', 'under_review', 'awaiting_documents', 'approved', 'payment_issued', 'denied', 'closed')),
  status_detail text,
  documents_required text[] not null default '{}',
  documents_due date,
  adjuster_name text,
  filed_on date not null,
  updated_on date not null,
  amount_approved numeric(10, 2)
);
create index claims_customer_id_idx on claims (customer_id);

-- ---------------------------------------------------------------------------------------------
-- Server-owned per-call state.
-- ---------------------------------------------------------------------------------------------
create table call_sessions (
  call_key text primary key,            -- message.call.id ?? message.chat.sessionId ?? message.chat.id
  channel text not null,                -- webCall | inboundPhoneCall | outboundPhoneCall | chat | unknown
  caller_number text,                   -- message.call.customer.number when it is a real number; a hint only
  level text not null default 'none' check (level in ('none', 'phone_found', 'verified', 'locked')),
  candidate_customer_id uuid references customers(id),
  verified_customer_id uuid references customers(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per tool call: the counters, the replay guard and the per-call tool timeline.
-- Arguments are never stored (no DOB or phone number in the trace).
create table attempts (
  call_key text not null,
  tool_call_id text not null,
  tool_name text not null,
  kind text check (kind in ('lookup_hit', 'lookup_miss', 'dob_ok', 'dob_wrong', 'unreadable', 'other')),
  code text,
  created_at timestamptz not null default now(),
  primary key (call_key, tool_call_id)
);
create index attempts_created_at_idx on attempts (created_at);

create table escalations (
  id uuid primary key default gen_random_uuid(),
  call_key text not null,
  kind text not null check (kind in ('representative', 'emergency')),
  reason text not null check (reason in
    ('representative_requested', 'emergency', 'auth_locked', 'not_found', 'unsupported_question', 'transfer_failed')),
  details text,                         -- redacted on insert (model-written free text)
  callback_phone text,
  channel text not null,
  verified boolean not null default false,
  callback_source text check (callback_source in ('argument', 'account', 'caller_id', 'none')),
  alert_status text not null default 'pending' check (alert_status in ('pending', 'sent', 'failed', 'skipped')),
  delivery_error text,                  -- last channel error, shown on the dashboard
  status text not null default 'open' check (status in ('open', 'claimed', 'done')),
  claimed_by text,
  claimed_at timestamptz,
  closed_by text,
  closed_at timestamptz,
  close_note text,
  realerted_at timestamptz,             -- set by the sla job
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_key, kind)               -- one representative row and one emergency row per call
);
create index escalations_status_idx on escalations (status, created_at);

-- Ledger of outbound Resend emails, one per (call, kind); the Idempotency-Key is call_key:kind.
create table emails (
  id uuid primary key default gen_random_uuid(),
  call_key text not null,
  kind text not null check (kind in
    ('callback_request', 'emergency_alert', 'sla_realert', 'document_checklist', 'claim_summary', 'how_to_start_claim')),
  to_masked text not null,              -- m***@example.com; the full address is never stored here
  resend_id text,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (call_key, kind)
);

-- ---------------------------------------------------------------------------------------------
-- Integration #2: the post-call interaction record.
-- ---------------------------------------------------------------------------------------------
create table call_interactions (
  id uuid primary key default gen_random_uuid(),
  vapi_call_id text not null unique,
  channel text,
  customer_id uuid references customers(id),
  caller_name text,
  caller_phone text,
  summary text,
  sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
  sentiment_source text check (sentiment_source in ('vapi', 'structured_output', 'backfill')),
  outcome text check (outcome in
    ('resolved', 'auth_failed', 'not_found', 'escalated', 'emergency', 'unsupported', 'abandoned', 'in_progress')),
  escalated boolean not null default false,
  emergency boolean not null default false,
  flags text[] not null default '{}',   -- evidence-first flags (flags.ts)
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  ended_reason text,
  transcript text,
  recording_url text,                   -- private stable identifier, never played directly
  cost numeric(10, 4),
  success_evaluation text,
  analysis_raw jsonb,
  messages jsonb,
  latency_avg_ms int,
  cost_breakdown jsonb,
  staff_notes text,
  assistant_name text,
  search_tsv tsvector generated always as
    (to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(transcript, ''))) stored,
  analysis_status text not null default 'pending' check (analysis_status in ('pending', 'ok', 'backfilled', 'missing')),
  status text generated always as (case
    when ended_at is null then 'in_progress'
    when caller_name is not null and summary is not null and sentiment is not null and started_at is not null
      then 'completed'
    else 'incomplete' end) stored,      -- for SQL only: Realtime never carries generated columns
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index call_interactions_search_idx on call_interactions using gin (search_tsv);
create index call_interactions_started_idx on call_interactions (started_at desc);
create index call_interactions_created_idx on call_interactions (created_at desc);

-- Live final transcript fragments for the dashboard; redacted on insert.
create table transcript_lines (
  id bigint generated always as identity primary key,
  call_key text not null,
  role text not null check (role in ('user', 'assistant')),
  text text not null,
  ts_ms bigint not null,
  created_at timestamptz not null default now(),
  unique (call_key, role, ts_ms)        -- a retried delivery is a no-op
);
create index transcript_lines_call_idx on transcript_lines (call_key, ts_ms);
create index transcript_lines_created_idx on transcript_lines (created_at);

-- Dashboard allowlist; rows written only by scripts/create_staff.ts (service role).
create table staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text unique not null
);

-- Idempotency for scheduled jobs (one digest per day, one reaper pass per hour).
create table job_runs (
  job text not null,
  period_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result jsonb,
  primary key (job, period_key)
);

-- Raw webhook bodies, captured only while CAPTURE_WEBHOOKS=true (fixtures for replay tests).
-- Fictional data only; the reaper deletes rows older than 7 days.
create table webhook_captures (
  id bigint generated always as identity primary key,
  message_type text,
  call_key text,
  body jsonb not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- RLS on everything. No policies here: a table without a policy is default-deny for anon and
-- authenticated, and service_role bypasses RLS. Dashboard select policies arrive in 0003.
-- ---------------------------------------------------------------------------------------------
alter table customers enable row level security;
alter table claims enable row level security;
alter table call_sessions enable row level security;
alter table attempts enable row level security;
alter table escalations enable row level security;
alter table emails enable row level security;
alter table call_interactions enable row level security;
alter table transcript_lines enable row level security;
alter table staff enable row level security;
alter table job_runs enable row level security;
alter table webhook_captures enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- updated_at maintenance
create function touch_updated_at() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger call_sessions_touch before update on call_sessions for each row execute function touch_updated_at();
create trigger escalations_touch before update on escalations for each row execute function touch_updated_at();
create trigger call_interactions_touch before update on call_interactions for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Identity state machine.
--
--   none --lookup hit--> phone_found --DOB match--> verified --> claim tools allowed
--     |                       | DOB miss #1 --> phone_found
--     |                       | DOB miss #2 --> locked (sticky; a later correct DOB still returns locked)
--     +--lookup miss--> none (miss 1: not_found; miss 2+: not_found_final, sticky)
--   bad phone, unreadable DOB and DB errors are never counted against the caller;
--   3 unreadable DOB reads -> dob_give_up (same exit as locked, without the lock).
--
-- Each counted tool claims its toolCallId first under the call_sessions row lock, then derives
-- the code from ledger counts. A VAPI retry or a parallel delivery of the same toolCallId waits
-- on the lock, finds its id already claimed and returns the stored code: counters cannot be
-- burned twice, which a prompt-only cap cannot guarantee.
-- ---------------------------------------------------------------------------------------------
create function lookup_customer_attempt(
  p_call_key text, p_channel text, p_phone_e164 text, p_tool_call_id text, p_caller_number text default null
) returns table (code text, misses int)
language plpgsql security invoker set search_path = public as $$
#variable_conflict use_column
declare
  v_level text;
  v_prior text;
  v_misses int;
  v_customer uuid;
  v_code text;
  v_kind text;
begin
  insert into call_sessions (call_key, channel, caller_number)
  values (p_call_key, coalesce(p_channel, 'unknown'), p_caller_number)
  on conflict (call_key) do nothing;

  select s.level into v_level from call_sessions s where s.call_key = p_call_key for update;

  -- replay guard: the same toolCallId always gets the same answer
  select a.code into v_prior from attempts a where a.call_key = p_call_key and a.tool_call_id = p_tool_call_id;
  if found then
    select count(*)::int into v_misses from attempts a where a.call_key = p_call_key and a.kind = 'lookup_miss';
    return query select v_prior, v_misses;
    return;
  end if;

  select count(*)::int into v_misses from attempts a where a.call_key = p_call_key and a.kind = 'lookup_miss';

  if v_level = 'verified' then
    v_code := 'already_verified'; v_kind := 'other';
  elsif v_level = 'locked' then
    v_code := 'locked'; v_kind := 'other';
  elsif p_phone_e164 is null then
    v_code := 'invalid_phone'; v_kind := 'unreadable';
  elsif v_misses >= 2 then
    v_code := 'not_found_final'; v_kind := 'other';   -- sticky: no further lookups this call
  else
    select c.id into v_customer from customers c where c.phone_e164 = p_phone_e164;
    if v_customer is not null then
      v_code := 'needs_dob'; v_kind := 'lookup_hit';
      update call_sessions set level = 'phone_found', candidate_customer_id = v_customer
      where call_key = p_call_key;
    else
      v_kind := 'lookup_miss';
      v_misses := v_misses + 1;
      v_code := case when v_misses >= 2 then 'not_found_final' else 'not_found' end;
    end if;
  end if;

  insert into attempts (call_key, tool_call_id, tool_name, kind, code)
  values (p_call_key, p_tool_call_id, 'lookup_customer', v_kind, v_code);

  return query select v_code, v_misses;
end $$;

create function verify_dob_attempt(
  p_call_key text, p_y int, p_m int, p_d int, p_tool_call_id text
) returns table (code text, first_name text, attempts int, customer_id uuid)
language plpgsql security invoker set search_path = public as $$
#variable_conflict use_column
declare
  v_level text;
  v_candidate uuid;
  v_verified uuid;
  v_prior text;
  v_dob date;
  v_given date;
  v_wrong int;
  v_unreadable int;
  v_code text;
  v_kind text;
  v_first text;
begin
  insert into call_sessions (call_key, channel) values (p_call_key, 'unknown')
  on conflict (call_key) do nothing;

  select s.level, s.candidate_customer_id, s.verified_customer_id
    into v_level, v_candidate, v_verified
  from call_sessions s where s.call_key = p_call_key for update;

  select count(*)::int into v_wrong from attempts a where a.call_key = p_call_key and a.kind = 'dob_wrong';

  select a.code into v_prior from attempts a where a.call_key = p_call_key and a.tool_call_id = p_tool_call_id;
  if found then
    if v_prior = 'verified' then
      select c.first_name into v_first from customers c where c.id = v_verified;
      return query select v_prior, v_first, v_wrong, v_verified;
    else
      return query select v_prior, null::text, v_wrong, null::uuid;
    end if;
    return;
  end if;

  if v_level = 'verified' then
    v_code := 'verified'; v_kind := 'other';
  elsif v_level = 'locked' then
    v_code := 'locked'; v_kind := 'other';
  elsif v_level = 'none' then
    v_code := 'no_lookup_yet'; v_kind := 'other';
  else
    begin
      if p_y is null or p_m is null or p_d is null or p_y < 1900 or p_y > extract(year from now())::int then
        raise exception using errcode = '22008';
      end if;
      v_given := make_date(p_y, p_m, p_d);
    exception when others then
      v_given := null;
    end;

    if v_given is null then
      select count(*)::int + 1 into v_unreadable from attempts a
      where a.call_key = p_call_key and a.kind = 'unreadable' and a.tool_name = 'verify_identity';
      v_kind := 'unreadable';
      v_code := case when v_unreadable >= 3 then 'dob_give_up' else 'dob_unreadable' end;
    else
      select c.date_of_birth, c.first_name into v_dob, v_first from customers c where c.id = v_candidate;
      if v_dob = v_given then
        v_code := 'verified'; v_kind := 'dob_ok';
        update call_sessions set level = 'verified', verified_customer_id = v_candidate
        where call_key = p_call_key;
        v_verified := v_candidate;
      else
        v_first := null;
        v_kind := 'dob_wrong';
        v_wrong := v_wrong + 1;
        if v_wrong >= 2 then
          v_code := 'locked';
          update call_sessions set level = 'locked' where call_key = p_call_key;
        else
          v_code := 'auth_failed';
        end if;
      end if;
    end if;
  end if;

  insert into attempts (call_key, tool_call_id, tool_name, kind, code)
  values (p_call_key, p_tool_call_id, 'verify_identity', v_kind, v_code);

  if v_code = 'verified' then
    if v_first is null then
      select c.first_name into v_first from customers c where c.id = v_verified;
    end if;
    return query select v_code, v_first, v_wrong, v_verified;
  else
    return query select v_code, null::text, v_wrong, null::uuid;
  end if;
end $$;

-- Escalation upsert: the row exists before any transport is tried, one per (call, kind); a repeat
-- only merges a newly supplied callback number and never resets delivery state.
create function upsert_escalation(
  p_call_key text, p_kind text, p_reason text, p_details text, p_callback_phone text,
  p_callback_source text, p_channel text, p_verified boolean
) returns table (id uuid, inserted boolean, callback_phone text, callback_source text, alert_status text, verified boolean)
language plpgsql security invoker set search_path = public as $$
#variable_conflict use_column
begin
  return query
  insert into escalations as e (call_key, kind, reason, details, callback_phone, callback_source, channel, verified)
  values (p_call_key, p_kind, p_reason, p_details, p_callback_phone, coalesce(p_callback_source, 'none'), p_channel,
          coalesce(p_verified, false))
  on conflict (call_key, kind) do update set
    callback_phone = coalesce(excluded.callback_phone, e.callback_phone),
    callback_source = case when excluded.callback_phone is not null then excluded.callback_source
                           else e.callback_source end,
    details = coalesce(excluded.details, e.details),
    verified = e.verified or excluded.verified
  returning e.id, (e.xmax = 0), e.callback_phone, e.callback_source, e.alert_status, e.verified;
end $$;

-- Post-call record merge. Partial reports arrive before full ones and duplicates happen, so each
-- column merges by type: text keeps the existing value when the new one is empty; timestamps and
-- numbers keep the existing value when the new one is null; booleans OR; flags replace only when
-- non-empty. Forward-only: a stub (no ended_at) can never overwrite a completed row.
create function upsert_interaction(p jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare
  r call_interactions%rowtype;
begin
  r := jsonb_populate_record(null::call_interactions, p);
  insert into call_interactions as ci (
    vapi_call_id, channel, customer_id, caller_name, caller_phone, summary, sentiment, sentiment_source, outcome,
    escalated, emergency, flags, started_at, ended_at, duration_seconds, ended_reason, transcript, recording_url,
    cost, success_evaluation, analysis_raw, messages, latency_avg_ms, cost_breakdown, assistant_name, analysis_status)
  values (
    r.vapi_call_id, r.channel, r.customer_id, r.caller_name, r.caller_phone, r.summary, r.sentiment,
    r.sentiment_source, r.outcome, coalesce(r.escalated, false), coalesce(r.emergency, false),
    coalesce(r.flags, '{}'), r.started_at, r.ended_at, r.duration_seconds, r.ended_reason, r.transcript,
    r.recording_url, r.cost, r.success_evaluation, r.analysis_raw, r.messages, r.latency_avg_ms, r.cost_breakdown,
    r.assistant_name, coalesce(r.analysis_status, 'pending'))
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
                           else excluded.analysis_status end
  where ci.ended_at is null or excluded.ended_at is not null;
end $$;

revoke execute on function touch_updated_at() from public, anon, authenticated;
revoke execute on function lookup_customer_attempt(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function verify_dob_attempt(text, int, int, int, text) from public, anon, authenticated;
revoke execute on function upsert_escalation(text, text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function upsert_interaction(jsonb) from public, anon, authenticated;
grant execute on function lookup_customer_attempt(text, text, text, text, text) to service_role;
grant execute on function verify_dob_attempt(text, int, int, int, text) to service_role;
grant execute on function upsert_escalation(text, text, text, text, text, text, text, boolean) to service_role;
grant execute on function upsert_interaction(jsonb) to service_role;
