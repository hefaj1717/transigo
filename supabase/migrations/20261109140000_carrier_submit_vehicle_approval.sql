-- Stage 4 / part 1, step 3 prerequisites (D106, D107)
--   * submit_carrier_for_review() tells whether this call set submitted_at (the admin e-mail is sent only then)
--   * carrier_vehicles: first_approved_at (set once, never cleared); the plate of a vehicle that was ever
--     approved cannot change; a change of type or payload removes the approval — for every role
-- See docs/spec.md D106, D107 and docs/db-schema.md.

-- ---------------------------------------------------------------------------
-- submit_carrier_for_review(): returns (submitted_at, newly_submitted) (D106)
-- The carrier row is locked (select … for update), so of two parallel calls exactly one returns
-- newly_submitted = true; the other waits for the lock, sees submitted_at and returns false.
-- The return type changes, so the function is dropped and created again (same privileges).
-- ---------------------------------------------------------------------------
drop function public.submit_carrier_for_review();

create function public.submit_carrier_for_review()
returns table (submitted_at timestamptz, newly_submitted boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id      uuid := auth.uid();
  v_carrier public.carriers%rowtype;
  v_missing text[];
  v_at      timestamptz;
begin
  if v_id is null or public.auth_role() is distinct from 'padroncino' then
    raise exception 'submit_carrier_for_review: not allowed' using errcode = '42501';
  end if;

  select * into v_carrier from public.carriers c where c.profile_id = v_id for update;
  if not found then
    raise exception 'submit_carrier_for_review: carrier not found' using errcode = '22023';
  end if;
  if v_carrier.status = 'pending_review' and v_carrier.submitted_at is not null then
    -- already waiting for the admin (also the second of two parallel calls)
    return query select v_carrier.submitted_at, false;
    return;
  end if;
  if v_carrier.status not in ('pending_review', 'rejected') then
    raise exception 'submit_carrier_for_review: account is %', v_carrier.status using errcode = '55000';
  end if;

  v_missing := public.carrier_onboarding_missing(v_id);
  if cardinality(v_missing) > 0 then
    raise exception 'submit_carrier_for_review: incomplete' using errcode = '23514', detail = array_to_string(v_missing, ',');
  end if;

  update public.carriers c
     set status = 'pending_review', status_reason = null, submitted_at = now()
   where c.profile_id = v_id
  returning c.submitted_at into v_at;
  return query select v_at, true;
end;
$$;

revoke execute on function public.submit_carrier_for_review() from public, anon;
grant execute on function public.submit_carrier_for_review() to authenticated;

-- ---------------------------------------------------------------------------
-- carrier_vehicles.first_approved_at (D107): when the vehicle was approved for the first time.
-- Written only by the trigger below; it never changes afterwards, for any role.
-- Added before the new trigger, so the backfill is a plain update.
-- ---------------------------------------------------------------------------
alter table public.carrier_vehicles add column first_approved_at timestamptz;

update public.carrier_vehicles set first_approved_at = approved_at where approved_at is not null;

-- API users cannot write it directly (no column grant; the protect trigger is the second line of defence).
drop trigger carrier_vehicles_a_protect_columns on public.carrier_vehicles;
create trigger carrier_vehicles_a_protect_columns
  before update on public.carrier_vehicles
  for each row execute function public.protect_server_columns('id', 'carrier_id', 'approved_at', 'first_approved_at', 'created_at');

-- ---------------------------------------------------------------------------
-- Approval rules (D107), for every role — anon, authenticated, service_role and the database owner:
--   * plate: may change only while the vehicle was never approved (first_approved_at is null);
--   * vehicle_type_id or payload_kg changed → approved_at = null (vehicle documents unchanged);
--   * is_active and cargo_* do not affect the approval;
--   * first_approved_at = the first non-null approved_at, kept forever.
-- No session flag or setting changes these rules. decide_carrier_review() only sets approved_at.
-- ---------------------------------------------------------------------------
create or replace function public.reset_vehicle_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.plate is distinct from old.plate and old.first_approved_at is not null then
      raise exception 'carrier_vehicles: the plate of an approved vehicle cannot be changed'
        using errcode = '23514';
    end if;
    new.first_approved_at = old.first_approved_at;
    if new.vehicle_type_id is distinct from old.vehicle_type_id or new.payload_kg is distinct from old.payload_kg then
      new.approved_at = null;
    end if;
  else
    new.first_approved_at = null;
  end if;

  if new.first_approved_at is null and new.approved_at is not null then
    new.first_approved_at = new.approved_at;
  end if;
  return new;
end;
$$;

drop trigger carrier_vehicles_b_reset_approval on public.carrier_vehicles;
create trigger carrier_vehicles_b_reset_approval
  before insert or update on public.carrier_vehicles
  for each row execute function public.reset_vehicle_approval();
