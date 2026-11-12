-- Facchinaggio from 1 person (D177, replaces the minimum of 2 from D157; the maximum of 4 from D54 stays).
-- The price list still decides the minimum (porters_min_persons); new price lists start at 1. Published lists are
-- immutable — the minimum of the active one changes with "Crea bozza" → edit → "Pubblica".

alter table public.price_lists
  drop constraint price_lists_porters_min_persons_check,
  add constraint price_lists_porters_min_persons_check check (porters_min_persons between 1 and 4),
  alter column porters_min_persons set default 1;

alter table public.order_porter_jobs
  drop constraint order_porter_jobs_persons_check,
  add constraint order_porter_jobs_persons_check check (persons between 1 and 4);
