# Test ręczny: panel admina (krok 3, plan `docs/plany/panel-admina.md`)

Dane: `npm run db:local:reset && npm run db:local:seed-demo`, logowanie `admin@example.com` (hasło: `.seed-local/password`).
Lokalnie płatności są sztuczne (`pi_demo_…`), więc każdy zwrot zostaje „In corso — non ancora inviato a Stripe”
(w logu `No such payment_intent`). Prawdziwy zwrot testowy — na stagingu po seedzie z płatnościami testowymi Stripe.

## A. Pieniądze (D140–D142)

1. `/admin/ordini?filtro=annullamento` → zlecenie 23 (Ferri, klient poprosił o anulowanie). W „Pagamenti e rimborsi”
   jest data i powód klienta, propozycja wg 24 h / 50 %, pola z limitami.
   - Kwota ponad limit (np. 999) → komunikat, nic się nie zmienia.
   - Zwrot 50, przewoźnik 10 → „Annullato”, podsumowanie decyzji (trattenuto = suma − zwrot), zwrot 50 € z „Riprova”.
   - `/admin/email`: `order_cancelled` do klienta. Klient (`/cliente/ordini/…`) widzi „Annullato” i kwotę zwrotu.
2. `/admin/ordini?filtro=da-verificare` → zlecenie 24 (Stripe pobrał 5 € więcej): „Segna come pagato” → „Pagato”,
   sekcja „Assegna padroncino”. (Albo „Rimborsa 111,58 €” → „Rimborsato”.)
3. `/admin/ordini?filtro=rimborsi` → zlecenie 25 (zwrot 20 € „Non riuscito”): „Riprova” → nowy wiersz
   „(nuovo tentativo)”, stary zostaje „Non riuscito”; drugi „Riprova” na starym wierszu już się nie pojawia.
4. „Rimborso manuale” (np. zlecenie 2–3, `paid`): bez motywu → „Scegli il motivo.”; częściowy → status bez zmian;
   reszta w całości → „Rimborsato”. Przy kursie w toku (zlecenie 4) zwrot całości → „rimuovi prima il padroncino”.
5. Na stagingu (po zgodzie na migrację i seed): to samo z prawdziwymi zwrotami testowymi — w Stripe Dashboard widać
   refund z `metadata.refund_id`, wiersz przechodzi w „Rimborsato” (od razu albo przez webhook `refund.updated`).

## B. Reklamacje (D138)

1. Menu „Reclami” → zakładka „Aperti”: reklamacja do zlecenia 20 (Merce danneggiata), wiek „oggi”, klient.
2. Szczegóły: opis, zdjęcia (jeśli klient dodał — `/cliente/reclami` → „Aggiungi foto”; podgląd przez podpisany URL),
   zlecenie z linkiem, przewoźnik, kontakt do klienta. `/admin/ordini/[id]` zlecenia 20 pokazuje „Reclamo aperto … apri”.
3. „Chiudi il reclamo” bez tekstu → przeglądarka wymaga pola; z tekstem → „Chiuso”, odpowiedź z datą i adminem.
   `/admin/email`: `claim_closed` do klienta. Klient w „I miei reclami” widzi „Chiuso” i odpowiedź.
4. Druga karta z tą samą reklamacją otwartą wcześniej → „Chiudi” → „Il reclamo era già chiuso.”

## C. Klienci (D143)

1. Menu „Clienti”: lista (nazwa lub firma, e-mail, typ, data rejestracji, liczba zleceń, stan). Szukaj „conti”,
   „cliente@example.com”, fragment P.IVA / CF → wynik; `x),email.ilike.*` → „Nessun cliente trovato.” (bez błędu).
2. Szczegóły: dane, dane do faktury, zlecenia (linki), reklamacje. Z `/admin/ordini/[id]` link na imieniu klienta.
3. „Blocca cliente” bez motywu → przeglądarka wymaga pola; z motywem → „Cliente bloccato. N ordini in corso
   continuano…”, czerwony pasek, historia „bloccato (motivo) · admin”. Zakładka „Bloccati” pokazuje klienta.
4. W drugiej przeglądarce klient (`cliente@example.com`) przy następnym kliknięciu trafia na „Account sospeso”.
5. „Sblocca cliente” → klient znów się loguje i widzi swoje zlecenia.

## D. Impostazioni

1. Menu „Impostazioni”: dane firmy (puste po seedzie) i reguły (24 h, 50 %, 24 h, 4 h).
2. Dane firmy z błędną P.IVA (np. 1234) → „La P.IVA ha 11 cifre.”, **wpisane pola zostają**. Poprawna → „Dati aziendali
   salvati.”; stopka strony publicznej pokazuje ragione sociale, sede legale (prowincja wielkimi literami) i P.IVA
   (na produkcji od razu dzięki `revalidateTag`; inaczej najpóźniej po 1 h).
3. Reguły: penale „40” → zapis; podgląd anulowania u klienta (`/cliente/ordini/[id]` → „Annulla ordine”) liczy 40 %.
   Penale „101” lub ore „1,5” → komunikat, nic nie zapisane. Bez zmian → „Nessuna modifica.”
4. `audit_log`: `settings.company` (zmienione pola), `settings.rules` (`before` / `after`).
