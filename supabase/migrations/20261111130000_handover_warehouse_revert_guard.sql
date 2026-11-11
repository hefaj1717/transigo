-- Fixes from the code review of the job execution plan (owner 2026-11-11, D136; docs/plany/realizacja-kursu.md):
--   1. admin_unassign_job: an order in picked_up / in_transit NEVER goes back to 'paid' (the customer would see the
--      status go back, and with the pickup window of leg 1 in the past nobody could take it — too_late).
--        * load on board (order_onboard_leg)                    → "da gestire", handover_reason 'on_board' (as before);
--        * goods in the warehouse (a leg finished, the next one
--          not loaded)                                          → "da gestire" on the next leg, 'in_warehouse';
--        * every leg unloaded, POD missing                      → refused (55000 'all_unloaded'): the goods are at
--                                                                 the recipient — "Consegnato" with a reason.
--      'assigned' (nothing loaded) → back to 'paid' as before.
--   2. admin_revert_last_step(order, admin, leg, step, reason): the step the admin saw is compared with the last
--      live step UNDER the order's row lock — another step → 55000 'changed', nothing reverted (no race with the
--      carrier recording a step in between).
--   3. The status goes back only when the reverted step itself moved it, on ANY leg (carrier_record_step moves the
--      status forward on any leg since 20261111120000_carrier_handover.sql): 'loaded' with picked_up_at = the step's
--      time → assigned; 'departed' with in_transit_at = the step's time → picked_up. A status set by the admin or
--      reached before a takeover is never lowered by undoing the new carrier's step.
-- No data is changed. Tests: tests/rls/carrier-handover.test.ts, tests/rls/carrier-execution.test.ts.

-- ---------------------------------------------------------------------------
-- Internal: the leg a new carrier has to take over — the leg with the load on board, else (goods in the warehouse)
-- the first unfinished leg after a finished one. Null = nothing to take over (nothing loaded, or every leg done).
-- ---------------------------------------------------------------------------
create function public.order_handover_leg(p_order_id uuid)
returns smallint
language sql
stable
set search_path = ''
as $$
  select coalesce(
    public.order_onboard_leg(p_order_id),
    (select min(l.leg_index) from public.order_legs l
      where l.order_id = p_order_id
        and not exists (select 1 from public.order_leg_steps u
                        where u.order_id = l.order_id and u.leg_index = l.leg_index and u.step = 'unloaded' and u.reverted_at is null)
        and exists (select 1 from public.order_leg_steps d
                    where d.order_id = l.order_id and d.leg_index < l.leg_index and d.step = 'unloaded' and d.reverted_at is null))
  );
$$;
revoke execute on function public.order_handover_leg(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_unassign_job (D122 + D130 + D136). Errors: 22023 reason / order | 55000 not_assigned | all_unloaded
-- ---------------------------------------------------------------------------
create or replace function public.admin_unassign_job(p_order_id uuid, p_admin_id uuid, p_reason_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_reasons constant text[] := array['errore_admin', 'richiesta_padroncino', 'problema_veicolo', 'padroncino_non_disponibile', 'altro'];
  v_email   text := public.require_admin(p_admin_id);
  v_order   public.orders%rowtype;
  v_leg     smallint;
  v_kind    text;
begin
  if p_reason_code is null or not p_reason_code = any (c_reasons) then
    raise exception 'admin_unassign_job: unknown reason code' using errcode = '22023', detail = 'reason';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_unassign_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.carrier_id is null or v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'admin_unassign_job: not assigned' using errcode = '55000', detail = 'not_assigned';
  end if;

  -- decided BEFORE the update: the carrier-change trigger reverts the steps of unfinished legs
  if public.order_onboard_leg(p_order_id) is not null then
    v_leg := public.order_onboard_leg(p_order_id);
    v_kind := 'on_board';
  elsif v_order.status in ('picked_up', 'in_transit') then
    v_leg := public.order_handover_leg(p_order_id);
    if v_leg is null then
      raise exception 'admin_unassign_job: every leg unloaded, delivery not confirmed' using errcode = '55000', detail = 'all_unloaded';
    end if;
    v_kind := 'in_warehouse';
  end if;

  if v_leg is not null then
    update public.orders
       set carrier_id = null, carrier_vehicle_id = null, assigned_at = null,
           handover_required_at = now(), handover_leg_index = v_leg
     where id = p_order_id;
  else
    update public.orders
       set status = 'paid', carrier_id = null, carrier_vehicle_id = null, assigned_at = null,
           picked_up_at = null, in_transit_at = null
     where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
    values (p_order_id, v_order.status, 'paid', p_admin_id, 'admin_panel');
  end if;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.unassigned', 'order', p_order_id,
          jsonb_build_object('carrier_id', v_order.carrier_id, 'vehicle_id', v_order.carrier_vehicle_id,
                             'reason_code', p_reason_code, 'from', v_order.status, 'goods_loaded', coalesce(v_kind = 'on_board', false),
                             'handover_leg_index', v_leg, 'handover_reason', v_kind,
                             'pickup_window_passed', v_order.pickup_window_start <= now()));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_revert_last_step(order, admin, leg, step, reason) — replaces the version without leg/step.
-- Errors: 42501 | 22023 order / reason / leg | 55000 not_in_progress | no_step | changed
-- ---------------------------------------------------------------------------
drop function public.admin_revert_last_step(uuid, uuid, text);

create function public.admin_revert_last_step(
  p_order_id uuid, p_admin_id uuid, p_leg_index smallint, p_step public.order_leg_step, p_reason text
)
returns table (leg_index smallint, step public.order_leg_step, order_status public.order_status)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email  text := public.require_admin(p_admin_id);
  v_reason text := trim(coalesce(p_reason, ''));
  v_order  public.orders%rowtype;
  v_step   public.order_leg_steps%rowtype;
  v_to     public.order_status;
  v_now    timestamptz := now();
begin
  if length(v_reason) not between 1 and 1000 then
    raise exception 'admin_revert_last_step: reason required' using errcode = '22023', detail = 'reason';
  end if;
  if p_leg_index is null or p_step is null then
    raise exception 'admin_revert_last_step: step the admin saw required' using errcode = '22023', detail = 'leg';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_revert_last_step: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'admin_revert_last_step: job not in progress' using errcode = '55000', detail = 'not_in_progress';
  end if;
  select * into v_step from public.order_leg_steps
   where order_id = p_order_id and reverted_at is null
   order by leg_index desc, step desc
   limit 1;
  if not found then
    raise exception 'admin_revert_last_step: no step to undo' using errcode = '55000', detail = 'no_step';
  end if;
  -- under the row lock: carrier_record_step locks the same row, so the last step cannot change any more here
  if v_step.leg_index <> p_leg_index or v_step.step <> p_step then
    raise exception 'admin_revert_last_step: the last step changed' using errcode = '55000', detail = 'changed';
  end if;

  update public.order_leg_steps set reverted_at = v_now, reverted_by = p_admin_id where id = v_step.id;

  -- back only when THIS step moved the status (carrier_record_step writes the step and *_at with the same now())
  v_to := case
            when v_step.step = 'departed' and v_order.status = 'in_transit' and v_order.in_transit_at = v_step.created_at
              then 'picked_up'::public.order_status
            when v_step.step = 'loaded' and v_order.status = 'picked_up' and v_order.picked_up_at = v_step.created_at
              then 'assigned'::public.order_status
            else v_order.status
          end;
  if v_to <> v_order.status then
    update public.orders
       set status = v_to,
           in_transit_at = case when v_order.status = 'in_transit' then null else in_transit_at end,
           picked_up_at = case when v_order.status = 'picked_up' then null else picked_up_at end
     where id = p_order_id;

    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (p_order_id, v_order.status, v_to, p_admin_id, 'admin_panel', v_now);
  end if;
  insert into public.order_admin_notes (order_id, kind, leg_index, body, created_by, created_at)
  values (p_order_id, 'step_reverted', v_step.leg_index, v_reason, p_admin_id, v_now);
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.step_reverted', 'order', p_order_id,
          jsonb_build_object('leg_index', v_step.leg_index, 'step', v_step.step, 'from', v_order.status, 'to', v_to));

  return query select v_step.leg_index, v_step.step, v_to;
end;
$$;
revoke execute on function public.admin_revert_last_step(uuid, uuid, smallint, public.order_leg_step, text) from public, anon, authenticated;
grant execute on function public.admin_revert_last_step(uuid, uuid, smallint, public.order_leg_step, text) to service_role;
