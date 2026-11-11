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
  `day_cents`, `month_cents`, `is_active`, kolejność. Tylko admin; opublikowanego cennika nie da się zmienić.
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
3. Migracja 1 — cennik (SQL do akceptacji) + `/admin/listini`.
4. Strona publiczna (sekcja 4).
5. Migracja 2 — zlecenia (SQL do akceptacji) + filtr w `/admin/ordini`.
6. Kreator Facchini → płatność → admin przypisuje → „Consegnato”.
7. Kreator Deposito, płatność z góry (bez rat): porto io / ritiro Transigo / consegna dalej.
8. Kreator Trasporto: „Deposito Transigo”, tragarze z ceną.
9. Panele klienta i admina (sekcja 7).
10. Raty miesięczne (subskrypcja Stripe z datą końca, faktura za ratę, alert „Rata non pagata”) i „Prolunga”.
11. Seed demo, testy ręczne (`docs/testy-reczne/tre-servizi.md`), E2E, staging — za zgodą właściciela.

## 9. Do pamiętania

- Stare zlecenia z dwoma odcinkami (dane demo) zostają czytelne; nowe ich nie tworzą.
- Zasada „towaru nie wydajemy przy zaległej racie” — do regulaminu (Termini).
- Raty: faktura przy każdej racie (D2) — **[DO POTWIERDZENIA Z COMMERCIALISTA]**.
