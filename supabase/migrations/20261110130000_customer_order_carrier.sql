-- Customer panel (spec 7): who carries my order.
--   * customer_order_carrier(order_id): for the signed-in customer who owns the order, once a carrier is
--     assigned (assigned … delivered / completed), returns ONLY the carrier's first name, company name,
--     vehicle type and plate. No phone, VAT number or address — contact goes through Transigo.
--     Everything else (another customer's order, carrier, admin, anonymous, blocked account, order not yet
--     assigned or unassigned again — D122) → no rows.
-- The mirror of D119 (what the carrier sees of the customer). No table or RLS policy changes: carriers and
-- carrier_vehicles stay readable only by their owner and admins.

create or replace function public.customer_order_carrier(p_order_id uuid)
returns table (first_name text, company_name text, vehicle_type text, plate text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.first_name, c.company_name, vt.name_it, cv.plate
  from public.orders o
  join public.carriers c on c.profile_id = o.carrier_id
  join public.profiles p on p.id = c.profile_id
  left join public.carrier_vehicles cv on cv.id = o.carrier_vehicle_id
  left join public.vehicle_types vt on vt.id = cv.vehicle_type_id
  where o.id = p_order_id
    and o.customer_id = auth.uid()
    and public.auth_role() = 'cliente'          -- null for blocked accounts
    and o.status in ('assigned', 'picked_up', 'in_transit', 'delivered', 'completed');
$$;

revoke execute on function public.customer_order_carrier(uuid) from public, anon;
grant execute on function public.customer_order_carrier(uuid) to authenticated;
