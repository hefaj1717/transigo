# Plan: ekrany kursów przewoźnika („Accetta la Corsa”, „Rinuncia”)

Zatwierdzony przez właściciela 2026-11-09. Po każdym kroku: testy, commit, push, krótkie podsumowanie „co sprawdzić” — i stop (nowa sesja zaczyna od tego pliku).

## Punkt wyjścia

- Baza gotowa: migracja `20261110100000_carrier_jobs.sql` (na stagingu) — `carrier_job_eligibility()`, `list_available_jobs(p_order_id)` (bez danych osobowych, D119), `accept_job()` (jeden wygrywa), `release_job()` (15 min od przyjęcia albo ≥ 48 h przed odbiorem), blokada pojazdu w kursie. Testy: `tests/rls/carrier-jobs.test.ts`.
- Zrobione już w bazie (TODO z CLAUDE.md do odhaczenia): `active` wymagane do listy i przyjęcia (D21, D116) oraz blokada zmian pojazdu w kursie — oba z testami.
- „Le mie corse” czyta zlecenia sesją przewoźnika przez istniejące RLS.
- **Bez zmian schematu.** Gdyby wyszła potrzeba migracji — stop, plan, zgoda.

## Decyzje właściciela (2026-11-09)

1. Po „Rinuncia” **bez maila do klienta**. Luka: outbox ma jeden mail na zlecenie i szablon, więc po ponownym przypisaniu klient nie dostaje drugiego `order_assigned` (jak po „Rimuovi padroncino”) — TODO w CLAUDE.md.
2. **Bez maila do admina przy przyjęciu** kursu (mail tylko przy rezygnacji, D121).

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
- [ ] **Krok 2 — serwer `src/lib/carriers/jobs-server.ts` (sesja przewoźnika)**
  - `loadEligibility`, `listAvailableJobs`, `loadAvailableJob`, `loadMyJobs`, `loadMyJob` (pełne dane dopiero po przyjęciu);
  - `acceptJob(orderId, vehicleId)`: RPC sesją przewoźnika, po sukcesie (tylko `newly_assigned`) mail `order_assigned` do klienta przez service role (outbox); błąd maila nie cofa przyjęcia;
  - `releaseJob(orderId)`: RPC sesją przewoźnika, potem mail do admina (nowy szablon `carrier_released_job`: numer, firma, data odbioru, link do `/admin/ordini/[id]`, bez danych klienta) przez service role; bez `ADMIN_NOTIFICATION_EMAIL` rezygnacja przechodzi, błąd w logach;
  - testy na lokalnej bazie `tests/rls/carrier-job-screens.test.ts`: bez ulic i kontaktów przed przyjęciem; przyjęcie → `order_assigned` w outboxie; podwójne przyjęcie → bez drugiego maila i bez „già accettata da un altro”; rezygnacja → mail do admina; zawieszony widzi swoje kursy i rezygnuje, nie widzi listy.
- [ ] **Krok 3 — Server Actions `src/app/(padroncino)/padroncino/corse/actions.ts`**
  - `acceptJobAction`, `releaseJobAction`: `requireArea("padroncino")` → zod → logika → `revalidatePath`;
  - test „każdy eksport jako nie-przewoźnik” (niezalogowany, cliente, admin, zablokowany padroncino): nic nie dociera do RPC ani service role; sesja przed service role.
- [ ] **Krok 4 — ekrany (mobile-first, `CarrierShell`)**
  - dolna nawigacja: *Corse*, *Le mie corse*, *Profilo*;
  - `/padroncino` (aktywny): liczniki dostępnych i „Da fare”;
  - `/padroncino/corse`: karty, „Aggiorna”, przy blokadach wyjaśnienie zamiast listy;
  - `/padroncino/corse/[id]`: szczegóły bez danych osobowych, kwota, wybór pojazdu (gdy > 1), ostrzeżenie o nakładaniu, „Accetta la Corsa” z potwierdzeniem i blokadą przycisku → `/padroncino/le-mie-corse/[id]`; `already_taken` → komunikat + odświeżenie listy;
  - `/padroncino/le-mie-corse` (+ `[id]`): zakładki, pełne adresy, kontakty `tel:`, uwagi, piętra, usługi, kwota; „Rinuncia alla corsa” z potwierdzeniem, terminem (Europe/Rome) i blokadą przycisku; po terminie „Contatta Transigo” („Segnala un problema” D39 — w kroku realizacji);
  - zawieszony (D116): na „Account sospeso” link i licznik „Le mie corse”.
- [ ] **Krok 5 — seed i listy testów ręcznych**
  - `seed-demo.mjs`: opłacone nieprzypisane kursy różnej wielkości (część za duża dla furgonu), drugi aktywny przewoźnik („già accettata”), kurs przyjęty > 15 min temu i < 48 h przed odbiorem (Rinuncia zablokowana);
  - `seed-local-carriers.mjs`: kurs przypisany (ostrzeżenie przy „Sospendi”, D116);
  - oba skrypty odmawiają działania poza lokalną bazą (`SUPABASE_URL`);
  - `docs/testy-reczne/corse-padroncino.md` + dopisek w `admin-padroncini.md`.
- [ ] **Krok 6 — przegląd w przeglądarce i dokumentacja**
  - lokalnie na demo: przyjęcie → mail w outboxie, „già accettata” z drugiego konta, Rinuncia w obu wariantach, zawieszony przewoźnik;
  - CLAUDE.md (odhaczone TODO, nowe TODO niżej), decyzje w `docs/spec.md` sekcja 0;
  - widok na telefonie — do sprawdzenia przez właściciela.

## TODO do przeniesienia do CLAUDE.md (krok 6)

- Brak drugiego `order_assigned` po ponownym przypisaniu (po „Rinuncia” albo „Rimuovi padroncino”) — klucz outboxu jeden mail na zlecenie i szablon.
- Możliwa pętla przyjmij/zrezygnuj w oknie 15 min (blokowanie kursu przez jednego przewoźnika) — później licznik rezygnacji w panelu admina.
