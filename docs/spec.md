# Transigo — specyfikacja funkcji

> Dokument żywy. Pozycje oznaczone **[DO USTALENIA]** wymagają decyzji właściciela przed implementacją.
> Etykiety UI podane są po włosku (tak jak w aplikacji), opisy po polsku.

## 1. Słownik

| Termin | Znaczenie |
|---|---|
| Cliente | Klient prywatny (codice fiscale) lub firma (P.IVA) zamawiający usługę |
| Padroncino | Drobny przewoźnik z P.IVA, realizuje kursy |
| Ordine / zlecenie | Jedna rezerwacja klienta (może zawierać transport + usługi dodatkowe) |
| Corsa / kurs | Zlecenie widziane z perspektywy przewoźnika |
| Payout / wypłata | Transfer Stripe Connect na konto przewoźnika |
| SDI | Sistema di Interscambio — włoski system e-faktur |
| POD | Proof of Delivery — podpis odbiorcy + zdjęcie(a) |

## 2. Usługi

1. **Trasporto** — przewóz z punktu A do B; typ pojazdu wybiera klient (lub system sugeruje wg wymiarów/wagi).
   Proponowane typy pojazdów **[DO USTALENIA]**: auto/kombi, furgone piccolo (do ~3 m³), furgone medio (~9 m³), furgone grande / 3,5 t (~20 m³), camion con sponda idraulica.
2. **Facchinaggio** — tragarze; liczba osób × czas/stawka.
3. **Imballaggio** — pakowanie; ryczałt lub wg wolumenu/liczby sztuk.
4. **Deposito merci:**
   - *Transbordo* — przeładunek (krótki postój w magazynie, bez składowania),
   - *Breve periodo* — krótkie składowanie (np. do 30 dni) **[DO USTALENIA próg]**,
   - *Lungo periodo* — długie składowanie.
   Rozliczanie za dzień lub za paletę (konfigurowalne).

## 3. Silnik cenowy

### 3.1 Wzór

```
transport  = round(distance_km × rate_per_km_cents[vehicle_type])
             (z minimalną ceną za kurs: max(transport, min_price_cents[vehicle_type]))
surcharges = urgent + weekend/holiday + elevator/floors + porters + packing
storage    = days × rate_per_day_cents  |  pallets × days × rate_per_pallet_day_cents
subtotal   = transport + surcharges + storage
vat        = round(subtotal × vat_rate)          (IVA 22%)
total      = subtotal + vat
carrier_amount = percent_of(transport + carrier-relevant surcharges)  |  fixed_rate
```

- Wszystkie kwoty w centach (`integer`). Zaokrąglenie: half-up do pełnego centa, jednokrotnie na każdym składniku.
- Dystans z Google Maps (trasa drogowa), nie w linii prostej.
- Dopłaty mogą być kwotowe (centy) lub procentowe — typ zapisany w regule.
- Cena jest zapisywana w zleceniu jako **snapshot** (rozbicie pozycji + wersja cennika), żeby późniejsze zmiany cennika nie zmieniały historycznych zleceń.
- Wycena liczona zawsze po stronie serwera; front tylko wyświetla. Kwota w Stripe Checkout pochodzi z serwera.

### 3.2 Otwarte pytania cenowe
- Ceny prezentowane z IVA czy bez (B2C vs B2B)? **[DO USTALENIA]**
- Czy dystans liczy dojazd przewoźnika do miejsca odbioru? **[DO USTALENIA]**
- Które dopłaty wchodzą do kwoty dla przewoźnika (np. tragarze tak, magazyn nie)? **[DO USTALENIA]**
- Definicja „pilne” (np. realizacja < 24 h) i „weekend” (sobota/niedziela + święta włoskie?). **[DO USTALENIA]**

## 4. Statusy zlecenia

```
draft → pending_payment → paid → assigned → picked_up → in_transit → delivered → completed
                    ↘ expired      ↘ cancelled / refunded (admin)
```

| Status (kod) | UI (IT) | Kiedy |
|---|---|---|
| `draft` | Bozza | Kreator w toku |
| `pending_payment` | In attesa di pagamento | Utworzono sesję Stripe Checkout |
| `expired` | Scaduto | Sesja Checkout wygasła bez płatności |
| `paid` | Pagato | Webhook `checkout.session.completed` — kurs widoczny dla przewoźników |
| `assigned` | Assegnato | Przewoźnik kliknął „Accetta la Corsa” |
| `picked_up` | Ritirato | Przewoźnik potwierdził odbiór |
| `in_transit` | In viaggio | W drodze, GPS aktywny |
| `delivered` | Consegnato | Podpis + zdjęcie zapisane |
| `completed` | Completato | Wypłata wykonana |
| `cancelled` | Annullato | Anulowane przez admina |
| `refunded` | Rimborsato | Zwrot pełny (zwrot częściowy to zdarzenie, nie status) |

Każda zmiana statusu zapisywana w tabeli historii (kto, kiedy, skąd, lokalizacja GPS jeśli dotyczy).

Statusy wypłaty (osobno): `not_ready` → `ready` → `paid_out`, oraz `on_hold` (wstrzymana przez admina) i `failed`.

## 5. Strona publiczna

- **Home:** hero z mini-formularzem (Da / A / Data) → przejście do kreatora; opis usług; jak to działa (3 kroki); typy pojazdów; CTA „Diventa partner” dla przewoźników; FAQ; stopka z danymi firmy i linkami prawnymi.
- **Servizi:** podstrony transport, facchinaggio, imballaggio, deposito.
- **Diventa partner:** opis współpracy dla padroncini + rejestracja.
- **Strony prawne:** Termini e condizioni, Privacy (GDPR), Cookie policy (baner cookies).
- **Login / Registrazione** (wspólne dla wszystkich ról, rola wynika z typu rejestracji).

## 6. Kreator rezerwacji (Cliente)

Kroki (pasek postępu, cena na żywo w panelu bocznym / dolnym na mobile):

1. **Percorso** — adres odbioru i dostawy (Google Places autocomplete), opcjonalne przystanki pośrednie **[DO USTALENIA: czy w MVP]**; mapa z trasą i dystansem.
2. **Data e ora** — data i okno czasowe odbioru; opcja „Urgente”. System sam nalicza dopłatę weekendową/świąteczną.
3. **Merce e veicolo** — opis towaru, liczba sztuk, wymiary/waga orientacyjnie, wybór typu pojazdu.
4. **Servizi extra** — piętro i winda na odbiorze/dostawie, liczba tragarzy, pakowanie, magazyn (typ, liczba dni/palet).
5. **Contatti** — dane osoby kontaktowej przy odbiorze i dostawie (imię, telefon), notatki.
6. **Riepilogo** — rozbicie ceny (netto, IVA, brutto), dane do faktury (osoba prywatna: codice fiscale; firma: ragione sociale, P.IVA, codice SDI/PEC), akceptacja regulaminu.
7. **Pagamento** — przekierowanie do Stripe Checkout → strona „Grazie” (status czeka na webhook, odświeża się przez Realtime).

Rezerwacja wymaga konta (lub tworzy je w kroku 6) **[DO USTALENIA: czy dopuszczamy zamówienie jako gość]**.

## 7. Panel klienta

- **I miei ordini:** lista z filtrami (aktywne / zakończone), status, data, kwota.
- **Dettaglio ordine:** trasa, rozbicie ceny, oś czasu statusów, dane przewoźnika (imię, pojazd, tablica — po przypisaniu), mapa trackingu na żywo (od `picked_up` do `delivered`), POD: podpis + zdjęcia do pobrania, faktury PDF.
- **Fatture:** lista e-faktur (PDF + status SDI), noty korygujące przy zwrotach.
- **Profilo:** dane osobowe/firmowe, dane do faktury, adresy zapisane, zmiana hasła.
- **Powiadomienia (e-mail/SMS):** potwierdzenie płatności, przypisanie przewoźnika, odbiór, link do trackingu, dostawa z POD, faktura.
- **Link trackingu publiczny** (bez logowania, z tokenem) dla odbiorcy **[DO USTALENIA]**.

## 8. PWA przewoźnika (Padroncino)

Mobile-first, instalowalna (manifest + service worker), działa przy słabym zasięgu (kolejka wysyłek zdjęć/statusów offline **[DO USTALENIA: zakres w MVP]**).

### 8.1 Rejestracja i onboarding
1. Konto: imię, nazwisko, e-mail, telefon (weryfikacja SMS).
2. Firma: ragione sociale, P.IVA, codice fiscale, adres siedziby, PEC/codice SDI.
3. Dokumenty (upload do Supabase Storage, z datą ważności): licencja przewozowa (iscrizione Albo autotrasportatori / licenza), polisa OC (RCA) + ewentualnie ubezpieczenie towaru, dowód rejestracyjny pojazdu (libretto), dokument tożsamości, prawo jazdy.
4. Pojazd(y): typ (z listy Transigo), tablica, ładowność, wymiary przestrzeni ładunkowej.
5. Wypłaty: onboarding Stripe Connect Express (Stripe zbiera IBAN i KYC).
6. Status konta: `pending_review` → admin aktywuje (`active`) lub odrzuca z powodem; możliwe `suspended`.

### 8.2 Ekrany
- **Corse disponibili:** lista kursów `paid` pasujących do typu pojazdu przewoźnika; karta: trasa (miasta), data/okno, dystans, typ pojazdu, usługi extra, **kwota dla przewoźnika**. Szczegóły przed przyjęciem bez danych osobowych klienta. Przycisk **„Accetta la Corsa”** — przyjęcie atomowe (kto pierwszy, ten ma; drugi dostaje komunikat).
- **Le mie corse:** przypisane / w realizacji / zakończone.
- **Esecuzione corsa:** pełne adresy i kontakty, nawigacja (link do Google Maps), przyciski statusów: „Ritirato” (zdjęcie ładunku), „In viaggio”, „Consegnato” (zdjęcia + podpis odbiorcy na ekranie + imię odbiorcy). GPS wysyłany co N sekund, gdy kurs aktywny i aplikacja otwarta **[DO USTALENIA interwał; ograniczenia PWA w tle na iOS]**.
- **Fattura:** po dostawie upload faktury przewoźnika dla Transigo (PDF/XML) z kwotą; system porównuje kwotę z `carrier_amount`.
- **Guadagni:** lista wypłat i ich statusy, suma w okresie, link do panelu Stripe Express.
- **Profilo e documenti:** dane, pojazdy, dokumenty z datami ważności (ostrzeżenie przed wygaśnięciem; po wygaśnięciu brak dostępu do nowych kursów).
- **Powiadomienia:** nowe kursy w okolicy (push web / SMS **[DO USTALENIA]**).

## 9. Panel admina

- **Dashboard:** przychód (brutto/netto), marża (przychód netto − wypłaty), liczba zleceń wg statusu, wypłaty wstrzymane, dokumenty przewoźników wygasające w ciągu 30 dni, zlecenia `paid` bez przewoźnika dłużej niż X godzin.
- **Ordini:** lista z filtrami i wyszukiwarką; szczegóły; ręczne przypisanie/odpięcie przewoźnika; zmiana statusu z powodem; anulowanie; **zwrot** (pełny/częściowy przez Stripe Refunds → nota korygująca SDI); notatki wewnętrzne; log zdarzeń.
- **Padroncini:** lista, weryfikacja dokumentów, aktywacja/odrzucenie/zawieszenie, pojazdy, status Stripe Connect, historia kursów i wypłat.
- **Clienti:** lista, szczegóły, zlecenia, faktury, blokada konta.
- **Listino prezzi (cennik):** typy pojazdów i stawki/km, ceny minimalne, dopłaty (kwotowe/procentowe), stawki usług (tragarze, pakowanie), stawki magazynowe (dzień/paleta), stawka IVA, reguła kwoty przewoźnika (procent lub stała, globalnie lub per typ pojazdu). Wersjonowanie cennika + podgląd przykładowej wyceny przed zapisem.
- **Magazzino:** lista pozycji w magazynie (zlecenie, klient, liczba palet, data wejścia, planowane wyjście, naliczone dni), przyjęcie/wydanie, lokalizacja w magazynie **[DO USTALENIA: jeden magazyn czy wiele]**, doliczanie opłat za przedłużone składowanie **[DO USTALENIA: jak klient płaci za przedłużenie]**.
- **Fatture:** faktury wystawione klientom (status SDI: inviata, consegnata, scartata) z ponowieniem; faktury przewoźników (podgląd, akceptacja/odrzucenie).
- **Pagamenti / Payouts:** lista wypłat (gotowe, wstrzymane, wykonane, nieudane), **wstrzymaj / zwolnij** wypłatę z powodem, ponowienie nieudanej.
- **Impostazioni:** dane firmy Transigo (do faktur), szablony e-mail/SMS, użytkownicy admin.

## 10. Płatności i wypłaty — reguły

- **Checkout:** sesja Stripe Checkout tworzona na serwerze z kwotą ze snapshotu wyceny; `metadata.order_id`. Zlecenie `paid` tylko po zweryfikowanym (podpis) webhooku; obsługa idempotentna (tabela przetworzonych `event.id`).
- **Model Connect:** „separate charges and transfers” — płatność na konto Transigo, a po spełnieniu warunków `Transfer` na konto Express przewoźnika (`transfer_group = order_id`).
- **Warunki automatycznej wypłaty** (wszystkie muszą być spełnione):
  1. status `delivered` z zapisanym podpisem i ≥1 zdjęciem,
  2. przewoźnik wgrał fakturę (kwota zgodna z `carrier_amount` **[DO USTALENIA: czy wymagana akceptacja admina]**),
  3. brak blokady `on_hold`,
  4. konto Connect przewoźnika ma aktywne `payouts_enabled`.
  Opcjonalne okno reklamacyjne (np. 24–48 h) przed wypłatą **[DO USTALENIA]**.
- **Wstrzymanie:** admin ustawia `on_hold` z powodem; zwolnienie przywraca ocenę warunków.
- **Zwroty:** pełne lub częściowe z poziomu admina; gdy wypłata już poszła — **[DO USTALENIA: reversal transferu czy koszt Transigo]**.
- **Testy jednostkowe** obowiązkowe dla: wyliczania ceny, kwoty przewoźnika, warunków wypłaty, zaokrągleń, zwrotów częściowych.

## 11. E-faktury (SDI)

- Faktura dla klienta wystawiana automatycznie po płatności (lub po dostawie — **[DO USTALENIA]**) przez adapter dostawcy (Fatture in Cloud lub Openapi.it — **[DO USTALENIA wybór]**).
- Dane: osoba prywatna — codice fiscale; firma — P.IVA + codice destinatario (SDI) lub PEC.
- Status z dostawcy (webhook lub polling) zapisywany w bazie; PDF dostępny dla klienta.
- Zwrot → nota di credito.
- Numeracja i dane firmy Transigo z ustawień.

## 12. Bezpieczeństwo i dane

- Supabase Auth; rola zapisana w profilu, egzekwowana przez RLS i middleware.
- RLS na każdej tabeli: `cliente` — tylko swoje zlecenia/faktury; `padroncino` — tylko przypisane zlecenia + widok kursów dostępnych bez danych osobowych; `admin` — pełny dostęp.
- Storage: prywatne buckety (dokumenty, POD, faktury), dostęp przez signed URL.
- Lokalizacja GPS przechowywana tylko dla aktywnych kursów; retencja **[DO USTALENIA]**.
- GDPR: zgoda na przetwarzanie, eksport/usunięcie danych na żądanie.
- Sekrety tylko w zmiennych środowiskowych (Vercel / `.env.local`).

## 13. Powiadomienia

| Zdarzenie | Klient | Przewoźnik | Admin |
|---|---|---|---|
| Płatność potwierdzona | e-mail | — | — |
| Nowy kurs dostępny | — | push/SMS | — |
| Przewoźnik przypisany | e-mail + SMS | — | — |
| Odbiór / w drodze | SMS z linkiem trackingu | — | — |
| Dostarczono (POD) | e-mail | — | — |
| Faktura wystawiona | e-mail | — | — |
| Wypłata wykonana / wstrzymana | — | e-mail | — |
| Nowy przewoźnik do weryfikacji | — | — | e-mail |
| Dokument wygasa za 30/7 dni | — | e-mail | dashboard |
