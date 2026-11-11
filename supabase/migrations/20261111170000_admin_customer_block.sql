-- Admin blocks / unblocks a customer account (D143; plan docs/plany/panel-admina.md, part C).
--
--   admin_set_customer_blocked(customer, admin, block, reason_code)
--     service role only (the Server Action checks the admin session first; require_admin() checks again);
--     only profiles with role 'cliente' that have a customers row; block needs a reason code from the list, unblock
--     does not; audit_log in the same transaction (codes only, no free text — details go to the internal notes).
--     A blocked customer loses access at once (auth_role() = null → no policy matches; the DAL redirects).
--     Orders already under way are not touched: they are carried out as usual (as D116 for carriers).
--     Already in the requested state → changed = false, nothing written.
--   Returns: changed, and the number of the customer's orders under way (paid … in_transit, cancellation_review,
--   payment_review) for the warning on the page.
-- No new tables, no policy changes.

create function public.admin_set_customer_blocked(p_customer_id uuid, p_admin_id uuid, p_block boolean, p_reason_code text default null)
returns table (changed boolean, active_orders integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email   text := public.require_admin(p_admin_id);
  v_profile public.profiles%rowtype;
  v_active  integer;
begin
  if p_block is null then
    raise exception 'admin_set_customer_blocked: decision required' using errcode = '22023', detail = 'block';
  end if;
  if p_block and (p_reason_code is null or p_reason_code not in ('payment_issue', 'abuse', 'fraud_suspected', 'customer_request', 'other')) then
    raise exception 'admin_set_customer_blocked: reason code required' using errcode = '22023', detail = 'reason';
  end if;

  select * into v_profile from public.profiles where id = p_customer_id for update;
  if not found or v_profile.role <> 'cliente' or not exists (select 1 from public.customers c where c.profile_id = p_customer_id) then
    raise exception 'admin_set_customer_blocked: customer not found' using errcode = '22023', detail = 'customer';
  end if;

  select count(*)::integer into v_active from public.orders o
   where o.customer_id = p_customer_id
     and o.status in ('paid', 'assigned', 'picked_up', 'in_transit', 'cancellation_review', 'payment_review');

  if v_profile.is_blocked = p_block then
    return query select false, v_active;
    return;
  end if;

  update public.profiles set is_blocked = p_block where id = p_customer_id;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, case when p_block then 'customer.blocked' else 'customer.unblocked' end, 'customer', p_customer_id,
          case when p_block then jsonb_build_object('reason', p_reason_code, 'active_orders', v_active) else jsonb_build_object('active_orders', v_active) end);
  return query select true, v_active;
end;
$$;

revoke execute on function public.admin_set_customer_blocked(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_set_customer_blocked(uuid, uuid, boolean, text) to service_role;
