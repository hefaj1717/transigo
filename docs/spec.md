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
| D10 | Zasięg | Obszar obsługi = lista prowincji ustawiana przez admina; na start jeden region. Poza obszarem: komunikat + formularz kontaktowy. *(Reguła adresów doprecyzowana w D13.)* |
| D11 | GPS | W MVP tylko przy otwartej aplikacji; przewoźnik dostaje komunikat, by trzymał ją otwartą w trakcie kursu. |
| D12 | Faktura przewoźnika a potrącenia | Faktura przewoźnika zawsze na pełną kwotę przewoźnika za zlecenie (`carrier_amount`). Potrącenia nie zmieniają faktury — zmniejszają tylko kwotę przelewu i są dokumentowane osobno (rodzaj dokumentu **[DO POTWIERDZENIA Z COMMERCIALISTA]**). Walidacja: kwota na fakturze = `carrier_amount` (przed potrąceniami). |
| D13 | Reguła obszaru obsługi | Adres **odbioru** musi leżeć w obsługiwanej prowincji. Adres **dostawy** dowolny, o ile dystans trasy ≤ maksymalny dystans (km) ustawiany przez admina. |
| D14 | Dopłaty w części przewoźnika | Dopłaty pilne, weekend/święto i winda/piętra liczone do części transportowej przewoźnika (podlegają regule transportu z D6). |
| D15 | Potrącenia większe niż wypłata | Przelew nie może być ujemny; nadwyżka potrącenia przechodzi na kolejną wypłatę przewoźnika. |
| D16 | Uruchamianie wypłat | Zaplanowany job (cron) co 15 min sprawdza warunki i wykonuje transfery idempotentnie. |
| D17 | Interwał GPS | Lokalizacja wysyłana co 15 s podczas aktywnego kursu (przy otwartej aplikacji). |
| D18 | Cennik w bazie | Stawka/km i cena minimalna należą do **wersji cennika** (`price_list_vehicle_rates`), nie do typu pojazdu. Reguły (dopłaty, usługi, magazyn, kwoty przewoźnika) w tabeli `price_rules` z enumem kodów, nie w JSON. *(db-schema W1, W2)* |
| D19 | Zapis zleceń | Zlecenia, pozycje ceny, płatności, faktury i wypłaty zapisuje wyłącznie serwer; przewoźnik zmienia statusy przez funkcje RPC. Brak bezpośredniego `INSERT/UPDATE` z przeglądarki. *(W3)* |
| D20 | Przystanki pośrednie | Poza MVP (później tabela `order_stops`). *(W4)* |
| D21 | Warunki przyjęcia kursu | Konto przewoźnika `active` + zatwierdzone, ważne dokumenty obowiązkowe + `payouts_enabled` w Stripe Connect. *(W5)* |
| D22 | Dopasowanie kursu do pojazdu | Przewoźnik widzi kursy na swój typ pojazdu **i typy mniejsze** (kolejność wg `vehicle_types.size_rank`). Kwota dla przewoźnika zawsze według typu pojazdu ze zlecenia. *(W6)* |
| D23 | Konto firmowe | Jedno konto = jeden użytkownik; brak wielu użytkowników jednej firmy w MVP. *(W7)* |
| D24 | Publiczny link trackingu | Kolumna `tracking_token` przygotowana, funkcja wyłączona do osobnej decyzji. *(W8)* |
| D25 | Retencja GPS | Punkty GPS usuwane 30 dni po `delivered` (job). *(W9)* |
| D26 | Faktura klienta | Jedna faktura na płatność (zlecenie albo przedłużenie magazynu); zwrot = nota korygująca do tej faktury. *(W10)* |
| D27 | Święta | Tabela świąt edytowana przez admina, tylko święta krajowe (bez patronów lokalnych). *(W11)* |
| D28 | Tragarze | Liczba osób i godzin deklarowana w kreatorze, płatna z góry; bez dopłat za nadgodziny w MVP. *(W12)* |
| D29 | Co przewoźnik widzi z ceny | Tylko swoją kwotę i listę usług — bez ceny klienta i marży Transigo. *(W13)* |
| D30 | Reklamacja a przewoźnik | Przewoźnik widzi otwartą reklamację i jej opis (bez danych klienta), nie odpowiada w aplikacji — kontakt przez admina. *(W14)* |
| D31 | Wstrzymanie wypłaty | Przewoźnik widzi status `on_hold` i powód wpisany przez admina. *(W15)* |
| D32 | Częściowy zwrot przed wypłatą | Nie zmienia automatycznie kwoty przewoźnika ani jego faktury; admin decyduje i ewentualnie dodaje potrącenie. *(W16)* |
| D33 | Polityka anulowania (MVP) | Klient anuluje bezpłatnie do **X h** przed początkiem okna odbioru (domyślnie 24), później opłata **Y %** (domyślnie 50) — oba w `settings`. Anulowanie **po przyjęciu kursu** przez przewoźnika → status `cancellation_review`; decyzję (zwrot częściowy, ewentualna kwota dla przewoźnika) podejmuje admin. Bez automatycznych rekompensat dla przewoźnika. *(W17; szczegóły: sekcja 4a)* |
| D34 | Weryfikacja telefonu | Weryfikacja SMS (Twilio Verify) **tylko dla przewoźników**. Klienci: tylko e-mail (telefon bez weryfikacji). *(W18)* |
| D35 | GDPR — usunięcie danych | Anonimizacja profilu (imię, telefon, adresy) zamiast usunięcia; zlecenia i faktury zostają z danymi fiskalnymi ze snapshotu (obowiązek przechowywania 10 lat). *(W19)* |
| D36 | Dane do faktury | Domyślnie z profilu; klient może je zmienić dla danego zlecenia w „Riepilogo” (snapshot w zleceniu, profil bez zmian). *(W20)* |
| D37 | Tworzenie kont | `profiles` tworzy trigger przy rejestracji; `customers` / `carriers` tworzy serwer z danych formularza. Rola `admin` nadawana wyłącznie ręcznie. *(W21)* |
| D38 | Podstawa opłaty za późne anulowanie | Y % liczone tylko od pozycji **transport (z dopłatami, D14), tragarze i pakowanie** (brutto). Składowanie, które się nie rozpoczęło, zwracane w całości. *(A1)* |
| D39 | Rezygnacja przewoźnika z kursu | Przewoźnik nie rezygnuje sam. W PWA przycisk **„Segnala un problema”** przy kursie: powód z listy + opis → zgłoszenie (`order_issues`) widoczne przy zleceniu, powiadomienie dla admina. Admin może odpiąć przewoźnika (zlecenie wraca do `paid`). Etap 4. *(A2)* |
| D40 | Kwota dla przewoźnika przy anulowaniu | Kwota ustalona przez admina w `cancellation_review` tworzy zwykłą wypłatę: wymaga faktury przewoźnika na tę kwotę, bez wymogu POD, okno liczone od decyzji admina. *(A3)* |
| D41 | `cancelled` vs `refunded` | Anulowanie (D33) zawsze kończy się `cancelled` (zwrócona kwota w `refunded_cents`). `refunded` = pełny zwrot zlecenia z innego powodu, decyzją admina. *(A4)* |
| D42 | Zgody prawne | Przy rejestracji dwa osobne checkboxy: „Termini e condizioni” i „Privacy”. W `profiles` zapisujemy `terms_accepted_at` + `terms_version` oraz `privacy_accepted_at` + `privacy_version` (wersja jako tekst, np. `2026-11-01`). Aktualne wersje dokumentów w `settings` (`terms_version`, `privacy_version`), edytowane przez admina. Zgody zapisuje tylko serwer. Wymuszanie ponownej zgody po zmianie wersji — osobna decyzja. |
| D43 | Rejestracja klienta prywatnego | Nome, cognome, e-mail, hasło, telefon opcjonalny. **Codice fiscale i adres do faktury** zbierane w kroku „Riepilogo” przed płatnością (Etap 2/3); serwer nie tworzy sesji Checkout dla `private` bez codice fiscale. W bazie brak wymogu `fiscal_code` dla `private`. |
| D44 | Rejestracja firmy (cliente azienda) | Nome, cognome, e-mail, hasło, telefon opcjonalny + ragione sociale, P.IVA oraz **codice SDI lub PEC** (co najmniej jedno; check w bazie). Adres do faktury w „Riepilogo”. |
| D45 | Rejestracja przewoźnika | Nome, cognome, e-mail, hasło, telefon (wymagany; weryfikacja SMS w Etapie 4) + ragione sociale, P.IVA, codice fiscale, adres siedziby (via, città, CAP, provincia), PEC lub codice SDI. Dokumenty, pojazdy i Stripe Connect w Etapie 4. Konto startuje jako `pending_review`. |
| D46 | Trasy kont i ochrona | `/registrati`, `/accedi`, `/password-dimenticata`, `/reimposta-password`, `/auth/confirm`, `/account-sospeso`; panele `/cliente`, `/padroncino`, `/admin`. Kontrola dostępu po stronie serwera w każdej stronie (DAL), proxy tylko optymistycznie (brak sesji → `/accedi`). Zła rola → własny panel; zablokowany → „Account sospeso”; przewoźnik nieaktywny → ekran „Account in attesa di verifica”. |

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

## 2a. Obszar obsługi (D10, D13)

- Admin ustawia listę obsługiwanych prowincji (na start jeden region) oraz maksymalny dystans trasy w km.
- Adres **odbioru** musi leżeć w obsługiwanej prowincji (prowincja z Google Geocoding / Places).
- Adres **dostawy** może być dowolny, jeśli dystans trasy ≤ maksymalny dystans.
- Poza obszarem (odbiór spoza prowincji lub zbyt długa trasa) kreator nie pokazuje ceny, tylko komunikat („Al momento non serviamo questa zona”) i formularz kontaktowy (zapis do tabeli zapytań + e-mail do admina).

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

carrier_amount = carrier_share(transport_part)   # transport + jego dopłaty (pilne, weekend, winda) — D14
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
- Definicja „pilne” (np. realizacja < 24 h) i „weekend” (sobota/niedziela + święta włoskie?). **[DO USTALENIA]**

## 4. Statusy zlecenia

```
draft → pending_payment → paid → assigned → picked_up → in_transit → delivered → completed
                    ↘ expired      ↘ cancelled / refunded (admin)
                                   paid → cancelled (klient, D33)
                                   assigned → cancellation_review → cancelled (decyzja admina, D33)
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
| `cancellation_review` | Annullamento in revisione | Klient anulował po przyjęciu kursu przez przewoźnika; czeka na decyzję admina (D33) |
| `cancelled` | Annullato | Anulowane (przez klienta wg D33 lub przez admina) |
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

## 4a. Anulowanie zlecenia (D33)

- Ustawienia admina (`settings`): `free_cancellation_hours` (domyślnie 24) i `late_cancellation_fee_bp` (domyślnie 5000 = 50 %).
- Moment odniesienia: początek okna odbioru (`pickup_window_start`).
- **Status `paid` (brak przewoźnika):**
  - ≥ X h przed odbiorem → anulowanie bezpłatne, pełny zwrot automatycznie, status `cancelled`;
  - < X h przed odbiorem → opłata Y % od pozycji transport (z dopłatami), tragarze i pakowanie (brutto); składowanie, które się nie rozpoczęło, zwracane w całości (D38); zwrot reszty automatycznie, status `cancelled`.
- **Status `assigned` (przewoźnik przyjął kurs):** klient zgłasza anulowanie → `cancellation_review`; przewoźnik dostaje informację, że kursu nie wykonuje. Admin decyduje: kwota zwrotu dla klienta i ewentualna kwota dla przewoźnika (bez automatycznych rekompensat) → `cancelled`.
- Od `picked_up` klient nie anuluje w aplikacji — tylko przez reklamację / kontakt z adminem.
- Kwota dla przewoźnika z decyzji admina → wypłata wg D40. Status końcowy zawsze `cancelled` (D41).
- Każdy zwrot (pełny lub częściowy) → nota di credito (D26).

## 5. Strona publiczna

- **Home:** hero z mini-formularzem (Da / A / Data) → przejście do kreatora; opis usług; jak to działa (3 kroki); typy pojazdów; CTA „Diventa partner” dla przewoźników; FAQ; stopka z danymi firmy i linkami prawnymi.
- **Servizi:** podstrony transport, facchinaggio, imballaggio, deposito.
- **Diventa partner:** opis współpracy dla padroncini + rejestracja.
- **Strony prawne:** Termini e condizioni, Privacy (GDPR), Cookie policy (baner cookies).
- **Login / Registrazione** (wspólne dla wszystkich ról, rola wynika z typu rejestracji).

## 6. Kreator rezerwacji (Cliente)

Kroki (pasek postępu, cena na żywo w panelu bocznym / dolnym na mobile):

1. **Percorso** — adres odbioru i dostawy (Google Places autocomplete), bez przystanków pośrednich w MVP (D20); mapa z trasą i dystansem. Sprawdzenie obszaru obsługi (sekcja 2a: prowincja odbioru + maks. dystans) — poza obszarem komunikat + formularz kontaktowy.
2. **Data e ora** — data i okno czasowe odbioru; opcja „Urgente”. System sam nalicza dopłatę weekendową/świąteczną.
3. **Merce e veicolo** — opis towaru, liczba sztuk, wymiary/waga orientacyjnie, wybór typu pojazdu.
4. **Servizi extra** — piętro i winda na odbiorze/dostawie, liczba tragarzy, pakowanie, magazyn (typ, liczba dni/palet).
5. **Contatti** — dane osoby kontaktowej przy odbiorze i dostawie (imię, telefon), notatki.
6. **Riepilogo** — rozbicie ceny wg typu klienta (D3), dane do faktury (osoba prywatna: codice fiscale + adres — wymagane tu, bo nie ma ich przy rejestracji, D43; firma: adres, dane z rejestracji do sprawdzenia/zmiany, D36, D44), akceptacja regulaminu.
7. **Account** — logowanie lub rejestracja (wybór Privato/Azienda; pola wg D43/D44). Wycena zostaje zachowana; po zalogowaniu cena przeliczana na serwerze i, jeśli typ klienta się zmienił, pokazywana ponownie.
8. **Pagamento** — przekierowanie do Stripe Checkout → strona „Grazie” (status czeka na webhook, odświeża się przez Realtime).

Kroki 1–6 (wycena) dostępne bez logowania; konto jest obowiązkowe przed płatnością (D8). Brak zamówień jako gość. Kreator niezalogowanego użytkownika trzymany po stronie klienta (localStorage), zlecenie w bazie powstaje dopiero po zalogowaniu.

## 7. Panel klienta

- **I miei ordini:** lista z filtrami (aktywne / zakończone), status, data, kwota.
- **Dettaglio ordine:** trasa, rozbicie ceny, oś czasu statusów, dane przewoźnika (imię, pojazd, tablica — po przypisaniu), mapa trackingu na żywo (od `picked_up` do `delivered`), POD: podpis + zdjęcia do pobrania, faktury PDF, przycisk „Annulla ordine” z informacją o opłacie wg D33 (sekcja 4a).
- **Fatture:** lista e-faktur (PDF + status SDI), noty korygujące przy zwrotach.
- **Reclami:** otwarcie reklamacji do zlecenia (opis + zdjęcia), podgląd statusu.
- **Deposito:** pozycje w magazynie, data końca opłaconego okresu, przedłużenie przez link płatności (D9).
- **Profilo:** dane osobowe/firmowe, dane do faktury, adresy zapisane, zmiana hasła.
- **Powiadomienia (e-mail/SMS):** potwierdzenie płatności, przypisanie przewoźnika, odbiór, link do trackingu, dostawa z POD, faktura.
- **Link trackingu publiczny** (bez logowania, z tokenem) dla odbiorcy — przygotowane w bazie, wyłączone do osobnej decyzji (D24).

## 8. PWA przewoźnika (Padroncino)

Mobile-first, instalowalna (manifest + service worker), działa przy słabym zasięgu (kolejka wysyłek zdjęć/statusów offline **[DO USTALENIA: zakres w MVP]**).

### 8.1 Rejestracja i onboarding
1. Konto: imię, nazwisko, e-mail, telefon (weryfikacja SMS przez Twilio Verify — tylko przewoźnicy, D34).
2. Firma: ragione sociale, P.IVA, codice fiscale, adres siedziby, PEC/codice SDI.
3. Dokumenty (upload do Supabase Storage, z datą ważności): licencja przewozowa (iscrizione Albo autotrasportatori / licenza), polisa OC (RCA) + ewentualnie ubezpieczenie towaru, dowód rejestracyjny pojazdu (libretto), dokument tożsamości, prawo jazdy.
4. Pojazd(y): typ (z listy Transigo), tablica, ładowność, wymiary przestrzeni ładunkowej.
5. Wypłaty: onboarding Stripe Connect Express (Stripe zbiera IBAN i KYC).
6. Status konta: `pending_review` → admin aktywuje (`active`) lub odrzuca z powodem; możliwe `suspended`.

### 8.2 Ekrany
- **Corse disponibili:** lista kursów `paid` na typ pojazdu przewoźnika lub mniejszy (D22), dostępna po spełnieniu warunków D21; karta: trasa (miasta), data/okno, dystans, typ pojazdu, usługi extra, **kwota dla przewoźnika**. Szczegóły przed przyjęciem bez danych osobowych klienta. Przycisk **„Accetta la Corsa”** — przyjęcie atomowe (kto pierwszy, ten ma; drugi dostaje komunikat).
- **Le mie corse:** przypisane / w realizacji / zakończone.
- **Esecuzione corsa:** pełne adresy i kontakty, nawigacja (link do Google Maps), przyciski statusów: „Ritirato” (zdjęcie ładunku), „In viaggio”, „Consegnato” (zdjęcia + podpis odbiorcy na ekranie + imię odbiorcy). GPS wysyłany co 15 s (D17) **tylko przy otwartej aplikacji** (D11). Przez cały kurs widoczny baner: „Tieni l'app aperta durante la corsa per condividere la posizione”; Wake Lock API, gdy dostępne. Brak sygnału GPS > X min → ostrzeżenie dla przewoźnika.
- **Fattura:** po dostawie upload faktury przewoźnika dla Transigo (PDF/XML) z podaną kwotą. Faktura zawsze na pełną kwotę przewoźnika za zlecenie (D12). Walidacja automatyczna (D4, D12): kwota = `carrier_amount` (przed potrąceniami) → wypłata przechodzi dalej; niezgodność → `to_verify` i komunikat dla przewoźnika, decyzja admina.
- **Segnala un problema** (przy kursie, D39): powód z listy (awaria pojazdu, nie mogę dojechać na odbiór, towar niezgodny z opisem, problem z adresem, brak kontaktu z klientem, inne) + opis; zgłoszenie widoczne przy zleceniu w panelu admina, admin dostaje powiadomienie.
- **Guadagni:** lista wypłat i ich statusy (z przewidywaną datą wypłaty po oknie), rozbicie każdej wypłaty: kwota z faktury − potrącenia (`payout_adjustments`, z powodem) = przelew, suma w okresie, link do panelu Stripe Express.
- **Profilo e documenti:** dane, pojazdy, dokumenty z datami ważności (ostrzeżenie przed wygaśnięciem; po wygaśnięciu brak dostępu do nowych kursów).
- **Powiadomienia:** nowe kursy w okolicy (push web / SMS **[DO USTALENIA]**).

## 9. Panel admina

- **Dashboard:** przychód (brutto/netto), marża (przychód netto − wypłaty), liczba zleceń wg statusu, wypłaty wstrzymane, dokumenty przewoźników wygasające w ciągu 30 dni, zlecenia `paid` bez przewoźnika dłużej niż X godzin.
- **Ordini:** lista z filtrami i wyszukiwarką; szczegóły; ręczne przypisanie/odpięcie przewoźnika; zmiana statusu z powodem; anulowanie; kolejka `cancellation_review` (decyzja: kwota zwrotu + ewentualna kwota dla przewoźnika — D33); **zwrot** (pełny/częściowy przez Stripe Refunds → nota korygująca SDI); notatki wewnętrzne; log zdarzeń.
- **Padroncini:** lista, weryfikacja dokumentów, aktywacja/odrzucenie/zawieszenie, pojazdy, status Stripe Connect, historia kursów i wypłat.
- **Clienti:** lista, szczegóły, zlecenia, faktury, blokada konta.
- **Reclami:** lista reklamacji, otwarcie/zamknięcie z notatką; otwarta reklamacja wstrzymuje wypłatę.
- **Veicoli:** CRUD typów pojazdów (nazwa, ładowność, wymiary, stawka/km, cena minimalna, aktywny) — D7.
- **Listino prezzi (cennik):** dopłaty (kwotowe/procentowe), stawki usług (tragarze, pakowanie), stawki magazynowe (dzień/paleta), stawka IVA, **reguły kwoty przewoźnika: osobno dla transportu, tragarzy i pakowania** (procent lub kwota; magazyn zawsze 0) — D6. Wersjonowanie cennika + podgląd przykładowej wyceny przed zapisem.
- **Area di servizio:** lista obsługiwanych prowincji odbioru i maksymalny dystans trasy w km (D10, D13); zapytania z formularza kontaktowego spoza obszaru.
- **Magazzino:** jeden magazyn w MVP (tabela `warehouses`, gotowa na kolejne) — D9. Lista pozycji (zlecenie, klient, liczba palet, data wejścia, opłacone do, naliczone dni), przyjęcie/wydanie, lokalizacja w magazynie. Pozycje z kończącym się okresem → przycisk „Invia link di pagamento” (Stripe Payment Link / Checkout na przedłużenie; po webhooku przesuwa datę „opłacone do” i wystawia fakturę).
- **Fatture:** faktury wystawione klientom (status SDI: inviata, consegnata, scartata) z ponowieniem; faktury przewoźników (podgląd, akceptacja/odrzucenie).
- **Pagamenti / Payouts:** lista wypłat wg statusów (sekcja 4), kolejka **„Da verificare”** (podgląd faktury przewoźnika vs `carrier_amount`, akceptuj / odrzuć z powodem), **wstrzymaj / zwolnij** z powodem, ponowienie nieudanej, **potrącenia** (`payout_adjustments`: przewoźnik, kwota w centach, powód, powiązane zlecenie; rozliczane przy następnej wypłacie; nie zmieniają faktury przewoźnika, dokument potrącenia generowany osobno — D12).
- **Impostazioni:** dane firmy Transigo (do faktur), okno wypłaty w godzinach (domyślnie 24), polityka anulowania (X h bezpłatnie, Y % opłaty — D33), szablony e-mail/SMS, użytkownicy admin.

## 10. Płatności i wypłaty — reguły

- **Checkout:** sesja Stripe Checkout tworzona na serwerze z kwotą ze snapshotu wyceny; `metadata.order_id`. Zlecenie `paid` tylko po zweryfikowanym (podpis) webhooku; obsługa idempotentna (tabela przetworzonych `event.id`).
- **Model Connect:** „separate charges and transfers” — płatność na konto Transigo, a po spełnieniu warunków `Transfer` na konto Express przewoźnika (`transfer_group = order_id`).
- **Warunki automatycznej wypłaty** (D4, wszystkie muszą być spełnione):
  1. status `delivered` z zapisanym podpisem i ≥1 zdjęciem,
  2. przewoźnik wgrał fakturę, a jej kwota = `carrier_amount` przed potrąceniami (automatyczna walidacja, D12; niezgodność → `to_verify`, admin akceptuje lub odrzuca),
  3. minęło okno od `delivered` (domyślnie 24 h, konfigurowalne w panelu admina),
  4. brak otwartej reklamacji i brak ręcznej blokady `on_hold`,
  5. konto Connect przewoźnika ma aktywne `payouts_enabled`.
  Sprawdzanie realizuje zaplanowany job (cron co 15 min, D16) — idempotentnie, z `idempotency_key` na transferze Stripe.
- **Kwota przelewu** = `carrier_amount` zlecenia (= kwota faktury) + suma nierozliczonych `payout_adjustments` przewoźnika (potrącenia ujemne). Przelew nie może zejść poniżej 0 — nadwyżka potrącenia przechodzi na kolejną wypłatę (D15).
- **Potrącenia a dokumenty (D12):** faktura przewoźnika się nie zmienia; każde rozliczone potrącenie dostaje osobny dokument (rodzaj **[DO POTWIERDZENIA Z COMMERCIALISTA]**) powiązany z wypłatą.
- **Wstrzymanie:** admin ustawia `on_hold` z powodem; zwolnienie przywraca ocenę warunków.
- **Zwroty:** pełne lub częściowe z poziomu admina (Stripe Refunds → nota di credito). Jeśli wypłata już poszła, **koszt ponosi Transigo** (bez reversal transferu); admin może ręcznie dodać potrącenie do następnej wypłaty przewoźnika (D5).
- **Testy jednostkowe** obowiązkowe dla: wyliczania ceny, kwoty przewoźnika (3 reguły), warunków wypłaty i okna czasowego, walidacji kwoty faktury, potrąceń (w tym przeniesienia nadwyżki), zaokrągleń, zwrotów częściowych, reguły obszaru obsługi.

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
- Lokalizacja GPS przechowywana tylko dla aktywnych kursów; retencja 30 dni po dostawie (D25).
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
| Zgłoszenie problemu przez przewoźnika (D39) | — | — | e-mail + dashboard |
| Dokument wygasa za 30/7 dni | — | e-mail | dashboard |
