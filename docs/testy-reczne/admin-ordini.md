# Test ręczny: `/admin/ordini` — obsługa zleceń przez admina (wersja minimalna)

Decyzje: D117 (bez „stoccaggio lungo termine”), D120, D122, D123. Test na **lokalnej** bazie (Docker), aplikacja na `localhost:3000`.

## Przygotowanie

1. Lokalny Supabase musi działać:

   ```sh
   npm run db:local:start
   ```

2. Czysta baza i **jeden** komplet danych demo (admin, klient, jeden przewoźnik, 9 zleceń w różnych statusach). Uruchom **raz** oba polecenia:

   ```sh
   npm run db:local:reset
   npm run db:local:seed-demo
   ```

   Skrypt działa tylko na lokalnej bazie (sprawdza `127.0.0.1:55321` / `:55322`, inaczej przerywa). Na końcu wypisuje numery zleceń i loginy — hasło dla wszystkich `Prova-12345!`. Każde kolejne uruchomienie **dokłada** następny komplet. `npm run test:rls` kasuje dane — po nim uruchom oba polecenia ponownie.

3. Przełącz `npm run dev` na lokalną bazę (`.env.development.local` ma w dev pierwszeństwo przed `.env.local`, ignorowany przez git):

   ```sh
   npx supabase status -o json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`NEXT_PUBLIC_SUPABASE_URL=${s.API_URL}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${s.ANON_KEY}\nSUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`)' > .env.development.local
   ```

   Potem zrestartuj `npm run dev`.

4. Zaloguj się na `http://localhost:3000/accedi` kontem admina wypisanym przez skrypt (`admin-<TAG>@example.com`). Jeśli strona od razu przekierowuje — najpierw „Esci”.

5. **Po teście** wróć na staging:

   ```sh
   rm .env.development.local
   ```

   i zrestartuj `npm run dev`.

Zlecenia z seeda (numery od `TG-…-000001` na czystej bazie):

| Nr | Status | Co sprawdzamy |
|---|---|---|
| 000001 | In attesa di pagamento | brak przycisków obsługi |
| 000002 | Pagato — da assegnare | Assegna, Rimuovi padroncino |
| 000003 | Pagato — da assegnare, z depozytem (2 tratte) | Assegna przy dwóch odcinkach |
| 000004 | Assegnato | kolejne statusy aż do „Consegnato” |
| 000005 | Ritirato (dziś rano) | „Segna come in viaggio” |
| 000006 | In viaggio (dziś) | „Segna come consegnato” |
| 000007 | Consegnato 10 dni temu, bez POD | znacznik „senza firma e foto” |
| 000008 | Consegnato 25 dni temu, bez POD | j.w. |
| 000009 | Scaduto | brak przycisków obsługi |

## A. Lista `/admin/ordini`

- [ ] Filtry: Tutti (9), **Da assegnare** (2: 000002, 000003 — od najbliższego ritiro), **In corso** (3: 000004–000006), **Consegnati** (2), In attesa di pagamento (1), Scaduti (1).
- [ ] Kolumna „Padroncino”: firma przewoźnika przy przypisanych; przy opłaconych bez przewoźnika link „Da assegnare”.
- [ ] Numer zlecenia prowadzi do strony zlecenia.

## B. Strona zlecenia — dane

Otwórz 000003.
- [ ] Sekcje: Percorso (dwie tratte: ritiro → deposito, deposito → consegna; adresy, piętra, okno, km, czas jazdy), Merce e contatti, Importi (cena klienta z pozycjami i IVA, „Importo padroncino”), Storico stati (kto i skąd).

## C. Assegna i Rimuovi padroncino (000002)

1. [ ] Sekcja „Assegna padroncino”: lista ma jedną pozycję „Ferri Trasporti <TAG> Srl — FT<TAG>A (Furgone medio, 1200 kg)”.
2. [ ] „Assegna” bez wyboru → przeglądarka nie wysyła (pole wymagane).
3. [ ] Wybierz przewoźnika → „Assegna”. Strona: status **Assegnato**, sekcja „Padroncino” z firmą, tablicą i linkiem „scheda padroncino”, przyciski „Segna come ritirato” i „Rimuovi padroncino”. W historii „Pagato → Assegnato · admin (…)”.
4. [ ] „Rimuovi padroncino” bez motywu → przeglądarka nie wysyła. Wybierz „Errore nell'assegnazione” → status wraca do **Pagato**, znowu „Assegna padroncino” z tym samym przewoźnikiem. W historii „Assegnato → Pagato · admin”.
5. [ ] **Dwie karty (odrzucenie):** otwórz 000002 w dwóch kartach. Karta 1: „Assegna”. Karta 2 (bez odświeżania): „Assegna” → czerwony komunikat „L'ordine è già stato assegnato (forse da un padroncino dall'app). Ricarica la pagina.”

## D. Statusy krok po kroku (000004)

1. [ ] „Segna come ritirato” → **Ritirato**, przy „Padroncino” czas „ritirato”.
2. [ ] „Segna come in viaggio” → **In viaggio**.
3. [ ] Przy przycisku „Segna come consegnato” ostrzeżenie: „Senza firma e foto del destinatario: il pagamento al padroncino non partirà in automatico.” Kliknij → **Consegnato**, żółty znacznik „Consegnato senza firma e foto — nessun pagamento automatico al padroncino”, brak dalszych przycisków.
4. [ ] Historia: Pagato → Assegnato → Ritirato → In viaggio → Consegnato, każdy wpis „admin (…)”.
5. [ ] **Dwie karty (odrzucenie):** na 000005 (Ritirato) otwórz dwie karty. Karta 1: „Segna come in viaggio”. Karta 2 (bez odświeżania): to samo → „Lo stato è già cambiato. Ricarica la pagina.”
6. [ ] **Rimuovi po odbiorze niemożliwe:** na 000005/000006 nie ma przycisku „Rimuovi padroncino”.

## E. Zlecenia zakończone i inne statusy

- [ ] 000007 i 000008: daty w przeszłości (ritiro i consegna 10 / 25 dni temu), znacznik „senza firma e foto”.
- [ ] 000001 i 000009: brak sekcji „Assegna” i przycisków statusu.

## F. Kreator — bez „stoccaggio lungo termine” (D117)

Wyloguj się („Esci”) albo otwórz okno prywatne: `http://localhost:3000/prenota`.
1. [ ] W kroku z usługami zaznacz „Porta la merce nel nostro deposito…” → pod spodem tekst „… Deposito fino a 30 giorni.”
2. [ ] Pole „Ritiro dal deposito il” nie pozwala wybrać daty późniejszej niż 30 dni od ritiro (kalendarz blokuje dalsze dni).
3. [ ] (Odrzucenie po stronie serwera) Wpisz ręcznie datę o 31 dni późniejszą, jeśli przeglądarka pozwoli → przy wycenie komunikat „Per ora il deposito è disponibile solo per un periodo breve: scegli una data di ritiro dal deposito più vicina.”

Uwaga: wycena w kreatorze potrzebuje Google Maps — bez klucza w `.env.local` sprawdzisz tylko punkty 1–2.

## G. Baza (opcjonalnie)

```sh
docker exec supabase_db_TransiGo psql -U postgres -c "select order_number, status, delivered_without_pod from orders order by order_number"
```

```sh
docker exec supabase_db_TransiGo psql -U postgres -c "select action, data from audit_log where action like 'order.%' order by id"
```

- [ ] Po testach: `order.assigned`, `order.unassigned` z `reason_code` (np. `errore_admin`), `order.status_changed`; przy dostawie `"pod": false`. Brak danych osobowych w `data`.
