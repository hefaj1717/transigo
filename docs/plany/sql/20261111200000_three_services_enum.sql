-- SZKIC (krok 5a planu docs/plany/tre-servizi.md) — do akceptacji właściciela. Nie jest w supabase/migrations.
-- Three services (D151) / migration 2a, part 1: enum values and new enum types.
-- New enum values cannot be used in the transaction that adds them, so they live in their own migration
-- (like 20261111190000_pricing_services_code.sql).

-- Porters-only service: floors without elevator (D157).
alter type public.order_line_type add value if not exists 'porters_floors';

-- D151: what an order is.
create type public.service_type as enum ('transport', 'porters', 'storage');

-- D154–D156: storage bookings.
create type public.storage_unit as enum ('box', 'pallet');
create type public.storage_payment_plan as enum ('upfront', 'monthly');
create type public.storage_intake as enum ('self', 'transigo');            -- porto io / ritiro Transigo
create type public.storage_outbound as enum ('self', 'transigo', 'later'); -- ritiro io / consegna Transigo / lo deciderò più avanti
create type public.warehouse_booking_status as enum ('booked', 'in_storage', 'released', 'cancelled');
