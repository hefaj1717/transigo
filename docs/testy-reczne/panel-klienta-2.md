# Test ręczny: panel klienta — część 2 (profil, anulowanie, reklamacje, depozyt)

Plan: `docs/plany/panel-klienta-2.md` (D137–D139). Dane: `npm run db:local:reset && npm run db:local:seed-demo`
(lokalnie) albo seed na stagingu (`node scripts/seed-demo.mjs --staging=bacabuzzevwwdxrswbnc`, tylko za zgodą).
Konto: `cliente@example.com`. Na stagingu zwroty są prawdziwe (Stripe test); lokalnie zostają „in elaborazione”.

## A. Profilo (`/cliente/profilo`)
1. Zmień imię i telefon → „Dati salvati.”, po odświeżeniu nowe wartości.
2. Dane do faktury: zły codice fiscale → błąd przy polu; poprawny + adres → zapis; nowa rezerwacja → „Riepilogo” ma je wpisane.
3. Hasło: złe obecne → „La password attuale non è corretta”; poprawne → „Password aggiornata.”, wyloguj i zaloguj nowym.

## B. Anulowanie opłaconego zlecenia (`/cliente/ordini/[id]`)
1. Zlecenie „Confermato” z odbiorem za ≥ 24 h → „Annulla ordine” → okno: rimborso = cała kwota → „Sì, annulla” →
   „Ordine annullato … Rimborso …”. Na stagingu: Stripe Dashboard → Payments → zwrot widoczny.
2. Zlecenie z odbiorem za < 24 h (np. przesunięte w seedzie) → okno pokazuje koszt 50 % transportu/tragarzy/pakowania;
   magazyn zwracany w całości.
3. Zlecenie z przewoźnikiem („Trasportatore assegnato”) → „Richiedi l'annullamento” → status „Annullamento in corso”;
   `/admin/email`: `cancellation_requested` (admin) i `carrier_job_cancelled` (przewoźnik).
4. Zlecenie „Ritirato” / „In viaggio” → brak przycisku, tylko „contattaci”.
5. Mail `order_cancelled` w `/admin/email` z kwotą zwrotu.

## C. Reklamacje
1. Zlecenie dostarczone ≤ 14 dni temu → „Problemi con la consegna?” → „Apri un reclamo”.
2. Wyślij bez kategorii / z krótkim opisem → błędy przy polach.
3. Kategoria + opis + 2 zdjęcia z telefonu (aparat) → `/cliente/reclami`: „Reclamo inviato”, zdjęcia widoczne.
4. „Aggiungi foto” do otwartej reklamacji (do 5 łącznie).
5. Zlecenie dostarczone > 14 dni temu → komunikat „Sono passati più di 14 giorni…”.
6. `/admin/email`: `claim_opened` (bez danych klienta). Zamknięcie przez admina — krok 3 planu demo.

## D. Depozyt (`/cliente/deposito`)
1. Zlecenia z magazynem: „In arrivo al magazzino” (przed rozładunkiem), „In magazzino” (po rozładunku odcinka 1),
   palety, „Pagato fino al”.
2. Bez magazynu → pusta strona z „Prenota”.
3. Telefon (375 px): zakładki „I miei ordini · Deposito · Reclami · Profilo” w drugim wierszu nagłówka.
