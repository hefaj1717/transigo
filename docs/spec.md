# Transigo — specyfikacja funkcji

> Dokument żywy. Pozycje oznaczone **[DO USTALENIA]** wymagają decyzji właściciela przed implementacją.
> Etykiety UI podane są po włosku (tak jak w aplikacji), opisy po polsku.
> Pozycje oznaczone **[DO POTWIERDZENIA Z COMMERCIALISTA]** budujemy zgodnie z opisem, ale wymagają weryfikacji księgowo-podatkowej przed startem produkcyjnym.

## 0. Rejestr decyzji (2026-11-08)

| # | Temat | Decyzja |
|---|---|---|
| D1 | Dostawca e-faktur | Fatture in Cloud, za warstwą adaptera (wymienny dostawca). **[DO POTWIERDZENIA Z COMMERCIALISTA]** |
| D2 | Moment wystawienia faktury klientowi | Zaraz po potwierdzonej płatności (webhook Stripe). **[DO POTWIERDZENIA Z COMMERCIALISTA]** |
| D3 | Prezentacja cen | Klient prywatny: ceny z IVA. Firma: netto + IVA osobno. Typ klienta wybierany przy rejestracji. **[DO POTWIERDZENIA Z COMMERCIALISTA]** |
| D4 | Wypłata automatyczna | 24 h po `delivered` (okno konfigurowalne przez admina), jeśli brak otwartej reklamacji i faktura przewoźnika wgrana i zgodna kwotowo. Niezgodność → `to_verify` („Da verificare”), decyzja admina. |
| D5 | Zwrot po wykonanej wypłacie | Koszt ponosi Transigo. Admin może ręcznie dodać potrącenie do następnej wypłaty przewoźnika (`payout_adjustments`). |
| D6 | Kwota przewoźnika | Osobna konfigurowalna reguła (procent lub kwota) dla transportu, tragarzy i pakowania. Magazyn w 100% dla Transigo. |
| D7 | Typy pojazdów | 5 typów startowych, lista edytowalna w panelu admina (nazwa, ładowność, wymiary, stawka/km, cena minimalna). |
| D8 | Konto klienta | Obowiązkowe, zakładane na końcu kreatora przed płatnością. Wycena dostępna bez logowania. |
| D9 | Magazyn | Jeden magazyn w MVP, model danych wielomagazynowy. Składowanie płatne z góry za wybrany okres; przedłużenie przez link płatności Stripe wysyłany klientowi. |
| D10 | Zasięg | Obszar obsługi = lista prowincji ustawiana przez admina; na start jeden region. Poza obszarem: komunikat + formularz kontaktowy. |
| D11 | GPS | W MVP tylko przy otwartej aplikacji; przewoźnik dostaje komunikat, by trzymał ją otwartą w trakcie kursu. |

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
   Typy startowe (D7): auto/kombi, furgone piccolo (do ~3 m³), furgone medio (~9 m³), furgone grande / 3,5 t (~20 m³), camion con sponda idraulica.
   Lista jest **edytowalna w panelu admina**: nazwa, ładowność (kg), wymiary przestrzeni ładunkowej, stawka/km, cena minimalna, aktywny/nieaktywny.
2. **Facchinaggio** — tragarze; liczba osób × czas/stawka.
3. **Imballaggio** — pakowanie; ryczałt lub wg wolumenu/liczby sztuk.
4. **Deposito merci:**
   - *Transbordo* — przeładunek (krótki postój w magazynie, bez składowania),
   - *Breve periodo* — krótkie składowanie (np. do 30 dni) **[DO USTALENIA próg]**,
   - *Lungo periodo* — długie składowanie.
   Rozliczanie za dzień lub za paletę (konfigurowalne).
   Składowanie **płatne z góry** za okres wybrany w kreatorze; przedłużenie przez link płatności Stripe wysyłany klientowi (D9). Przychód z magazynu w 100% dla Transigo.

## 2a. Obszar obsługi (D10)

- Admin ustawia listę obsługiwanych prowincji (na start jeden region).
- Adres odbioru **i** dostawy muszą leżeć w obsługiwanych prowincjach (prowincja z Google Geocoding / Places).
- Poza obszarem kreator nie pokazuje ceny, tylko komunikat („Al momento non serviamo questa zona”) i formularz kontaktowy (zapis do tabeli zapytań + e-mail do admina).

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

carrier_amount = carrier_share(transport_part)   # transport + jego dopłaty (pilne, weekend, winda)
               + carrier_share(porters_part)
               + carrier_share(packing_part)
               # storage → 0 (100% Transigo)
carrier_share(x) = round(x × percent)  |  fixed_cents   # osobna reguła dla każdej z 3 usług (D6)
```

- Wszystkie kwoty w centach (`integer`). Zaokrąglenie: half-up do pełnego centa, jednokrotnie na każdym składniku.
- Dystans z Google Maps (trasa drogowa), nie w linii prostej.
- Dopłaty mogą być kwotowe (centy) lub procentowe — typ zapisany w regule.
- Cena jest zapisywana w zleceniu jako **snapshot** (rozbicie pozycji + wersja cennika), żeby późniejsze zmiany cennika nie zmieniały historycznych zleceń.
- Wycena liczona zawsze po stronie serwera; front tylko wyświetla. Kwota w Stripe Checkout pochodzi z serwera.

### 3.2 Prezentacja cen (D3) **[DO POTWIERDZENIA Z COMMERCIALISTA]**
- Typ klienta (`private` / `business`) wybierany przy rejestracji.
- Przed zalogowaniem kreator pozwala przełączyć widok „Privato / Azienda” (domyślnie Privato).
- Privato: ceny z IVA (brutto). Azienda: netto + IVA osobno + brutto.
- Silnik zawsze liczy netto, IVA i brutto — różni się tylko prezentacja.

### 3.3 Otwarte pytania cenowe
- Czy dystans liczy dojazd przewoźnika do miejsca odbioru? **[DO USTALENIA]** (domyślnie: nie)
- Które dopłaty transportowe zalicza się do części przewoźnika — przyjęto wszystkie (pilne, weekend, winda). **[DO USTALENIA]**
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

Statusy wypłaty (osobno):

| Status (kod) | UI (IT) | Kiedy |
|---|---|---|
| `not_ready` | Non pronto | Brak dostawy lub faktury przewoźnika |
| `to_verify` | Da verificare | Kwota na fakturze ≠ `carrier_amount`; czeka na decyzję admina |
| `waiting_window` | In attesa | Warunki spełnione, trwa okno (domyślnie 24 h od `delivered`) |
| `ready` | Pronto | Okno minęło, gotowe do transferu (wykonuje job) |
| `paid_out` | Pagato | Transfer Stripe wykonany |
| `on_hold` | Sospeso | Wstrzymane przez admina lub otwarta reklamacja |
| `failed` | Fallito | Błąd transferu; admin może ponowić |

Reklamacje (`claims`): klient lub admin otwiera reklamację do zlecenia; otwarta reklamacja blokuje wypłatę (`on_hold`), zamknięcie przywraca ocenę warunków.

## 5. Strona publiczna

- **Home:** hero z mini-formularzem (Da / A / Data) → przejście do kreatora; opis usług; jak to działa (3 kroki); typy pojazdów; CTA „Diventa partner” dla przewoźników; FAQ; stopka z danymi firmy i linkami prawnymi.
- **Servizi:** podstrony transport, facchinaggio, imballaggio, deposito.
- **Diventa partner:** opis współpracy dla padroncini + rejestracja.
- **Strony prawne:** Termini e condizioni, Privacy (GDPR), Cookie policy (baner cookies).
- **Login / Registrazione** (wspólne dla wszystkich ról, rola wynika z typu rejestracji).

## 6. Kreator rezerwacji (Cliente)

Kroki (pasek postępu, cena na żywo w panelu bocznym / dolnym na mobile):

1. **Percorso** — adres odbioru i dostawy (Google Places autocomplete), opcjonalne przystanki pośrednie **[DO USTALENIA: czy w MVP]**; mapa z trasą i dystansem. Sprawdzenie obszaru obsługi (sekcja 2a) — poza obszarem komunikat + formularz kontaktowy.
2. **Data e ora** — data i okno czasowe odbioru; opcja „Urgente”. System sam nalicza dopłatę weekendową/świąteczną.
3. **Merce e veicolo** — opis towaru, liczba sztuk, wymiary/waga orientacyjnie, wybór typu pojazdu.
4. **Servizi extra** — piętro i winda na odbiorze/dostawie, liczba tragarzy, pakowanie, magazyn (typ, liczba dni/palet).
5. **Contatti** — dane osoby kontaktowej przy odbiorze i dostawie (imię, telefon), notatki.
6. **Riepilogo** — rozbicie ceny wg typu klienta (D3), dane do faktury (osoba prywatna: codice fiscale; firma: ragione sociale, P.IVA, codice SDI/PEC), akceptacja regulaminu.
7. **Account** — logowanie lub rejestracja (wybór Privato/Azienda). Wycena zostaje zachowana; po zalogowaniu cena przeliczana na serwerze i, jeśli typ klienta się zmienił, pokazywana ponownie.
8. **Pagamento** — przekierowanie do Stripe Checkout → strona „Grazie” (status czeka na webhook, odświeża się przez Realtime).

Kroki 1–6 (wycena) dostępne bez logowania; konto jest obowiązkowe przed płatnością (D8). Brak zamówień jako gość. Kreator niezalogowanego użytkownika trzymany po stronie klienta (localStorage), zlecenie w bazie powstaje dopiero po zalogowaniu.

## 7. Panel klienta

- **I miei ordini:** lista z filtrami (aktywne / zakończone), status, data, kwota.
- **Dettaglio ordine:** trasa, rozbicie ceny, oś czasu statusów, dane przewoźnika (imię, pojazd, tablica — po przypisaniu), mapa trackingu na żywo (od `picked_up` do `delivered`), POD: podpis + zdjęcia do pobrania, faktury PDF.
- **Fatture:** lista e-faktur (PDF + status SDI), noty korygujące przy zwrotach.
- **Reclami:** otwarcie reklamacji do zlecenia (opis + zdjęcia), podgląd statusu.
- **Deposito:** pozycje w magazynie, data końca opłaconego okresu, przedłużenie przez link płatności (D9).
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
- **Esecuzione corsa:** pełne adresy i kontakty, nawigacja (link do Google Maps), przyciski statusów: „Ritirato” (zdjęcie ładunku), „In viaggio”, „Consegnato” (zdjęcia + podpis odbiorcy na ekranie + imię odbiorcy). GPS wysyłany co N sekund **tylko przy otwartej aplikacji** (D11) **[DO USTALENIA interwał, domyślnie 15 s]**. Przez cały kurs widoczny baner: „Tieni l'app aperta durante la corsa per condividere la posizione”; Wake Lock API, gdy dostępne. Brak sygnału GPS > X min → ostrzeżenie dla przewoźnika.
- **Fattura:** po dostawie upload faktury przewoźnika dla Transigo (PDF/XML) z podaną kwotą. Walidacja automatyczna (D4): kwota = `carrier_amount` (+ suma `payout_adjustments` przypisanych do tej wypłaty) → wypłata przechodzi dalej; niezgodność → `to_verify` i komunikat dla przewoźnika, decyzja admina.
- **Guadagni:** lista wypłat i ich statusy (z przewidywaną datą wypłaty po oknie), potrącenia (`payout_adjustments`) z powodem, suma w okresie, link do panelu Stripe Express.
- **Profilo e documenti:** dane, pojazdy, dokumenty z datami ważności (ostrzeżenie przed wygaśnięciem; po wygaśnięciu brak dostępu do nowych kursów).
- **Powiadomienia:** nowe kursy w okolicy (push web / SMS **[DO USTALENIA]**).

## 9. Panel admina

- **Dashboard:** przychód (brutto/netto), marża (przychód netto − wypłaty), liczba zleceń wg statusu, wypłaty wstrzymane, dokumenty przewoźników wygasające w ciągu 30 dni, zlecenia `paid` bez przewoźnika dłużej niż X godzin.
- **Ordini:** lista z filtrami i wyszukiwarką; szczegóły; ręczne przypisanie/odpięcie przewoźnika; zmiana statusu z powodem; anulowanie; **zwrot** (pełny/częściowy przez Stripe Refunds → nota korygująca SDI); notatki wewnętrzne; log zdarzeń.
- **Padroncini:** lista, weryfikacja dokumentów, aktywacja/odrzucenie/zawieszenie, pojazdy, status Stripe Connect, historia kursów i wypłat.
- **Clienti:** lista, szczegóły, zlecenia, faktury, blokada konta.
- **Reclami:** lista reklamacji, otwarcie/zamknięcie z notatką; otwarta reklamacja wstrzymuje wypłatę.
- **Veicoli:** CRUD typów pojazdów (nazwa, ładowność, wymiary, stawka/km, cena minimalna, aktywny) — D7.
- **Listino prezzi (cennik):** dopłaty (kwotowe/procentowe), stawki usług (tragarze, pakowanie), stawki magazynowe (dzień/paleta), stawka IVA, **reguły kwoty przewoźnika: osobno dla transportu, tragarzy i pakowania** (procent lub kwota; magazyn zawsze 0) — D6. Wersjonowanie cennika + podgląd przykładowej wyceny przed zapisem.
- **Area di servizio:** lista obsługiwanych prowincji (D10); zapytania z formularza kontaktowego spoza obszaru.
- **Magazzino:** jeden magazyn w MVP (tabela `warehouses`, gotowa na kolejne) — D9. Lista pozycji (zlecenie, klient, liczba palet, data wejścia, opłacone do, naliczone dni), przyjęcie/wydanie, lokalizacja w magazynie. Pozycje z kończącym się okresem → przycisk „Invia link di pagamento” (Stripe Payment Link / Checkout na przedłużenie; po webhooku przesuwa datę „opłacone do” i wystawia fakturę).
- **Fatture:** faktury wystawione klientom (status SDI: inviata, consegnata, scartata) z ponowieniem; faktury przewoźników (podgląd, akceptacja/odrzucenie).
- **Pagamenti / Payouts:** lista wypłat wg statusów (sekcja 4), kolejka **„Da verificare”** (podgląd faktury przewoźnika vs `carrier_amount`, akceptuj / odrzuć z powodem), **wstrzymaj / zwolnij** z powodem, ponowienie nieudanej, **potrącenia** (`payout_adjustments`: przewoźnik, kwota w centach, powód, powiązane zlecenie; rozliczane przy następnej wypłacie).
- **Impostazioni:** dane firmy Transigo (do faktur), okno wypłaty w godzinach (domyślnie 24), szablony e-mail/SMS, użytkownicy admin.

## 10. Płatności i wypłaty — reguły

- **Checkout:** sesja Stripe Checkout tworzona na serwerze z kwotą ze snapshotu wyceny; `metadata.order_id`. Zlecenie `paid` tylko po zweryfikowanym (podpis) webhooku; obsługa idempotentna (tabela przetworzonych `event.id`).
- **Model Connect:** „separate charges and transfers” — płatność na konto Transigo, a po spełnieniu warunków `Transfer` na konto Express przewoźnika (`transfer_group = order_id`).
- **Warunki automatycznej wypłaty** (D4, wszystkie muszą być spełnione):
  1. status `delivered` z zapisanym podpisem i ≥1 zdjęciem,
  2. przewoźnik wgrał fakturę, a jej kwota = kwota wypłaty (automatyczna walidacja; niezgodność → `to_verify`, admin akceptuje lub odrzuca),
  3. minęło okno od `delivered` (domyślnie 24 h, konfigurowalne w panelu admina),
  4. brak otwartej reklamacji i brak ręcznej blokady `on_hold`,
  5. konto Connect przewoźnika ma aktywne `payouts_enabled`.
  Sprawdzanie realizuje zaplanowany job (cron, np. co 15 min) — idempotentnie, z `idempotency_key` na transferze Stripe.
- **Kwota wypłaty** = `carrier_amount` zlecenia + suma nierozliczonych `payout_adjustments` przewoźnika (potrącenia ujemne). Wypłata nie może zejść poniżej 0 — nadwyżka potrącenia przechodzi na kolejną wypłatę.
- **Wstrzymanie:** admin ustawia `on_hold` z powodem; zwolnienie przywraca ocenę warunków.
- **Zwroty:** pełne lub częściowe z poziomu admina (Stripe Refunds → nota di credito). Jeśli wypłata już poszła, **koszt ponosi Transigo** (bez reversal transferu); admin może ręcznie dodać potrącenie do następnej wypłaty przewoźnika (D5).
- **Testy jednostkowe** obowiązkowe dla: wyliczania ceny, kwoty przewoźnika (3 reguły), warunków wypłaty i okna czasowego, walidacji kwoty faktury, potrąceń, zaokrągleń, zwrotów częściowych.

## 11. E-faktury (SDI)

- **[DO POTWIERDZENIA Z COMMERCIALISTA]** (D1, D2)
- Dostawca: **Fatture in Cloud**, wywoływany wyłącznie przez interfejs adaptera (`lib/einvoice`, np. `EInvoiceProvider` z metodami `issueInvoice`, `issueCreditNote`, `getStatus`) — zmiana dostawcy = nowa implementacja adaptera, bez zmian w logice biznesowej.
- Faktura dla klienta wystawiana automatycznie **zaraz po potwierdzonej płatności** (webhook Stripe), także dla płatności za przedłużenie magazynu. Błąd dostawcy nie blokuje zlecenia — faktura trafia do kolejki ponowień, admin widzi błąd.
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
| Wypłata wykonana / wstrzymana / da verificare | — | e-mail | dashboard |
| Reklamacja otwarta | — | e-mail | e-mail |
| Magazyn: kończy się opłacony okres / link do przedłużenia | e-mail (+ SMS) | — | dashboard |
| Zapytanie spoza obszaru obsługi | — | — | e-mail |
| Nowy przewoźnik do weryfikacji | — | — | e-mail |
| Dokument wygasa za 30/7 dni | — | e-mail | dashboard |
