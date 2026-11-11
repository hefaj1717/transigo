# Plan: faktury klienta — adapter DEMO (krok 4 „pełnego demo strony”, 2026-11-11)

**Status:** plan zatwierdzony 2026-11-11 (D144–D149), razem z `pdf-lib` i jednorazowym wystawieniem faktur demo dla
już opłaconych zleceń. Migracja `invoices` zatwierdzona 2026-11-11 ze zmianami D150 (patrz niżej) —
`supabase/migrations/20261111180000_invoices.sql` (lokalnie), testy `tests/rls/invoices.test.ts`.

Cel: klient i admin widzą faktury i noty korygujące jak w docelowym produkcie, ale dokumenty wystawia adapter DEMO
(PDF ze znakiem „DEMO — documento senza valore fiscale”). Później Fatture in Cloud (D1) = nowy adapter + zmienna
środowiskowa, **bez zmian w reszcie kodu**. Treść faktur według D1–D3 i D26 (czekają na commercialista).

## 1. Wspólny interfejs — `src/lib/einvoice/`

- `provider.ts` — `EInvoiceProvider`:
  - `name: "demo" | "fatture_in_cloud"`, `isDemo: boolean`;
  - `issueInvoice(doc: InvoiceDocument, idempotencyKey) → { providerDocumentId, number, issuedAt, sdiStatus, pdf: Uint8Array | null }`;
  - `issueCreditNote(doc: CreditNoteDocument, idempotencyKey) → to samo`;
  - `getStatus(providerDocumentId) → sdiStatus`; `getPdf(providerDocumentId) → Uint8Array`.
  Klucz idempotencji = id wiersza `invoices` (ponowienie nigdy nie wystawia drugiego dokumentu).
- `document.ts` (czyste) — `buildInvoiceDocument(snapshot, company)` i `buildCreditNoteDocument(invoice, refund)`:
  sprzedawca z `settings.company_*`; nabywca z `order_charges.billing_details` (prywatny: CF; firma: P.IVA + SDI/PEC);
  pozycje netto/IVA/brutto z `order_lines`; płatność (Stripe, data), numer zlecenia. Kwoty w centach.
- `index.ts` — `getEInvoiceProvider()`: `EINVOICE_PROVIDER=demo|fatture_in_cloud` (domyślnie `demo`).
  **Adapter demo odmawia działania na produkcji** (`VERCEL_ENV=production` albo `SITE_INDEXING=on`).
- `demo.ts` — adapter DEMO: PDF przez `pdf-lib` (nowa zależność) ze znakiem wodnym na każdej stronie, status SDI
  symulowany od razu („consegnata”), bez XML FatturaPA. PDF do prywatnego bucketu `invoices`.
- **Numeracja (wymóg właściciela 1):** seria DEMO jest **osobna** (`DEMO-2026-0001`, nota `DEMO-NC-2026-0001`),
  z licznika `invoice_demo_counters` używanego **wyłącznie** przez adapter demo. Numer prawdziwej faktury pochodzi
  **od dostawcy** (`number` zwrócone przez `issueInvoice`) — nasz licznik nigdy nie nadaje prawdziwego numeru.
  Unikalność `(provider, number)`, więc serie się nie mieszają.

## 2. Kiedy powstają dokumenty

- **Wyzwalacz faktury w jednym miejscu (wymóg 3):** `src/lib/einvoice/trigger.ts` —
  `INVOICE_TRIGGER = "payment_confirmed"` (D2) i `invoiceDueFor(payment, order)`: jedyna funkcja, która decyduje,
  czy płatność ma już dostać fakturę. Wołają ją: webhook po `paid`, „Segna come pagato” (D141) i zadanie
  `/api/cron/einvoice` (dogania wszystko, co przegapiło wywołanie). Zmiana momentu (np. „po dostawie”) po decyzji
  commercialista = zmiana tego jednego pliku + jego testów.
- **Nota korygująca (wymóg 2):** powstaje, gdy zwrot jest `succeeded` **i faktura tej płatności jest `issued`**.
  Faktura `pending`/`failed` → nota czeka (wiersza noty jeszcze nie ma; funkcja w bazie odmawia `invoice_not_issued`),
  cron tworzy ją po wystawieniu faktury. Test: zwrot `succeeded` przy fakturze `failed` → brak noty; faktura `issued`
  → nota powstaje raz (test RLS + test przepływu).
- Kolejność zawsze: wiersz `pending` w bazie → dostawca (klucz = id wiersza) → `record_invoice_result`. Błąd dostawcy
  **nigdy** nie cofa płatności ani zwrotu: wiersz `failed` z kodem błędu, ponawia cron albo admin („Riprova”).
- Kwoty noty: brutto = kwota zwrotu; IVA = `round_half_up(zwrot × iva_faktury / brutto_faktury)`, netto = reszta
  (liczy funkcja w bazie; ten sam wzór w TS do podglądu, testy na tych samych przykładach).

## 3. Migracja `invoices` — projekt (zatwierdzony; zmiany D150 w pliku migracji)

Plik: `supabase/migrations/2026111118xxxx_invoices.sql`. Zapis tylko funkcjami (service role), odczyt sesją.

```sql
create type public.invoice_kind   as enum ('invoice', 'credit_note');
create type public.invoice_status as enum ('pending', 'issued', 'failed');   -- nasz proces; 'issued' jest końcowy
create type public.invoice_sdi_status as enum ('not_sent', 'sent', 'delivered', 'rejected');

-- Licznik TYLKO serii DEMO (wymóg 1). Prawdziwy numer nadaje dostawca.
create table public.invoice_demo_counters (
  series      text    not null check (series in ('DEMO', 'DEMO-NC')),
  year        integer not null check (year between 2020 and 2100),
  last_number integer not null default 0 check (last_number >= 0),
  primary key (series, year)
);

create table public.invoices (
  id                   uuid primary key default gen_random_uuid(),
  kind                 public.invoice_kind not null,
  order_id             uuid not null references public.orders (id) on delete restrict,
  payment_id           uuid not null references public.payments (id) on delete restrict,
  refund_id            uuid unique references public.refunds (id) on delete restrict,      -- nota: zwrot
  invoice_id           uuid references public.invoices (id) on delete restrict,            -- nota: faktura
  provider             text not null check (provider in ('demo', 'fatture_in_cloud')),
  is_demo              boolean not null,
  status               public.invoice_status not null default 'pending',
  sdi_status           public.invoice_sdi_status,
  number               text,                                    -- od dostawcy (demo: DEMO-2026-0001)
  issued_at            timestamptz,
  provider_document_id text,
  net_cents            integer not null check (net_cents >= 0),
  vat_cents            integer not null check (vat_cents >= 0),
  total_cents          integer not null check (total_cents > 0 and total_cents = net_cents + vat_cents),
  pdf_path             text unique,                             -- bucket invoices: {order_id}/{id}.pdf
  attempts             integer not null default 0,
  last_error_code      text check (length(last_error_code) <= 200),   -- kod, bez danych osobowych
  last_attempt_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (is_demo = (provider = 'demo')),
  check ((kind = 'invoice') = (refund_id is null)),
  check ((kind = 'invoice') = (invoice_id is null)),
  check (status <> 'issued' or (number is not null and issued_at is not null)),
  unique (provider, number)
);
create unique index invoices_one_per_payment on public.invoices (payment_id) where kind = 'invoice';   -- D26
create index invoices_order_idx on public.invoices (order_id);
create index invoices_open_idx on public.invoices (status) where status <> 'issued';
-- triggery: forbid_column_changes(id, kind, order_id, payment_id, refund_id, invoice_id, provider, is_demo, kwoty,
-- created_at); 'issued' nie wraca do pending/failed; set_updated_at.

-- Uprawnienia + RLS: sesje tylko czytają; klient — swoje (przez orders.customer_id), admin — wszystko,
-- przewoźnik — nic. Kolumny techniczne (provider_document_id, attempts, last_error_code) tylko admin
-- (GRANT kolumnowy dla authenticated bez nich + funkcja admin_invoice_errors() albo odczyt service role po DAL).
-- invoice_demo_counters: RLS bez polityk (tylko funkcje).

-- Storage: prywatny bucket 'invoices' (application/pdf, ≤ 5 MB); zapis tylko service role; odczyt: klient —
-- PDF swojej faktury (istnieje wiersz invoices z tym pdf_path i jego zlecenie), admin — wszystko.

-- Funkcje (tylko service role, security definer, blokada wiersza):
--   queue_invoice(p_payment_id) → (invoice_id, newly_queued)
--       płatność succeeded i przyjęta (order_main_payment), kwoty z order_charges; drugi raz → ten sam wiersz.
--   queue_credit_note(p_refund_id) → (invoice_id, newly_queued)
--       zwrot succeeded; faktura tej płatności MUSI być 'issued', inaczej 55000 invoice_not_issued (wymóg 2);
--       kwoty noty liczone tu (round half up), drugi raz → ten sam wiersz.
--   next_demo_invoice_number(p_series) → text   -- tylko seria DEMO / DEMO-NC, rok w Europe/Rome
--   record_invoice_result(p_invoice_id, p_ok, p_number, p_issued_at, p_provider_document_id, p_sdi_status,
--                         p_pdf_path, p_error_code) → boolean
--       pending/failed → issued (końcowe) albo failed (attempts + 1); issued → bez zmian (false).
--   record_invoice_sdi_status(p_invoice_id, p_sdi_status)
--   admin_retry_invoice(p_invoice_id, p_admin_id) → invoice_id   -- failed → pending, audit (bez wolnego tekstu)
```

Testy `tests/rls/invoices.test.ts`: sesje nie wywołają funkcji; klient widzi tylko swoje i nie widzi kolumn
technicznych; przewoźnik nic; jedna faktura na płatność (wyścig 2 wywołań); nota przy fakturze `failed`/`pending`
→ `invoice_not_issued`, po `issued` → jedna nota; kwoty noty (te same przykłady co TS); seria DEMO rośnie bez dziur
pod równoległymi wywołaniami i nie koliduje z numerem dostawcy; `issued` jest końcowe; polityka Storage.

## 4. Ekrany, PDF, maile

- **Podpisane URL do PDF ważne 60 s (wymóg 4)**, tworzone sesją klienta / admina przy kliknięciu „Scarica PDF”
  (Route Handler → redirect), nie przy renderowaniu listy.
- Klient: `/cliente/fatture` (lista: numer, data, zlecenie, kwota, status; noty pod fakturą) + sekcja na karcie
  zlecenia; menu klienta dostaje „Fatture”.
- Admin: `/admin/fatture` (zakładki „Da emettere / in errore” i „Emesse”, „Riprova”) + sekcja w `/admin/ordini/[id]`;
  kafelek „Fatture in errore” na dashboardzie.
- Mail `invoice_issued` do klienta (link do „Fatture”, bez załącznika), klucz outboxu = id faktury.

## 5. Skrypt dla już opłaconych zleceń (wymóg 5)

`scripts/einvoice-backfill.mjs`:
- domyślnie **`--dry-run`**: wypisuje zlecenia/płatności bez faktury i zwroty `succeeded` bez noty, nic nie zapisuje;
  zapis tylko z jawnym `--apply`;
- działa na lokalnej bazie albo na stagingu `--staging=bacabuzzevwwdxrswbnc` (jak seed: URL z `.env.local` musi być
  stagingiem); **odmawia każdego innego projektu** i gdy `EINVOICE_PROVIDER` ≠ `demo`;
- używa tych samych funkcji co aplikacja (`queue_invoice` → adapter demo → `record_invoice_result`, potem noty).
- Na stagingu `--apply` tylko za zgodą właściciela w danej rozmowie.

## 6. Kolejność

1. Migracja `invoices` + testy RLS (po zgodzie) — lokalnie.
2. `src/lib/einvoice/`: dokument, interfejs, adapter demo (`pdf-lib`), wyzwalacz, testy kontraktu adaptera.
3. Przepływ: webhook / „Segna come pagato” / zwroty → kolejka; cron `/api/cron/einvoice`; testy przepływu
   (błąd dostawcy, ponowienie, nota czeka na fakturę).
4. Ekrany klienta i admina, PDF przez URL 60 s, mail `invoice_issued`.
5. Skrypt backfill (`--dry-run` → `--apply` lokalnie), przegląd w przeglądarce, `docs/testy-reczne/faktury.md`.
6. Staging: migracja i backfill — za zgodą właściciela.
