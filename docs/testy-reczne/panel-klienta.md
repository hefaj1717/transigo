# Test ręczny: panel klienta (`/cliente`)

Spec 7. Dane przewoźnika dla klienta: imię, firma, typ pojazdu, tablica (`customer_order_carrier`). Maile `order_assigned` / `order_delivered` (outbox). Test na **lokalnej** bazie — migracja `customer_order_carrier` do czasu `db:push` jest tylko lokalnie.

## Przygotowanie

1. Lokalny Supabase, czysta baza i dane demo (klient z 9 zleceniami we wszystkich statusach, admin, przewoźnik):

   ```sh
   npm run db:local:start
   npm run db:local:reset
   npm run db:local:seed-demo
   ```

2. `npm run dev` na lokalnej bazie — `.env.development.local` jak w `docs/testy-reczne/admin-ordini.md` (krok 3 przygotowania), restart dev. Po teście usuń plik i zrestartuj dev.
3. Zaloguj się kontem klienta wypisanym przez skrypt (`cliente-<TAG>@example.com`, hasło `Prova-12345!`).

Sprawdź na komputerze **i na telefonie** (szerokość ~390 px).

## A. Lista `/cliente`

| # | Krok | Oczekiwany wynik |
|---|---|---|
| A1 | Otwórz `/cliente` | Nagłówek: logo, „I miei ordini”, „Nuova prenotazione”, „Esci”. Powitanie z imieniem. |
| A2 | Zakładka „In corso” | Zlecenia do zapłaty, opłacone, przypisane, odebrane, w drodze — najbliższy odbiór na górze. Karta: trasa „Miasto → Miasto” (z magazynem „(con deposito)”), dzień i okno odbioru, numer, etykieta statusu, kwota; „Paga ora” przy zleceniu do zapłaty. |
| A3 | Zakładka „Conclusi” | Dostarczone i wygasłe. Liczniki w zakładkach się zgadzają. |
| A4 | Klient bez zleceń w toku | Domyślnie otwiera się „Conclusi”; pusta zakładka pokazuje „Calcola il prezzo”. |

## B. Szczegóły zlecenia

| # | Zlecenie (seed) | Oczekiwany wynik |
|---|---|---|
| B1 | „In attesa di pagamento” | Bez paska postępu; ramka z terminem płatności, „Paga ora”, „Annulla ordine”. |
| B2 | „Pagato — da assegnare” | Etykieta „Confermato”, pasek: 1. krok aktywny; „Il tuo trasportatore: Stiamo assegnando…”; „Devi modificare o annullare l'ordine? Contattaci”. |
| B3 | „Pagato — da assegnare (con deposito)” | Dwa odcinki („1. Ritiro → deposito”, „2. Deposito → consegna”), „Nostro magazzino” zamiast piętra, w „Merce e servizi” „Deposito: N giorni, N pallet”, w cenie pozycja depozytu. |
| B4 | „Assegnato” / „Ritirato” / „In viaggio” | Pasek z ukończonymi krokami i godzinami; ramka przewoźnika: **imię · firma · typ pojazdu · tablica** — bez telefonu i P.IVA. |
| B5 | „Consegnato” | Wszystkie kroki zielone; dopisek „Consegna confermata dal nostro team” (dostawa oznaczona przez admina, D123). |
| B6 | Dowolne | Percorso: data, okno, „Urgente” gdy dotyczy, adresy z piętrem i windą, km; kontakty przy odbiorze i dostawie; uwagi. Prezzo: pozycje brutto i „Totale (IVA inclusa)” (konto firmowe: pozycje netto, Imponibile, IVA, Totale). Cronologia z czytelnymi etykietami („Confermato”, „Trasportatore assegnato”…). |
| B7 | Cudze zlecenie: wklej w adres ID zlecenia innego klienta | 404. |

## C. Przypisanie przez admina → klient (maile)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| C1 | Jako admin: `/admin/ordini` → zlecenie „Pagato — da assegnare” → wybierz przewoźnika → „Assegna” | „Padroncino assegnato”. |
| C2 | Outbox: `docker exec -i supabase_db_TransiGo psql -U postgres -d postgres -c "select template_code, to_address, subject from email_outbox where template_code in ('order_assigned','order_delivered') order by created_at desc limit 5;"` | `order_assigned` na adres klienta: trasa, okno odbioru, „Marco (Ferri Trasporti … Srl)”, pojazd z tablicą, link do zlecenia; **bez kwot**. |
| C3 | Jako klient: odśwież zlecenie | Etykieta „Trasportatore assegnato”, ramka przewoźnika z danymi. |
| C4 | Admin: „Rimuovi padroncino” | U klienta ramka wraca do „Stiamo assegnando…” (dane przewoźnika znikają). |
| C5 | Admin: przypisz ponownie | Drugi `order_assigned` **nie** jest wysyłany (jeden mail na zlecenie — świadomie, demo). |
| C6 | Admin: Ritirato → In viaggio → Consegnato | Outbox: `order_delivered` „Ordine consegnato – TG-…”. U klienta zlecenie w „Conclusi”. |
