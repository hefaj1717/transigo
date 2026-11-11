# Plan: realizacja kursu w PWA przewoźnika (statusy, zdjęcia, podpis, czas pracy tragarzy)

**Status: projekt do akceptacji właściciela (2026-11-11).** Nic nie jest jeszcze zrobione. Po akceptacji: po każdym kroku testy, commit, push, krótkie „co sprawdzić” — i stop.

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

- [ ] **Krok 1 — migracja + testy RLS** (lokalnie). Staging dopiero po osobnej zgodzie w rozmowie.
- [ ] **Krok 2 — czysta logika `src/lib/carriers/execution.ts` + testy**: następny krok i tekst przycisku, wymagania (zdjęcia, dzień), minuty tragarzy per odcinek i podgląd nadgodzin przez `porterOvertimeCost()`, mapowanie błędów RPC na włoskie komunikaty, etykiety „In magazzino” itp., daty w Europe/Rome.
- [ ] **Krok 3 — serwer i akcje**: `execution-server.ts` (sesja przewoźnika; service role tylko do maila po udanym `complete_delivery` → `order_delivered`), akcje `recordStepAction`, `registerPhotoAction`, `deletePhotoAction`, `completeDeliveryAction` (DAL → status konta `active`/`suspended` → zod → RPC → `revalidatePath`), test „każdy eksport jako nie-przewoźnik”.
- [ ] **Krok 4 — ekran kursu (mobile-first, 375 px)** w `/padroncino/le-mie-corse/[id]`: oś kroków per odcinek, jeden przycisk następnego kroku w `stickyActionBar`, zdjęcia (`<input capture>` → przeskalowanie do 2000 px i JPEG w przeglądarce, podgląd, usuwanie przed zamknięciem kroku), opcjonalna lokalizacja przy kroku (pyt. 4), ekran „Conferma consegna”: imię odbiorcy (podpowiedź: kontakt dostawy), czas tragarzy do potwierdzenia, pole podpisu (własny canvas, pointer events, „Cancella”, bez nowej biblioteki), blokada podwójnego wysłania, błędy po włosku z „Riprova”. Baner „Tieni l'app aperta…” dopiero z GPS (Etap 5).
- [ ] **Krok 5 — klient i admin**: `/cliente/ordini/[id]` — sekcja „Prova di consegna” (imię odbiorcy, godzina, podpis, zdjęcia przez signed URL 5 min sesją klienta) i czas tragarzy; `/admin/ordini/[id]` — kroki z godzinami, zdjęcia, POD, minuty tragarzy, znacznik „senza firma e foto” bez zmian.
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
