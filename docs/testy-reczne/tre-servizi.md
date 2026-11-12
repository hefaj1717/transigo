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

## B. Krok 6 — Facchinaggio: kreator, płatność, przydział, PWA, klient (lokalnie)

Przygotowanie (tylko lokalna baza, D64):

```
npm run db:local:reset && npm run db:local:seed-demo
```

Hasło do kont: `.seed-local/password`. Seed tworzy przewoźników z „Offre facchinaggio”: **Ferri** (`padroncino@example.com`,
ekipa 2) i **Galli** (`padroncino2@example.com`, ekipa 4), oraz cztery zlecenia Facchinaggio klienta
`cliente@example.com`:

| Zlecenie | Stan | Do czego |
|---|---|---|
| TG-2026-000026 | `paid`, 2 facchini, 4° piano bez windy | widzą je Ferri **i** Galli; „Assegna facchini” w adminie |
| TG-2026-000027 | `paid`, **3 facchini** | widzi je **tylko Galli** (ekipa Ferriego za mała) |
| TG-2026-000028 | `picked_up` u Ferriego | „Segna lavoro concluso” w adminie |
| TG-2026-000029 | `pending_payment` | „Paga ora” u klienta |

Webhooki Stripe lokalnie (osobny terminal, cały czas włączony). **Najpierw `stripe login`** — sesja CLI wygasła:

```
stripe login
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,refund.updated,refund.failed --forward-to localhost:3000/api/webhooks/stripe
```

Wypisany `whsec_…` musi być równy `STRIPE_WEBHOOK_SECRET` w `.env.local` (po zmianie restart `npm run dev`).

### B1. Kreator z kalkulatora (`/facchinaggio`)

1. `/facchinaggio` — kalkulator: 2 facchini, 1 h → cena orientacyjna; przycisk prowadzi do `/prenota/facchini` z
   wypełnionymi osobami i godzinami (nie do `/contatti`).
2. Kreator: „Indirizzo” (adres w aktywnej prowincji; adres spoza obszaru → formularz kontaktu) → „Data e fascia” →
   „Facchini” (mniej niż minimum niemożliwe) → „Ore stimate”: poniżej minimum z cennika tekst „verranno conteggiate N ore”
   i w wycenie liczy się minimum → „Piano e ascensore” → „Cosa spostare” → „Preventivo”.
3. **Dopłata weekendowa:** data w sobotę albo niedzielę → w „Preventivo” pozycja weekendowa; zmiana daty na dzień roboczy
   → pozycja znika, cena spada. Tak samo „pilne” (termin w ciągu X h z „Impostazioni”), jeśli dostępny.
4. **Piętra:** 3° piano bez windy → dopłata za piętra (3 × stawka z cennika); „con ascensore” albo piano terra → bez
   dopłaty.
5. Ceny: klient prywatny z IVA; firma (konto business) netto + IVA.
6. „Account” (zalogowanie / rejestracja) → „Contatti” (osoba na miejscu, telefon) → „Riepilogo” → płatność.

### B2. Płatność

7. Stripe Checkout: karta `4242 4242 4242 4242`, dowolna przyszła data, dowolny CVC. Po powrocie zlecenie w
   `/cliente` — „Pagamento in verifica”, dopóki nie przyjdzie webhook; po webhooku (`[200]` w terminalu `stripe listen`)
   zlecenie `paid`. Bez `stripe listen` zostaje nieopłacone — to poprawne (opłacone tylko po webhooku).
8. W `email_outbox` mail `order_paid` z tekstem dla facchinaggio (adres, data, osoby; bez pojazdu i trasy).
9. TG-2026-000029: „Paga ora” w `/cliente/ordini/[id]` → ten sam Checkout → po webhooku `paid`.
10. Faktura DEMO po płatności: `/cliente/fatture` — pozycje facchinaggio z `order_lines`.

### B3. Admin (`admin@example.com`)

11. `/admin/ordini?servizio=facchinaggio` — 4 zlecenia; „Da assegnare” pokazuje TG-26 i TG-27 (+ nowe z B2).
12. TG-26 → sekcja „Assegna facchini”: kandydaci Ferri i Galli, **bez wyboru pojazdu** → „Assegna” → „Facchini
    assegnati.”; status „Facchini assegnati”/`assigned`; w outboxie `order_assigned` „Facchini assegnati – ordine …”
    (bez tablicy i pojazdu).
13. TG-27 → kandydaci: **tylko Galli** (3 osoby > ekipa Ferriego).
14. „Rimuovi padroncino” w `assigned` (z kodem powodu) → zlecenie wraca do „Da assegnare” (`paid`). Przypisać ponownie.
15. „Segna lavoro iniziato” → `picked_up` („Lavoro iniziato”). Teraz „Rimuovi padroncino” → odmowa „Il lavoro è già
    iniziato: il padroncino non si può rimuovere…”.
16. TG-28 → „Segna lavoro concluso” bez powodu → błąd; z powodem → `delivered` („Lavoro concluso”), znacznik „Concluso
    senza firma del cliente — nessun pagamento automatico al padroncino”; mail `order_delivered` „Lavoro concluso – …”.
    Brak sekcji „Esecuzione” i „Percorso” w szczegółach facchinaggio.
17. `/admin/padroncini/[Ferri]` → „Offre facchinaggio”: zmiana ekipy niczego nie loguje, jeśli wartości te same; zmiana
    → `audit_log` `carrier.porters_updated` ze starą i nową wartością.
18. **Squadra insufficiente:** przypisać TG-27 (3 osoby) Galliemu, potem w profilu Galliego zmniejszyć ekipę do 2 →
    ostrzeżenie „Attenzione: 1 lavoro di facchinaggio in corso richiede più persone…”; kurs zostaje u Galliego, a w
    `/admin/ordini` i w szczegółach TG-27 czerwony znacznik „Squadra insufficiente”. Wyłączenie „Offre facchinaggio”
    daje to samo. Przywrócić ekipę 4 → znacznik znika.

### B4. PWA przewoźnika (najlepiej na telefonie)

19. Ferri `/padroncino/corse`: karta TG-26 z etykietą „Facchinaggio”, „2 facchini · 3 h”, piętro; **bez** TG-27. Karta
    zanonimizowana: miasto, prowincja, data i okno, własna kwota — bez ulicy, nazwiska, telefonu (sprawdzić też HTML).
20. Szczegóły → „Accetta” **bez wyboru pojazdu**; okno potwierdzenia „Accetti il lavoro …?” z „Luogo”, „Inizio lavoro”,
    „Squadra”. Po przyjęciu kurs w „Le mie corse”, zniknął z listy Galliego.
21. Galli `/padroncino/corse`: widzi TG-27 (i TG-26, jeśli nieprzyjęte).
22. „Le mie corse” → szczegóły: pełny adres, „Apri in Google Maps”, kontakt na miejscu (`tel:`), piętro/winda, opis,
    kwota; status „Da iniziare” → po akcji admina „Lavoro iniziato” / „Lavoro concluso”. Brak przycisków realizacji
    (ekran realizacji facchinaggio — później, D166).
23. „Rinuncia” w ciągu 15 min od przyjęcia → kurs wraca na listę (u obu przewoźników), mail `carrier_released_job` do
    admina. Po terminie → „Contatta Transigo”.

### B5. Klient (`cliente@example.com`)

24. `/cliente` — karty „Facchinaggio · …” w „In corso” / „Conclusi”.
25. Szczegóły po przypisaniu: „Facchini assegnati”, karta „I tuoi facchini” (imię + firma, **bez pojazdu i tablicy**,
    bez telefonu). Pasek postępu: „Facchini assegnati → Lavoro iniziato → Lavoro concluso” — **bez „In viaggio”**.
26. TG-28 po „Lavoro concluso”: zlecenie w „Conclusi”, mail „Lavoro concluso”.

### B6. Telefon

27. Kreator `/prenota/facchini`, `/cliente/ordini/[id]` i PWA (`/padroncino/corse`, „Le mie corse”) przy szerokości
    telefonu: bez poziomego przewijania, przyciski w zasięgu kciuka, okno „Accetta” mieści się na ekranie.

## C. Krok 7 — Deposito: kreator, łańcuch, jedna płatność i faktura (lokalnie)

Przygotowanie: `npm run db:local:reset && npm run db:local:seed-demo` (seed ustawia też pojemność magazynu: boxy S 10,
M 8, L 3, 40 miejsc paletowych — tylko gdy nie są ustawione). Do płatności w kreatorze — `stripe listen` jak w Etapie 3.
Zlecenia demo:
- **TG-30** — box M, „porto io” + „ritiro io”, opłacone;
- **TG-31 → TG-32 → TG-33** — łańcuch: odbiór Transigo z facchino (nadrzędne, płatność i faktura) → box L na 45 dni →
  dostawa Transigo, opłacony jedną płatnością;
- **TG-34** — `azienda@example.com`: 4 palety, „porto io”, „lo deciderò più avanti”.

### C1. Kalkulator → kreator (`/deposito`)

1. Kalkulator: box S, 30 dni → „Prenota online” → `/prenota/deposito?servizio=deposito&giorni=30&box=s`; w kroku 1
   zaznaczony box S. Po wpisaniu daty początku data końca uzupełnia się sama (30 dni, początek i koniec wliczone).
2. Ręcznie zmienić adres na `?box=xl&giorni=99999&pallet=-1` → nic nie jest wybrane (tylko znane wartości).
3. Niezalogowany: przełącznik „Privato – box / Azienda – pallet”. Zalogowany klient widzi tylko swój typ (D154).

### C2. Okres i dostępność

4. Wybrać daty → komunikat „Disponibile: …” albo „Non disponibile per queste date” (tylko tak/nie, bez liczby wolnych
   miejsc). Box L na okres TG-32 (dni 5–49) → przy pojemności 3 dostępny; po zajęciu wszystkich (np. SQL lokalnie:
   `update warehouse_box_capacity set quantity = 1 where box_code = 'l'`) → „Non disponibile”, „Avanti” zablokowane.
5. Data końca przed początkiem → komunikat; początek w przeszłości → pole `min` i błąd serwera.

### C3. Arrivo / Uscita / Merce / Facchini

6. „La porto io” → tekst z miastem magazynu, bez adresu (adres przychodzi po płatności).
7. „Ritiro Transigo” → adres (Google), piętro, winda, okno w dniu początku. Adres w prowincji poza obszarem → komunikat
   „Al momento non effettuiamo ritiri in questa zona.” + „Lasciaci una richiesta”.
8. „Consegna Transigo” → adres, okno w dniu końca; „Lo deciderò più avanti” — bez adresu.
9. „Merce”: opis obowiązkowy; waga / wymiary / „Si tratta di un trasloco?” tylko z transportem. Krok „Facchini” pojawia
   się tylko z transportem Transigo; wybór „Pochi colli…” zmienia cenę odbioru.

### C4. Preventivo, zamówienie, płatność

10. „Preventivo”: osobno „Ritiro e trasporto al deposito – X km, pojazd”, „Deposito – Box …, N giorni”, „Consegna dal
    deposito …” i „Totale da pagare”. Brak informacji o ratach przy okresie > 2 mies. (D172). Dostawa w sobotę → dopłata
    weekendowa w części dostawy.
11. Account → Contatti (z transportem: osoba i telefon obowiązkowe; bez transportu tylko notatki) → Riepilogo → „Conferma
    e paga” → Stripe Checkout: **jedna pozycja** „Ordine TG-… – Deposito e trasporti” na sumę grupy, w opisie wszystkie
    części. Karta 4242 → wszystkie zlecenia grupy „Confermato” jednocześnie.
12. Mail `order_paid` (outbox, `/admin/email`): **jeden**, na zleceniu nadrzędnym, z wierszami „Ritiro e trasporto al
    deposito”, „Deposito”, „Consegna dal deposito” i sumą. Dla „porto io”: wiersz „Magazzino: nazwa, adres”.
13. Faktura DEMO (`/cliente/fatture`): jedna, na zleceniu nadrzędnym, na sumę grupy; w PDF pozycje z prefiksami części.
14. Wyjście z Checkout bez płatności → „Annulla ordine” na dowolnym zleceniu grupy → wszystkie „Scaduto”; termin
    płatności wspólny.

### C5. Klient (`cliente@example.com`)

15. TG-30: karta „Deposito” z „Magazzino: Magazzino Transigo Milano, Via Toffetti 20…” i „Apri in Google Maps” (D171).
    Anulowanie: „Puoi annullare gratuitamente fino a … (inizio del deposito; poi contattaci)”.
16. TG-32 (i TG-31, TG-33): karta „Prenotazione collegata” — trzy zlecenia z linkami, statusem i kwotą, „Totale della
    prenotazione”, „Un solo pagamento… La fattura è nell'ordine TG-31”.
17. „Annulla ordine” na TG-32 → tekst „L'annullamento riguarda tutta la prenotazione”; potwierdzić → wszystkie trzy
    „Annullato”, trzy zwroty (lokalnie `pending`: sztuczne `pi_demo_`), jeden mail `order_cancelled` na TG-31 z sumą.
18. Po przypisaniu przewoźnika do TG-33 („Assegna”) → na żadnym zleceniu grupy nie ma „Annulla ordine” (D169), tylko
    „contattaci”. Depozyt, który się zaczął (lokalnie: przesunąć `start_date`/`pickup_window_start` SQL-em) → to samo (D170).

### C6. Admin (`admin@example.com`)

19. `/admin/ordini` „Da assegnare”: TG-31 i TG-33 (transporty łańcucha), **bez** TG-32 (depozyt). Przed opłaceniem
    grupy żadnego z nich nie ma.
20. TG-33: „Ordini collegati (deposito)”, „Pagamento unico della prenotazione, registrato sull'ordine TG-31”, „Rimborso
    manuale (ancora rimborsabile …)” = kwota TG-33, nie całej płatności. Zwrot większy → błąd.
21. Przewoźnik (Ferri): na liście kursów TG-31 i TG-33 z oznaczeniem magazynu; po przyjęciu widzi tylko swój transport
    (bez depozytu, bez kwot klienta).

### C7. Telefon

22. `/prenota/deposito` i `/cliente/ordini/[id]` z kartą grupy przy szerokości telefonu: bez poziomego przewijania.
