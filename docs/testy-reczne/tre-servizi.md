# Test ręczny — trzy usługi (plan `docs/plany/tre-servizi.md`)

## A. Krok 5a — zlecenia Facchinaggio i Deposito w panelach (lokalnie)

Przygotowanie (tylko lokalna baza, D64):

```
npm run db:local:reset && npm run db:local:seed-demo
docker exec -i supabase_db_TransiGo psql -U postgres -d postgres -X -q < docs/testy-reczne/sql/tre-servizi-5a.sql
```

Skrypt wypisuje linki do dwóch opłaconych zleceń (`cliente@example.com`). Hasło: `.seed-local/password`.

Admin (`admin@example.com`):

1. `/admin/ordini` — pod filtrami statusu wiersz „Servizio: Tutti · Trasporto · Facchinaggio · Deposito”; każde zlecenie ma
   etykietę typu (stare = „Trasporto”). Deposito w kolumnie „Data” pokazuje „dal …” (bez godziny).
2. „Facchinaggio” / „Deposito” zawęża listę; połączenie z filtrem statusu zostaje w adresie (`?filtro=…&servizio=…`).
3. „Da assegnare” + „Deposito” → „Nessun ordine.” (depozyt nie idzie do przewoźników).
4. Zlecenie Facchinaggio: etykieta „Facchinaggio”, „Assegna facchini — non è ancora disponibile”, sekcja „Facchinaggio”
   (adres, piętro, okno, 2 facchini, 2 h „richieste 1 h, minimo del listino”), „Contatto sul posto”, bez „Percorso”,
   „Importo padroncino” 120,00 €.
5. Zlecenie Deposito: sekcja „Deposito” (magazyn, Box M, okres 45 giorni, „Porta il cliente”, „Da decidere”), bez
   „Assegna padroncino”, bez „Percorso” i kontaktów.
6. Dashboard `/admin`: kafelek „Pagati senza padroncino…” nie liczy depozytu.

Klient (`cliente@example.com`), także na telefonie:

7. `/cliente` — karty „Facchinaggio · Milano” („Facchini gio 14 nov, …”) i „Deposito · Box M” („Dal … al …”).
8. Szczegóły Facchinaggio: karta „I tuoi facchini”, karta „Facchinaggio” z kontaktem i notą, bez paska postępu transportu.
9. Szczegóły Deposito: karta „Deposito” („La porti tu in magazzino”, „Da decidere più avanti”), bez karty przewoźnika.
   Adres magazynu dla klienta — krok 7 (dziś klient nie czyta `warehouses`).
10. Stare zlecenia transportowe wyglądają jak przedtem (lista, szczegóły, pasek postępu).

Sprawdzone automatycznie 2026-11-11 (Playwright na `npm run dev`, lokalna baza): punkty 1–9 — strony 200, oczekiwane teksty.
