# Test ręczny: `/admin/padroncini` (Etap 4.1, krok 4)

Decyzje: D101, D105, D113–D116. Test na **lokalnej** bazie (Docker), aplikacja na `localhost:3000`.

## Przygotowanie

1. Lokalny Supabase musi działać:

   ```sh
   npm run db:local:start
   ```

2. Czysta baza i **jeden** komplet danych testowych (admin + po jednym przewoźniku w każdym stanie, z plikami PDF w Storage). Skrypt działa tylko na lokalnej bazie. Uruchom **raz** oba polecenia:

   ```sh
   npm run db:local:reset
   npm run db:local:seed-carriers
   ```

   Każde kolejne uruchomienie `db:local:seed-carriers` **dokłada** następny komplet (liczniki w sekcji A rosną ×2, ×3…). Seed bez resetu uruchamiamy tylko w kroku B4.

   Skrypt wypisuje e-mail admina, hasło, adresy stron przewoźników i tablice. Każde uruchomienie ma inny 4-znakowy znacznik — w tej instrukcji oznaczony `<TAG>` (np. tablice `BI<TAG>A`, `BI<TAG>B`, e-mail `admin-<TAG>@example.com`).

   **Uwaga:** `npm run test:rls` resetuje lokalną bazę i kasuje te konta — po nim uruchom skrypt ponownie.

3. Przełącz `npm run dev` na lokalną bazę. `.env.development.local` ma w trybie dev pierwszeństwo przed `.env.local` i jest ignorowany przez git:

   ```sh
   npx supabase status -o json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`NEXT_PUBLIC_SUPABASE_URL=${s.API_URL}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${s.ANON_KEY}\nSUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`)' > .env.development.local
   ```

   Potem zrestartuj `npm run dev`.

4. Zaloguj się na `http://localhost:3000/accedi` jako `admin-<TAG>@example.com`, hasło `Prova-12345!`.

5. **Po teście** wróć na staging:

   ```sh
   rm .env.development.local
   ```

   i zrestartuj `npm run dev`.

Przewoźnicy z seeda:

| Stan | Firma | Co ma |
|---|---|---|
| In verifica | Trasporti Verdi Srl | kompletna rejestracja wysłana do weryfikacji |
| Attivo | Trasporti Bianchi Srl | pojazd `BI<TAG>A` „Da riverificare” (zmieniona ładowność), pojazd `BI<TAG>B` „Nuovo veicolo” z dwoma dokumentami w weryfikacji, „Polizza RC vettoriale” w weryfikacji |
| Sospeso | Trasporti Neri Srl | motyw „RCA scaduta: carica la nuova polizza.”, nowe RCA pojazdu `NE<TAG>A` w weryfikacji |
| Incompleto | Trasporti Gialli Srl | tylko Albo, bez pojazdu i patente |
| Rifiutato | Trasporti Rosa Srl | motyw „Albo non leggibile.” |

## A. Lista `/admin/padroncini`

- [ ] Liczniki: Da verificare (1), Veicoli da verificare (2), Documenti da verificare (4), Registrazione incompleta (1), Attivi (1), Sospesi (1), Rifiutati (1).
- [ ] „Veicoli da verificare”: `BI<TAG>B` „Nuovo veicolo”, `BI<TAG>A` „Da riverificare”.
- [ ] „Documenti da verificare”: 3 dokumenty Bianchiego i RCA Neriego z oznaczeniem „sospeso”.
- [ ] „Registrazione incompleta”: Gialli z „Nessun veicolo attivo, Patente del titolare”.

## B. Trasporti Verdi (w weryfikacji) — otwórz stronę w dwóch kartach

1. [ ] Karta 1, „Rifiuta” z samymi spacjami w motywie → „Indica il motivo (massimo 1000 caratteri).” (puste pole zatrzymuje już przeglądarka).
2. [ ] Karta 1, „Rifiuta” z motywem „Albo non leggibile” → „Registrazione rifiutata. Il padroncino riceverà un'e-mail con il motivo.” Po odświeżeniu: status Rifiutato i motyw.
3. [ ] Karta 2 (bez odświeżania), „Approva padroncino” → **odrzucone**: „Questo padroncino non è più in attesa di verifica (forse è già stato deciso). Ricarica la pagina.” Drugiego maila nie ma.
4. [ ] Udane Approva: uruchom jeszcze raz `npm run db:local:seed-carriers` (bez resetu — dokłada drugi komplet; od tej chwili liczniki listy są większe) i otwórz nowego Verdiego z linku wypisanego przez skrypt (nowy `<TAG>`). „Approva padroncino” → „Padroncino approvato.”, status Attivo, jego dokumenty i pojazd „Approvato”.

## C. Trasporti Bianchi (aktywny)

1. [ ] „Apri …pdf” przy dokumencie otwiera PDF (link ważny 5 minut).
2. [ ] „Polizza RC vettoriale” (w weryfikacji) — otwórz stronę w dwóch kartach:
   - karta 1, „Approva documento” → „Documento approvato.”;
   - karta 2 (bez odświeżania), „Rifiuta documento” z motywem → **odrzucone**: „Il documento è già stato valutato. Ricarica la pagina.”
3. [ ] Pojazd `BI<TAG>B`: przy „Assicurazione RCA” „Rifiuta documento” z motywem „Targa non corrispondente” → „Documento rifiutato. Il padroncino riceverà un'e-mail con il motivo.” Potem „Approva veicolo” → **odrzucone**: „Il veicolo non ha tutti i documenti obbligatori validi: Assicurazione RCA (BI<TAG>B).”
4. [ ] Pojazd `BI<TAG>A`: „Approva veicolo” → „Veicolo approvato insieme ai suoi documenti in attesa.”, plakietka „Approvato”, licznik „Veicoli da verificare” (1). Drugie kliknięcie z karty bez odświeżania → **odrzucone**: „Il veicolo è già approvato o non è attivo. Ricarica la pagina.”
5. [ ] „Sospendi” z samymi spacjami → „Indica il motivo (massimo 1000 caratteri).” Z motywem „Controllo documenti” → „Padroncino sospeso.”, status Sospeso, widoczny motyw.
6. [ ] „Riattiva” → **odrzucone**: „La registrazione non è completa: Assicurazione RCA (BI<TAG>B).” (skutek kroku 3: odrzucone RCA aktywnego pojazdu).

## D. Trasporti Neri (zawieszony)

1. [ ] Na stronie: „1 documento è in attesa di verifica: valutali qui sotto prima di riattivare.”
2. [ ] „Riattiva” → **odrzucone**: „Prima di riattivare valuta i documenti in attesa di verifica.”
3. [ ] RCA pojazdu `NE<TAG>A`: „Approva documento” → „Documento approvato.” (bez maila).
4. [ ] „Riattiva” → „Padroncino riattivato.”, status Attivo.

## E. Dane firmy (np. Neri → „Modifica dati aziendali”)

1. [ ] Zmień „Indirizzo sede” → „Dati aziendali aggiornati.” Ponowny zapis bez zmian → „Nessuna modifica.”
2. [ ] P.IVA `123` → przy polu „Partita IVA non valida”.
3. [ ] P.IVA Bianchiego (przepisz ze strony Bianchiego, sekcja „Dati aziendali”) → przy polu „Questa partita IVA è già registrata da un altro padroncino.”

## F. Gialli i Rosa

- [ ] Gialli: brak przycisków decyzji, w „Completezza” lista braków.
- [ ] Rosa: status Rifiutato, motyw „Albo non leggibile.”, brak przycisków decyzji.

## G. Maile w outboxie

```sh
docker exec supabase_db_TransiGo psql -U postgres -c "select template_code, to_address, status, subject from email_outbox order by created_at"
```

Po całym przebiegu — wiersze ze statusem `captured_dev`:

- [ ] `carrier_rejected` → Verdi (B2);
- [ ] `carrier_approved` → drugi Verdi (B4);
- [ ] `carrier_document_rejected` → Bianchi, temat „Documento rifiutato: Assicurazione RCA del veicolo BI<TAG>B” (C3);
- [ ] `carrier_suspended` → Bianchi (C5);
- [ ] `carrier_reactivated` → Neri (D4).

Brak maili przy zatwierdzeniu dokumentu, zatwierdzeniu pojazdu i przy każdej odrzuconej próbie.

## Poza tym testem

- Ostrzeżenie o kursach w toku przy zawieszonym przewoźniku (D116) — seed nie tworzy jeszcze kursów; dojdzie w kroku z „Accetta la Corsa”.
