-- Porter overtime rule code (D68). Separate migration: Postgres cannot use a new enum value in the
-- same transaction that adds it.
alter type public.price_rule_code add value if not exists 'porter_overtime_hour' after 'porter_hour';
