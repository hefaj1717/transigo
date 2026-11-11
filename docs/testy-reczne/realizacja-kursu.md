# Test ręczny: realizacja kursu w PWA przewoźnika (kroki 4–6)

Plan: `docs/plany/realizacja-kursu.md`. Decyzje: D69, D116, D117 (model A), D130, D132. Test na **lokalnej** bazie (Docker).
Automatycznie to samo sprawdza `npm run test:e2e` (iPhone 13 / WebKit i Pixel 7 / Chromium, emulacja) — ten test ręczny
jest po to, żeby sprawdzić **prawdziwy telefon**: aparat, palec na ekranie, Safari i Chrome.

## Przygotowanie (wariant A — telefon w tej samej sieci Wi-Fi)

1. Komputer i telefon w **tej samej sieci Wi-Fi** (nie sieć gościnna — ona często blokuje urządzenia między sobą).
2. Adres komputera w sieci: `ipconfig getifaddr en0` (np. `192.168.1.8`). Niżej zamiast `192.168.1.8` wpisz swój.
3. Baza i dane demo:

   ```sh
   npm run db:local:start
   npm run db:local:reset
   npm run db:local:seed-demo
   cat .seed-local/password
   ```

4. W pliku `.env.development.local` zmień **jedną linię** (telefon wysyła zdjęcia prosto do bazy, więc musi znać jej adres w sieci):

   ```
   NEXT_PUBLIC_SUPABASE_URL=http://192.168.1.8:55321
   ```

   Pozostałe linie (`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) bez zmian. **Po teście** przywróć
   `http://127.0.0.1:55321`.
5. Zatrzymaj działający `npm run dev` (Ctrl+C w jego oknie) i uruchom:

   ```sh
   DEV_LAN_HOST=192.168.1.8 npm run dev -- -H 0.0.0.0
   ```

6. Na telefonie: `http://192.168.1.8:3000/accedi` → `padroncino@example.com` + hasło z kroku 3.
   macOS może zapytać, czy pozwolić aplikacji „node” na połączenia przychodzące — **Pozwól**.

**Ograniczenia wariantu A** (po `http`, nie `https`): przeglądarka nie poda lokalizacji (kurs przechodzi bez niej —
lokalizacja jest opcjonalna), nie da się zainstalować PWA, a rejestracja przewoźnika i wgrywanie jego dokumentów nie
działają (inne ekrany, nie część tego testu). Pełny test z lokalizacją: wariant B (staging, `https`) po kroku 4.

Kursy do testu (konto Ferri, odbiór **dziś**; po północy zrób znów krok 3):
- **TG-2026-000016** — jedna tratta, facchini (monolocale), piano 3 senza ascensore.
- **TG-2026-000017** — z magazynem (2 tratte), facchini przy odbiorze i dostawie.

Każdy kurs da się przejść raz. Na powtórkę: krok 3 od nowa.

## A. Ekran kursu (000016) — iPhone (Safari) i Android (Chrome)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| A1 | „Le mie corse” → 000016 | Na górze karta „Ritiro”: adres, piano, „Contatto: Giulia Conti”, zielony przycisk „Chiama +39…”, przyciski „Google Maps” i „Apple Maps”. Na dole duży przycisk „Sono arrivato al ritiro” w zasięgu kciuka, nad dolną nawigacją. |
| A2 | „Chiama …” | Telefon proponuje połączenie z numerem. |
| A3 | „Google Maps” / „Apple Maps” | Otwiera nawigację do adresu odbioru (na iPhonie Apple Maps w aplikacji Mapy). Wróć do aplikacji. |
| A4 | „Sono arrivato al ritiro” (jedno dotknięcie, bez okna) | „Passaggi”: ✓ „Arrivato al ritiro” z godziną. Przycisk: „Carico completato” **szary**, nad nim „Aggiungi almeno una foto.” |
| A5 | Szybkie podwójne dotknięcie przycisku w A4 (na nowym kursie) | Zapisany tylko jeden krok, bez błędu. |

## B. Zdjęcia

| # | Krok | Oczekiwany wynik |
|---|---|---|
| B1 | „Scatta foto” | Otwiera się **aparat** (nie galeria). Zrób zdjęcie, zatwierdź. |
| B2 | Po zatwierdzeniu | Miniatura z paskiem postępu → po chwili zdjęcie zapisane, licznik „1/10”. Zdjęcie **nie jest obrócone** (pion / poziom jak w aparacie). |
| B3 | Włącz tryb samolotowy, „Scatta un'altra foto”, zrób zdjęcie | Komunikat „Connessione assente o lenta…”, na miniaturze „Riprova” i „Elimina”. Przycisk „Carico completato” zablokowany („Una foto non è stata caricata…”). |
| B4 | Wyłącz tryb samolotowy, „Riprova” | Zdjęcie się wgrywa, licznik „2/10” (to samo zdjęcie, bez duplikatu). |
| B5 | „×” na jednym zdjęciu | Zdjęcie znika, „1/10”. |
| B6 | Zdjęcie poziome i pionowe, zdjęcie w słabym świetle | Wgrywa się w kilka sekund (zmniejszone do ~1600 px). |

## C. Kroki nieodwracalne

| # | Krok | Oczekiwany wynik |
|---|---|---|
| C1 | „Carico completato” | **Okno w aplikacji** (nie systemowe) „Carico completato?” z „Sì, confermo” i „Annulla”. |
| C2 | „Annulla”, potem znów „Carico completato” → „Sì, confermo” | Krok zapisany; zdjęć już nie da się usunąć ani dodać. Przycisk: „Inizia il viaggio”. |
| C3 | „Inizia il viaggio” → „Sono arrivato alla consegna” | Jednym dotknięciem każdy. Karta zmienia się na „Consegna” (adres, kontakt Paolo Conti, mapy). |
| C4 | Zdjęcie dostawy → „Scarico completato” → okno → „Sì, confermo” | Przycisk „Conferma consegna”, nad osią „Tempo di lavoro dei facchini” (minuty, „Incluse nel prezzo: 2 h”). |

## D. Potwierdzenie dostawy (podpis)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| D1 | „Conferma consegna” | Ekran „Conferma consegna”: czas tragarzy **przed** podpisem, pole „Nome di chi riceve la merce”, przycisk „Riceve Paolo Conti”, pole podpisu „Firma qui con il dito”. |
| D2 | „Conferma consegna” bez imienia i podpisu | „Scrivi il nome di chi riceve la merce.” i „Chiedi al destinatario di firmare nel riquadro.” — nic nie jest wysyłane. |
| D3 | Podpis palcem | Linia idzie za palcem, **strona się nie przewija** podczas podpisu. |
| D4 | „Cancella” | Pole czyste. Podpisz ponownie. |
| D5 | Obróć telefon w poziom i z powrotem | Podpis zostaje (przerysowany). |
| D6 | Wpisz imię → „Conferma consegna” → okno „Confermi la consegna…?” → „Sì, consegna effettuata” | Pasek „Invio firma… %”, potem kurs: „Consegna confermata. Grazie!” i „Consegnata a … il …”. |
| D7 | Tryb samolotowy przed D6 | Błąd „Connessione assente…”, w oknie „Riprova”; po wyłączeniu trybu „Riprova” kończy dostawę. Mail `order_delivered` tylko **jeden** (D9). |
| D8 | Na komputerze `/admin/ordini` (admin@example.com) | 000016 „Consegnato”, bez znacznika „senza firma e foto”. |
| D9 | `/admin/email` albo tabela `email_outbox` w Studio (`http://127.0.0.1:55323`) | Dokładnie jeden `order_delivered` dla 000016. |

## E. Zlecenie z magazynem (000017)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| E1 | Tratta 1 do „Sono arrivato al magazzino” → zdjęcie → „Scarico in magazzino completato” → okno | Żółty komunikat „In magazzino: …”, przycisk „Sono arrivato al magazzino” (tratta 2). |
| E2 | Tratta 2 do końca | Karta pokazuje „Ritiro · tratta 2” (magazyn), potem „Consegna · tratta 2” z kontaktem Marta Conti. |
| E3 | „Conferma consegna” | Czas tragarzy **obu** tratt („Tratta 1”, „Tratta 2”) przed podpisem. Dostawa jak w D6. |

## G. Klient — zlecenia 000019–000021 (komputer albo telefon, `cliente@example.com`)

Dane z `npm run db:local:reset && npm run db:local:seed-demo` (na końcu seed wypisuje linki do 000018–000022).
Tę część można robić na komputerze (`http://localhost:3000`), bez Wi-Fi.

| # | Krok | Oczekiwany wynik |
|---|---|---|
| G1 | `/cliente` → 000019 („Trasloco bilocale…”, „In viaggio”) | Sekcja ze zdjęciami **z odbioru** (2), bez zdjęć z dostawy i bez „Prova di consegna”. „Tempo di lavoro dei facchini”: ok. 45 min, „in corso”, inclusi 2 h. **Bez kwot**. |
| G2 | 000020 („10 scatoloni di libri…”, „Consegnato” wczoraj) | „Prova di consegna”: „Anna Conti”, godzina wczoraj ok. 10:20, podpis widoczny. Zdjęcia z odbioru (2) i z dostawy (1). Czas tragarzy 1 h 20 min, inclusi 1 h — **bez kwoty i bez słowa o dopłacie**. |
| G3 | 000021 („Arredo ufficio…”, magazyn) | Zdjęcia z odbioru tratty 1 widoczne; zdjęcie z magazynu (dostawa tratty 1) **niewidoczne** do dostawy. |
| G4 | 000018 („Cucina componibile…”, „Assegnato”) | Bez zdjęć i bez sekcji tragarzy. |
| G5 | Na żadnym ekranie klienta | Brak „posizione” (pozycji przewoźnika) i powodów admina. |

## H. Admin — zlecenia 000018–000021 (komputer, `admin@example.com`)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| H1 | `/admin/ordini/<000019>` → „Esecuzione” | 3 kroki z godzinami, „Marco Ferri” i link „posizione” (Google Maps, Como). „Facchini”: ok. 45 min su 2 h inclusi · in corso. Zdjęcia „Ritiro” (2). |
| H2 | 000020 | 5 kroków z „posizione”, „Prova di consegna”: Anna Conti + podpis + „posizione”. „Facchini”: 1 h 20 min (80 min) su 1 h inclusi, żółty znacznik „straordinario: 1 h a persona”. Brak przycisku „Annulla ultimo passo” (dostarczone). |
| H3 | 000018 → „Annulla ultimo passo” bez powodu | Przeglądarka wymaga pola „Motivo”. |
| H4 | 000018 → powód „test” → „Annulla ultimo passo” | Krok „Arrivato al ritiro” przekreślony, „— annullato … da Anna Admin”; w „Note interne”: „Passo annullato” + powód. Przewoźnik (Ferri, telefon) znowu widzi „Sono arrivato al ritiro”, **bez powodu**. Klient nic nie widzi. Brak maila do przewoźnika. |
| H5 | Dwie karty z 000019: w pierwszej przewoźnik (telefon) zapisuje następny krok („Sono arrivato alla consegna”), w drugiej admin klika „Annulla ultimo passo” z powodem na starej stronie | „Nel frattempo il padroncino ha registrato un altro passo. Ricarica la pagina.” — nic nie zostaje cofnięte. |
| H6 | 000021 → przewoźnik (telefon): „In magazzino”, przycisk „Sono arrivato al magazzino” nieaktywny, „Potrai iniziare da …” | Zgodnie z dniem odbioru tratty 2 (za 3 dni). |
| H7 | 000021 → admin: „Tratta 2: il padroncino potrà iniziare prima…” → powód → „Consenti inizio anticipato” | „Inizio anticipato consentito (tratta 2) il …”, powód w „Note interne”. Przewoźnik po odświeżeniu może kliknąć „Sono arrivato al magazzino”. |
| H9 | 000022 („Scaffalature metalliche…”, magazyn) → „Rimuovi padroncino” | Nad przyciskiem: „La merce è in magazzino: l'ordine passa in «Da gestire»”. Po usunięciu: sekcja „Da gestire”, znacznik „Da gestire: merce in magazzino, padroncino rimosso” (też na `/admin/ordini`), pole adresu wypełnione adresem magazynu. Klient (`cliente@example.com`) dalej widzi „In viaggio”, bez nowego wpisu w historii. |
| H10 | 000022 → wybierz Galli, powód → „Assegna padroncino” | Galli (`padroncino2@example.com`, telefon) widzi „Ritiro merce presso: …Via Toffetti 20…”; tratta 2 od dnia odbioru. |
| H11 | 000016 po „Carico completato”, „Inizia il viaggio”, „Sono arrivato alla consegna”, „Scarico completato” (bez podpisu) → „Rimuovi padroncino” | Ostrzeżenie „La merce è già stata scaricata a destinazione…”; po kliknięciu błąd z tym samym tekstem, nic się nie zmienia. |
| H8 | `/admin/ordini/<000007>` (dostarczone przez admina) | „Note interne”: „Consegnato senza firma e foto” z powodem „Consegna demo (seed)” i datą sprzed ok. 11 dni. |

H4, H7, H9 i H10 sprawdza też `npm run test:e2e` (projekt `desktop`, `tests/e2e/admin-correzioni.spec.ts`).

## F. Uwagi do zgłoszenia

Przy każdym problemie zapisz: telefon i system (np. iPhone 13, iOS 19; Pixel 7, Android 16), przeglądarkę, numer
kroku i zrzut ekranu.
