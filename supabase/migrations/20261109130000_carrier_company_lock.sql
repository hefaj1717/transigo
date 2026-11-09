-- Stage 4 / part 1: carrier company data lock (D105)
-- Company data (used for e-invoices and payouts, Stage 6) is editable by the carrier only before it is sent
-- for review (pending_review or rejected, submitted_at null). Otherwise only admin_update_carrier_company()
-- changes it, writing audit_log (field names only) in the same transaction. Direct UPDATEs by API roles —
-- service_role included — are refused. SQL Editor (database owner) bypasses the audit: emergencies only.
-- No RLS policy changes.

-- ---------------------------------------------------------------------------
-- Trigger: lock company data depending on the previous state of the row
-- ---------------------------------------------------------------------------
create or replace function public.lock_carrier_company_data()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.company_name, new.vat_number, new.fiscal_code, new.pec, new.sdi_code,
      new.hq_street, new.hq_city, new.hq_postal_code, new.hq_province)
     is not distinct from
     (old.company_name, old.vat_number, old.fiscal_code, old.pec, old.sdi_code,
      old.hq_street, old.hq_city, old.hq_postal_code, old.hq_province) then
    return new;
  end if;

  -- Unlocked until the account is sent for review (and again after a rejection): the carrier (column grants
  -- + RLS) and the server may edit.
  if old.status in ('pending_review', 'rejected') and old.submitted_at is null then
    return new;
  end if;

  -- Every other change by an API role is refused — no session flag or setting can unlock it.
  -- admin_update_carrier_company() is SECURITY DEFINER, so inside it current_user is the owner, not an API role.
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'Company data of carrier % is locked (use admin_update_carrier_company)', old.profile_id
      using errcode = '42501';
  end if;

  return new; -- database owner: admin_update_carrier_company() or SQL Editor (emergencies, no audit)
end;
$$;

create trigger carriers_b_lock_company_data
  before update on public.carriers
  for each row execute function public.lock_carrier_company_data();

-- ---------------------------------------------------------------------------
-- admin_update_carrier_company(): the only way for the app to change locked company data
-- p_changes: {"vat_number": "...", ...} — only the 9 company fields; '' and blanks become null.
-- Returns the names of the fields that actually changed ('{}' = nothing written, no audit entry).
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_carrier_company(p_carrier_id uuid, p_admin_id uuid, p_changes jsonb)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_fields  constant text[] := array['company_name', 'vat_number', 'fiscal_code', 'pec', 'sdi_code',
                                     'hq_street', 'hq_city', 'hq_postal_code', 'hq_province'];
  v_email   text;
  v_old     jsonb;
  v_new     jsonb;
  v_row     public.carriers%rowtype;
  v_key     text;
  v_value   jsonb;
  v_changed text[] := '{}';
begin
  select p.email into v_email from public.profiles p where p.id = p_admin_id and p.role = 'admin' and not p.is_blocked;
  if not found then
    raise exception 'admin_update_carrier_company: not an admin' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' then
    raise exception 'admin_update_carrier_company: changes must be an object' using errcode = '22023';
  end if;

  select to_jsonb(c) into v_old from public.carriers c where c.profile_id = p_carrier_id for update;
  if v_old is null then
    raise exception 'admin_update_carrier_company: carrier not found' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_changes) loop
    if not v_key = any (c_fields) then
      raise exception 'admin_update_carrier_company: field % cannot be changed here', v_key using errcode = '22023';
    end if;
  end loop;

  -- In the fixed field order, so the result and the audit entry are stable.
  v_new := v_old;
  foreach v_key in array c_fields loop
    continue when not p_changes ? v_key;
    v_value := p_changes -> v_key;
    if jsonb_typeof(v_value) not in ('string', 'null') then
      raise exception 'admin_update_carrier_company: % must be text', v_key using errcode = '22023';
    end if;
    v_value := case when jsonb_typeof(v_value) = 'string' and trim(v_value #>> '{}') <> ''
                    then to_jsonb(trim(v_value #>> '{}')) else 'null'::jsonb end;
    if v_value is distinct from v_old -> v_key then
      v_new := jsonb_set(v_new, array[v_key], v_value);
      v_changed := array_append(v_changed, v_key);
    end if;
  end loop;

  if cardinality(v_changed) = 0 then
    return v_changed;
  end if;

  v_row := jsonb_populate_record(null::public.carriers, v_new);
  update public.carriers
     set company_name = v_row.company_name, vat_number = v_row.vat_number, fiscal_code = v_row.fiscal_code,
         pec = v_row.pec, sdi_code = v_row.sdi_code, hq_street = v_row.hq_street, hq_city = v_row.hq_city,
         hq_postal_code = v_row.hq_postal_code, hq_province = v_row.hq_province
   where profile_id = p_carrier_id;

  -- Field names only, never values (D65, D105).
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'carrier.company_data_updated', 'carrier', p_carrier_id,
          jsonb_build_object('fields', to_jsonb(v_changed)));

  return v_changed;
end;
$$;

revoke execute on function public.admin_update_carrier_company(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_update_carrier_company(uuid, uuid, jsonb) to service_role;
