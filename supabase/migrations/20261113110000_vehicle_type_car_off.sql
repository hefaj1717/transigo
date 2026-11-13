-- D183 (owner 2026-11-13): "Auto / station wagon" is no longer offered; "Furgone piccolo" is the smallest
-- vehicle. Data only, no schema change: the row stays (orders, carrier vehicles and price lists keep
-- pointing at it) and every place that offers vehicles already filters on is_active — booking wizard,
-- public pages and rates, carrier vehicle form, price list publication. The admin can turn it back on
-- in /admin/veicoli.
update public.vehicle_types set is_active = false where code = 'car';
