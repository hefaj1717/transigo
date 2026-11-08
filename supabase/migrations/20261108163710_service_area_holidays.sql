-- Stage 2a / migration 2: service area provinces, national holidays, pricing-related settings
-- See docs/db-schema.md section 3.2 and decisions D10, D13, D27, D50, D51, D61, D62 in docs/spec.md.

-- ---------------------------------------------------------------------------
-- holidays (D27: national holidays only; drive the weekend/holiday surcharge, D51)
-- ---------------------------------------------------------------------------
create table public.holidays (
  date       date primary key,
  name_it    text not null check (length(trim(name_it)) > 0),
  created_at timestamptz not null default now()
);

insert into public.holidays (date, name_it) values
  ('2026-01-01', 'Capodanno'),
  ('2026-01-06', 'Epifania'),
  ('2026-04-05', 'Pasqua'),
  ('2026-04-06', 'Lunedì dell''Angelo'),
  ('2026-04-25', 'Festa della Liberazione'),
  ('2026-05-01', 'Festa dei Lavoratori'),
  ('2026-06-02', 'Festa della Repubblica'),
  ('2026-08-15', 'Ferragosto'),
  ('2026-11-01', 'Ognissanti'),
  ('2026-12-08', 'Immacolata Concezione'),
  ('2026-12-25', 'Natale'),
  ('2026-12-26', 'Santo Stefano'),
  ('2027-01-01', 'Capodanno'),
  ('2027-01-06', 'Epifania'),
  ('2027-03-28', 'Pasqua'),
  ('2027-03-29', 'Lunedì dell''Angelo'),
  ('2027-04-25', 'Festa della Liberazione'),
  ('2027-05-01', 'Festa dei Lavoratori'),
  ('2027-06-02', 'Festa della Repubblica'),
  ('2027-08-15', 'Ferragosto'),
  ('2027-11-01', 'Ognissanti'),
  ('2027-12-08', 'Immacolata Concezione'),
  ('2027-12-25', 'Natale'),
  ('2027-12-26', 'Santo Stefano'),
  ('2028-01-01', 'Capodanno'),
  ('2028-01-06', 'Epifania'),
  ('2028-04-16', 'Pasqua'),
  ('2028-04-17', 'Lunedì dell''Angelo'),
  ('2028-04-25', 'Festa della Liberazione'),
  ('2028-05-01', 'Festa dei Lavoratori'),
  ('2028-06-02', 'Festa della Repubblica'),
  ('2028-08-15', 'Ferragosto'),
  ('2028-11-01', 'Ognissanti'),
  ('2028-12-08', 'Immacolata Concezione'),
  ('2028-12-25', 'Natale'),
  ('2028-12-26', 'Santo Stefano');

-- ---------------------------------------------------------------------------
-- service_area_provinces (D13, D61: all inactive at start; the admin enables the region)
-- ---------------------------------------------------------------------------
create table public.service_area_provinces (
  province_code char(2) primary key check (province_code ~ '^[A-Z]{2}$'),
  name_it       text not null check (length(trim(name_it)) > 0),
  region_it     text not null check (length(trim(region_it)) > 0),
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index service_area_provinces_region_idx on public.service_area_provinces (region_it);

create trigger service_area_provinces_set_updated_at
  before update on public.service_area_provinces
  for each row execute function public.set_updated_at();

-- 107 provinces / metropolitan cities (sigle as returned in Google address components, administrative_area_level_2).
insert into public.service_area_provinces (province_code, name_it, region_it) values
  ('TO', 'Torino', 'Piemonte'),
  ('VC', 'Vercelli', 'Piemonte'),
  ('NO', 'Novara', 'Piemonte'),
  ('CN', 'Cuneo', 'Piemonte'),
  ('AT', 'Asti', 'Piemonte'),
  ('AL', 'Alessandria', 'Piemonte'),
  ('BI', 'Biella', 'Piemonte'),
  ('VB', 'Verbano-Cusio-Ossola', 'Piemonte'),
  ('AO', 'Aosta', 'Valle d''Aosta'),
  ('VA', 'Varese', 'Lombardia'),
  ('CO', 'Como', 'Lombardia'),
  ('SO', 'Sondrio', 'Lombardia'),
  ('MI', 'Milano', 'Lombardia'),
  ('BG', 'Bergamo', 'Lombardia'),
  ('BS', 'Brescia', 'Lombardia'),
  ('PV', 'Pavia', 'Lombardia'),
  ('CR', 'Cremona', 'Lombardia'),
  ('MN', 'Mantova', 'Lombardia'),
  ('LC', 'Lecco', 'Lombardia'),
  ('LO', 'Lodi', 'Lombardia'),
  ('MB', 'Monza e della Brianza', 'Lombardia'),
  ('BZ', 'Bolzano', 'Trentino-Alto Adige'),
  ('TN', 'Trento', 'Trentino-Alto Adige'),
  ('VR', 'Verona', 'Veneto'),
  ('VI', 'Vicenza', 'Veneto'),
  ('BL', 'Belluno', 'Veneto'),
  ('TV', 'Treviso', 'Veneto'),
  ('VE', 'Venezia', 'Veneto'),
  ('PD', 'Padova', 'Veneto'),
  ('RO', 'Rovigo', 'Veneto'),
  ('UD', 'Udine', 'Friuli-Venezia Giulia'),
  ('GO', 'Gorizia', 'Friuli-Venezia Giulia'),
  ('TS', 'Trieste', 'Friuli-Venezia Giulia'),
  ('PN', 'Pordenone', 'Friuli-Venezia Giulia'),
  ('IM', 'Imperia', 'Liguria'),
  ('SV', 'Savona', 'Liguria'),
  ('GE', 'Genova', 'Liguria'),
  ('SP', 'La Spezia', 'Liguria'),
  ('PC', 'Piacenza', 'Emilia-Romagna'),
  ('PR', 'Parma', 'Emilia-Romagna'),
  ('RE', 'Reggio Emilia', 'Emilia-Romagna'),
  ('MO', 'Modena', 'Emilia-Romagna'),
  ('BO', 'Bologna', 'Emilia-Romagna'),
  ('FE', 'Ferrara', 'Emilia-Romagna'),
  ('RA', 'Ravenna', 'Emilia-Romagna'),
  ('FC', 'Forlì-Cesena', 'Emilia-Romagna'),
  ('RN', 'Rimini', 'Emilia-Romagna'),
  ('MS', 'Massa-Carrara', 'Toscana'),
  ('LU', 'Lucca', 'Toscana'),
  ('PT', 'Pistoia', 'Toscana'),
  ('FI', 'Firenze', 'Toscana'),
  ('LI', 'Livorno', 'Toscana'),
  ('PI', 'Pisa', 'Toscana'),
  ('AR', 'Arezzo', 'Toscana'),
  ('SI', 'Siena', 'Toscana'),
  ('GR', 'Grosseto', 'Toscana'),
  ('PO', 'Prato', 'Toscana'),
  ('PG', 'Perugia', 'Umbria'),
  ('TR', 'Terni', 'Umbria'),
  ('PU', 'Pesaro e Urbino', 'Marche'),
  ('AN', 'Ancona', 'Marche'),
  ('MC', 'Macerata', 'Marche'),
  ('AP', 'Ascoli Piceno', 'Marche'),
  ('FM', 'Fermo', 'Marche'),
  ('VT', 'Viterbo', 'Lazio'),
  ('RI', 'Rieti', 'Lazio'),
  ('RM', 'Roma', 'Lazio'),
  ('LT', 'Latina', 'Lazio'),
  ('FR', 'Frosinone', 'Lazio'),
  ('AQ', 'L''Aquila', 'Abruzzo'),
  ('TE', 'Teramo', 'Abruzzo'),
  ('PE', 'Pescara', 'Abruzzo'),
  ('CH', 'Chieti', 'Abruzzo'),
  ('CB', 'Campobasso', 'Molise'),
  ('IS', 'Isernia', 'Molise'),
  ('CE', 'Caserta', 'Campania'),
  ('BN', 'Benevento', 'Campania'),
  ('NA', 'Napoli', 'Campania'),
  ('AV', 'Avellino', 'Campania'),
  ('SA', 'Salerno', 'Campania'),
  ('FG', 'Foggia', 'Puglia'),
  ('BA', 'Bari', 'Puglia'),
  ('TA', 'Taranto', 'Puglia'),
  ('BR', 'Brindisi', 'Puglia'),
  ('LE', 'Lecce', 'Puglia'),
  ('BT', 'Barletta-Andria-Trani', 'Puglia'),
  ('PZ', 'Potenza', 'Basilicata'),
  ('MT', 'Matera', 'Basilicata'),
  ('CS', 'Cosenza', 'Calabria'),
  ('CZ', 'Catanzaro', 'Calabria'),
  ('RC', 'Reggio Calabria', 'Calabria'),
  ('KR', 'Crotone', 'Calabria'),
  ('VV', 'Vibo Valentia', 'Calabria'),
  ('TP', 'Trapani', 'Sicilia'),
  ('PA', 'Palermo', 'Sicilia'),
  ('ME', 'Messina', 'Sicilia'),
  ('AG', 'Agrigento', 'Sicilia'),
  ('CL', 'Caltanissetta', 'Sicilia'),
  ('EN', 'Enna', 'Sicilia'),
  ('CT', 'Catania', 'Sicilia'),
  ('RG', 'Ragusa', 'Sicilia'),
  ('SR', 'Siracusa', 'Sicilia'),
  ('SS', 'Sassari', 'Sardegna'),
  ('NU', 'Nuoro', 'Sardegna'),
  ('CA', 'Cagliari', 'Sardegna'),
  ('OR', 'Oristano', 'Sardegna'),
  ('SU', 'Sud Sardegna', 'Sardegna');

-- ---------------------------------------------------------------------------
-- settings: pricing / booking columns
-- ---------------------------------------------------------------------------
alter table public.settings
  add column max_route_distance_m   integer not null default 300000 check (max_route_distance_m > 0),            -- D13, D61
  add column min_booking_lead_hours integer not null default 3 check (min_booking_lead_hours between 0 and 168), -- D50
  add column quote_valid_minutes    integer not null default 30 check (quote_valid_minutes between 1 and 1440);  -- D62

grant update (max_route_distance_m, min_booking_lead_hours, quote_valid_minutes) on public.settings to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.holidays, public.service_area_provinces from anon, authenticated;

grant select on public.holidays to anon, authenticated;
grant insert, delete on public.holidays to authenticated;
grant update (name_it) on public.holidays to authenticated;

grant select on public.service_area_provinces to anon, authenticated;
grant insert (province_code, name_it, region_it, is_active) on public.service_area_provinces to authenticated;
grant update (name_it, region_it, is_active) on public.service_area_provinces to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.holidays enable row level security;
alter table public.service_area_provinces enable row level security;

-- holidays: public read (the wizard works without login), admin writes.
create policy holidays_select_all on public.holidays
  for select to anon, authenticated using (true);
create policy holidays_insert_admin on public.holidays
  for insert to authenticated with check ((select public.is_admin()));
create policy holidays_update_admin on public.holidays
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy holidays_delete_admin on public.holidays
  for delete to authenticated using ((select public.is_admin()));

-- service_area_provinces: public read of active provinces; admin reads all and writes (no delete).
create policy service_area_provinces_select_active on public.service_area_provinces
  for select to anon, authenticated using (is_active);
create policy service_area_provinces_select_admin on public.service_area_provinces
  for select to authenticated using ((select public.is_admin()));
create policy service_area_provinces_insert_admin on public.service_area_provinces
  for insert to authenticated with check ((select public.is_admin()));
create policy service_area_provinces_update_admin on public.service_area_provinces
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
