# Test ręczny: faktury klienta — adapter DEMO (krok 4 „pełnego demo strony”, D144–D150)

Plan: `docs/plany/faktury.md`. Lokalnie, na danych demo.

## Przygotowanie

```bash
npm run db:local:reset && npm run db:local:seed-demo
node scripts/einvoice-backfill.mjs            # dry run: lista płatności bez faktury i zwrotów bez noty
node scripts/einvoice-backfill.mjs --apply    # wystawia faktury DEMO (bez maili)
npm run dev                                   # .env.development.local → lokalna baza
```

Loginy i hasło: wypisuje seed (`cat .seed-local/password`).

Zwrot `succeeded` lokalnie (sztuczne `pi_demo_` w Stripe zostaje `pending`) — symulacja wyniku Stripe:

```bash
docker exec supabase_db_TransiGo psql -U postgres -tAc "
with a as (select id from profiles where email='admin@example.com'), o as (select id from orders where order_number='TG-2026-000005'),
r as (select (admin_refund_order((select id from o),(select id from a),2000,'goodwill')).refund_id as rid)
select record_refund_result((select rid from r), 're_demo_local_1', 'succeeded');"
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/einvoice
```

## A. Klient

1. `cliente@example.com` → menu „Fatture” → lista: numer `DEMO-RRRR-NNNN`, znacznik DEMO, data, link do zlecenia, kwota „IVA inclusa”; czerwona informacja „Ambiente di prova…”.
2. „Scarica PDF” → PDF ze znakiem wodnym „DEMO — documento senza valore fiscale” na każdej stronie, dane firmy z „Impostazioni”, dane do faktury ze zlecenia.
3. Link z PDF skopiowany i otwarty po ponad 60 s → odmowa (podpisany URL ważny 60 s, D148).
4. Po zwrocie (przygotowanie): nota `DEMO-NC-…` pod fakturą, kwota ze znakiem minus, własny PDF z „Rif. fattura n. …”.
5. Karta zlecenia `/cliente/ordini/[id]`: sekcja „Fatture” (faktura + noty), link „Tutte le fatture”.
6. Dokument niewystawiony (w błędzie) → „In preparazione”, bez PDF, bez kodu błędu.
7. Adres `/api/fatture/<id faktury innego klienta>/pdf` → 404.

## B. Admin

1. `admin@example.com` → menu „Fatture”: zakładki „Da emettere / in errore” i „Emesse”.
2. Dokument w błędzie: stan „In errore”, liczba prób, kod po włosku; „Riprova” → „Documento emesso.”, dokument przechodzi do „Emesse” z tym samym numerem, jeśli był już zarezerwowany.
3. Dashboard: kafelek „Fatture in errore”.
4. `/admin/ordini/[id]`: sekcja „Fatture”; „Scarica PDF”.
5. Zlecenie 24 („Pagamento da verificare”) → „Segna come pagato” → w sekcji „Fatture” od razu faktura DEMO.
6. `/admin/email`: maile `invoice_issued` (link do „Fatture”, bez załącznika) — po jednym na dokument; backfill maili nie wysyła.

## C. Skrypt backfill (D149)

1. Bez flag → tylko lista, „Dry run: nulla è stato scritto.”
2. `--apply` dwa razy → za drugim razem nic nowego.
3. Odmawia: `--staging=<inny ref>`, `--apply --dry-run`, `EINVOICE_PROVIDER=fatture_in_cloud`, `SITE_INDEXING=on`, `VERCEL_ENV=production`, `NEXT_PUBLIC_SUPABASE_URL` spoza lokalnej bazy.
4. Staging (`--staging=bacabuzzevwwdxrswbnc --apply`) — **tylko za zgodą właściciela w danej rozmowie**, po migracji `invoices` na stagingu.

## D. Na telefonie (do sprawdzenia przez właściciela)

`/cliente/fatture` przy 375 px: numer, kwota i „Scarica PDF” mieszczą się bez przewijania w bok.
