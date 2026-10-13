-- 0010_lookup_retries.sql — the lookup cap counts different numbers, not misses.
--
-- On a real call the caller's first number missed, the second was misheard and missed, and the right
-- third number was refused ("I can't look up another number on this call"), because two misses per
-- call were final. Now:
--   * a number that already missed on this call is not_found_final: the caller said yes to "Is that
--     the right number?", so the same answer is final for that number. It is recorded as 'other' and
--     not counted again, and it is not sticky: a different number may still be tried;
--   * up to three different numbers may miss. The third different miss is not_found_final, and so is
--     every lookup after it (sticky, as before);
--   * misses (returned) is the count of different numbers that missed.
-- A number is known again by its hex SHA-256 (of the E.164) in lookup_numbers, one row per number
-- that missed on the call; the number itself is never stored. The hash lives in its own table, not
-- on attempts: staff can read attempts and it is in the Realtime publication (0003), and a SHA-256 of
-- a ten-digit number is reversible by brute force in seconds, which would undo the masking of every
-- spoken number. lookup_numbers is service_role only and never published. Miss rows written before
-- this migration have no lookup_numbers row: each one still counts as a different number.

create table lookup_numbers (
  call_key text not null,
  number_hash text not null check (number_hash ~ '^[0-9a-f]{64}$'),
  tool_call_id text not null,           -- the attempts row of the miss
  created_at timestamptz not null default now(),
  primary key (call_key, number_hash)
);
alter table lookup_numbers enable row level security;
revoke all on lookup_numbers from anon, authenticated;
grant select, insert, delete on lookup_numbers to service_role;

-- Same signature, return type, row lock and replay guard as 0001; only the counting changed.
create or replace function lookup_customer_attempt(
  p_call_key text, p_channel text, p_phone_e164 text, p_tool_call_id text, p_caller_number text default null
) returns table (code text, misses int)
language plpgsql security invoker set search_path = public as $$
#variable_conflict use_column
declare
  v_level text;
  v_prior text;
  v_misses int;
  v_hash text;
  v_customer uuid;
  v_code text;
  v_kind text;
begin
  insert into call_sessions (call_key, channel, caller_number)
  values (p_call_key, coalesce(p_channel, 'unknown'), p_caller_number)
  on conflict (call_key) do nothing;

  select s.level into v_level from call_sessions s where s.call_key = p_call_key for update;

  -- different numbers that missed on this call; a miss row with no lookup_numbers row (before 0010)
  -- is one of its own
  select ((select count(*) from lookup_numbers n where n.call_key = p_call_key)
        + (select count(*) from attempts a
           where a.call_key = p_call_key and a.kind = 'lookup_miss'
             and not exists (select 1 from lookup_numbers n
                             where n.call_key = a.call_key and n.tool_call_id = a.tool_call_id)))::int
    into v_misses;

  -- replay guard: the same toolCallId always gets the same answer
  select a.code into v_prior from attempts a where a.call_key = p_call_key and a.tool_call_id = p_tool_call_id;
  if found then
    return query select v_prior, v_misses;
    return;
  end if;

  if p_phone_e164 is not null then
    v_hash := encode(sha256(convert_to(p_phone_e164, 'UTF8')), 'hex');
  end if;

  if v_level = 'verified' then
    v_code := 'already_verified'; v_kind := 'other';
  elsif v_level = 'locked' then
    v_code := 'locked'; v_kind := 'other';
  elsif p_phone_e164 is null then
    v_code := 'invalid_phone'; v_kind := 'unreadable';
  elsif exists (select 1 from lookup_numbers n where n.call_key = p_call_key and n.number_hash = v_hash) then
    v_code := 'not_found_final'; v_kind := 'other';   -- this number already missed: final for it only
  elsif v_misses >= 3 then
    v_code := 'not_found_final'; v_kind := 'other';   -- three different numbers missed: sticky
  else
    select c.id into v_customer from customers c where c.phone_e164 = p_phone_e164;
    if v_customer is not null then
      v_code := 'needs_dob'; v_kind := 'lookup_hit';
      update call_sessions set level = 'phone_found', candidate_customer_id = v_customer
      where call_key = p_call_key;
    else
      v_kind := 'lookup_miss';
      v_misses := v_misses + 1;
      v_code := case when v_misses >= 3 then 'not_found_final' else 'not_found' end;
    end if;
  end if;

  insert into attempts (call_key, tool_call_id, tool_name, kind, code)
  values (p_call_key, p_tool_call_id, 'lookup_customer', v_kind, v_code);
  if v_kind = 'lookup_miss' then
    insert into lookup_numbers (call_key, number_hash, tool_call_id) values (p_call_key, v_hash, p_tool_call_id)
    on conflict (call_key, number_hash) do nothing;
  end if;

  return query select v_code, v_misses;
end $$;

-- create or replace keeps the grants; restated so this file says who may call it.
revoke execute on function lookup_customer_attempt(text, text, text, text, text) from public, anon, authenticated;
grant execute on function lookup_customer_attempt(text, text, text, text, text) to service_role;
