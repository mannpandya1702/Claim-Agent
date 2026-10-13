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
-- The ledger knows a number again by attempts.number_hash, the hex SHA-256 of the E.164, written on
-- lookup_miss rows only; the number itself is still never stored. Staff can read the column like the
-- rest of attempts (0003), and they already see full caller numbers on the call page. Rows written
-- before this migration have no hash: each one still counts as a different number.

alter table attempts add column number_hash text;

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

  -- different numbers that missed on this call; a row without a hash (before 0010) is one of its own
  select (count(distinct a.number_hash) + count(*) filter (where a.number_hash is null))::int into v_misses
  from attempts a where a.call_key = p_call_key and a.kind = 'lookup_miss';

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
  elsif exists (select 1 from attempts a
                where a.call_key = p_call_key and a.kind = 'lookup_miss' and a.number_hash = v_hash) then
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

  insert into attempts (call_key, tool_call_id, tool_name, kind, code, number_hash)
  values (p_call_key, p_tool_call_id, 'lookup_customer', v_kind, v_code,
          case when v_kind = 'lookup_miss' then v_hash end);

  return query select v_code, v_misses;
end $$;

-- create or replace keeps the grants; restated so this file says who may call it.
revoke execute on function lookup_customer_attempt(text, text, text, text, text) from public, anon, authenticated;
grant execute on function lookup_customer_attempt(text, text, text, text, text) to service_role;
