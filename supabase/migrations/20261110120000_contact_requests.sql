-- Stage 2c, step 4: contact requests (D125)
--   * contact_requests: "general" (form on /contatti) and "out_of_area" (booking wizard, spec 2a — step 5);
--     consent to the privacy notice stored with its version (privacy_accepted_at + privacy_version, as in D42);
--     no addresses for out_of_area — only cities, provinces and the route distance;
--   * ip_hash: HMAC-SHA256 of the sender's IP computed by the server (secret CONTACT_IP_HASH_SECRET), never the
--     IP itself; used only for the rate limit and cleared after 30 days;
--   * submit_contact_request(): the only way to insert (service role), with a per-IP limit of 5 per hour and
--     20 per day (advisory lock per ip_hash, so concurrent submissions cannot exceed it);
--   * admin_set_contact_request_status(): new ↔ handled, audit in the same transaction (ids and status only);
--   * purge_contact_requests(): deletes handled requests 24 months after handled_at, clears old ip_hash.
-- RLS: only admins read; nobody writes directly (not even the service role, except DELETE for GDPR requests).

create type public.contact_request_kind as enum ('general', 'out_of_area');
create type public.contact_request_status as enum ('new', 'handled');

create table public.contact_requests (
  id                  uuid primary key default gen_random_uuid(),
  kind                public.contact_request_kind not null,
  status              public.contact_request_status not null default 'new',
  name                text not null check (length(trim(name)) between 1 and 200),
  email               text not null check (length(email) between 3 and 320 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone               text check (phone is null or length(trim(phone)) between 1 and 40),
  message             text not null check (length(trim(message)) between 1 and 5000),
  -- out_of_area only (no street addresses)
  pickup_city         text check (pickup_city is null or length(pickup_city) <= 200),
  pickup_province     text check (pickup_province is null or length(pickup_province) <= 10),
  delivery_city       text check (delivery_city is null or length(delivery_city) <= 200),
  delivery_province   text check (delivery_province is null or length(delivery_province) <= 10),
  route_distance_km   integer check (route_distance_km is null or route_distance_km between 0 and 5000),
  privacy_accepted_at timestamptz not null,
  privacy_version     text not null check (length(trim(privacy_version)) > 0),
  ip_hash             text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default now(),
  handled_at          timestamptz,
  handled_by          uuid references public.profiles (id) on delete set null,
  constraint contact_requests_route_fields check (
    kind = 'out_of_area'
    or (pickup_city is null and pickup_province is null and delivery_city is null and delivery_province is null and route_distance_km is null)
  ),
  constraint contact_requests_handled check ((status = 'handled') = (handled_at is not null))
);

create index contact_requests_status_idx on public.contact_requests (status, created_at desc);
create index contact_requests_ip_idx on public.contact_requests (ip_hash, created_at) where ip_hash is not null;

alter table public.contact_requests enable row level security;

revoke all on public.contact_requests from anon, authenticated, service_role;
grant select on public.contact_requests to authenticated;          -- RLS: admins only
grant select, delete on public.contact_requests to service_role;   -- delete: GDPR requests (D35); no insert/update

create policy contact_requests_admin_read on public.contact_requests
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- submit_contact_request()
-- Called by the server after validation (zod, honeypot) with the HMAC of the sender's IP.
-- Returns (request_id, result): result 'created' or 'rate_limited' (request_id null).
-- ---------------------------------------------------------------------------
create or replace function public.submit_contact_request(
  p_kind              public.contact_request_kind,
  p_name              text,
  p_email             text,
  p_phone             text,
  p_message           text,
  p_privacy_accepted  boolean,
  p_ip_hash           text,
  p_pickup_city       text default null,
  p_pickup_province   text default null,
  p_delivery_city     text default null,
  p_delivery_province text default null,
  p_route_distance_km integer default null
)
returns table (request_id uuid, result text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text;
  v_id      uuid;
begin
  if p_privacy_accepted is distinct from true then
    raise exception 'submit_contact_request: privacy consent required' using errcode = '22023';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'submit_contact_request: ip hash required' using errcode = '22023';
  end if;

  -- One submission per ip_hash at a time: the count below cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('contact_request:' || p_ip_hash, 0));

  if (select count(*) from public.contact_requests c where c.ip_hash = p_ip_hash and c.created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.contact_requests c where c.ip_hash = p_ip_hash and c.created_at > now() - interval '1 day') >= 20 then
    return query select null::uuid, 'rate_limited'::text;
    return;
  end if;

  select s.privacy_version into v_version from public.settings s limit 1;

  insert into public.contact_requests (
    kind, name, email, phone, message, pickup_city, pickup_province, delivery_city, delivery_province,
    route_distance_km, privacy_accepted_at, privacy_version, ip_hash
  ) values (
    p_kind, trim(p_name), lower(trim(p_email)), nullif(trim(p_phone), ''), trim(p_message),
    nullif(trim(p_pickup_city), ''), nullif(upper(trim(p_pickup_province)), ''),
    nullif(trim(p_delivery_city), ''), nullif(upper(trim(p_delivery_province)), ''),
    p_route_distance_km, now(), v_version, p_ip_hash
  )
  returning id into v_id;

  return query select v_id, 'created'::text;
end;
$$;

revoke execute on function public.submit_contact_request(public.contact_request_kind, text, text, text, text, boolean, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.submit_contact_request(public.contact_request_kind, text, text, text, text, boolean, text, text, text, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- admin_set_contact_request_status()
-- "Segna come gestita" (new → handled) / "Riapri" (handled → new). p_admin_id comes from the admin's session
-- and is checked here (active admin). Setting the current status again raises 55000.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_contact_request_status(p_request_id uuid, p_status public.contact_request_status, p_admin_id uuid)
returns public.contact_request_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text;
  v_status public.contact_request_status;
begin
  if p_status is null then
    raise exception 'admin_set_contact_request_status: status required' using errcode = '22023';
  end if;
  select p.email into v_email from public.profiles p where p.id = p_admin_id and p.role = 'admin' and not p.is_blocked;
  if not found then
    raise exception 'admin_set_contact_request_status: not an admin' using errcode = '42501';
  end if;

  select c.status into v_status from public.contact_requests c where c.id = p_request_id for update;
  if not found then
    raise exception 'admin_set_contact_request_status: request not found' using errcode = '22023';
  end if;
  if v_status = p_status then
    raise exception 'admin_set_contact_request_status: already %', p_status using errcode = '55000';
  end if;

  update public.contact_requests
     set status = p_status,
         handled_at = case when p_status = 'handled' then now() else null end,
         handled_by = case when p_status = 'handled' then p_admin_id else null end
   where id = p_request_id;

  -- ids and status only — no names, e-mails or messages in the log (D65)
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email,
          case when p_status = 'handled' then 'contact_request.handled' else 'contact_request.reopened' end,
          'contact_request', p_request_id, jsonb_build_object('from', v_status, 'to', p_status));

  return p_status;
end;
$$;

revoke execute on function public.admin_set_contact_request_status(uuid, public.contact_request_status, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_contact_request_status(uuid, public.contact_request_status, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- purge_contact_requests() — retention (D125), called by /api/cron/purge-contact-requests.
-- Handled requests: deleted 24 months after handled_at. New (unhandled) requests are never deleted here.
-- ip_hash: cleared after 30 days (the rate limit only looks at the last day).
-- ---------------------------------------------------------------------------
create or replace function public.purge_contact_requests()
returns table (deleted integer, ip_hashes_cleared integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_cleared integer;
begin
  delete from public.contact_requests
   where status = 'handled' and handled_at < now() - interval '24 months';
  get diagnostics v_deleted = row_count;

  update public.contact_requests
     set ip_hash = null
   where ip_hash is not null and created_at < now() - interval '30 days';
  get diagnostics v_cleared = row_count;

  return query select v_deleted, v_cleared;
end;
$$;

revoke execute on function public.purge_contact_requests() from public, anon, authenticated;
grant execute on function public.purge_contact_requests() to service_role;
