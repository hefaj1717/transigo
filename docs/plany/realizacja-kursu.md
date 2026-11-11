# Plan: realizacja kursu w PWA przewoźnika (statusy, zdjęcia, podpis, czas pracy tragarzy)

**Zatwierdzony przez właściciela 2026-11-11** (propozycje 1–9 + doprecyzowania niżej, D130). Po każdym kroku: testy, commit, push, krótkie „co sprawdzić” — i stop.

## Decyzje właściciela (2026-11-11)

1. Osobny przycisk „Inizia il viaggio”.
2. Kurs od dnia odbioru odcinka (Europe/Rome). Admin może zacząć wcześniej ręcznie (`admin_advance_order` → `picked_up` znosi ograniczenie dnia na odcinku 1).
3. Bez kolejki offline, ale **zrobione zdjęcie nie ginie**: przy błędzie sieci zostaje na ekranie, „Riprova” wysyła ten sam plik (ta sama ścieżka; `register_order_photo` idempotentne).
4. Jednorazowa lokalizacja przy kroku, nigdy nie blokuje, czyta ją tylko admin.
5. Magazyn w modelu A — patrz „Znane ograniczenie”.
6. Czas tragarzy w dół do pełnych minut.
7. Odbiorca nie podpisuje → „Contatta Transigo”; admin daje „Consegnato” bez POD **tylko z powodem** (notatka w historii statusów). Zdjęcia ze „Scarico completato” zostają.
8. Zdjęcia zmniejszane w przeglądarce: dłuższy bok ~1600 px, JPEG ~80 %; limity 1–10 na odcinek i rodzaj, ≤ 5 MB; podpis PNG ≤ 512 KB.
9. Retencja zdjęć i podpisów — TODO przed startem.
- Czas kroku zapisuje baza (`now()`), nie telefon; czas tragarzy liczy baza (`order_porters_worked_minutes`), odbiorca widzi wartość z serwera.
- Kroki tylko w kolejności, sprawdzane w bazie. Ponowne wysłanie kroku = bez duplikatu i bez błędu.
- Przewoźnik nie cofa kroku; cofnięcie ostatniego kroku tylko admin (`admin_revert_last_step`) z powodem w historii.
- Imię odbiorcy obowiązkowe.

## Znane ograniczenie (do modelu B, D117)

Zlecenie z magazynem: jeden przewoźnik na oba odcinki; przez cały czas składowania zlecenie ma status `in_transit` (w UI „In magazzino”); w magazynie tylko zdjęcie (bez podpisu); odbiorca w B potwierdza podpisem czas tragarzy **obu** odcinków. Odcinek 2 zaczyna się w swoim dniu odbioru, chyba że admin dopuści wcześniejszy start (`admin_allow_early_start`, jak dla odcinka 1). Do zmiany razem z modelem B — przed Etapem 7 i przed startem.

## Poprawki właściciela po kroku 1 (2026-11-11)

- Powody admina (Consegnato bez POD, cofnięcie kroku, wcześniejszy start) **tylko wewnętrznie** — tabela `order_admin_notes` (RLS: tylko admin). W historii statusów wiersz tylko przy zmianie statusu, bez notatki.
- „Rinuncia” zablokowana po „Carico completato” na dowolnym odcinku (`release_job` → `loaded`, „Il carico è già a bordo. Contatta Transigo.”). „Rimuovi padroncino” (admin) także w `picked_up`/`in_transit`, z ostrzeżeniem o załadowanym towarze. **Uwaga:** po odpięciu przy minionym oknie odbioru nikt nie przyjmie zlecenia (`too_late`) — TODO D122 (zmiana terminu / zwrot), do tego czasu ręcznie.
- `admin_allow_early_start(order, leg, admin, reason)` dla każdego odcinka.

## „Da gestire” — zdjęcie przewoźnika z towarem na pokładzie (2026-11-11, zatwierdzone)

Migracja `20261111120000_carrier_handover.sql` (na stagingu od 2026-11-11), testy `tests/rls/carrier-handover.test.ts`, wspólne helpery `tests/rls/execution-fixtures.ts`.
- „Rimuovi padroncino” przy towarze na pokładzie: status zostaje, przewoźnik zdjęty, znacznik `handover_required_at` (tylko admin); zlecenie poza listą kursów i `accept_job`.
- `admin_assign_handover` (kandydaci z `admin_job_candidates`, bez okna odbioru) + adres towaru (`order_handovers`, nowy przewoźnik i admin) + powód (`order_admin_notes`), mail `order_assigned`; albo „Consegnato” bez POD z powodem.
- Zakończone odcinki zostają przy zmianie przewoźnika; status do przodu od `loaded`/`departed` na każdym odcinku; `release_job` blokuje tylko odcinek załadowany i nierozładowany.
- Panel: znacznik i filtr „Da gestire” (`/admin/ordini`), sekcja „Da gestire” w szczegółach (`assignHandoverAction`).
- **Do kroku 4 (PWA):** na przejętym odcinku pokazać nowemu przewoźnikowi „Ritiro merce presso: …” z `order_handovers` zamiast adresu odbioru.
- Odpowiedzi właściciela: klient widzi dalej „Ritirato”/„In viaggio”; adres tylko dla nowego przewoźnika; czas tragarzy przejętego odcinka liczony od nowa; „Consegnato” bez przewoźnika — bez automatycznej wypłaty (decyzja admina w Etapie 6).
- Znana luka (TODO D122): zlecenie zdjęte, gdy towar jest w magazynie, wraca na listę, ale okno odbioru odcinka 1 minęło (`too_late`) — obsługa ręczna.

Zakres: Etap 4 — przewoźnik prowadzi przyjęty kurs: kolejne kroki na każdym odcinku, zdjęcia ładunku, podpis i imię odbiorcy (POD), czas pracy tragarzy (D69). Podstawa: spec 8.2 „Esecuzione corsa”, D19, D69, D74, D116, D117 (model A), D123, D128, `docs/db-schema.md` (projekt `order_photos`, `delivery_proofs`, bucketów).

**Poza zakresem (osobne plany):** ciągły GPS co 15 s i mapa dla klienta (Etap 5, D17, D25), „Segnala un problema” (D39, `order_issues`), faktura przewoźnika i wypłaty (Etap 6), link do dopłaty za nadgodziny (Etap 6, D69), kolejka offline, SMS.

## Punkt wyjścia

- Statusy zlecenia: `assigned → picked_up → in_transit → delivered`. Dziś zmienia je tylko admin (`admin_advance_order`, „Consegnato” = bez POD, `delivered_without_pod = true`, D123).
- `order_legs.porters_worked_minutes` istnieje (jedyna zmienna kolumna odcinka, D77) — dotąd nieużywana.
- `porterOvertimeCost()` w `src/lib/pricing/overtime.ts` (D68) — czysta, z testami.
- Mail `order_delivered` do klienta (`sendOrderDeliveredEmail`, outbox, D129: raz na zlecenie).
- Wzorzec wgrywania plików: przeglądarka → Storage → serwer sprawdza metadane obiektu i zapisuje wiersz sesją użytkownika (dokumenty przewoźnika, D103).

## Przepływ w aplikacji (model A, D117 — jeden przewoźnik na wszystkie odcinki)

Każdy odcinek ma te same kroki, w tej kolejności (przycisk na dole ekranu kursu zawsze pokazuje **jeden** następny krok):

| Krok odcinka | Przycisk (IT) | Wymaga | Zmiana statusu zlecenia |
|---|---|---|---|
| `arrived_pickup` | „Sono arrivato al ritiro” | dzień odbioru odcinka (pyt. 2) | — |
| `loaded` | „Carico completato” | ≥ 1 zdjęcie ładunku tego odcinka | odcinek 1: `assigned → picked_up` |
| `departed` | „Inizia il viaggio” | — | odcinek 1: `picked_up → in_transit` |
| `arrived_delivery` | „Sono arrivato alla consegna” | — | — |
| `unloaded` | „Scarico completato” | ≥ 1 zdjęcie przy dostawie tego odcinka | — |
| (ostatni odcinek) POD | „Conferma consegna” | imię odbiorcy + podpis na ekranie | `in_transit → delivered` |

- Zlecenie z magazynem (2 odcinki): po `unloaded` odcinka 1 zlecenie zostaje `in_transit`, w UI „In magazzino” (pyt. 5). Odcinek 2 zaczyna się w swoim dniu odbioru.
- **Czas pracy tragarzy (D69)** — tylko na odcinkach z tragarzami: `(loaded − arrived_pickup) + (unloaded − arrived_delivery)`, bez jazdy. Sekundy sumowane, potem w dół do pełnych minut (pyt. 6). Przewoźnik widzi go po `unloaded`; na ekranie podpisu odbiorca widzi czas każdego odcinka i ewentualne nadgodziny w godzinach (bez kwot — rozliczenie w Etapie 6) i podpisem go potwierdza. `complete_delivery` zapisuje `porters_worked_minutes` wszystkich odcinków w tej samej transakcji co POD.
- Każdy krok jest jednorazowy i nieodwracalny w aplikacji. Pomyłka → kontakt z Transigo (blok „Contatta Transigo” jak przy „Rinuncia”); korekta przez admina później.
- Zawieszony przewoźnik (D116) wykonuje wszystkie kroki przyjętych kursów normalnie (test).
- Admin nadal może przesunąć status ręcznie (`admin_advance_order`); kroki przewoźnika nigdy nie cofają statusu, a po `delivered` (także bez POD) są zablokowane.

## Zmiany w bazie (jedna migracja, **do akceptacji**)

`20261111100000_carrier_job_execution.sql`:

1. **Enumy:** `order_leg_step` (`arrived_pickup`, `loaded`, `departed`, `arrived_delivery`, `unloaded`), `order_photo_kind` (`pickup`, `delivery`; `claim` dojdzie z reklamacjami w Etapie 5).
2. **`order_leg_steps`** — append-only: `id`, `order_id`, `leg_index`, `step`, `created_at`, `created_by`, `lat`, `lng`; unikalne `(order_id, leg_index, step)`; FK do `order_legs`. Zapis tylko przez RPC. Odczyt: klient i przewoźnik — **bez `created_by`, `lat`, `lng`** (uprawnienia kolumn, jak D128); przewoźnik tylko kroki od swojego przypisania; admin wszystko.
3. **`order_photos`** — `id`, `order_id`, `leg_index`, `kind`, `storage_path` (unikalne, `{order_id}/{uuid}.jpg`), `size_bytes`, `uploaded_by`, `created_at`. Zapis przez RPC `register_order_photo()` (sprawdza obiekt w Storage: istnieje, `image/jpeg`, rozmiar ≤ 5 MB, ścieżka zlecenia); usunięcie przez `delete_order_photo()` tylko przez autora i tylko przed krokiem, który to zdjęcie zamyka (`loaded` / `unloaded`). Maks. 10 zdjęć na odcinek i rodzaj. Odczyt: klient — zdjęcia swojego zlecenia; przewoźnik — **tylko swoje** zdjęcia przypisanego zlecenia (nowy przewoźnik po „Rinuncia” nie widzi zdjęć poprzedniego); admin wszystko.
4. **`delivery_proofs`** (1:1 ze zleceniem) — `order_id` PK, `recipient_name` (1–200 znaków), `signature_path` (unikalne), `signed_at`, `created_by`, `lat`, `lng`. Niezmienne (trigger, każda rola). Odczyt: klient i przypisany przewoźnik bez `created_by/lat/lng`; admin wszystko.
5. **Storage:** prywatne buckety `order-photos` (`image/jpeg`, 5 MB) i `pod-signatures` (`image/png`, 512 KB). Wgrywa przypisany przewoźnik do folderu `{order_id}/` zlecenia w statusie `assigned`…`in_transit`; czyta klient zlecenia, przypisany przewoźnik (swoje pliki), admin. Bez nadpisywania i usuwania z przeglądarki (usuwa RPC + serwer).
6. **RPC (sesja przewoźnika, `auth.uid()`, `security definer`, blokada wiersza zlecenia):**
   - `carrier_record_step(order_id, leg_index, step, lat, lng)` — sprawdza przypisanie, status (`assigned`/`picked_up`/`in_transit`), kolejność kroków (poprzedni krok / poprzedni odcinek zamknięty), dzień odbioru (pyt. 2), zdjęcia przed `loaded`/`unloaded`; zapisuje krok i — gdy trzeba — status + `picked_up_at`/`in_transit_at` + historię (`carrier_app`, z `lat/lng`). Ponowne wywołanie tego samego kroku → bez zmian (`already_recorded`), bez błędu.
   - `register_order_photo(...)`, `delete_order_photo(photo_id)`.
   - `complete_delivery(order_id, recipient_name, signature_path, lat, lng)` — `unloaded` ostatniego odcinka, ≥ 1 zdjęcie dostawy, plik podpisu w Storage; w jednej transakcji: `delivery_proofs`, `porters_worked_minutes` z kroków, `in_transit → delivered`, `delivered_at`, historia. `delivered_without_pod` zostaje `false` (D123). Wiersz `payouts` — dopiero Etap 6.
   - `admin_order_execution(order_id)` dla `/admin/ordini/[id]` (pełne kroki z lat/lng), wzór `admin_order_status_history()`.
   - Kody błędów jak w `carrier_jobs` (`55000` + `detail`: `not_assigned`, `wrong_step`, `too_early`, `photo_required`, `delivered`, …).
7. **Testy RLS** `tests/rls/carrier-execution.test.ts`: pełny przebieg 1 i 2 odcinków; kolejność i podwójne kliknięcie; zdjęcie wymagane; obcy przewoźnik / klient / anon nic nie zapisują; nowy przewoźnik po rezygnacji nie widzi zdjęć poprzedniego; klient czyta POD i zdjęcia swojego zlecenia, nie cudzego; ukryte kolumny (`42501`); POD niezmienny także dla service role; `suspended` kończy kurs; po `admin_advance_order → delivered` kroki zablokowane; minuty tragarzy na granicach (59 s, pełne minuty).

## Kroki

- [x] **Krok 1 — migracja + testy RLS** — zrobione 2026-11-11, poprawki właściciela tego samego dnia; **na stagingu od 2026-11-11** (za zgodą, `db:list` — lokalne = zdalne). Testy: 24 w `carrier-execution.test.ts` (w tym zgodność `LEG_STEPS` i limitów bucketów z bazą). `20261111100000_carrier_job_execution.sql`, `tests/rls/carrier-execution.test.ts` (17 testów). Poza planem: `admin_advance_order(..., p_note)` — „Consegnato” bez POD wymaga powodu (22023 `note`), zmienione wywołania (`dispatch.ts`, `dispatch-server.ts`, pole „Motivo” w `/admin/ordini/[id]`, testy, `seed-demo.mjs`). Przy zmianie przewoźnika (rezygnacja / „Rimuovi padroncino”) trigger cofa jego kroki (`reverted_at`, `reverted_by` = null). `delete_order_photo` zwraca ścieżkę — plik usuwa serwer (krok 3).
- [x] **Krok 2 — czysta logika `src/lib/carriers/execution.ts` + testy** (zrobione 2026-11-11, `execution.test.ts`): `liveSteps`, `nextAction` (jeden następny krok albo POD, `notBefore` z dniem w Europe/Rome, wcześniejszy start), `isInWarehouse`, `porterSummaries` (minuty z bazy + nadgodziny w godzinach regułą `porterOvertimeCost`, bez kwot; `overtimeEnabled` poda serwer), `scaledSize` (1600 px), ścieżki plików i `isAlreadyUploaded` (dla „Riprova”), `recipientNameSchema`, `executionDbError` + `EXEC_MSG`. Plan pierwotny: następny krok i tekst przycisku, wymagania (zdjęcia, dzień), minuty tragarzy per odcinek i podgląd nadgodzin przez `porterOvertimeCost()`, mapowanie błędów RPC na włoskie komunikaty, etykiety „In magazzino” itp., daty w Europe/Rome.
- [x] **Krok 3 — serwer i akcje** (zrobione 2026-11-11, bez zmian w bazie): `src/lib/carriers/execution-server.ts` (sesja przewoźnika; klucz serwisowy tylko po udanym RPC — usunięcie pliku zwróconego przez `delete_order_photo` i mail `order_delivered`), schematy i typy `execution-actions.ts`, akcje `src/app/(padroncino)/padroncino/le-mie-corse/[id]/actions.ts`: `recordStepAction`, `createPhotoUploadAction` / `createSignatureUploadAction` (podpisany URL do wgrania sesją przewoźnika — przeglądarka wgrywa prosto do Storage, właścicielem obiektu jest przewoźnik; „Riprova” z tą samą ścieżką → `alreadyUploaded`), `registerPhotoAction`, `deletePhotoAction`, `completeDeliveryAction`. Mail `order_delivered` po każdym udanym `complete_delivery` (także powtórzonym) — outbox przepuszcza jeden na zlecenie, więc powtórne potwierdzenie dosyła mail, którego pierwsza próba się nie udała; błąd maila → log `[execution] order_delivered e-mail failed { orderId }`, dostawa zostaje. Błędy Storage → `uploadErrorMessage()` (413 → `photoTooBig`). Testy: `actions.test.ts` (każdy eksport jako nie-przewoźnik, `pending_review`/`rejected` odrzuceni z sesji, `suspended` przechodzi) i `tests/rls/carrier-execution-server.test.ts` (pełna ścieżka 1 i 2 odcinków, zła kolejność, przed dniem odbioru, za duże zdjęcie, „Riprova”, usuwanie, cudze zlecenie, błąd maila). Plan pierwotny: `execution-server.ts` (sesja przewoźnika; service role tylko do maila po udanym `complete_delivery` → `order_delivered`), akcje `recordStepAction`, `registerPhotoAction`, `deletePhotoAction`, `completeDeliveryAction` (DAL → status konta `active`/`suspended` → zod → RPC → `revalidatePath`), test „każdy eksport jako nie-przewoźnik”.
- [ ] **Krok 4 — ekran kursu (mobile-first, 375 px)** w `/padroncino/le-mie-corse/[id]` (+ adres przekazania z `order_handovers` na przejętym odcinku): oś kroków per odcinek, jeden przycisk następnego kroku w `stickyActionBar`, zdjęcia (`<input capture>` → przeskalowanie do 2000 px i JPEG w przeglądarce, podgląd, usuwanie przed zamknięciem kroku), opcjonalna lokalizacja przy kroku (pyt. 4), ekran „Conferma consegna”: imię odbiorcy (podpowiedź: kontakt dostawy), czas tragarzy do potwierdzenia, pole podpisu (własny canvas, pointer events, „Cancella”, bez nowej biblioteki), blokada podwójnego wysłania, błędy po włosku z „Riprova”. Baner „Tieni l'app aperta…” dopiero z GPS (Etap 5).
- [ ] **Krok 5 — klient i admin**: przyciski z powodem „Annulla ultimo passo” (`admin_revert_last_step`) i „Consenti inizio anticipato” (`admin_allow_early_start`), lista `order_admin_notes`; `/cliente/ordini/[id]` — sekcja „Prova di consegna” (imię odbiorcy, godzina, podpis, zdjęcia przez signed URL 5 min sesją klienta) i czas tragarzy; `/admin/ordini/[id]` — kroki z godzinami, zdjęcia, POD, minuty tragarzy, znacznik „senza firma e foto” bez zmian.
- [ ] **Krok 6 — seed, przegląd, dokumentacja**: kursy demo w różnych krokach (1 i 2 odcinki, z tragarzami), przejście w Playwright przy 375 px, lista `docs/testy-reczne/realizacja-kursu.md`, decyzje D130+ w spec, CLAUDE.md.

## Pytania do właściciela (proponowana odpowiedź w nawiasie)

1. **Osobny przycisk „Inizia il viaggio”** po „Carico completato”? (Tak — zgodnie ze spec; od niego w Etapie 5 rusza GPS.)
2. **Od kiedy można zacząć kurs?** (Od dnia odbioru odcinka w Europe/Rome — chroni przed przypadkowym kliknięciem kilka dni wcześniej; spóźnienie poza oknem dozwolone.)
3. **Kolejka offline** (spec 8: [DO USTALENIA])? (Nie w MVP — przy braku sieci komunikat i „Riprova”, wybrane zdjęcia zostają w formularzu do skutku.)
4. **Lokalizacja przy krokach** (jednorazowa, nie śledzenie)? (Tak, jeśli przeglądarka pozwoli; nigdy nie blokuje kroku; widzi ją tylko admin, D128.)
5. **Zlecenie z magazynem (model A):** status `in_transit` przez cały czas składowania, w UI „In magazzino”; w magazynie tylko zdjęcie, bez podpisu; odbiorca w B potwierdza podpisem czas tragarzy obu odcinków? (Tak — tymczasowo, do modelu B przed Etapem 7, D117.)
6. **Zaokrąglenie czasu tragarzy:** suma sekund odcinka w dół do pełnych minut? (Tak — na korzyść klienta; tolerancja D68 działa dalej.)
7. **Odbiorca nie chce podpisać / nie ma odbiorcy:** na razie „Contatta Transigo”, admin może dać „Consegnato” bez POD (D123); właściwa obsługa w „Segnala un problema” (D39). (Tak.)
8. **Limity zdjęć:** 1–10 na odcinek i rodzaj, JPEG po kompresji ≤ 5 MB; podpis PNG ≤ 512 KB. (Tak.)
9. **Retencja zdjęć i podpisów** (GDPR) — bez kasowania teraz, decyzja razem z D25/D35 przed startem? (Tak, TODO.)
