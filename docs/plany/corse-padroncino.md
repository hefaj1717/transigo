# Plan: ekrany kursów przewoźnika („Accetta la Corsa”, „Rinuncia”)

**Zamknięty 2026-11-09** — wszystkie kroki zrobione. Otwarte sprawy przeniesione do CLAUDE.md (sekcja „Odłożone: PWA przewoźnika”) i D128.

Zatwierdzony przez właściciela 2026-11-09. Po każdym kroku: testy, commit, push, krótkie podsumowanie „co sprawdzić” — i stop (nowa sesja zaczyna od tego pliku).

## Punkt wyjścia

- Baza gotowa: migracja `20261110100000_carrier_jobs.sql` (na stagingu) — `carrier_job_eligibility()`, `list_available_jobs(p_order_id)` (bez danych osobowych, D119), `accept_job()` (jeden wygrywa), `release_job()` (15 min od przyjęcia albo ≥ 48 h przed odbiorem), blokada pojazdu w kursie. Testy: `tests/rls/carrier-jobs.test.ts`.
- Zrobione już w bazie (TODO z CLAUDE.md do odhaczenia): `active` wymagane do listy i przyjęcia (D21, D116) oraz blokada zmian pojazdu w kursie — oba z testami.
- „Le mie corse” czyta zlecenia sesją przewoźnika przez istniejące RLS.
- **Bez zmian schematu.** Gdyby wyszła potrzeba migracji — stop, plan, zgoda.

## Decyzje właściciela (2026-11-09)

1. Po „Rinuncia” **bez maila do klienta**. Luka: outbox ma jeden mail na zlecenie i szablon, więc po ponownym przypisaniu klient nie dostaje drugiego `order_assigned` (jak po „Rimuovi padroncino”) — TODO w CLAUDE.md.
2. **Bez maila do admina przy przyjęciu** kursu (mail tylko przy rezygnacji, D121).
3. (po kroku 3) „Rinuncia”: `active` i `suspended` (D116) mogą zrezygnować; `pending_review` i `rejected` dostają „Operazione non consentita.” — zatwierdzone.
4. Kolejność kroków zmieniona: po kroku 3 najpierw **krok 5 (seed)**, potem krok 4 podzielony na **4a** i **4b**.

## Zasady dla wszystkich kroków

- Wszystkie godziny w UI (okno odbioru, „Puoi rinunciare fino alle …”) w strefie **Europe/Rome**, niezależnie od strefy serwera — z testem.
- `releaseAllowed` w TS służy **tylko do wyświetlania**; o zgodzie decyduje zawsze `release_job` w bazie. Testy granic: dokładnie 15 min po przyjęciu i dokładnie 48 h przed odbiorem (obie granice włącznie, jak w SQL).
- „Accetta la Corsa” i „Rinuncia”: przycisk zablokowany w trakcie wysyłania. Ponowne `accept_job` tego samego przewoźnika na ten sam kurs zwraca `newly_assigned = false` (bez błędu) — UI pokazuje „già accettata da te”, nigdy „già accettata da un altro padroncino” (test).
- Po błędzie `already_taken` lista kursów jest odświeżana.
- Kwoty zawsze w centach; formatowanie dopiero w UI (it-IT, €).
- Skrypty seed odmawiają działania, gdy `SUPABASE_URL` nie wskazuje na lokalną bazę.

## Kroki

- [x] **Krok 1 — czysta logika `src/lib/carriers/jobs.ts` + testy** (`jobs.test.ts`)
  - mapowanie wierszy `list_available_jobs` na karty (trasa z miast i magazynu, km, czas jazdy, okno odbioru, „Urgente”, ładunek, usługi, kwota z rozbiciem w centach);
  - teksty blokad z `carrier_job_eligibility` z linkiem „co poprawić”;
  - komunikaty błędów `accept_job` / `release_job` po włosku (D120 dla `already_taken`) + flaga „odśwież listę”;
  - wynik `accept_job`: `newly_assigned = false` → „già accettata da te”;
  - `releaseDeadline` / `releaseInfo` (tylko wyświetlanie; granice włącznie);
  - `overlappingJobs()` — ostrzeżenie o nakładaniu (D120);
  - zakładki „Le mie corse”: *Da fare* / *In corso* / *Concluse*;
  - formatowanie godzin w Europe/Rome (test przy różnych `TZ`).
- [x] **Krok 2 — serwer `src/lib/carriers/jobs-server.ts` (sesja przewoźnika)** — zrobione 2026-11-09. Service role przekazywany jako fabryka (`JobNotifyDeps.serviceDb()`), wołana dopiero po udanym RPC (test liczy wywołania). Mail `carrier_released_job` zapisywany **bez `order_id`** (klucz outboxu: jeden mail na zlecenie i szablon), żeby każda rezygnacja dawała mail (D121); link do zlecenia w treści. Numer, okno odbioru i godzinę przyjęcia `releaseJob` czyta sesją przewoźnika **przed** RPC (potem zlecenie już nie jest jego).
  - `loadEligibility`, `listAvailableJobs`, `loadAvailableJob`, `loadMyJobs`, `loadMyJob` (pełne dane dopiero po przyjęciu);
  - `acceptJob(orderId, vehicleId)`: RPC sesją przewoźnika, po sukcesie (tylko `newly_assigned`) mail `order_assigned` do klienta przez service role (outbox); błąd maila nie cofa przyjęcia;
  - `releaseJob(orderId)`: RPC sesją przewoźnika, potem mail do admina (nowy szablon `carrier_released_job`: numer, firma, data odbioru, link do `/admin/ordini/[id]`, bez danych klienta) przez service role; bez `ADMIN_NOTIFICATION_EMAIL` rezygnacja przechodzi, błąd w logach;
  - testy na lokalnej bazie `tests/rls/carrier-job-screens.test.ts`: bez ulic i kontaktów przed przyjęciem; przyjęcie → `order_assigned` w outboxie; podwójne przyjęcie → bez drugiego maila i bez „già accettata da un altro”; rezygnacja → mail do admina; zawieszony widzi swoje kursy i rezygnuje, nie widzi listy.
- [x] **Krok 3 — Server Actions `src/app/(padroncino)/padroncino/corse/actions.ts`** — zrobione 2026-11-09. Plik eksportuje tylko `acceptJobAction` i `releaseJobAction` (zod i bramki statusu w `src/lib/carriers/job-actions.ts`, `jobNotifyDeps()` w `job-deps.ts`). Kolejność: `requireArea` → status z sesji (przyjęcie: `active`; rezygnacja: `active`/`suspended`, D116) → zod (`z.uuid()`) → `jobs-server.ts` → `revalidatePath`. Przyjęcie zwraca `href` do `/padroncino/le-mie-corse/[id]` (przekierowanie robi UI w kroku 4). `acceptJob` dostał `userId`: id zlecenia do maila `order_assigned` jest odczytywane sesją przewoźnika **po** udanym `accept_job` (`id` + `carrier_id` = sesja), bo RPC nie zwraca `order_id` (bez migracji).
  - `acceptJobAction`, `releaseJobAction`: `requireArea("padroncino")` → zod → logika → `revalidatePath`;
  - test „każdy eksport jako nie-przewoźnik” (niezalogowany, cliente, admin, zablokowany padroncino): nic nie dociera do RPC ani service role; sesja przed service role.
- [x] **Krok 5 — seed i listy testów ręcznych** — zrobione 2026-11-09 (przed krokiem 4).
  - Wspólny moduł `scripts/lib/local-seed.mjs`: strażniki (`SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, jeśli ustawione, muszą wskazywać `http://127.0.0.1:55321`; `supabase status` = 55321/55322; SQL tylko w kontenerze z kontrolą gniazda), konta „znajdź albo utwórz” po stałym e-mailu, zlecenia przez silnik cenowy i kod kreatora.
  - **Bez duplikatów:** każdy skrypt sprawdza znacznik ukończenia (demo: 15 zleceń klienta i dostawy przesunięte w przeszłość; padroncini: Rosa odrzucona). Jest → wypisuje dane i kończy; częściowy stan → każe zacząć od `db:local:reset`. Admin `admin@example.com` wspólny dla obu seedów.
  - **Hasło poza repo:** `SEED_PASSWORD` albo `.seed-local/password` (git-ignored, losowane przy pierwszym uruchomieniu); każde uruchomienie ustawia je na kontach seeda.
  - `seed-demo.mjs`: drugi aktywny przewoźnik Galli (camion) do „già accettata”; opłacone kursy 000010 (furgone piccolo), 000011 (test „già accettata”), 000012 (camion, 6 palet) i 000013 (blat 4 m, furgone grande) — dwa ostatnie za duże dla furgonu medio; 000014 przyjęty przez Ferriego (`accept_job` jego sesją) i przesunięty o 2 h wstecz, odbiór jutro → Rinuncia zablokowana; 000015 odbiór za 6 dni → Rinuncia możliwa. Sprawdzone sesjami: Ferri widzi 02, 03, 10, 11; Galli także 12, 13; `release_job` na 000014 → `too_late`.
  - `seed-local-carriers.mjs`: Bianchi z kursem przypisanym przez admina (pojazd `BI100CC`, ostrzeżenie przy „Sospendi”), Neri z kursem przypisanym przed zawieszeniem (odbiór za 5 dni — może zrezygnować), drugi przewoźnik w weryfikacji (Viola) zamiast ponownego uruchomienia seeda w kroku B4.
  - `docs/testy-reczne/corse-padroncino.md` (konta demo i co pokazują; kroki testu dojdą w 4a/4b i 6); zaktualizowane `admin-padroncini.md` (D116), `admin-ordini.md`, `panel-klienta.md`.
- [x] **Krok 4a — nawigacja, lista, szczegóły i „Accetta la Corsa” (mobile-first)** — zrobione 2026-11-09.
  - dolna nawigacja `CarrierShell` (`src/components/padroncino/bottom-nav.tsx`): *Corse*, *Le mie corse*, *Profilo* (= `/padroncino`); stała na dole z safe-area, `main` rezerwuje jej wysokość;
  - `/padroncino/corse`: karty (`job-views.tsx`, bez danych osobowych), „Aggiorna”, „Nessuna corsa disponibile al momento”, błąd z „Riprova”, przy blokadach wyjaśnienie z „Cosa fare →” zamiast listy;
  - `/padroncino/corse/[id]`: szczegóły bez danych osobowych (D119), kwota z rozbiciem, wybór pojazdu (gdy > 1), ostrzeżenie o nakładaniu (D120), przycisk „Accetta la Corsa” przyklejony nad nawigacją → okno potwierdzenia (trasa, data, pojazd, kwota; „Annulla”, Esc, kliknięcie tła) → „Conferma e accetta” zablokowany z napisem „Accettazione in corso…” (+ blokada podwójnego kliknięcia); własny kurs → przekierowanie do „Le mie corse”; kurs niedostępny → „Questa corsa non è più disponibile.”;
  - błąd z `refreshList` (np. `already_taken`) → `/padroncino/corse?avviso=<klucz JOB_MSG>`: komunikat + odświeżona lista (w URL tylko klucz z białej listy `JOB_LIST_NOTICES`, testy w `jobs.test.ts`);
  - po przyjęciu: `/padroncino/le-mie-corse/[id]?esito=accettata|gia-tua` — potwierdzenie i pełne dane (adresy, kontakty `tel:`, merce, uwagi, pojazd, kwota);
  - `/padroncino/le-mie-corse`: na razie prosta lista (cel dla nawigacji) — zakładki w 4b.
- [x] **Krok 4b — „Le mie corse”, „Rinuncia”, liczniki, konto zawieszone** — zrobione 2026-11-09. Zakładki to linki `?tab=` (biała lista, domyślnie *Da fare*) z licznikami (`countMyJobs`, `jobsForTab` — *Concluse* od najnowszych), pusty stan po włosku dla każdej. Szczegóły: per odcinek „Ritiro”/„Consegna” (okno, pełny adres, piętro, kontakt `tel:` przy pierwszym odbiorze i ostatniej dostawie, „Apri in Google Maps” z lat/lng), merce i usługi („Solo trasporto”), uwagi, kwota, „Storico”. „Rinuncia” (`release-job.tsx`): „Puoi rinunciare fino alle HH:MM di …” (Europe/Rome) nad przyciskiem, okno `alertdialog` (fokus na „No, tengo la corsa”), „Rinuncia in corso…” + blokada ref, sukces → `/padroncino/le-mie-corse?esito=rinuncia` (biała lista `MY_JOBS_NOTICES`). Po terminie i przy `too_late` z bazy (`ReleaseResult.tooLate`) ten sam blok „Contatta Transigo” (telefon/e-mail z `settings.company_*`, bez nich link do `/contatti`). `/padroncino` (aktywny): kafelki „Corse disponibili” i „Da fare” (+ „In corso”, gdy > 0); „Account sospeso”: karta „Le mie corse” z licznikiem kursów do zrobienia / w toku. Sprawdzone w Playwright przy 375 px (lista kroków E–G w `docs/testy-reczne/corse-padroncino.md`).
  - `/padroncino/le-mie-corse`: zakładki *Da fare* / *In corso* / *Concluse*;
  - rozbudowa `/padroncino/le-mie-corse/[id]` (np. nawigacja do adresu, historia statusów);
  - „Rinuncia alla corsa” z potwierdzeniem, terminem (Europe/Rome) i blokadą przycisku; po terminie „Contatta Transigo” („Segnala un problema” D39 — w kroku realizacji);
  - `/padroncino` (aktywny): liczniki dostępnych i „Da fare”;
  - zawieszony (D116): na „Account sospeso” link i licznik „Le mie corse”.
- [x] **Krok 6 — przegląd w przeglądarce i dokumentacja** — zrobione 2026-11-09.
  - Przegląd kodu `a2cc49f..HEAD`: dane osobowe przed przyjęciem i po rezygnacji, service role dopiero po sesji i udanym RPC (id do maila czytane sesją przewoźnika), w `corse/actions.ts` tylko `acceptJobAction` i `releaseJobAction`, do UI tylko teksty `JOB_MSG` (bez błędów bazy), daty Europe/Rome i kwoty `formatCents` — bez problemów. Poprawione: stary link `/padroncino/le-mie-corse/[id]` (po rezygnacji / „Rimuovi padroncino”) zamiast angielskiego 404 pokazuje „Questa corsa non è più assegnata a te.”; statusy kursu w rodzaju żeńskim jak w „Storico” („Ritirata”, „Consegnata”, „Completata”); „Trasbordo” zamiast „Transbordo” w `jobs.ts`.
  - Nowy test `tests/rls/carrier-job-history.test.ts` (rezygnacja i „Rimuovi padroncino” → drugi przewoźnik): poprzedni nie czyta nic ze zlecenia, nowy nie widzi firmy/pojazdów/dokumentów poprzedniego ani `audit_log`. **Znaleziona luka D128:** `order_status_history.changed_by` pokazuje nowemu przewoźnikowi UUID poprzedniego — `it.fails`, naprawa wymaga migracji (do decyzji).
  - Przejście w przeglądarce (Playwright, 375 px, świeże seedy): przyjęcie 000011 → `order_assigned` w outboxie, „già accettata” u Galliego + odświeżona lista, 000014 bez „Rinuncia” z „Contatta Transigo”, 000015 „Puoi rinunciare fino alle 14:00 di venerdì 13 novembre.” → rezygnacja → mail `carrier_released_job` → stary adres z komunikatem → 000015 wraca u Galliego; Neri (zawieszony): blokada listy, rezygnacja z 000017 + mail.
  - Decyzje D127, D128 w `docs/spec.md`; CLAUDE.md zaktualizowane.
  - Widok na telefonie — do sprawdzenia przez właściciela (wynik testu po 4b nie został podany).

## TODO do przeniesienia do CLAUDE.md (krok 6)

- ~~Brak drugiego `order_assigned`…~~ — przeniesione do CLAUDE.md jako jedno TODO „migracja klucza outboxu” (razem z `carrier_released_job` bez `order_id`).
- ~~Możliwa pętla przyjmij/zrezygnuj…~~ — przeniesione do CLAUDE.md.
