# Test ręczny: kursy przewoźnika (`/padroncino/corse`, „Le mie corse”)

Plan: `docs/plany/corse-padroncino.md`. Decyzje: D21, D116, D119–D121. Test na **lokalnej** bazie (Docker), aplikacja na `localhost:3000`.

> Kroki A–D (krok 4a planu): nawigacja, lista, szczegóły, „Accetta la Corsa”, „già accettata”, blokady. Kroki E–G (krok 4b): „Le mie corse” z zakładkami, „Rinuncia”, liczniki, konto zawieszone. **Kroki E–G zrób na świeżych seedach** (albo przed krokiem C) — w C Ferri przyjmuje 000011, co zmienia liczniki.

## Przygotowanie

1. Lokalny Supabase, czysta baza i oba seedy:

   ```sh
   npm run db:local:start
   npm run db:local:reset
   npm run db:local:seed-demo
   npm run db:local:seed-carriers
   ```

   - Skrypty działają **tylko na lokalnej bazie**: odmawiają, gdy `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` wskazuje gdzie indziej albo `supabase status` nie pokazuje `127.0.0.1:55321` / `:55322`.
   - **Ponowne uruchomienie niczego nie dokłada** — wypisuje istniejące zlecenia i loginy. Jeśli poprzednie uruchomienie się przerwało, skrypt każe zacząć od `db:local:reset`.
   - Kursy zależą od zegara (np. „Rinuncia bloccata” = przyjęty ponad 15 min temu, odbiór jutro). Na następny dzień testów: `db:local:reset` i oba seedy od nowa.
   - `npm run test:rls` kasuje dane — po nim uruchom seedy ponownie.
   - Seed zaraz po `db:local:reset` może skończyć się błędem `PGRST002` („schema cache”) — REST API jeszcze się uruchamia. Odczekaj ~30 s, zrób `db:local:reset` jeszcze raz i uruchom seed ponownie.

2. **Hasło** (wspólne dla wszystkich kont seeda) nie jest w repo: przy pierwszym uruchomieniu skrypt losuje je i zapisuje w `.seed-local/password` (ignorowany przez git):

   ```sh
   cat .seed-local/password
   ```

   Własne hasło: `SEED_PASSWORD='…' npm run db:local:seed-demo` (min. 10 znaków) — skrypt ustawia je na wszystkich kontach seeda, także przy ponownym uruchomieniu.

3. `npm run dev` na lokalnej bazie — `.env.development.local` jak w `docs/testy-reczne/admin-ordini.md` (krok 3 przygotowania), restart dev. Po teście usuń plik i zrestartuj dev.

4. Do testu dwóch przewoźników naraz: druga przeglądarka albo okno prywatne (osobna sesja).

## Konta demo

Numery zleceń jak na czystej bazie (`seed-demo` przed `seed-carriers`). Skrypt wypisuje je na końcu z datą odbioru.

| Konto | Kto | Co ma pokazać |
|---|---|---|
| `padroncino@example.com` | Marco Ferri, **Ferri Trasporti Srl**, aktywny, furgone medio `FT123AB` (1200 kg) | **Corse:** 000002, 000003 (z magazynem), 000010 (furgone piccolo — mniejszy pojazd też pasuje), 000011. **Nie widzi** 000012 (camion, 6 palet, 2,2 t) ani 000013 (blat 4 m, furgone grande). **Le mie corse:** 000004 (przypisane przez admina), 000005 (ritirato), 000006 (in viaggio), 000007 i 000008 (consegnati), **000014** — przyjęty 2 h temu, odbiór jutro → „Rinuncia” **zablokowana** (po terminie „Contatta Transigo”), **000015** — odbiór za 6 dni → „Rinuncia” **możliwa** (≥ 48 h). |
| `padroncino2@example.com` | Luca Galli, **Galli Logistica Srl**, aktywny, camion con sponda `GL456CD` (3000 kg) | **Corse:** 000002, 000003, 000010, 000011, **000012 i 000013** (za duże dla furgonu). **Le mie corse:** puste. Test „già accettata”: Ferri i Galli otwierają 000011, jeden przyjmuje, drugi dostaje komunikat D120 i odświeżoną listę. |
| `bianchi@example.com` | Trasporti Bianchi Srl, aktywny (seed padroncini) | **Corse:** jak Ferri (furgone medio `BI100CC`; `BI100AA` czeka na ponowną weryfikację, `BI100BB` nowy — nie liczą się do przyjęcia). **Le mie corse:** 000016 (przypisane przez admina). |
| `neri@example.com` | Trasporti Neri Srl, **zawieszony** (D116) | **Corse:** zamiast listy wyjaśnienie (konto zawieszone). **Le mie corse:** 000017 (odbiór za 5 dni) — zostaje u niego i **może zrezygnować**. |
| `verdi@example.com`, `viola@example.com` | w weryfikacji | Brak listy kursów (blokada „in verifica”); „Rinuncia” → „Operazione non consentita.” |
| `rosa@example.com` | odrzucony | j.w. |
| `gialli@example.com` | rejestracja niekompletna | Brak listy kursów, ekran onboardingu. |
| `cliente@example.com` | Giulia Conti, klient | Zlecenia 000001–000015; po „Accetta la Corsa” mail `order_assigned` w outboxie. |
| `admin@example.com` | Anna Admin (wspólny dla obu seedów) | `/admin/ordini`: przyjęcia i rezygnacje przewoźników w historii; po „Rinuncia” mail `carrier_released_job` do `ADMIN_NOTIFICATION_EMAIL`. |

Pozostałe zlecenia z `seed-demo` (000001 do zapłaty, 000009 wygasłe) nie są widoczne dla przewoźników.

## Telefon w tej samej sieci Wi-Fi

1. Na komputerze `npm run dev` — Next wypisuje adres w sieci, np. `Network: http://192.168.1.8:3000` (albo: `ipconfig getifaddr en0`).
2. Telefon w tej samej sieci Wi-Fi: otwórz `http://192.168.1.8:3000/accedi`. Baza zostaje na komputerze — z bazą łączy się serwer Next, nie telefon.
3. Przez adres IP Next blokuje tylko „hot reload” (w konsoli błędy `WebSocket … /_next/hmr`) — strony, logowanie i akcje działają; po zmianie kodu odśwież stronę ręcznie. Sprawdzone 2026-11-09.
4. Nie łączy się? macOS → Ustawienia → Sieć → Zapora: zezwól na połączenia dla `node`; sieć gościnna / „izolacja klientów” w routerze blokuje ruch między urządzeniami.
5. Service worker i instalacja PWA działają tylko w buildzie produkcyjnym przez HTTPS albo `localhost` — przez IP to zwykła strona. Do testu ekranów wystarcza.

## A. Nawigacja i układ (telefon albo DevTools 375 px)

1. Zaloguj się jako `padroncino@example.com` (Ferri). Na dole trzy pozycje: **Corse**, **Le mie corse**, **Profilo**; aktywna jest podświetlona.
2. Na iPhonie z paskiem domowym: nawigacja nad paskiem (safe-area), ostatni element strony i przycisk „Accetta la Corsa” **nie są zasłonięte**.
3. Żadna strona nie przewija się w poziomie; przyciski i linki wygodne do trafienia kciukiem (≥ 44 px).
4. **Profilo** → `/padroncino` (konto, „Vedi le corse disponibili”, veicoli, documenti).

## B. Lista i szczegóły (Ferri)

1. **Corse:** karty 000002, 000003 (z magazynem), 000010, 000011 — trasa (miasta i prowincje), okno odbioru w czasie włoskim, km, czas jazdy, typ pojazdu, kwota „per te”. **Nie ma** 000012 ani 000013.
2. „Aggiorna” → przycisk na chwilę „Aggiornamento…” i nieaktywny, lista ta sama.
3. Na karcie i w szczegółach **żadnej ulicy, telefonu ani nazwiska klienta** (np. „Via Italia”, „Conti”, „+39 333…”). Sprawdź też źródło strony (widok źródła / DevTools → Network → odpowiedź dokumentu).
4. Otwórz 000011: kwota (z rozbiciem, jeśli są tragarze/pakowanie), trasa, ritiro, piętra, carico, „Veicolo: Furgone medio · FT123AB”.
5. Otwórz 000003 (z magazynem): dwie tratte, „Magazzino …” jako przystanek.
6. Ostrzeżenie o nakładaniu (D120): jeśli kurs pokrywa się czasowo z kursem w toku Ferriego, nad kwotą „Attenzione: si sovrappone con …” z linkiem; przyjęcie nadal możliwe.

## C. „Accetta la Corsa” i „già accettata” (dwie sesje)

1. **Galli** (`padroncino2@example.com`, okno prywatne / druga przeglądarka): otwórz 000011 i **zostaw** stronę otwartą.
2. **Ferri:** 000011 → „Accetta la Corsa” → okno z trasą, datą, pojazdem i kwotą. „Annulla” (albo Esc, albo kliknięcie w tło) zamyka okno — nic się nie dzieje.
3. Ponownie „Accetta la Corsa” → „Conferma e accetta”: przycisk zmienia się na „Accettazione in corso…” i jest nieaktywny (szybkie podwójne kliknięcie nie wysyła drugi raz).
4. Przekierowanie na `/padroncino/le-mie-corse/[id]`: zielone „Corsa accettata. La trovi in «Le mie corse».”, pełne adresy, kontakty (telefon jako link `tel:`), merce, uwagi, pojazd, kwota.
5. `/admin/ordini` (admin) albo outbox: mail `order_assigned` do klienta dla 000011.
6. **Galli** na starej stronie: „Accetta la Corsa” → „Conferma e accetta” → przejście na listę z komunikatem „Questa corsa è già stata accettata da un altro padroncino. L'elenco è stato aggiornato.”; 000011 zniknęło, pozostałe kursy są (lista nie jest pusta).
7. Galli otwiera ponownie adres 000011 → „Questa corsa non è più disponibile.” + „Vedi le corse disponibili”.
8. Ferri otwiera adres `/padroncino/corse/<id 000011>` → przekierowanie do „Le mie corse” (kurs jest jego).
9. **Le mie corse** (Ferri): 000011 w zakładce „Da fare” razem z 000004, 000014, 000015.

## D. Blokady i błędy

1. `npm run db:local:seed-carriers`, zaloguj się jako `neri@example.com` (zawieszony): **Corse** → zamiast listy „Non puoi ancora vedere le corse disponibili” z wyjaśnieniem i „Cosa fare →”.
2. `verdi@example.com` (w weryfikacji): to samo (konto nieaktywne).
3. Pusta lista: Galli po przyjęciu przez siebie wszystkich kursów (albo na bazie bez kursów) → „Nessuna corsa disponibile al momento” + „Aggiorna”.
4. Błąd ładowania: zatrzymaj lokalną bazę (`npm run db:local:stop`) i odśwież **Corse** → „Non è stato possibile caricare le corse.” + „Riprova”. Po `npm run db:local:start` „Riprova” ładuje listę.

## E. „Le mie corse” i liczniki (Ferri, świeże seedy)

1. **Profilo** (`/padroncino`): kafelki **4 — Corse disponibili →**, **3 — Da fare →** i szeroki **2 — Corse in corso →**. Każdy kafelek prowadzi do właściwej listy / zakładki.
2. **Le mie corse:** trzy zakładki z licznikami **Da fare 3 / In corso 2 / Concluse 2**; aktywna podświetlona.
   - *Da fare:* 000014, 000004, 000015 (najbliższy odbiór pierwszy), etykieta „Da ritirare”.
   - *In corso:* 000005 („Ritirato”), 000006 („In viaggio”).
   - *Concluse:* 000007, 000008 (najnowsze pierwsze), „Consegnato”.
3. Zakładki działają też po odświeżeniu strony i przyciskiem „wstecz” (adres `?tab=in-corso` itd.). Zmyślony `?tab=xyz` → „Da fare”.
4. Galli (`padroncino2@example.com`): każda zakładka ma swój pusty stan („Nessuna corsa da fare / in corso / conclusa”); w „Da fare” przycisk „Vedi le corse disponibili”.
5. Szczegóły dowolnego kursu: „Ritiro” (kiedy, pełny adres, piano, kontakt z „Chiama +39…”), „Consegna” (adres, piano, kontakt, dystans), przy każdym „Apri in Google Maps” (otwiera nawigację do adresu), „Merce e servizi”, „Note del cliente”, kwota, „Storico” (godziny w czasie włoskim). „← Le mie corse” wraca do zakładki tego kursu.
6. 000003-podobne zlecenie z magazynem (np. po przyjęciu 000003): dwie tratte, kontakt klienta tylko przy pierwszym odbiorze i ostatniej dostawie, przy magazynie „Magazzino Transigo”.

## F. „Rinuncia alla corsa” (Ferri)

1. **000014** (przyjęty 2 h temu, odbiór jutro): **brak** przycisku „Rinuncia”; zamiast niego żółty blok **„Contatta Transigo”** z tekstem o minionym terminie i telefonem / e-mailem Transigo (z `settings.company_*`; gdy puste — link „Scrivici dalla pagina Contatti”).
2. **000015** (odbiór za 6 dni): nad przyciskiem **„Puoi rinunciare fino alle 14:00 di …”** — termin = 48 h przed początkiem okna odbioru, w czasie włoskim.
3. „Rinuncia alla corsa” → okno: „tornerà disponibile per gli altri padroncini”, „Non vedrai più indirizzi e contatti”, „Il team Transigo riceverà un avviso”. „No, tengo la corsa” / Esc / kliknięcie w tło zamyka okno — nic się nie dzieje.
4. Ponownie → **„Sì, rinuncio alla corsa”**: przycisk „Rinuncia in corso…”, nieaktywny (podwójne kliknięcie nie wysyła drugi raz).
5. Powrót na „Le mie corse” z zielonym „Hai rinunciato alla corsa. La corsa torna disponibile…”; *Da fare* = 2, 000015 zniknęło. Stary adres kursu → „nie znaleziono”.
6. Galli → **Corse**: 000015 jest na liście.
7. Outbox (Studio albo `docker exec supabase_db_TransiGo psql -U postgres -c "select template_code, subject from email_outbox where template_code='carrier_released_job'"`): mail „Rinuncia alla corsa TG-2026-000015 – Ferri Trasporti Srl”.
8. `too_late` w trakcie (opcjonalnie): otwórz 000015 w dwóch kartach u Ferriego **przed** krokiem 4, zrezygnuj w jednej, w drugiej kliknij „Sì, rinuncio” → „Questa corsa non è più assegnata a te.” (bez błędu technicznego). Wariant „termin minął w trakcie” (baza zwraca `too_late`) pokazuje ten sam blok „Contatta Transigo” co pkt 1 — sprawdzony testem (`actions.test.ts`, `carrier-job-screens.test.ts`).

## G. Konto zawieszone (Neri, `neri@example.com`)

1. **Profilo:** „Account sospeso” z powodem, pod nim karta **„Le mie corse” — „1 corsa da fare o in corso: restano assegnate a te.”** z licznikiem 1.
2. Karta → „Le mie corse” → 000017 w „Da fare”; szczegóły z adresami i kontaktami.
3. „Puoi rinunciare fino alle …” → „Rinuncia alla corsa” → „Sì, rinuncio” → powrót z komunikatem; mail `carrier_released_job` dla 000017 w outboxie.
4. **Profilo:** „Nessuna corsa da fare o in corso.” **Corse:** nadal blokada (konto zawieszone).
5. `verdi@example.com` (w weryfikacji): „Le mie corse” puste; rezygnacja niemożliwa (brak kursów; akcja zwraca „Operazione non consentita.” — test).

## Telefon (do sprawdzenia przez właściciela)

- 360–390 px: zakładki z licznikami mieszczą się w jednym wierszu, brak przewijania w poziomie.
- Okno „Rinuncia” wysuwa się od dołu, przyciski nad paskiem domowym iPhone'a (safe-area).
- „Chiama +39…” otwiera dzwonienie, „Apri in Google Maps” — aplikację map z nawigacją.
