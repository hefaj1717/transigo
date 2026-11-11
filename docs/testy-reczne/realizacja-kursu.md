# Test ręczny: realizacja kursu w PWA przewoźnika (krok 4)

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

## F. Uwagi do zgłoszenia

Przy każdym problemie zapisz: telefon i system (np. iPhone 13, iOS 19; Pixel 7, Android 16), przeglądarkę, numer
kroku i zrzut ekranu.
