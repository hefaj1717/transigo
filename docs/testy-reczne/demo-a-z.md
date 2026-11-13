# Test ręczny — demo od A do Z (adres Vercel, staging `bacabuzzevwwdxrswbnc`)

Cel: przejść całe demo (strona publiczna → trzy kreatory → płatność testowa Stripe → obsługa w panelu admina →
widok klienta) na adresie Vercel. Każdy punkt sprawdzić na **komputerze** i na **telefonie** (szerokość ~375 px),
chyba że napisano inaczej. PWA przewoźnika, wypłaty, SMS — poza zakresem.

## 0. Przygotowanie

- Vercel (Production) ma zmienne: `NEXT_PUBLIC_APP_URL` (adres Vercel), klucze Supabase stagingu,
  `STRIPE_SECRET_KEY` (test) i `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, `GOOGLE_MAPS_SERVER_API_KEY`,
  `ADMIN_NOTIFICATION_EMAIL`, `CONTACT_IP_HASH_SECRET`, `EMAIL_TRANSPORT=outbox`, `EINVOICE_PROVIDER` puste albo `demo`,
  **bez** `SITE_INDEXING`. Po zmianie `NEXT_PUBLIC_*` — nowy deploy.
- Stripe (test) → Webhooks: `https://<vercel>/api/webhooks/stripe` ze zdarzeniami `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `refund.updated`, `refund.failed`.
- Supabase (staging) → Auth → URL Configuration: Site URL i Redirect URLs z `https://<vercel>/auth/confirm`.
- `/admin/impostazioni`: dane firmy (`company_*`) — mogą być placeholdery, ale niepuste (stopka, kontakt magazynu).
- Seed na stagingu (krok 11, za zgodą właściciela) — `node scripts/seed-demo.mjs --staging=bacabuzzevwwdxrswbnc`:
  cennik z facchinaggio od 1 osoby, magazyn Bologna z pojemnością, zlecenia z kategoriami przesyłki.
- Konta czyste: `privato.test@`, `azienda.test@`, `admin.test@example.com`; z danymi demo: `cliente@`, `azienda@`,
  `admin@example.com`. Hasło: `.seed-staging/password` (poza repo).
- Karty testowe Stripe: `4242 4242 4242 4242` (OK), `4000 0025 0000 3155` (3D Secure), `4000 0000 0000 0002`
  (odrzucona); dowolna przyszła data i CVC.

## A. Strona publiczna (bez logowania)

1. Strona główna: zakładki w hero (Trasporto / Facchini / Deposito), menu „Servizi”, na telefonie menu mobilne.
2. `/trasporto`, `/facchinaggio`, `/deposito`: ceny orientacyjne, FAQ, **żadnej wzmianki o ratach**.
3. Stopka z danymi firmy, `/contatti`, `/come-funziona`, `/domande-frequenti`, `/diventa-partner`, baner cookie „Ok”.
4. Kalkulator na `/facchinaggio` i `/deposito` → przycisk prowadzi do kreatora z wypełnionymi wartościami.

## B. Trasporto (`privato.test@`)

1. `/prenota`: Milano → Monza; „Aiuto per carico e scarico” 2 osoby; „Cosa spedisci?” = Pallet ×2, „Sovrapponibile”.
2. Ceny z IVA; po zalogowaniu krok „Account” pominięty.
3. „Riepilogo” → Stripe Checkout, karta 4242 → powrót: zlecenie najpierw „Pagamento in verifica”/„In attesa”, po
   chwili (webhook) „Confermato”.
4. `/cliente/fatture`: faktura DEMO, PDF się otwiera (znak wodny).
5. Druga rezerwacja „Veicolo intero” (wybór pojazdu w kroku „Merce”), karta 4000 0000 0000 0002 → płatność odrzucona,
   zlecenie zostaje do zapłaty; „Paga ora” z listy → karta 4242 → „Confermato”.
6. Trzecia rezerwacja → wyjście z Checkout → „Annulla ordine” → zlecenie anulowane.

## C. Facchinaggio (`privato.test@`)

1. `/prenota/facchini`: **1 persona**, 2 h, 3° piano senza ascensore → dopłata za piętro w cenie.
2. Płatność kartą 3D Secure (3155) → potwierdzenie w oknie Stripe → „Confermato”.

## D. Deposito (`privato.test@`)

1. `/prenota/deposito`: krok „Magazzino” — wyszukaj „Bologna”, karta z pełnym adresem, „Vedi sulla mappa” otwiera
   Google Maps w nowej karcie.
2. Box M, ~45 dni, „Ritiro a cura di Transigo” + „Consegna a cura di Transigo” → płatność 4242.
3. `/cliente`: **jedna karta** „Deposito · Box M con trasporto” z trzema częściami (ritiro / deposito / consegna),
   suma grupy; jedna faktura w `/cliente/fatture`.
4. `/cliente/deposito`: rezerwacja w „In corso”, odznaka „Prenotato”.

## E. Firma (`azienda.test@`)

1. Deposito na paletach (Milano, „La porti tu”) — ceny netto + IVA; po płatności adres magazynu w szczegółach.
2. Transport „Pacchi e colli” — ceny netto + IVA, faktura z danymi firmy.

## F. Poza obszarem

1. `/prenota`: Roma → Napoli → komunikat o obszarze + „Lasciaci una richiesta” → wysłanie.
2. `/admin/richieste` (admin): zgłoszenie RM/NA z dystansem, bez ulic → „Segna come gestita”.

## G. Admin (`admin.test@` lub `admin@`) — komputer; telefon tylko podgląd

1. `/admin`: kafelki „Da gestire”, „Incassi” miesiąca, zlecenia wg statusu.
2. `/admin/ordini`: filtr „Servizio”, „Da assegnare”.
3. Transport z B.1: „Assegna” (Ferri) → „Ritirato” → „In viaggio” → „Consegnato” (z powodem; znacznik „senza firma e
   foto”). Kategoria przesyłki i „Sovrapponibile” widoczne w szczegółach.
4. Facchinaggio z C: „Assegna facchini” → „Segna lavoro iniziato” → „Segna lavoro concluso” (z powodem).
5. Łańcuch z D: karta grupy, płatność grupy, limit zwrotu zlecenia; „Assegna” oba transporty; sekcja „Deposito” —
   stan „Prenotato”, po „Consegnato” transportu odbioru → „In deposito”.
6. `/admin/magazzino`: „Prenotazioni deposito” — Milano i Bologna z zajętością („box M 0/8 …”), zakładki
   „In deposito” / „Prenotati e in arrivo” / „Usciti” / „Da pagare”; łańcuch „catena 0xx → 0xx → 0xx”.
7. `/admin/fatture` (wystawione, bez błędów), `/admin/email` (maile w outboxie: `order_paid`, `order_assigned`,
   `order_delivered`, `invoice_issued`).
8. `/admin/listini`: aktywny cennik z „persone minime 1”.

## H. Pieniądze

1. Klient (`privato.test@`) anuluje opłacone zlecenie z B (przed odbiorem): podgląd opłaty → „Annulla” → zwrot
   `succeeded` (Stripe Dashboard test: kwota, metadata), nota kredytowa w `/cliente/fatture`.
2. Admin: częściowy zwrot innego zlecenia („Rimborsa”), wynik w „Pagamenti e rimborsi”.
3. Dane demo (`cliente@`): „Annullamento in revisione” (decyzja admina), „Pagamento da verificare”, „Riprova” zwrotu.

## I. Widok klienta po obsłudze (`privato.test@`)

1. Szczegóły zlecenia: pasek postępu, przewoźnik (imię, firma, pojazd, tablica — bez telefonu), historia.
2. Reklamacja ze zdjęciem do dostarczonego transportu → admin `/admin/reclami` → „Chiudi il reclamo” → mail
   `claim_closed` w outboxie.
3. `/cliente/deposito`, `/cliente/profilo` (zmiana danych, hasło).

## J. Blokada konta

1. Admin `/admin/clienti` → `privato.test@` → „Blocca cliente” z powodem → logowanie klienta odrzucone (`/account-sospeso`).
2. „Sblocca cliente” → logowanie działa.

## Wynik

| Część | Komputer | Telefon | Uwagi |
|---|---|---|---|
| A | uwagi → poprawki 2026-11-13 (D181) | | ponownie po poprawkach |
| B | ✓ poza B1 (do decyzji), faktury naprawione (D180) | | |
| C | ✓, kreator skrócony | | |
| D | ✓ po poprawce fazy „In arrivo” | | |
| E | ✓ | | |
| F | ✓ | | |
| G | ✓ (Claude, `transigo-staging.vercel.app`, 2026-11-13: TG-46, 49, 50→51→52) | — | poprawione: „1 facchino/persona”, „non misurato” zamiast „in corso” po zamknięciu przez admina |
| H | ✓ (Claude: H.1 TG-47, H.2 TG-46 10 €, H.3 TG-27/28/29; zwroty Stripe `succeeded`, noty kredytowe) | | poprawione: zwrot ponowiony z sukcesem nie wisi w „Rimborsi da completare” |
| I | ✓ (Claude: TG-46 szczegóły, reklamacja ze zdjęciem → zamknięta, `claim_opened`/`claim_closed`; hasło nie zmieniane) | | |
| J | | | |
