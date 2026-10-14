-- 0012_callback_caller_name.sql — who the claims team should ask for when they call back.
--
-- An unverified caller who asks for a callback is asked "Who should they ask for?" once, after the
-- request is logged and the team alerted. The name they give (escalate's caller_name, cleaned by
-- identity.ts normaliseCallerName) is stored on the escalation row; it is a claim, never an identity.
--
-- Additive for the webhook deployed before this migration: upsert_escalation keeps its first eight
-- parameters (PostgREST calls it by name, and the new p_caller_name defaults to null) and returns the
-- same columns plus caller_name at the end. Every statement can run again: the column and the CHECK are
-- added only once, and the old signature is dropped only if it is still there.

alter table escalations add column if not exists caller_name text;

alter table escalations drop constraint if exists escalations_caller_name_check;
alter table escalations add constraint escalations_caller_name_check
  check (caller_name is null or char_length(caller_name) between 1 and 80);

-- Adding a parameter makes a new function rather than replacing the old one, so the eight-parameter
-- signature (0001) is dropped first and PostgREST sees exactly one upsert_escalation.
drop function if exists upsert_escalation(text, text, text, text, text, text, text, boolean);

-- Same merge as 0001, plus the name: a repeat takes a newly supplied name over an older one and keeps
-- the stored name when none is supplied, like every other non-null value.
create or replace function upsert_escalation(
  p_call_key text, p_kind text, p_reason text, p_details text, p_callback_phone text,
  p_callback_source text, p_channel text, p_verified boolean, p_caller_name text default null
) returns table (id uuid, inserted boolean, callback_phone text, callback_source text, alert_status text,
                 verified boolean, caller_name text)
language plpgsql security invoker set search_path = public as $$
#variable_conflict use_column
begin
  return query
  insert into escalations as e (call_key, kind, reason, details, callback_phone, callback_source, channel, verified,
                                caller_name)
  values (p_call_key, p_kind, p_reason, p_details, p_callback_phone, coalesce(p_callback_source, 'none'), p_channel,
          coalesce(p_verified, false), p_caller_name)
  on conflict (call_key, kind) do update set
    callback_phone = coalesce(excluded.callback_phone, e.callback_phone),
    callback_source = case when excluded.callback_phone is not null then excluded.callback_source
                           else e.callback_source end,
    details = coalesce(excluded.details, e.details),
    verified = e.verified or excluded.verified,
    caller_name = coalesce(excluded.caller_name, e.caller_name)
  returning e.id, (e.xmax = 0), e.callback_phone, e.callback_source, e.alert_status, e.verified, e.caller_name;
end $$;

-- The grants 0001 gave the old signature: the service role only.
revoke execute on function upsert_escalation(text, text, text, text, text, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function upsert_escalation(text, text, text, text, text, text, text, boolean, text) to service_role;
