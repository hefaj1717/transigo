# Plan: panel klienta — część 2 (krok 2 „pełnego demo strony”, 2026-11-11)

Zakres: to, czego brakuje w panelu klienta według spec 7 — bez faktur (krok 4) i bez trackingu (odłożony z PWA).
„Profilo” zrobione (commit `358041a`, bez zmian w bazie). Zostają: **anulowanie opłaconego zlecenia ze zwrotem**,
**reklamacje**, **depozyt**. Ekrany admina do tych funkcji (decyzja w `cancellation_review`, obsługa reklamacji,
ponowienie zwrotu) — krok 3.

**Status: czeka na akceptację właściciela** (migracje = zmiana schematu).

## A. Anulowanie opłaconego zlecenia (D33, D38, D41, D94)

Reguły (spec 4a, bez zmian):
- `paid`, ≥ X h przed początkiem okna odbioru → bezpłatnie, **pełny zwrot automatycznie**, `cancelled`.
- `paid`, < X h → opłata Y % od pozycji transport + dopłaty + tragarze + pakowanie (brutto); składowanie zwracane w
  całości (D38); zwrot reszty automatycznie, `cancelled`.
- `assigned` → „Richiedi annullamento” → `cancellation_review`; decyzję (kwota zwrotu, ewentualna kwota dla
  przewoźnika) podejmuje admin (krok 3). Przewoźnik dostaje mail, że kursu nie wykonuje.
- Od `picked_up` brak przycisku — „Contattaci” / reklamacja.
- X = `settings.free_cancellation_hours` (24), Y = `settings.late_cancellation_fee_bp` (5000) — wartości z D94,
  zmiana w „Impostazioni” (krok 3).

Pieniądze:
- Opłata = `round(suma gross_cents pozycji ≠ storage × Y / 10000)`, zaokrąglenie do centa **połówki w górę**
  (jawnie w kodzie). Zwrot = `total_cents − opłata`. Prowizji Stripe nie potrącamy (D94).
- **Jedno źródło prawdy: funkcja w bazie** liczy opłatę przy anulowaniu (pod blokadą wiersza, z `now()` bazy).
  Ta sama reguła w TypeScript (`src/lib/orders/cancellation.ts`, czysta) służy do podglądu w oknie potwierdzenia;
  testy jednostkowe + test RLS na tych samych przykładach sprawdza, że SQL i TS dają te same kwoty.
- Zwrot przez Stripe Refunds na `payment_intent` zlecenia, klucz idempotencji = id wiersza `refunds`. Wynik zapisuje
  funkcja w bazie (`refunds.status`, `order_charges.refunded_cents`). Nieudany zwrot zostaje `pending`/`failed` —
  admin widzi go i ponawia (krok 3); klient widzi „Rimborso in elaborazione”.
- Webhook `refund.updated` (zwroty, które Stripe kończy później) — dopisany do obsługiwanych zdarzeń; trzeba go
  zaznaczyć w webhooku Stripe na Vercel.

Migracja `customer_cancellation` (plan):
- `customer_cancel_order(p_order_id, p_customer_id, p_reason)` — tylko service role; sprawdza właściciela i status;
  `paid` → `cancelled` + `cancellation_fee_cents` + wiersz `refunds` (`customer_cancellation`, `pending`) gdy zwrot > 0;
  `assigned` → `cancellation_review` + `cancellation_requested_at/_by/_reason`. Historia statusów (`customer`) w tej
  samej transakcji. Zwraca rodzaj, opłatę, zwrot, id zwrotu.
- `record_refund_result(p_refund_id, p_stripe_refund_id, p_status)` — tylko service role; `succeeded` dolicza kwotę do
  `refunded_cents` dokładnie raz.
- Bez nowych tabel i bez zmian polityk RLS (kolumny anulowania i `refunds` istnieją od Etapu 3).
- Testy `tests/rls/customer-cancellation.test.ts`: cudze zlecenie, każdy status, granica X h, kwoty jak w TS,
  wyścig dwóch anulowań, anulowanie vs `admin_assign_job`/`accept_job` w tym samym momencie, sesje nie wywołają funkcji.

Ekran `/cliente/ordini/[id]`: „Annulla ordine” (okno: opłata, kwota zwrotu, termin bezpłatnego anulowania w
Europe/Rome, opcjonalny powód) albo „Richiedi annullamento” przy `assigned`. Maile: `order_cancelled` (klient, kwota
zwrotu), `cancellation_requested` (admin, bez danych osobowych), `carrier_job_cancelled` (przewoźnik).
Nota di credito — krok 4 (faktury). Kwota dla przewoźnika (D40) — Etap 6.

## B. Reklamacje (`claims`, spec 4 i 7)

- Klient otwiera reklamację do **dostarczonego** zlecenia (`delivered`, `completed`) w ciągu **N dni** od dostawy
  (propozycja: 14); jedna otwarta naraz na zlecenie. Kategoria (danni alla merce, merce mancante, ritardo,
  comportamento del padroncino, altro) + opis (≤ 4000 znaków) + do **5 zdjęć**.
- Statusy `open` → `closed`; admin zamyka z notatką widoczną dla klienta (krok 3). Otwarta reklamacja wstrzyma
  wypłatę (Etap 6 — `on_hold`).
- Migracja `claims`: tabela `claims` (+ `claim_photos`), prywatny bucket `claim-photos` (jpg/png/heic, ≤ 10 MB),
  zapis tylko funkcjami (`open_claim`, `register_claim_photo`; zamknięcie `admin_close_claim` z auditem w tej samej
  transakcji). RLS: klient — swoje, admin — wszystkie, **przewoźnik nie widzi** (propozycja na MVP).
  Pliki jak przy zdjęciach kursu: przeglądarka wgrywa przez podpisany URL sesją klienta, rejestracja sprawdza
  metadane z Storage.
- Testy `tests/rls/claims.test.ts`.
- Ekrany: „Apri un reclamo” na `/cliente/ordini/[id]`, lista `/cliente/reclami`. Maile: `claim_opened` (admin, bez
  danych osobowych), `claim_closed` (klient).

## C. Depozyt (spec 7, D9) — bez migracji

- `/cliente/deposito`: zlecenia z magazynem — „In arrivo al magazzino” / „In magazzino” (od rozładunku odcinka 1) /
  „Ritirato dal magazzino”; data przyjęcia, liczba palet, opłacone do (= odbiór z magazynu), magazyn.
- Odczyt sesją klienta (RLS jak dziś). Przedłużenie przez link płatności (D9) **odłożone** razem z modelem B
  (D117) — na razie „Per prolungare il deposito contattaci”.

## Kolejność

1. A — migracja + testy RLS → logika + akcje + ekran + maile.
2. B — migracja + testy RLS → ekrany + maile.
3. C — ekran.
4. Przegląd w przeglądarce, lista testu ręcznego `docs/testy-reczne/panel-klienta-2.md`.

Na stagingu: migracje tylko za zgodą właściciela w danej rozmowie (`npm run db:push`).
