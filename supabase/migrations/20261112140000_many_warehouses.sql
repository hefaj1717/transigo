-- Many active warehouses (D178, replaces "one active warehouse in the MVP" from 20261108230000_warehouses.sql).
-- The customer picks the warehouse in the Deposito wizard (search by city). Bookings, capacity and free units
-- were already per warehouse (warehouse_bookings.warehouse_id, warehouse_box_capacity, warehouses.pallet_capacity,
-- warehouse_free_units, create_service_order checks the booking's warehouse is active) — only the index goes.

drop index public.warehouses_one_active_idx;

create index warehouses_active_city_idx on public.warehouses (city) where is_active;
