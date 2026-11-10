-- D128: the status history shows no user ids or positions to customers and carriers; a carrier sees only the
-- rows from its own assignment on (nothing of a previous carrier). Admins read everything through a function.
-- Tests: tests/rls/carrier-job-history.test.ts.

drop policy order_status_history_select on public.order_status_history;

-- Customer: every row of an own order (statuses and times; no changed_by / lat / lng — column grants below).
create policy order_status_history_select_customer on public.order_status_history
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_status_history.order_id
      and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
  ));

-- Carrier: only rows written since ITS assignment. accept_job / admin_assign_job set orders.assigned_at and
-- insert the 'assigned' row in one transaction with the same now(), so that row is included; anything of a
-- previous carrier (its accept, its release, an admin unassignment) is older and stays hidden.
create policy order_status_history_select_carrier on public.order_status_history
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_status_history.order_id
      and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
      and order_status_history.created_at >= o.assigned_at
  ));

create policy order_status_history_select_admin on public.order_status_history
  for select to authenticated
  using ((select public.is_admin()));

-- Column privileges: who changed a status and where are never readable with a user session.
revoke select on public.order_status_history from authenticated;
grant select (id, order_id, from_status, to_status, source, note, created_at)
  on public.order_status_history to authenticated;

-- Admin: the full history of one order (who changed what), checked in the database.
create function public.admin_order_status_history(p_order_id uuid)
returns table (
  id bigint, from_status public.order_status, to_status public.order_status, source public.status_source,
  changed_by uuid, note text, lat double precision, lng double precision, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_order_status_history: admins only' using errcode = '42501';
  end if;
  return query
    select h.id, h.from_status, h.to_status, h.source, h.changed_by, h.note, h.lat, h.lng, h.created_at
    from public.order_status_history h
    where h.order_id = p_order_id
    order by h.id;
end;
$$;
revoke execute on function public.admin_order_status_history(uuid) from public, anon;
grant execute on function public.admin_order_status_history(uuid) to authenticated, service_role;
