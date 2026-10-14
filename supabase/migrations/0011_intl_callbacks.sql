-- 0011_intl_callbacks.sql — a callback number is whatever number the caller gives.
--
-- identity.ts normaliseCallbackNumber stores three forms, and this file lets each of them through:
--   +1XXXXXXXXXX          a North American number (as before)
--   +<8 to 15 digits>     an international number given with its country code (E.164)
--   <7 to 15 digits>      any other number, noted exactly as the caller said it (no country code)
-- Account lookup keys are not touched: customers.phone_e164 stays North American (0001).
--
-- Checked against 0001-0010: the only rule that refused these forms is caller_contacts.callback_phone's
-- CHECK (0006, '^\+1[0-9]{10}$'). upsert_escalation, upsert_caller_contact (0006, 0009),
-- file_claim_intake (0007, 0009), escalations.callback_phone and call_interactions.caller_phone store
-- the number as given and validate nothing. The generated *_masked columns (0003) accepted every
-- form but read bare digits as North American ("+1 960 ... 0123"); they now say "+1" only for a
-- number stored with its "+1", and "... 0123" for the rest. Every number the server wrote before this
-- file is "+1" and ten digits (0006's CHECK; the server wrote no other form), so those keep their mask.

-- 1. The callback number CHECK, replaced whatever name the inline constraint was given.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.caller_contacts'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%callback_phone%'
  loop
    execute format('alter table public.caller_contacts drop constraint %I', v_name);
  end loop;
end $$;

alter table caller_contacts add constraint caller_contacts_callback_phone_check
  check (callback_phone is null or callback_phone ~ '^(\+[1-9][0-9]{7,14}|[0-9]{7,15})$');

-- 2. The list masks. "+1 602 ... 0101" only for a North American number stored with its "+1": 11
-- digits after the "+", a leading 1, area code and exchange starting with 2-9. Anything else
-- (international, or noted as said: bare digits carry no country code, whatever their shape, such as
-- "6025550177" from a caller abroad) shows its last four digits only. Postgres 17 rewrites a stored
-- generated column in place (SET EXPRESSION), so the list functions that read it are kept.
alter table call_interactions alter column caller_phone_masked set expression as (case
  when nullif(caller_phone, '') is null then null
  when caller_phone ~ '^\s*\+' and regexp_replace(caller_phone, '\D', '', 'g') ~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$'
    then '+1 ' || substr(regexp_replace(caller_phone, '\D', '', 'g'), 2, 3) || ' ... '
         || right(regexp_replace(caller_phone, '\D', '', 'g'), 4)
  when length(regexp_replace(caller_phone, '\D', '', 'g')) >= 4
    then '... ' || right(regexp_replace(caller_phone, '\D', '', 'g'), 4)
  else '...' end);

alter table escalations alter column callback_phone_masked set expression as (case
  when nullif(callback_phone, '') is null then null
  when callback_phone ~ '^\s*\+' and regexp_replace(callback_phone, '\D', '', 'g') ~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$'
    then '+1 ' || substr(regexp_replace(callback_phone, '\D', '', 'g'), 2, 3) || ' ... '
         || right(regexp_replace(callback_phone, '\D', '', 'g'), 4)
  when length(regexp_replace(callback_phone, '\D', '', 'g')) >= 4
    then '... ' || right(regexp_replace(callback_phone, '\D', '', 'g'), 4)
  else '...' end);
