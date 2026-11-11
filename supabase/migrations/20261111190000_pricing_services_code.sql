-- Porters-only service: surcharge per floor without elevator (D157). Separate migration: Postgres cannot use
-- a new enum value in the same transaction that adds it.
alter type public.price_rule_code add value if not exists 'porters_floor_no_elevator' after 'porter_overtime_hour';
