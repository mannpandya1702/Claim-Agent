-- 0009_review_fixes.sql — two fixes to functions already applied (0006, 0007), as new definitions.
--
-- 1. upsert_caller_contact kept a confirmation when only the callback number changed. The number a
--    caller says is part of the read-back they said yes to, and GoHighLevel and the claim intake key
--    on a confirmed row's number, so a new number (or a new source for it) now needs a new "yes".
-- 2. file_claim_intake returns the filed row to the delivery that filed it and to one that waited on
--    its lock alike, so two overlapping confirm_claim deliveries both paged the team.
--    file_claim_intake_once says which one filed (filed_now), like escalations' inserted flag, and
--    only that one sends the confirmation and pages.

-- Same signature and rules as 0006, with the number and its source in the comparison.
create or replace function upsert_caller_contact(
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
    confirmed = cc.confirmed
      and (cc.kind, cc.first_name, cc.last_name, cc.email, cc.callback_phone, cc.callback_source)
      is not distinct from
          (excluded.kind, excluded.first_name, excluded.last_name, excluded.email, excluded.callback_phone,
           excluded.callback_source),
    confirmed_at = case
      when (cc.kind, cc.first_name, cc.last_name, cc.email, cc.callback_phone, cc.callback_source)
        is not distinct from
           (excluded.kind, excluded.first_name, excluded.last_name, excluded.email, excluded.callback_phone,
            excluded.callback_source)
      then cc.confirmed_at else null end
  returning cc.*
$$;

-- confirm_claim's "yes": file_claim_intake, plus whether this call filed it. The row lock is taken
-- first, so a parallel delivery waits here and then reads the intake as already filed (filed_now
-- false). No row: no row.
create function file_claim_intake_once(p_call_key text)
returns table (intake claim_intakes, filed_now boolean)
language plpgsql security invoker set search_path = public as $$
declare
  v_was_filed boolean;
begin
  select ci.confirmed into v_was_filed from claim_intakes ci where ci.call_key = p_call_key for update;
  if not found then
    return;
  end if;
  return query select f, not v_was_filed from file_claim_intake(p_call_key) f;
end $$;

revoke execute on function file_claim_intake_once(text) from public, anon, authenticated;
grant execute on function file_claim_intake_once(text) to service_role;
