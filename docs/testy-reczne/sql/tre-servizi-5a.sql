-- LOCAL database only (D64): one paid Facchinaggio and one paid Deposito order for cliente@example.com
-- (after npm run db:local:reset && npm run db:local:seed-demo). Run:
--   docker exec -i supabase_db_TransiGo psql -U postgres -d postgres -X -q < docs/testy-reczne/sql/tre-servizi-5a.sql
-- Never against staging or production. Sets 3 boxes M in the active warehouse. Prints the order links.
\set ON_ERROR_STOP 1
do $$
declare
  v_cust uuid := (select id from auth.users where email = 'cliente@example.com');
  v_list record;
  v_prov text;
  v_wh uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '3 days';
  v_p jsonb; v_s jsonb; r jsonb; v_id uuid; v_total int; v_sess text;
begin
  select id, version into v_list from public.price_lists where status = 'active';
  select province_code into v_prov from public.service_area_provinces where is_active order by province_code limit 1;
  select id into v_wh from public.warehouses where is_active;
  insert into public.warehouse_box_capacity (warehouse_id, box_code, quantity) values (v_wh, 'm', 3)
    on conflict (warehouse_id, box_code) do update set quantity = 3;
  raise notice 'list v%, province %, boxes %', v_list.version, v_prov,
    (select string_agg(code, ',') from public.price_list_storage_boxes where price_list_id = v_list.id);

  v_p := jsonb_build_object(
    'service_type', 'porters', 'customer_id', v_cust, 'goods_description', 'Armadio e 10 scatoloni', 'customer_notes', 'Citofono Rossi',
    'site_contact_name', 'Mario Rossi', 'site_contact_phone', '+393331234567',
    'porter_job', jsonb_build_object('address', 'Via Roma 10, Milano', 'place_id', 'x', 'lat', 45.46, 'lng', 9.19, 'city', 'Milano',
      'postal_code', '20121', 'province', v_prov, 'job_date', (v_start at time zone 'Europe/Rome')::date, 'window_start', v_start,
      'window_end', v_start + interval '2 hours', 'floor', 3, 'has_elevator', false, 'persons', 2, 'requested_hours', 1,
      'billed_hours', 2, 'is_urgent', false, 'overtime_grace_minutes', 15),
    'charges', jsonb_build_object('price_list_id', v_list.id, 'price_list_version', v_list.version, 'customer_type', 'private',
      'vat_rate_bp', 2200, 'subtotal_cents', 15000, 'vat_cents', 3300, 'total_cents', 18300, 'porter_overtime_rate_cents', 3500,
      'billing_details', jsonb_build_object('first_name', 'Mario', 'last_name', 'Rossi', 'fiscal_code', 'RSSMRA80A01F205X', 'street', 'Via Roma 1', 'city', 'Milano', 'postal_code', '20121', 'province', 'MI'),
      'terms_accepted_at', now(), 'terms_version', '2026-11-01', 'quoted_at', now()),
    'lines', jsonb_build_array(
      jsonb_build_object('sort_order', 0, 'leg_index', 0, 'line_type', 'porters', 'label_it', 'Facchini: 2 persone × 2 h', 'quantity', 1, 'unit_amount_cents', 12000, 'net_cents', 12000, 'vat_cents', 2640, 'gross_cents', 14640, 'carrier_share_group', 'porters'),
      jsonb_build_object('sort_order', 1, 'leg_index', 0, 'line_type', 'porters_floors', 'label_it', 'Piani senza ascensore × 3', 'quantity', 3, 'unit_amount_cents', 1000, 'net_cents', 3000, 'vat_cents', 660, 'gross_cents', 3660, 'carrier_share_group', 'porters')),
    'porter_terms', jsonb_build_object('carrier_amount_cents', 12000, 'porter_share_kind', 'percent', 'porter_share_bp', 8000));
  v_s := jsonb_build_object(
    'service_type', 'storage', 'customer_id', v_cust, 'goods_description', 'Mobili del soggiorno',
    'booking', jsonb_build_object('warehouse_id', v_wh, 'unit', 'box', 'box_code', 'm', 'start_date', (now() at time zone 'Europe/Rome')::date + 2,
      'end_date', (now() at time zone 'Europe/Rome')::date + 46, 'intake', 'self', 'outbound', 'later'),
    'charges', jsonb_build_object('price_list_id', v_list.id, 'price_list_version', v_list.version, 'customer_type', 'private',
      'vat_rate_bp', 2200, 'subtotal_cents', 17500, 'vat_cents', 3850, 'total_cents', 21350,
      'billing_details', jsonb_build_object('first_name', 'Mario', 'last_name', 'Rossi', 'fiscal_code', 'RSSMRA80A01F205X', 'street', 'Via Roma 1', 'city', 'Milano', 'postal_code', '20121', 'province', 'MI'),
      'terms_accepted_at', now(), 'terms_version', '2026-11-01', 'quoted_at', now()),
    'lines', jsonb_build_array(
      jsonb_build_object('sort_order', 0, 'leg_index', null, 'line_type', 'storage', 'label_it', 'Box M, 45 giorni', 'quantity', 1, 'unit_amount_cents', 17500, 'net_cents', 17500, 'vat_cents', 3850, 'gross_cents', 21350, 'carrier_share_group', 'none')));

  foreach r in array array[v_p, v_s] loop
    v_id := (public.create_service_order(r) ->> 'id')::uuid;
    v_total := (r -> 'charges' ->> 'total_cents')::int;
    v_sess := 'cs_test_local_' || replace(v_id::text, '-', '');
    perform public.start_order_payment(v_id, v_sess, v_total, now() + interval '1 hour');
    perform public.confirm_order_payment(v_sess, 'pi_demo_' || md5(v_sess), 'ch_demo_' || md5(v_sess), v_total, 'eur');
    raise notice '% → /admin/ordini/%', r ->> 'service_type', v_id;
  end loop;
end $$;
