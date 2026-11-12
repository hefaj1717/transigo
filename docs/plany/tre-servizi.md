# Plan: trzy równorzędne usługi — Trasporto, Facchinaggio, Deposito (2026-11-11)

**Status:** plan zatwierdzony przez właściciela 2026-11-11 (D151–D160). Nic jeszcze nie zrobione.
Każda migracja: przed zapisem SQL pokazujemy go właścicielowi i czekamy na zgodę (CLAUDE.md).

Cel: Transigo to trzy równorzędne usługi, nie „transport z dodatkami”. Magazyn i tragarze widoczne od razu na
stronie głównej, każda usługa ma własną podstronę i własny kreator. Teksty po włosku, kwoty w centach.

## 1. Decyzje (szczegóły w `docs/spec.md`, sekcja 0)

- **D151** — trzy usługi: `orders.service_type` = `transport | porters | storage` (UI: Trasporto / Facchinaggio /
  Deposito). Imballaggio zostaje dodatkiem do transportu.
- **D152** — facchinaggio wykonują przewoźnicy z `carriers.offers_porters = true` i `porters_team_size` (2–4);
  bez nowej roli. Udział przewoźnika = `carrier_share_porters`. Do PWA: przypisuje admin (D122).
- **D153** — łańcuch „odbiór → magazyn → dostawa dalej” = jedna rezerwacja, **jedna płatność, jedna faktura**;
  w bazie osobne, powiązane zlecenia (`parent_order_id`), każdy transport osobnym kursem z osobną wypłatą.
  **Zastępuje model B (D117)** — kreator nie tworzy już zleceń z dwoma odcinkami; długie składowanie odblokowane.
- **D154** — deposito zawsze na **okres stały** (od–do). Privati: boxy z cennika (nazwa, m³, stawka dzienna
  i miesięczna). Aziende: palety × dni (progi D55).
- **D155** — płatność: do 2 miesięcy całość z góry; powyżej 2 miesięcy wybór „Paga tutto ora” / „Paga ogni mese”
  (subskrypcja Stripe z datą końca, rata = faktura).
- **D156** — „Prolunga” z panelu klienta, gdy box / miejsca paletowe są wolne w nowym okresie (pojemność magazynu
  w bazie, sprawdzana pod blokadą).
- **D157** — bez dopłaty za odległość od parkingu i bez osobnej opłaty za przeładunek (zostaje *transbordo* 0 dni).
- **D158** — adresy: `/trasporto`, `/facchinaggio`, `/deposito`; kreatory `/prenota/trasporto|facchini|deposito`;
  stare `/servizi/*` → 308.

## 2. Silnik cenowy (czyste funkcje + testy, `src/lib/pricing/`)

- `portersServiceCost({ persons, hours, floorsWithoutElevator }, config)`:
  `persons × max(hours, porters_min_hours) × porter_hour + floors × porters_floor_no_elevator`
  + dopłaty pilne / weekend od pozycji tragarzy (D159).
  Osoby: `porters_min_persons` (domyślnie 2) … 4. Nadgodziny jak D68 (warunki zapisane w wycenie).
- `storageBoxCost({ box, days }, config)`: pełne miesiące (30 dni) × stawka miesięczna + reszta dni × stawka dzienna,
  reszta **nie droższa niż jeden miesiąc**; minimum 1 dzień.
- `storageCost()` (palety, D55) bez zmian; `transshipment_flat` dla 0 dni.
- `installmentPlan(total, startDate, endDate)`: raty miesięczne (podział w centach, reszta w pierwszej racie —
  jawnie w kodzie), tylko gdy okres > 2 miesiące.
- Testy (stawki-placeholdery): „2 tragarzy, 3 h, 4. piętro bez windy” = 2×3×30 € + 4×10 € = 220,00 € netto,
  IVA 48,40 €, razem 268,40 €; „5 palet, 20 dni” = 300,00 € netto; box: 2 dni, 30 dni, 45 dni, granica „reszta
  nie droższa niż miesiąc”; minimum godzin; raty z resztą centów.

## 3. Migracja 1 — cennik (`pricing_services`)

- `price_rule_code` + `porters_floor_no_elevator`.
- `price_lists.porters_min_hours` (domyślnie 2), `porters_min_persons` (domyślnie 2).
- `price_list_storage_boxes` (wersjonowana jak `price_list_porter_packages`): `code`, `label_it`, `volume_m3`,
  `day_cents`, `month_cents`, `is_enabled`, `sort_order`. Tylko admin; opublikowanego cennika nie da się zmienić.
- `config-from-db.ts`, `/admin/listini` (nowe pola i tabela boxów), testy RLS `tests/rls/pricing.test.ts`.

## 4. Strona publiczna

- Strona główna: `HeroTabs` (Trasporto | Facchini | Deposito). Transport = obecny formularz (`hero-form.tsx`).
  Facchini i Deposito: mini-kalkulator w przeglądarce na publicznych stawkach (te same czyste funkcje; dane
  przekazane ze strony statycznej, bez kwot przewoźnika), dopisek „prezzo indicativo”, przycisk → kreator
  z wypełnionymi polami (query string).
- `ServiceCards` (3 karty tej samej wielkości), `AudienceSection` („Per privati” — trasloco: trasporto + facchini +
  deposito; „Per aziende” — pallet, transbordo, stoccaggio breve e lungo).
- Nagłówek: „Servizi” rozwijane z 3 pozycjami; menu mobilne.
- `/trasporto`, `/facchinaggio` (do czego: salita/discesa, carico/scarico, spostamenti interni; cennik orientacyjny;
  FAQ), `/deposito` (privati: boxy, cennik; aziende: palety, transbordo; FAQ). Teksty w `content.ts`.
  Przekierowania 308 z `/servizi/*`, `sitemap.ts`, JSON-LD FAQ.

## 5. Migracja 2 — zlecenia (`three_services`)

- `service_type` enum, `orders.service_type` (istniejące = `transport`), `orders.parent_order_id`.
- `vehicle_type_id`, kontakt dostawy: wymagane tylko dla `transport` (check).
- `order_porter_jobs`: adres (jak odcinek), prowincja, data + okno (D73), osoby, godziny, piętro, winda, opis rzeczy.
  Przewoźnik czyta tylko gdy przypisany (lista kursów zanonimizowana jak dziś).
- `warehouse_capacity`: magazyn × rozmiar boxu → liczba; magazyn → miejsca paletowe.
- `warehouse_bookings`: `order_id`, `warehouse_id`, `unit` (`box` | `pallet`), `box_code` / `pallets`,
  `start_date`, `end_date` (wymagane), `payment_plan` (`upfront` | `monthly`), `intake` (`self` | `transigo`),
  `outbound` (`self` | `transigo` | `later`), `status` (`booked` → `in_storage` → `released` / `cancelled`).
  Zajętość = pojemność − rezerwacje nakładające się datami (nieopłacone tylko do `payment_due_at`, D88);
  kontrola w funkcji pod blokadą (wyścig o ostatni box — test).
- `carriers.offers_porters`, `carriers.porters_team_size`.
- `create_order()`: trzy rodzaje; łańcuch tworzy zlecenia w jednej transakcji (nadrzędne = pierwsze w łańcuchu).
- Płatność grupy: Checkout dla zlecenia nadrzędnego, `confirm_order_payment` opłaca grupę; jedna faktura
  (`invoices.order_id` = nadrzędne, pozycje ze wszystkich zleceń grupy); zwrot części = nota do tej faktury.
- Lista kursów / `accept_job` / `admin_job_candidates`: `porters` tylko dla `offers_porters` z ekipą ≥ osoby;
  `storage` nigdy u przewoźników. Nowe `order_line_type`: `porters_floors`.
- Testy RLS: widoczność per rola, kwoty klienta niewidoczne dla przewoźnika, deposito poza listą kursów,
  pojemność, płatność grupy (idempotencja webhooka).

## 6. Kreatory

- Wspólne kroki wydzielone (konto, kontakty, riepilogo, płatność) z obecnego `wizard.tsx`.
- **Facchini** (`/prenota/facchini`): indirizzo → data e fascia → numero di facchini (min. 2) → ore stimate (min.
  z cennika) → piano / ascensore → cosa spostare → preventivo → account → contatti → riepilogo → pagamento.
  Obszar obsługi: prowincja adresu musi być aktywna.
- **Deposito** (`/prenota/deposito`): privato/azienda → box lub palety → data inizio + data fine (dostępność na
  żywo) → come arriva la merce (porto io / ritiro Transigo → kroki transportu) → come esce (ritiro io / consegna
  Transigo → adres i okno = `end_date` / lo deciderò più avanti) → facchini opzionali (na transportach) →
  pagamento (raty, gdy > 2 mies.) → preventivo → account → riepilogo → pagamento.
- **Trasporto**: krok miejsca docelowego „Indirizzo” | „Deposito Transigo” (box/palety, okres, dalsza dostawa —
  ten sam komponent co w Deposito); magazyn znika z „Servizi extra”; tragarze jako wyraźna karta z ceną
  (kategorie D67 zostają).

## 7. Panele

- Klient: typ usługi na kartach i w szczegółach; grupa łańcucha razem; `/cliente/deposito` na `warehouse_bookings`
  („Prolunga”, „Richiedi la consegna” dla `outbound = later`).
- Admin: filtr typu usługi w `/admin/ordini`, szczegóły per typ, grupa łańcucha; `/admin/listini` (krok 3);
  `/admin/magazzino` — pojemność i rezerwacje; `/admin/padroncini` — „offre facchinaggio”.
- Przewoźnik (minimum do demo): pola facchinaggio w profilu; karta kursu facchinaggio na liście. Ekran realizacji
  facchinaggio w PWA — z resztą PWA.

## 8. Kolejność (po każdym kroku commit + push)

1. Decyzje D151–D158 + ten plan. ✔
2. Silnik cenowy (sekcja 2). ✔ (2026-11-11; stawka za piętro w `PricingConfig.portersService.floorNoElevatorCents` — loader wypełni ją z reguły `porters_floor_no_elevator` w kroku 3)
3. Migracja 1 — cennik (SQL do akceptacji) + `/admin/listini`. ✔ (2026-11-11, D161; migracje `20261111190000_pricing_services_code.sql` + `20261111190001_pricing_services.sql` lokalnie; opublikowane cenniki bez zmian — usługi dostępne po „Crea bozza” → „Pubblica”)
4. Strona publiczna (sekcja 4). ✔ (2026-11-11, D162; kalkulatory → `/contatti` do kroków 6–7 — wtedy zmienić `REQUEST_PATH` w `src/lib/public/requests.ts`)
5. Migracja 2 — zlecenia (SQL do akceptacji) + filtr w `/admin/ordini`. Podzielony (D163):
   - **5a ✔** (2026-11-11; migracje **na stagingu od 2026-11-11**, za zgodą właściciela): migracje `20261111200000_three_services_enum.sql` + `20261111200001_three_services.sql`
     (SQL zatwierdzony przez właściciela, bez zmian względem szkicu), testy `tests/rls/three-services.test.ts` (29: tylko
     service role, walidacje porters/storage, pojemność i wyścig o ostatni box, widoczność per rola, brak na liście kursów
     i u kandydatów admina, kolumny niezmienne). Aplikacja: `src/lib/orders/service-type.ts` (etykiety, filtr, pomocnicze
     depozytu), `/admin/ordini` — filtr „Servizio” (łączy się z filtrem statusu), oznaczenie typu, Deposito poza
     „Da assegnare”; szczegóły admina i klienta bez odcinków (sekcja Facchinaggio / Deposito zamiast „Percorso”);
     `orderTitle()` na kartach klienta; dashboard: alert bez Deposito, kwota przewoźnika facchinaggio w „Incassi”.
     Test ręczny `docs/testy-reczne/tre-servizi.md` (A).
   - Krok 6 przejmuje: przypisywanie facchinaggio (`offers_porters`, ekipa ≥ osoby) w `list_available_jobs` / `accept_job` /
     `admin_job_candidates` / `admin_assign_job`. Krok 7: łańcuch, jedna płatność i faktura grupy. Krok 10: raty.
   - **TODO z 5a (przed pierwszym zleceniem porters/storage z aplikacji, kroki 6–7):** mail `order_paid`
     (`sendOrderPaidEmail` w `src/lib/payments/server.ts`), `customer-emails.ts` i `cancellation-server.ts` zakładają
     odcinek `legs[0]`; Checkout dostaje pusty opis trasy. Klient nie czyta `warehouses` (RLS) — adres magazynu dla
     „porto io” podać inaczej (funkcja albo snapshot w rezerwacji). Anulowanie depozytu: tekst „24 ore prima del ritiro”
     liczy od północy pierwszego dnia — sprawdzić z D33.
6. Kreator Facchini → płatność → admin przypisuje → „Consegnato”. ✔ (2026-11-12, D164–D168; migracja
   `20261112100000_porters_dispatch.sql` **na stagingu od 2026-11-12**, za zgodą właściciela; `db:list` — lokalne = zdalne):
   - **6a** — migracja: `list_available_porter_jobs` / `accept_porter_job` (sesja przewoźnika, bez pojazdu),
     `admin_porter_candidates` / `admin_assign_porter_job` / `admin_set_carrier_porters` (service role, audit
     `carrier.porters_updated`), `carrier_fits_porter_job`, `vehicle_fits_order()` tylko dla transportu,
     `admin_advance_order` dla porters `assigned → picked_up → delivered` (bez `in_transit`), `admin_unassign_job`
     odmawia po rozpoczęciu (`work_started`). Testy `tests/rls/porters-dispatch.test.ts`.
   - **6b** — `src/lib/orders/order-summary.ts`: jedno podsumowanie per usługa zamiast `legs[0]` w mailach
     (`order_paid`, `order_assigned`, `order_delivered`, `order_cancelled`, `cancellation_requested`,
     `carrier_job_cancelled`) i w opisie Stripe Checkout. Zamyka TODO z 5a poza adresem magazynu dla klienta (krok 7).
   - **6c** — `src/lib/booking/porters/`: stan kreatora, `quotePorters` (miejsce ustala serwer, pełna wycena w
     `quotes` z `kind = 'porters'`, przeglądarka dostaje `toPublicQuote`), `placePortersOrder` (kontrole jak D76,
     `create_service_order`, kwota przewoźnika tylko w `porter_terms`).
   - **6d** — kreator `/prenota/facchini` (`/api/booking/porters-quote`, `submitPortersBooking` → Stripe Checkout);
     wspólne z kreatorem transportu: `AccountStep`, `BillingFields`, `TermsCheckbox`, `toWizardSession`. Kalkulator
     `/facchinaggio` → kreator z wypełnionymi wartościami (`parsePortersPrefill`; `REQUEST_PATH.facchinaggio`).
   - **6e** — admin: „Assegna facchini” (bez pojazdu), „Segna lavoro iniziato” / „Segna lavoro concluso” (z powodem,
     D123), „Rimuovi padroncino” tylko w `assigned`, „Squadra insufficiente” (lista i szczegóły),
     `/admin/padroncini/[id]` „Offre facchinaggio” + ekipa z ostrzeżeniem (D167). PWA: karta facchinaggio na liście,
     „Accetta” bez pojazdu (`acceptJobAction` z `kind=porters`), „Le mie corse” z adresem, kontaktem i ekipą,
     „Rinuncia”. Etykiety statusów per usługa (`orderStatusLabel`, `customerStatusLabel`, `carrierJobStatusLabel`,
     `nextStatusFor`), pasek klienta bez „In viaggio”. Testy `tests/rls/porters-screens.test.ts`.
   - **6f** — seed demo (Ferri ekipa 2, Galli ekipa 4, TG-26…29 przez `portersOrder()` = silnik + payload kreatora,
     `EXPECTED_ORDERS = 29`), szczegóły admina bez „Esecuzione” i ze znacznikiem „Concluso senza firma del cliente”,
     test ręczny `docs/testy-reczne/tre-servizi.md` (B).
   - **TODO po kroku 6:**
     - Nadgodziny tragarzy facchinaggio: `order_porter_jobs.worked_minutes` zostaje `NULL`, ekran realizacji
       facchinaggio w PWA (start/koniec pracy, podpis klienta, D68/D69) — z resztą PWA (D166).
     - Powiadomienia przewoźników o nowych kursach facchinaggio (D168) — z powiadomieniami PWA.
     - Wypłata (Etap 6): facchinaggio od `delivered`, kwota z `order_porter_carrier_terms` (nie od `worked_minutes`);
       `delivered_without_pod = true` (zakończenie przez admina) tylko decyzją admina — test.
     - Seed stagingu z 2026-11-11 ma 25 zleceń, a `EXPECTED_ORDERS = 29` — ponowny seed na stagingu kończy się
       „Seed demo incompleto sullo staging” i niczego nie dokłada; rozwiązać w kroku 11 (np. dosiew samych zleceń
       facchinaggio albo pulizia kont demo — decyzja właściciela).
     - `/prenota` to nadal kreator transportu; wybór usługi w `/prenota` (D158) — krok 8.
7. Kreator Deposito, płatność z góry (bez rat): porto io / ritiro Transigo / consegna dalej. ✔ (2026-11-12, D169–D173;
   migracja `20261112110000_storage_chain.sql` — **lokalnie**, na staging po zgodzie właściciela):
   - **7a** — migracja: `create_service_order` tworzy łańcuch w jednej transakcji (`intake_transport` /
     `outbound_transport` w kształcie `create_order`, jeden odcinek do / z magazynu rezerwacji, odbiór w `start_date`,
     dostawa w `end_date`; ciało `create_order` przeniesione do wewnętrznej `create_transport_order`), zlecenia
     podrzędne biorą termin płatności nadrzędnego; płatność, wygaszanie, `payment_review`, `queue_invoice` i zwroty dla
     całej grupy (zwrot na konkretnym zleceniu, limit = jego kwota); `customer_cancel_order` — grupa tylko w całości
     (D169), depozyt do startu (D170); `customer_order_warehouse()` (D171). Testy `tests/rls/storage-chain.test.ts`.
   - **7b** — `src/lib/orders/order-group.ts` (+ `order-group-server.ts`): Checkout i „Annulla ordine” na zleceniu
     nadrzędnym, jedna pozycja Checkout z opisem łańcucha, jeden mail `order_paid` / `order_cancelled` z częściami
     grupy (adres magazynu przy „porto io”), faktura i noty DEMO z pozycjami całej grupy, wiele zwrotów Stripe.
   - **7c** — `src/lib/booking/storage/`: `quoteStorage` (cena depozytu, pojemność, transporty łańcucha z polecanym
     pojazdem i `calculatePrice`), `placeStorageOrder`; testy `tests/rls/place-storage-order.test.ts`.
   - **7d** — kreator `/prenota/deposito` (`/api/booking/storage-quote`, `/api/booking/storage-availability` — tylko
     tak/nie), kalkulator `/deposito` → kreator (`parseStoragePrefill`, `REQUEST_PATH.deposito`).
   - **7e** — `OrderGroupCard` w `/cliente/ordini/[id]` i `/admin/ordini/[id]`; u admina płatność grupy i limit zwrotu
     zlecenia; u klienta adres magazynu i podgląd anulowania grupy (`groupCancellationPreview`).
   - **7f** — seed: pojemność magazynu (`ensureWarehouseCapacity`, tylko gdy pusta), TG-30 box, TG-31→32→33 łańcuch,
     `azienda@example.com` z paletami (TG-34), `EXPECTED_ORDERS = 33`; test ręczny `docs/testy-reczne/tre-servizi.md` (C).
   - Zamyka TODO z 5a: adres magazynu dla klienta (D171), tekst anulowania depozytu (D170).
   - **TODO po kroku 7:**
     - Nadpłata łańcucha (więcej niż suma grupy) → zwrot przez admina odmawia `overpaid_chain`, różnica ręcznie w
       Stripe — razem z otwartą decyzją o nadpłacie (D141).
     - Zwrot podwójnej płatności łańcucha jest dzielony na zlecenia i liczy się do ich limitów (jak dziś przy
       pojedynczym zleceniu) — do przemyślenia z D141.
     - Dostawa z magazynu (np. za 6 miesięcy) trafia na listę kursów od razu po opłaceniu — do decyzji: pokazywać
       przewoźnikom dopiero X dni przed terminem.
     - Kontakt magazynu w transportach łańcucha = nazwa magazynu + `settings.company_phone`; bez telefonu firmy —
       telefon klienta (lokalnie tak jest). Uzupełnić `company_*` przed startem (TODO już w CLAUDE.md).
     - `admin_decide_cancellation` nie obsługuje grup (zlecenie z grupy nigdy nie trafia do `cancellation_review`).
     - `warehouse_bookings.status`: krok 7 ustawia tylko `cancelled` (anulowanie klienta); `in_storage` / `released`
       i lista `/cliente` z grupą jako jedną kartą — krok 9.
     - Pojazd transportów łańcucha dobiera serwer (najmniejszy pasujący do wagi / wymiarów / palet); klient nie wybiera.
     - Strona `/deposito` (FAQ, lista korzyści) wspomina raty powyżej 2 miesięcy, a kreator ich jeszcze nie ma (D172) —
       teksty do przeglądu albo krok 10.
     - Seed stagingu: nadal 25 zleceń (`EXPECTED_ORDERS = 33`) — krok 11.
8. Kreator Trasporto: „Deposito Transigo”, tragarze z ceną.
9. Panele klienta i admina (sekcja 7).
10. Raty miesięczne (subskrypcja Stripe z datą końca, faktura za ratę, alert „Rata non pagata”) i „Prolunga”.
11. Seed demo, testy ręczne (`docs/testy-reczne/tre-servizi.md`), E2E, staging — za zgodą właściciela.

## 9. Do pamiętania

- Stare zlecenia z dwoma odcinkami (dane demo) zostają czytelne; nowe ich nie tworzą.
- Zasada „towaru nie wydajemy przy zaległej racie” — do regulaminu (Termini).
- Raty: faktura przy każdej racie (D2) — **[DO POTWIERDZENIA Z COMMERCIALISTA]**.
