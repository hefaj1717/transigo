-- Stage 4 / part 1, step 4: admin actions on carriers outside the review of a submission (D113–D115)
--   * review_carrier_document(): approve / reject one pending document of an active or suspended carrier;
--   * approve_carrier_vehicle(): approve one vehicle (and its pending, valid documents) of an active or
--     suspended carrier — "Veicoli da verificare" (D107);
--   * set_carrier_suspension(): Sospendi (active → suspended, reason required) / Riattiva (suspended → active,
--     only when complete (D99) and no document is waiting for review).
-- All three: service role only; p_admin_id comes from the admin's session and is checked here (active admin);
-- audit_log is written in the same transaction (ids and business values only, never personal data — D65).
-- No table or RLS policy changes.

-- ---------------------------------------------------------------------------
-- review_carrier_document()
-- Documents sent with a submission are decided by decide_carrier_review(); this one is for documents uploaded
-- by an active or suspended carrier (e.g. a renewed RCA). A second decision raises 55000.
-- Returns the new review_status.
-- ---------------------------------------------------------------------------
create or replace function public.review_carrier_document(p_document_id uuid, p_admin_id uuid, p_approve boolean, p_reason text default null)
returns public.review_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text;
  v_doc    public.carrier_documents%rowtype;
  v_status public.carrier_status;
  v_reason text := nullif(trim(p_reason), '');
begin
  if p_approve is null then
    raise exception 'review_carrier_document: decision required' using errcode = '22023';
  end if;
  select p.email into v_email from public.profiles p where p.id = p_admin_id and p.role = 'admin' and not p.is_blocked;
  if not found then
    raise exception 'review_carrier_document: not an admin' using errcode = '42501';
  end if;

  select * into v_doc from public.carrier_documents where id = p_document_id for update;
  if not found then
    raise exception 'review_carrier_document: document not found' using errcode = '22023';
  end if;
  select c.status into v_status from public.carriers c where c.profile_id = v_doc.carrier_id;
  if v_status not in ('active', 'suspended') then
    raise exception 'review_carrier_document: carrier is not active or suspended' using errcode = '55000';
  end if;
  if v_doc.review_status <> 'pending' then
    raise exception 'review_carrier_document: already reviewed' using errcode = '55000';
  end if;

  if p_approve then
    update public.carrier_documents
       set review_status = 'approved', reviewed_by = p_admin_id, reviewed_at = now(), rejection_reason = null
     where id = p_document_id;
  else
    if v_reason is null or length(v_reason) > 1000 then
      raise exception 'review_carrier_document: a reason (max 1000 characters) is required' using errcode = '22023';
    end if;
    update public.carrier_documents
       set review_status = 'rejected', reviewed_by = p_admin_id, reviewed_at = now(), rejection_reason = v_reason
     where id = p_document_id;
  end if;

  -- The reason is free text: not copied into the log (it stays on the document).
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email,
          case when p_approve then 'carrier.document_approved' else 'carrier.document_rejected' end,
          'carrier_document', p_document_id,
          jsonb_build_object('carrier_id', v_doc.carrier_id, 'vehicle_id', v_doc.vehicle_id, 'doc_type', v_doc.doc_type));

  return case when p_approve then 'approved'::public.review_status else 'rejected'::public.review_status end;
end;
$$;

revoke execute on function public.review_carrier_document(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.review_carrier_document(uuid, uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- approve_carrier_vehicle()
-- An active vehicle without approved_at, of an active or suspended carrier, whose required documents are valid
-- and not rejected (same rule as D99). Its pending documents that are valid now are approved with it (as in
-- D101), so the admin approves what they see on the vehicle's document list. A second call raises 55000.
-- Returns approved_at.
-- ---------------------------------------------------------------------------
create or replace function public.approve_carrier_vehicle(p_vehicle_id uuid, p_admin_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today    date := (now() at time zone 'Europe/Rome')::date;
  v_email    text;
  v_vehicle  public.carrier_vehicles%rowtype;
  v_status   public.carrier_status;
  v_missing  text[];
  v_docs     uuid[];
  v_now      timestamptz := now();
begin
  select p.email into v_email from public.profiles p where p.id = p_admin_id and p.role = 'admin' and not p.is_blocked;
  if not found then
    raise exception 'approve_carrier_vehicle: not an admin' using errcode = '42501';
  end if;

  select * into v_vehicle from public.carrier_vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'approve_carrier_vehicle: vehicle not found' using errcode = '22023';
  end if;
  select c.status into v_status from public.carriers c where c.profile_id = v_vehicle.carrier_id;
  if v_status not in ('active', 'suspended') then
    raise exception 'approve_carrier_vehicle: carrier is not active or suspended' using errcode = '55000';
  end if;
  if not v_vehicle.is_active then
    raise exception 'approve_carrier_vehicle: vehicle is not active' using errcode = '55000';
  end if;
  if v_vehicle.approved_at is not null then
    raise exception 'approve_carrier_vehicle: already approved' using errcode = '55000';
  end if;

  select coalesce(array_agg(m), '{}') into v_missing
  from unnest(public.carrier_onboarding_missing(v_vehicle.carrier_id)) m
  where m like 'vehicle_document:' || p_vehicle_id::text || ':%';
  if cardinality(v_missing) > 0 then
    raise exception 'approve_carrier_vehicle: documents missing' using errcode = '23514', detail = array_to_string(v_missing, ',');
  end if;

  with approved as (
    update public.carrier_documents d
       set review_status = 'approved', reviewed_by = p_admin_id, reviewed_at = v_now
      from public.carrier_document_types t
     where d.vehicle_id = p_vehicle_id and d.review_status = 'pending' and t.doc_type = d.doc_type
       and (t.expiry = 'none' or d.expires_at >= v_today)
    returning d.id
  )
  select coalesce(array_agg(id), '{}') into v_docs from approved;

  update public.carrier_vehicles set approved_at = v_now where id = p_vehicle_id;

  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'carrier.vehicle_approved', 'carrier_vehicle', p_vehicle_id,
          jsonb_build_object('carrier_id', v_vehicle.carrier_id,
                             'reapproval', v_vehicle.first_approved_at is not null,
                             'document_ids', to_jsonb(v_docs)));

  return v_now;
end;
$$;

revoke execute on function public.approve_carrier_vehicle(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_carrier_vehicle(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- set_carrier_suspension()
-- Sospendi: active → suspended, reason required (≤ 1000), shown to the carrier.
-- Riattiva: suspended → active, only when carrier_onboarding_missing() is empty and no document of the
--           carrier (company or active vehicle) is pending — the admin reviews uploads made during the
--           suspension first. status_reason cleared.
-- Any other state raises 55000. Returns the new status.
-- ---------------------------------------------------------------------------
create or replace function public.set_carrier_suspension(p_carrier_id uuid, p_admin_id uuid, p_suspend boolean, p_reason text default null)
returns public.carrier_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email   text;
  v_carrier public.carriers%rowtype;
  v_reason  text := nullif(trim(p_reason), '');
  v_missing text[];
begin
  if p_suspend is null then
    raise exception 'set_carrier_suspension: decision required' using errcode = '22023';
  end if;
  select p.email into v_email from public.profiles p where p.id = p_admin_id and p.role = 'admin' and not p.is_blocked;
  if not found then
    raise exception 'set_carrier_suspension: not an admin' using errcode = '42501';
  end if;

  select * into v_carrier from public.carriers where profile_id = p_carrier_id for update;
  if not found then
    raise exception 'set_carrier_suspension: carrier not found' using errcode = '22023';
  end if;

  if p_suspend then
    if v_carrier.status <> 'active' then
      raise exception 'set_carrier_suspension: carrier is not active' using errcode = '55000';
    end if;
    if v_reason is null or length(v_reason) > 1000 then
      raise exception 'set_carrier_suspension: a reason (max 1000 characters) is required' using errcode = '22023';
    end if;
    update public.carriers set status = 'suspended', status_reason = v_reason where profile_id = p_carrier_id;
  else
    if v_carrier.status <> 'suspended' then
      raise exception 'set_carrier_suspension: carrier is not suspended' using errcode = '55000';
    end if;
    v_missing := public.carrier_onboarding_missing(p_carrier_id);
    if cardinality(v_missing) > 0 then
      raise exception 'set_carrier_suspension: incomplete' using errcode = '23514', detail = array_to_string(v_missing, ',');
    end if;
    if exists (
      select 1 from public.carrier_documents d
      left join public.carrier_vehicles v on v.id = d.vehicle_id
      where d.carrier_id = p_carrier_id and d.review_status = 'pending'
        and (d.vehicle_id is null or v.is_active)
    ) then
      raise exception 'set_carrier_suspension: documents waiting for review' using errcode = '55000', detail = 'pending_documents';
    end if;
    update public.carriers set status = 'active', status_reason = null where profile_id = p_carrier_id;
  end if;

  -- The reason is free text: not copied into the log (it stays on the carrier).
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email,
          case when p_suspend then 'carrier.suspended' else 'carrier.reactivated' end,
          'carrier', p_carrier_id, '{}'::jsonb);

  return case when p_suspend then 'suspended'::public.carrier_status else 'active'::public.carrier_status end;
end;
$$;

revoke execute on function public.set_carrier_suspension(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_carrier_suspension(uuid, uuid, boolean, text) to service_role;
