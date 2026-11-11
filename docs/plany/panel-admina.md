# Plan: panel admina (krok 3 „pełnego demo strony”, 2026-11-11)

Zakres (spec 9): **Clienti**, **zwroty i decyzje** (`cancellation_review`, `payment_review`, zwrot ręczny, ponowienie
nieudanego zwrotu), **Reclami**, **Impostazioni**, **pozycje w magazynie**, **Dashboard**. Bez faktur i not
korygujących (krok 4), bez wypłat i potrąceń (Etap 6 — tu tylko zapis kwoty dla przewoźnika z D40).

**Status:** zatwierdzony 2026-11-11 (D140–D143). A–F zrobione 2026-11-11 (migracje `admin_refunds`, `admin_customer_block` lokalnie, staging za zgodą).

## A. Pieniądze: anulowania, płatności do sprawdzenia, zwroty — migracja `admin_refunds`

Wspólne: każda funkcja tylko service role, `require_admin(p_admin_id)` w bazie (Server Action najpierw `adminDeps()`),
blokada wiersza zlecenia, kwoty liczy/sprawdza baza, `audit_log` w tej samej transakcji (tylko id, kody i kwoty — bez
wolnego tekstu). Zwrot w Stripe jak w D137: wiersz `refunds` (`pending`) → Stripe Refund z kluczem `refund:<id>` →
`record_refund_result()`; błąd Stripe nie cofa decyzji, wiersz czeka na „Riprova”.

1. **Decyzja przy „Annullamento in revisione”** — `admin_decide_cancellation(order, admin, refund_cents, carrier_cents)`:
   - tylko `cancellation_review` → `cancelled` (D41), `cancellation_decided_at/_by`;
   - `0 ≤ refund_cents ≤ total − już zwrócone`, `0 ≤ carrier_cents ≤ carrier_amount_cents` zlecenia;
   - `cancellation_fee_cents = total − refund_cents` (to, co zatrzymuje Transigo, w tym część dla przewoźnika);
   - nowa kolumna **`orders.cancellation_carrier_cents`** (null = brak decyzji) — w Etapie 6 z niej powstanie wypłata
     wg D40; przewoźnik jej jeszcze nie widzi (grupa danych admina, D77);
   - podgląd w panelu: propozycja = reguła klienta z D137 (opłata Y %, gdy < X h), admin może ją zmienić;
   - mail `order_cancelled` do klienta (ten sam szablon, kwota zwrotu z decyzji).
2. **„Pagamento da verificare”** (D96) — `admin_resolve_payment_review(order, payment, admin, action)`:
   - `mark_paid`: zlecenie `payment_review` → `paid` (płatność oznaczona jako sprawdzona). Gdy okno odbioru już minęło,
     panel ostrzega i proponuje zwrot (to samo co D122 — zmiana terminu poza zakresem);
   - `refund`: pełny zwrot **tej** płatności; zlecenie `payment_review` → `refunded`; przy `duplicate_payment`
     zlecenie zostaje `paid`, zwracana jest tylko druga płatność;
   - `payments.reviewed_at/_by` (nowe kolumny) — płatność znika z kolejki po decyzji.
3. **Zwrot ręczny** — `admin_refund_order(order, admin, amount_cents, reason_code)`:
   - zlecenia opłacone (`paid` … `completed`, `cancelled`), kwota ≤ zapłacone − zwroty niebędące `failed`;
   - powody z listy (`service_issue`, `claim`, `goodwill`, `price_correction`, `other`) — kod w `refunds.reason`,
     opis tylko w „Note interne”;
   - zwrot całości → status `refunded` tylko z `paid`, `delivered`, `completed` (przy kursie w toku najpierw
     „Rimuovi padroncino”); częściowy — status bez zmian (D41);
   - `refunds.after_payout` zostaje `false` do Etapu 6.
4. **„Riprova rimborso”** — `pending` bez `stripe_refund_id`: ponowne wywołanie Stripe z tym samym kluczem (bez
   migracji); `failed`: `admin_retry_refund(refund, admin)` tworzy nowy wiersz na tę samą kwotę (stary zostaje).
5. Ekrany: w `/admin/ordini/[id]` sekcja „Pagamenti e rimborsi” (płatności, zwroty ze statusem, przyciski zależnie od
   stanu); filtry listy „Annullamento in revisione” i „Rimborsi da completare”. Logika podglądu czysta
   (`src/lib/orders/admin-refunds.ts` + testy), przepływ `admin-refunds-server.ts` (testy z atrapami Stripe).
6. Testy `tests/rls/admin-refunds.test.ts`: sesje (klient, przewoźnik, admin) nie wywołają funkcji, każdy status,
   granice kwot, wyścig decyzji z drugim kliknięciem i z `customer_cancel_order`, suma zwrotów ≤ płatność,
   `duplicate_payment`, audit w tej samej transakcji.

## B. Reklamacje admina — bez migracji

- `/admin/reclami` (zakładki „Aperti” / „Chiusi”, kategoria, zlecenie, wiek), szczegóły `/admin/reclami/[id]`
  (opis, zdjęcia przez podpisany URL **sesją admina**, link do zlecenia, „Chiudi con nota” → `admin_close_claim`).
- Mail `claim_closed` do klienta (notatka admina). Licznik otwartych reklamacji przy zleceniu w `/admin/ordini/[id]`.
- Otwieranie reklamacji przez admina — **nie w tym kroku** (admin pisze „Note interne”; przy wypłatach w Etapie 6
  wróci jako blokada).

## C. Clienti — migracja `admin_customer_block`

- `/admin/clienti`: lista (imię/firma, e-mail, typ, liczba zleceń, data rejestracji, zablokowany), wyszukiwarka po
  nazwie / e-mailu / P.IVA. Szczegóły `/admin/clienti/[id]`: dane, dane do faktury, zlecenia, reklamacje.
- Blokada: `admin_set_customer_blocked(customer, admin, block, reason_code)` — `is_blocked` jest kolumną chronioną,
  więc tylko funkcja; audit w tej samej transakcji. Zablokowany klient od razu traci dostęp (DAL, `auth_role()` = null).
  Zlecenia w toku **wykonują się dalej** (jak D116), panel pokazuje ostrzeżenie z ich liczbą.
- Testy w `tests/rls/admin-customers.test.ts` (tylko service role, admin musi być aktywny, odblokowanie, sesja
  zablokowanego nic nie czyta).
- Faktury klienta — krok 4.

## D. Impostazioni — bez migracji

- `/admin/impostazioni`: dane firmy (`company_*`), anulowanie (X h, Y %), okno wypłaty (h, użyte w Etapie 6),
  próg alertu „paid bez przewoźnika” (`unassigned_alert_hours`). Zapis sesją admina (RLS + istniejące GRANT-y), zod,
  `audit()` ze zmienionymi polami i wartościami (to dane Transigo, nie dane osobowe klientów).
- Okno płatności, obszar, wyprzedzenie rezerwacji — zostają w „Area di servizio”. Szablony e-mail, użytkownicy admin
  — później.

## E. Magazzino — pozycje, bez migracji

- Druga sekcja `/admin/magazzino`: zlecenia z magazynem — „In arrivo” / „In magazzino” / „Ritirati” (ta sama
  logika co `storage-view.ts` u klienta), zlecenie, klient, palety, data wejścia (rozładunek odcinka 1), opłacone do
  (odbiór odcinka 2), dni naliczone/zostające, przewoźnik.
- Przyjęcie/wydanie = kroki przewoźnika (już są); „Invia link di pagamento” i lokalizacja w magazynie — **odłożone**
  z modelem B (D117).

## F. Dashboard — bez migracji

- Kafelki „Da gestire” (linki): `cancellation_review`, `payment_review`, zwroty `pending`/`failed`, otwarte
  reklamacje, „Da gestire” z przekazania (D136), `paid` bez przewoźnika > `unassigned_alert_hours`, nowe richieste,
  przewoźnicy/pojazdy/dokumenty do weryfikacji, dokumenty wygasające w 30 dni.
- Liczby za wybrany miesiąc (Europe/Rome): przychód brutto i netto (opłacone − zwroty), kwota dla przewoźników
  (z `order_leg_carrier_terms` — „previsto”, bo wypłat jeszcze nie ma), marża = netto − przewoźnicy, zlecenia wg
  statusu. Obliczenia czyste w `src/lib/admin/dashboard.ts` + testy (centy, jawne zaokrąglenia).

## Kolejność

1. A — migracja + testy RLS → logika + akcje (+ test „każdy eksport jako nie-admin”) + ekrany + mail.
2. B — ekrany + mail.
3. C — migracja + testy RLS → ekrany.
4. D, E, F — ekrany.
5. Menu admina, przegląd w przeglądarce, seed demo (zlecenia w `cancellation_review`, `payment_review`, zwrot
   `failed`, otwarta reklamacja), lista `docs/testy-reczne/panel-admina.md`.

Na stagingu: migracje tylko za zgodą właściciela w danej rozmowie (`npm run db:push`) — razem z czekającymi
`customer_cancellation` i `claims`.
