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
| D8 | Konto klienta | Obowiązkowe, zakładane na końcu kreatora przed płatnością. Wycena dostępna bez logowania. *(Kolejność kroków: D70.)* |
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
| D47 | Odcinki zlecenia (legs) | Silnik cenowy liczy zlecenie jako listę odcinków (1–2): każdy ma `distance_m`, typ pojazdu, `pickup_at` (początek okna odbioru), prowincję odbioru i piętra/windę na odbiorze i dostawie. Zlecenie z magazynem = odcinek A→magazyn + magazyn→B. Cena minimalna, dopłaty pilne/weekend/święto i piętra liczone **per odcinek** wg jego danych. Model zleceń (jak zapisać odcinki) — Etap 2b. |
| D48 | Dystans | Bez dojazdu przewoźnika do odbioru. Trasa drogowa Google Routes (`DRIVE`, `TRAFFIC_UNAWARE`). `km = ceil(distance_m / 1000)` per odcinek; `transport = max(km × stawka_km, cena_min)` per odcinek. Ilość × cena jednostkowa = kwota pozycji (przy cenie minimalnej: 1 × cena_min). |
| D49 | „Pilne” | Naliczane **automatycznie**, gdy od chwili wyceny do `pickup_at` odcinka zostaje < `urgent_lead_hours` (w wersji cennika, domyślnie 24 h). Checkbox „Urgente” w kreatorze ma charakter informacyjny. Domyślnie +30 % transportu odcinka. |
| D50 | Minimalne wyprzedzenie | Rezerwacja odcinka nie wcześniej niż `settings.min_booking_lead_hours` (domyślnie 3 h) przed `pickup_at`; inaczej wycena zwraca błąd `too_soon`. |
| D51 | „Weekend/święto” | Data odbioru odcinka w strefie **Europe/Rome** wypada w sobotę, niedzielę lub dzień z tabeli `holidays` → jedna dopłata (nie sumuje się: święto w niedzielę = raz). Data dostawy bez znaczenia. Domyślnie +20 %. |
| D52 | Podstawa dopłat procentowych | Pozycja transportu odcinka **po** cenie minimalnej. Pilne i weekend liczone od tej samej podstawy i sumowane (30 % + 20 %, bez składania). Dopłata kwotowa (`fixed`) = kwota za odcinek. |
| D53 | Piętra / winda | Dopłata za każde piętro bez windy, osobno na odbiorze i dostawie odcinka (parter lub winda = 0). Domyślnie 10 €/piętro, piętro 0–20. |
| D54 | Tragarze, pakowanie | Tragarze: 1–4 osoby, domyślnie 30 €/osobogodzinę (kierowca się nie liczy); godziny wynikają z kategorii ładunku — **zastąpione przez D67/D68**. Pakowanie: ryczałt (15 €) + stawka za sztukę (5 €), dwie pozycje, każdą admin może wyłączyć. Pakowanie przypisane do jednego odcinka (domyślnie pierwszego) — ważne dla kwoty przewoźnika. Tragarze wybierani **osobno dla każdego odcinka** — D74. |
| D55 | Magazyn: progi i progresja | 0 dni = *transbordo* (ryczałt, domyślnie 25 €). Dni 1–`storage_short_term_max_days` (domyślnie 30) po stawce krótkiej, dni powyżej progu po stawce długiej (**progresja**: 45 dni = 30 × krótka + 15 × długa; koszt rośnie monotonicznie z liczbą dni). Typ: ≤ próg → `short_term`, > próg → `long_term`. Jednostka (`day` / `pallet_day`) wybierana przez admina w wersji cennika (domyślnie `pallet_day`). Domyślne stawki: krótkie 3 €/paleta/dzień lub 8 €/dzień, długie 2 € / 5 €. Koszt liczy osobna czysta funkcja `storageCost()` (także do przedłużeń w Etapie 7). |
| D56 | Zaokrąglenia i IVA | Kwoty w centach na liczbach całkowitych; procent = `round_half_up(x × bp / 10000)`, raz na składnik. IVA łącznie = `round_half_up(subtotal × vat_rate)` (jak w podsumowaniu FatturaPA), rozdzielona na pozycje proporcjonalnie do netto metodą największych reszt — suma IVA pozycji = IVA łącznie. Brutto pozycji = netto + IVA pozycji. |
| D57 | Udział przewoźnika — liczenie | Od **netto**. Grupy: transport (transport + pilne + weekend + piętra, D14) **per odcinek**; tragarze **per odcinek** (D74); pakowanie per zlecenie (na odcinku, do którego jest przypisane). Zaokrąglenie raz na grupę, rozdział na pozycje metodą największych reszt. Reguła `fixed` = kwota na grupę (transport: na odcinek). Domyślnie: transport 70 %, tragarze 80 %, pakowanie 60 %, magazyn 0. Udział > netto grupy → ostrzeżenie `negative_margin` w podglądzie admina (bez obcinania). |
| D58 | `carrier_amount` = imponibile | Kwota przewoźnika to netto (imponibile); walidacja faktury przewoźnika (D12) porównuje imponibile, niezależnie od reżimu IVA przewoźnika. **[DO POTWIERDZENIA Z COMMERCIALISTA]** |
| D59 | Dostęp do cennika | Tabele `price_lists`, `price_list_vehicle_rates`, `price_rules` — odczyt i zapis **tylko admin** (zawierają udziały przewoźnika, D29). Wycenę liczy serwer, czytając cennik klientem service role. Zmiana względem db-schema (tam: publiczny odczyt aktywnego cennika). |
| D60 | Wersjonowanie cennika | Nowa wersja = kopia (`clone_price_list`) → edycja `draft` → `publish_price_list` (sprawdza kompletność: stawki dla wszystkich aktywnych typów pojazdów i wszystkie kody reguł; archiwizuje poprzednią). Wersje `active`/`archived` i ich stawki/reguły są niemodyfikowalne dla wszystkich (trigger). Usunąć można tylko `draft`. Startowe stawki wersji 1 to placeholdery do zmiany przez admina. |
| D61 | Obszar obsługi — szczegóły | Na start wszystkie prowincje nieaktywne; admin włącza region w „Area di servizio”. Domyślny maks. dystans 300 km. Przy wielu odcinkach: prowincja odbioru **każdego** odcinka w obszarze i każdy odcinek ≤ maks. dystans. Autocomplete adresów tylko Włochy (`includedRegionCodes: ['it']`). |
| D62 | Ważność wyceny | Wycena ważna `settings.quote_valid_minutes` (domyślnie 30); przy tworzeniu płatności serwer zawsze przelicza cenę i, jeśli się zmieniła, pokazuje ją klientowi ponownie. Implementacja w Etapie 2b/3. |
| D63 | RLS zleceń — warunek ukończenia 2b | Polityki `orders` / `order_lines` / `order_status_history` (cliente tylko swoje, padroncino tylko przypisane, admin wszystko, zapis tylko serwer) powstają w 2b razem z migracją `orders`, z testami w `tests/rls/`. **Bez zielonych testów RLS zleceń Etap 2b nie jest ukończony.** |
| D64 | Środowisko testów RLS | `npm run test:rls` działa **wyłącznie na lokalnym Supabase** (Docker, `supabase start`, porty 553xx). Przed każdym uruchomieniem lokalna baza jest resetowana do migracji z repo; testy odrzucają każdy inny adres niż `http://127.0.0.1:55321`, więc nigdy nie zmieniają stagingu ani produkcji. Staging (chmura) służy do testów ręcznych. Docker tylko do testów — wdrożenia i `db:push` bez zmian. |
| D65 | `audit_log` — autor i GDPR | Wpis trwale przechowuje autora: `actor_id` (bez klucza obcego — usunięcie konta go nie czyści) i `actor_email` (stan z chwili działania, zapisuje serwer). Log jest append-only (UPDATE/DELETE/TRUNCATE odrzucane, także dla service role). Przy anonimizacji konta (D35) `actor_id` i `actor_email` zostają w logu. W `audit_log.data` zapisujemy tylko ID i zmienione wartości biznesowe — nigdy danych osobowych klientów (adresy, telefony itp.). **[DO POTWIERDZENIA Z PRAWNIKIEM – Etap 8]**, razem z otwartymi kwestiami (bez implementacji teraz): (a) czy do `audit_log` trafiają działania klientów i przewoźników (dziś tylko admin); (b) okres przechowywania logu i ewentualna kontrolowana funkcja czyszcząca starsze wpisy (wyjątek od append-only). |
| D66 | Konta adminów i przewoźników | Blokujemy (`is_blocked`, `carriers.status = suspended`), nie usuwamy. Usuwanie kont tylko w testach lub na żądanie GDPR (D35). Usunięcie konta nie może się nie udać z powodu powiązanych danych (np. autor publikacji cennika: `price_lists.published_by` → null, autor zostaje w `audit_log`). |
| D67 | Tragarze — kategorie ładunku | Klient nie wybiera godzin, tylko wielkość ładunku z **4 stałych kategorii**: `parcels` (Pochi colli / oggetti singoli), `monolocale`, `bilocale`, `trilocale_plus` (Trilocale e oltre). Każda kategoria w wersji cennika (`price_list_porter_packages`, wersjonowane, edytowalne w Listini) ma liczbę tragarzy i godziny wliczone w cenę. Cena = osoby × godziny w cenie × `porter_hour`. Klient może zwiększyć liczbę tragarzy (max 4, D54) — każdy dodatkowy dostaje te same godziny; godzin zmienić nie może. Kategoria i liczba osób wybierane **osobno dla każdego odcinka** (D74). Placeholdery: 1 os./1 h, 2/2, 2/3, 3/4; `porter_hour` 30 €. Kategoria wyłączona lub brak kategorii w cenniku → tragarze niedostępni. Opublikowane cenniki sprzed D67 nie mają kategorii — trzeba opublikować nową wersję. |
| D68 | Tragarze — nadgodziny | Reguła `porter_overtime_hour` (za osobę, za każdą rozpoczętą godzinę; placeholder 35 €) i tolerancja `price_lists.porter_overtime_grace_minutes` (domyślnie 15 min, 0–120), obie w wersji cennika. Nadgodziny liczone dopiero, gdy czas pracy > czas w cenie + tolerancja; wtedy od pełnej rozpoczętej godziny ponad czas w cenie: `ceil((praca − w_cenie) / 60)` (np. 3 h w cenie: 3 h 15 min → 0, 3 h 16 min → 1 h, 4 h 01 min → 2 h). Krótsza praca = bez zwrotu. Przewoźnik dostaje udział jak za tragarzy (`carrier_share_porters`, 80 %; przy regule `fixed` — ta sama proporcja co w pakiecie). Wycena zapisuje warunki (`Quote.porters[]`, jeden wpis na odcinek z tragarzami, D74: osoby, godziny w cenie, stawka, tolerancja, udział) — rozliczenie używa warunków z dnia zakupu, nie bieżącego cennika; nadgodziny liczone per odcinek. Funkcja `porterOvertimeCost()` w `src/lib/pricing/overtime.ts` (czysta, z testami). Reguła wyłączona → nadgodzin nie naliczamy. |
| D69 | Tragarze — rozliczenie nadgodzin (plan na Etap 4 i 6, bez implementacji teraz) | **Czas pracy = tylko załadunek + rozładunek, bez czasu jazdy.** Etap 4: PWA mierzy go statusami — „Arrivato al ritiro” → „Caricato” oraz „Arrivato alla consegna” → „Scaricato”; `porterOvertimeCost()` dostaje sumę tych dwóch odcinków (w minutach), nie czas całego zlecenia. Przewoźnik widzi wyliczony czas, klient potwierdza go podpisem przy dostawie. Etap 6: przy nadgodzinach > 0 admin wysyła klientowi link do dopłaty (Stripe), dopłata dostaje osobną e-fakturę, a kwota przewoźnika za nadgodziny dochodzi do wypłaty. **Otwarta kwestia (decyzja przed Etapem 6):** co z wypłatą przewoźnika za nadgodziny, gdy klient nie zapłaci dopłaty (Transigo płaci z własnych środków / wypłata dopiero po zapłacie / wstrzymanie + reklamacja). |
| D70 | Kolejność kreatora i konto | Wycena bez logowania (D8). Krok **Account** (logowanie / rejestracja) jest **przed** „Contatti” i „Riepilogo”: dane do faktury firmy i prezentacja IVA zależą od konta, a dane osobowe nie muszą być trzymane w przeglądarce (D78). Po zalogowaniu cena przeliczana na serwerze dla typu klienta z konta. Kolejność kroków: sekcja 6. |
| D71 | Numer zlecenia | `TG-RRRR-NNNNNN` (np. `TG-2026-000123`): rok wg daty utworzenia w strefie Europe/Rome + jedna globalna sekwencja bez resetu rocznego (przy > 999 999 numer się wydłuża). Nadaje trigger przy wstawieniu, niezmienny. To nie jest numer fiskalny (fakturę numeruje dostawca e-faktur), luki w numeracji są dopuszczalne. |
| D72 | Adres magazynu | Tabela `warehouses` (model wielomagazynowy, D9) tworzona w Etapie 2b, edycja w `/admin/magazzino` (tylko admin). W MVP co najwyżej jeden aktywny magazyn (indeks częściowy); wycena używa aktywnego magazynu. Brak aktywnego magazynu → opcja magazynu w kreatorze niedostępna. Prowincja magazynu musi być aktywna w obszarze obsługi (silnik sprawdza prowincję odbioru każdego odcinka, D61). Adres magazynu podaje kreatorowi serwer. |
| D73 | Okna czasowe | Stałe okna 2-godzinne odbioru 08:00–20:00 (08–10, 10–12, …, 18–20, Europe/Rome); `pickup_at` odcinka = początek okna. Zlecenie z magazynem: klient wybiera datę i okno odbioru z magazynu (odcinek 2); dni składowania = różnica dat kalendarzowych (Europe/Rome) między odbiorem w A a odbiorem z magazynu; 0 dni = *transbordo*, wtedy okno odcinka 2 zaczyna się nie wcześniej niż koniec okna odcinka 1. |
| D74 | Tragarze per odcinek | Tragarzy wybiera się **osobno dla każdego odcinka** (`PriceInput.porters[]` z `legIndex`, najwyżej jeden wpis na odcinek; każdy z własną kategorią D67 i liczbą osób). Przeprowadzka przez magazyn: kreator pyta o tragarzy przy odbiorze w A (odcinek 1) i przy dostawie do B (odcinek 2). Udział przewoźnika za tragarzy liczony per odcinek (reguła `fixed` = kwota na tragarzy odcinka). Warunki (`Quote.porters[]`) i nadgodziny (D68, D69) per odcinek; snapshot w `order_legs`. Pakowanie bez zmian (jeden odcinek, domyślnie pierwszy). Zmienia D54, D57, D67, D68. |
| D75 | Przewoźnik a odcinki | W Etapie 2b przewoźnik przypisany **per zlecenie** (`orders.carrier_id`). Kwoty przewoźnika zapisane per odcinek (`order_leg_carrier_terms`), więc później można przypisywać kurs per odcinek. **Decyzja przed Etapem 4:** czy odcinki zlecenia z magazynem są osobnymi kursami (różni przewoźnicy). |
| D76 | Przechowywanie wyceny | Wycena zapisywana na serwerze w tabeli `quotes` (tylko service role) na `settings.quote_valid_minutes`; przeglądarka dostaje `quoteId` i widok bez kwot przewoźnika, marży i ostrzeżeń. Serwer sam pobiera szczegóły miejsc i trasę z Google — prowincji ani dystansu z przeglądarki nie przyjmuje. Wycena ma właściciela (`quotes.input.ownerId` = zalogowany klient, null dla anonimowej). Zlecenie powstaje **wyłącznie** z ważnej wyceny tego klienta, policzonej dla tych samych danych i typu klienta (snapshot z wyceny; ponownie sprawdzane: minimalne wyprzedzenie D50 i pojazd D84). Wycena innego klienta → odmowa („Questo preventivo non appartiene al tuo account…”), bez przeliczania. W każdym innym przypadku (wygasła, anonimowa, zmienione dane lub typ klienta) serwer przelicza i **zawsze** prosi o ponowne potwierdzenie, także przy tej samej cenie („Il preventivo è scaduto: abbiamo ricalcolato il prezzo…” / „Il prezzo è stato aggiornato…”). Logika: `placeOrder()` (`src/lib/booking/place-order.ts`), testy `tests/rls/place-order.test.ts`. Stare wiersze usuwa serwer (> 24 h). Przed produkcją: rate limiting (tworzą je też anonimowi użytkownicy). |
| D77 | Model danych zleceń (2b) | Tabele dzielone wg tego, kto co widzi (RLS działa na wiersze, nie kolumny): **wspólne** `orders`, `order_legs`, `order_status_history` (klient — swoje, przewoźnik — przypisane, admin — wszystko); **cena klienta** `order_charges` (1:1) i `order_lines` (klient + admin; przewoźnik nie widzi ceny klienta — D29, zastępuje W13); **kwoty przewoźnika** `order_leg_carrier_terms` (przewoźnik przypisany + admin; klient nie). Zlecenie tworzy wyłącznie funkcja `create_order(jsonb)` (`SECURITY DEFINER`, tylko service role) w jednej transakcji; bezpośredni `INSERT` jest odebrany wszystkim rolom API, także service role. Snapshot ceny i odcinków jest niezmienny (trigger, także dla service role; wyjątki: `order_charges.refunded_cents`, `order_legs.porters_worked_minutes`). Historia statusów append-only; pole `note` widzą strony zlecenia, wewnętrzne powody admina idą do `audit_log`. W Etapie 2b zlecenie zapisywane od razu jako `pending_payment` („In attesa di pagamento”); od Etapu 3 oznacza to utworzoną sesję Checkout. Usunąć można tylko zlecenie nieopłacone (`draft`, `pending_payment`, `expired`) — reszta to dane finansowe. Konta klienta lub przewoźnika ze zleceniami nie da się usunąć (FK `restrict`) — dla zleceń to wyjątek od D66; GDPR = anonimizacja (D35). Kolumny anulowania (D33) dochodzą razem z funkcją anulowania (Etap 3). |
| D78 | Stan kreatora w przeglądarce | `localStorage` trzyma **tylko** trasę, termin, towar i usługi (oraz `quoteId`). Danych osobowych — kontaktów przy odbiorze/dostawie, danych do faktury (CF, adres rozliczeniowy, dane firmy) — nie zapisujemy w przeglądarce (tylko pamięć formularza). Po złożeniu zamówienia stan kreatora jest czyszczony. |
| D79 | Resend jako SMTP dla Supabase Auth | Odłożone do zakupu domeny; **wykonać przed Etapem 3** (maile z potwierdzeniem zamówienia). Bez zweryfikowanej domeny Resend dostarcza tylko na adres właściciela konta. Kroki ręczne: (1) Resend → Domains → Add domain (np. subdomena `mail.<domena>`, region `eu-west-1`); (2) u rejestratora rekordy DNS pokazane przez Resend: MX + TXT (SPF) dla `send`, TXT `resend._domainkey` (DKIM), opcjonalnie TXT `_dmarc` = `v=DMARC1; p=none;` → Verify; (3) Resend → API Keys → Create (`supabase-staging-smtp`, *Sending access*, tylko ta domena) — klucz tylko w panelu Supabase, nigdy w repo; (4) Supabase → Authentication → Emails → SMTP Settings → Enable custom SMTP: sender `no-reply@<domena>`, nazwa `Transigo`, host `smtp.resend.com`, port `465`, user `resend`, hasło = klucz API; (5) Authentication → Rate Limits: limit maili np. 100/h na czas testów; (6) szablony i Redirect URLs bez zmian; test: rejestracja / reset hasła, w Resend → Emails status „Delivered”. Do tego czasu konta testowe klientów tworzone w panelu Supabase (Add user → Auto Confirm User); przy pierwszym logowaniu uzupełniają profil klienta (D80). |
| D80 | Uzupełnienie profilu klienta | Konto `cliente` bez wiersza `customers`, imienia/nazwiska albo zgód (D42) — np. utworzone w panelu Supabase (Add user → Auto Confirm User) — jest „niekompletne”. Po zalogowaniu (i przy wejściu do `/cliente`) trafia na `/completa-profilo?next=…`: wybór Privato/Azienda (tylko gdy brak `customers`; typ potem niezmienny), imię, nazwisko, telefon, dane firmy (D44), obie zgody. Zapisuje serwer; potem powrót do `next` (panel klienta albo kreator `/prenota` z zachowanym stanem). `next` dozwolony tylko we własnym panelu lub — dla klienta — w kreatorze. Rejestracja w kreatorze działa normalnie (D70). |
| D81 | Parametry pojazdów | `vehicle_types`: ładowność (kg), długość/szerokość/wysokość przestrzeni ładunkowej (cm), objętość (w bazie dm³, w panelu m³), liczba palet EUR (`euro_pallets`). Edytowalne w `/admin/veicoli`, formularz wymaga wszystkich pól. Placeholdery (do potwierdzenia z przewoźnikami): auto 400 kg, 150×100×80, 1,2 m³, 0 palet; furgone piccolo 750 kg, 180×140×125, 3 m³, 2; furgone medio 1200 kg, 300×170×180, 9 m³, 4; furgone grande 3,5 t 1000 kg, 420×205×220, 19 m³, 8; camion con sponda 3000 kg, 600×240×240, 34,5 m³, 15. |
| D82 | Dobór pojazdu (propozycja) | Czysta funkcja `recommendVehicle()` / `assessVehicle()` (`src/lib/booking/vehicle-fit.ts`). Propozycja = najmniejszy pojazd (`size_rank`), który nie jest zablokowany (D84) i nie jest poniżej minimum kategorii (D83). Wymiary: posortowane wymiary największego przedmiotu ≤ posortowane wymiary przestrzeni (przedmiot można obrócić, bez ustawiania po przekątnej); częściowo podane wymiary — sprawdzane tylko podane. Brak danych klienta = kryterium nie ogranicza. Nic nie pasuje → wszystkie karty zablokowane + „Nessun veicolo adatto a questo carico: contattaci per un preventivo su misura.” Karta propozycji: „Consigliato” + krótki powód. **Znane ograniczenie:** dobór nie uwzględnia wymiarów otworu drzwi (wejścia do przestrzeni ładunkowej) ani układania po przekątnej. |
| D83 | Minimalny pojazd dla kategorii ładunku | Tabela `porter_package_min_vehicle` (kategoria D67 → typ pojazdu), niewersjonowana, edycja w `/admin/veicoli` (tylko admin); brak wiersza = brak minimum. Placeholdery: parcels — brak; monolocale → furgone medio; bilocale → furgone grande; trilocale_plus → furgone grande. Kategorię klient wybiera **raz** w kroku „Merce” („Che tipo di trasporto?”: Pochi colli / Monolocale / Bilocale / Trilocale e oltre / Non è un trasloco); wybór podpowiada kategorię tragarzy na odcinkach, którą nadal można zmienić osobno (D74). |
| D84 | Blokady pojazdu | Pojazd jest **zablokowany**, gdy waga > ładowność, największy przedmiot nie mieści się w wymiarach albo palet > `euro_pallets` (komunikat po włosku na karcie). Pojazd poniżej minimum kategorii (D83) **nie** jest blokowany — ostrzeżenie „Potrebbe non bastare per un trasloco …”. Większy pojazd zawsze dozwolony. Serwer sprawdza blokady przy wycenie (zablokowany pojazd nie dostaje zapisanej wyceny) i ponownie przy zapisie zlecenia, na aktualnych danych `vehicle_types`. |
| D85 | Pusty parametr pojazdu | Kryterium z pustym parametrem pojazdu nie jest sprawdzane (brak blokady); w praktyce nie występuje, bo formularz w `/admin/veicoli` wymaga wszystkich pól (D81). |
| D86 | Towar w zleceniu | Krok „Merce” pyta o wagę łączną (orientacyjną), wymiary **największego** przedmiotu (cm) i liczbę palet EUR — wszystko opcjonalne; łącznej objętości nie wymagamy. Snapshot w `orders`: `weight_kg`, `largest_item_length_cm`, `largest_item_width_cm`, `largest_item_height_cm`, `pallets_count`, `load_category` (kategoria D83, null = nie przeprowadzka). Liczba palet podpowiada liczbę palet przy magazynie. |
| D87 | Pojazd przewoźnika a wymagania zlecenia | **[DO USTALENIA — Etap 4]** Konkretny pojazd przewoźnika (`carrier_vehicles`) musi mieć parametry nie gorsze niż wymagania zlecenia (waga, największy przedmiot, palety — jak D84). Przewoźnik może przyjąć kurs (`accept_job`) tylko pojazdem, który je spełnia (rozszerza D21, D22). Camion con sponda może wymagać prawa jazdy kat. C — dokument do weryfikacji przy rejestracji przewoźnika. |
| D88 | Termin płatności zlecenia | Zlecenie `pending_payment` ma `orders.payment_due_at` (trigger przy zapisie, niezmienny) = min(utworzenie + `settings.payment_window_minutes`, początek okna odbioru − `min_booking_lead_hours`), ale nie wcześniej niż utworzenie + 30 min (minimum Stripe). Domyślnie 60 min **[DO USTALENIA]**. Do terminu cena ze snapshotu zlecenia (`order_charges.total_cents`) bez przeliczania; po terminie zlecenie przechodzi w `expired`, a klient rezerwuje od nowa z nową wyceną. |
| D89 | Stripe Checkout — jedna sesja na zlecenie | Po „Conferma e paga” serwer tworzy sesję Checkout (kwota z `order_charges.total_cents`, EUR, jedna pozycja brutto, `metadata`/`client_reference_id` = `order_id` + `order_number`, `locale: it`, `expires_at` = termin D88). Najwyżej jedna otwarta sesja na zlecenie (indeks w `payments`); „Paga ora” wraca do tej samej sesji, nowa powstaje tylko, gdy otwartej nie ma. Status `paid` **wyłącznie** przez `confirm_order_payment()` z webhooka po weryfikacji podpisu; powrót z Checkout (`/cliente/ordini/[id]?pagamento=ok`) pokazuje „Pagamento in verifica” i odświeża stronę (bez Realtime do Etapu 5). Webhook idempotentny (`stripe_events`). Lokalnie: `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to localhost:3000/api/webhooks/stripe`; na Vercel endpoint w Stripe Dashboard z tymi samymi zdarzeniami. Test E2E na stagingu 2026-11-09: karty 4242 (sukces), 0002 (odrzucona), 3155 (3D Secure), „Paga ora”, „Annulla ordine” (D92), `stripe events resend` bez zmian w bazie — Etap 3 ukończony. Kwota i waluta z PaymentIntent (pieniądze faktycznie otrzymane) muszą się zgadzać z płatnością i `order_charges`; inaczej `payment_review`. Tylko tryb testowy: serwer odrzuca klucze inne niż `sk_test_`/`rk_test_`, zdarzenia `livemode` są ignorowane. |
| D90 | Pod wypłaty (Etap 6) | Separate charges and transfers: płatność na konto Transigo, `payment_intent_data.transfer_group` = **numer zlecenia** (zmienia sekcję 10, gdzie było `order_id`). `stripe_payment_intent_id` i `stripe_charge_id` zapisywane w `payments` (1:N ze zleceniem), nie w `orders` — `orders` widzi przewoźnik (D29, D77). |
| D91 | Wygasanie | Główny mechanizm: webhook `checkout.session.expired` → płatność `expired`, zlecenie `expired`, gdy nie ma otwartej sesji i minął termin D88 (2 min tolerancji). Siatka bezpieczeństwa: `GET /api/cron/expire-orders` (`Authorization: Bearer CRON_SECRET`) — dla zleceń po terminie pyta Stripe o sesję (opłacona → jak webhook, wygasła → `expired`) i wygasza zlecenia bez sesji. Harmonogram (Vercel Cron co 15 min wymaga planu Pro / Supabase `pg_cron` + `pg_net`) **[DO USTALENIA]** przed wdrożeniem. |
| D92 | Anulowanie niezapłaconego zlecenia | Klient może anulować zlecenie `pending_payment` („Annulla ordine”): serwer najpierw wygasza sesję w Stripe (nie da się jej już opłacić), potem zlecenie → `expired` (historia: `customer_app`, „Annullato dal cliente prima del pagamento”). Bez opłat. |
| D93 | Maile — adapter i outbox | Każdy mail przechodzi przez `sendEmail()` (`src/lib/notifications/email.ts`) i tabelę `email_outbox` (unikalne `template_code + order_id` — powtórzony webhook nie wyśle drugiego maila). `EMAIL_TRANSPORT=outbox` (dev): mail zostaje w tabeli jako `captured_dev`, nic nie jest wysyłane; `resend` — po weryfikacji domeny (D79). W logach tylko id i kod szablonu. Szablony w kodzie (`src/lib/notifications/templates/`), po włosku; pierwszy: `order_paid` (numer, trasa, termin, kwota, link). Błąd maila nie psuje webhooka. |
| D94 | Anulowanie przez klienta — wartości (Etap 6) | **[DO USTALENIA]** Wartości w `settings`: bezpłatnie ≥ `free_cancellation_hours` = 24 h przed początkiem okna odbioru (zwrot 100 %); później opłata `late_cancellation_fee_bp` = 5000 (50 %) od transportu z dopłatami, tragarzy i pakowania brutto, składowanie zwracane w całości (D33, D38). Prowizji Stripe (niezwracanej przy refundzie) nie potrącamy klientowi — koszt Transigo. Model danych gotowy (Etap 3): `orders.cancellation_requested_at/_by`, `cancellation_reason`, `cancellation_decided_at/_by`, `order_charges.cancellation_fee_cents`, tabela `refunds`; kwota dla przewoźnika przy anulowaniu (D40) trafi do `payouts` w Etapie 6. Przycisk zwrotu i anulowanie opłaconego zlecenia — Etap 6. |
| D95 | Metody płatności | Karty (z Apple Pay / Google Pay) — ustawiane w Stripe Dashboard → Settings → Payment methods (ta wersja API nie ma `payment_method_types`). Adaptive Pricing wyłączone: zawsze EUR. PayPal, Klarna, SEPA — później (SEPA asynchroniczna; webhook i tak obsługuje `async_payment_succeeded/failed`). |
| D96 | Status `payment_review` | „Pagamento da verificare”: Stripe pobrał pieniądze, ale nie pasują do zlecenia — inna kwota lub waluta, płatność za zlecenie już wygasłe (`late_payment`). Zlecenie nie jest `paid`, nie trafia do przewoźników, nie wygasa i nie da się go usunąć. Drugi udany Checkout za zlecenie już opłacone (`duplicate_payment`) nie zmienia statusu, płatność jest oznaczona do sprawdzenia. Decyzja admina (oznacz jako opłacone / zwrot) — Etap 6; w Etapie 3 tylko widoczne w `/admin/ordini` (filtr „Pagamento da verificare”). |
| D97 | Dokumenty przewoźnika (Etap 4) | **Firma:** iscrizione all'Albo degli autotrasportatori (wymagana), patente del titolare (wymagana), polizza RC vettoriale (**opcjonalna** na razie). **Pojazd:** libretto di circolazione + assicurazione RCA (wymagane dla każdego aktywnego pojazdu). Bez dokumentu tożsamości — tożsamość weryfikuje Stripe Connect (typ `identity_document` zostaje w enumie, nieprzyjmowany). Prawa jazdy kierowców i kat. C — później (D87). |
| D98 | Konfiguracja typów dokumentów | Jedna konfiguracja: tabela `carrier_document_types` (zakres `carrier`/`vehicle`, wymagany, przyjmowany, `expiry`: `none`/`required`, etykieta dokumentu i pola daty) i jej lustro w kodzie `src/lib/carriers/document-types.ts`; test RLS pilnuje zgodności. Zmiana = nowa migracja + plik. Albo: bez daty. Libretto: data wymagana, etykieta „Prossima revisione”. RCA, RC vettoriale, patente: „Scadenza”. Reguły zależne od typu (data wymagana/zabroniona, pojazd wymagany/zabroniony, typ przyjmowany) egzekwuje trigger `validate_carrier_document()` czytający tabelę — także dla service role (CHECK nie może czytać innej tabeli). Plik: ścieżka `{carrier_id}/{uuid}.{pdf|jpg|png|webp|heic}` (unikalna), `file_name`, `mime_type`, `size_bytes` ≤ 10 MB. |
| D99 | Kompletność konta przewoźnika | `carrier_onboarding_missing(carrier_id)` zwraca brakujące pozycje: `company` (ragione sociale, P.IVA, CF, adres siedziby, PEC lub SDI), `vehicle` (≥ 1 aktywny pojazd), `document:<typ>`, `vehicle_document:<pojazd>:<typ>`. Dokument się liczy, gdy nie jest odrzucony i (typ bez daty albo `expires_at` ≥ dziś w Europe/Rome). Wywołać może przewoźnik (tylko dla siebie), admin i serwer. Ta sama funkcja w `submit_*` i `decide_*`; ekran przewoźnika pokazuje jej wynik. |
| D100 | Wysłanie do weryfikacji | Przewoźnik uzupełnia dane, pojazdy i dokumenty, potem „Invia per la verifica” → `submit_carrier_for_review()` (tylko kompletne konto, status `pending_review` lub `rejected`) ustawia `carriers.submitted_at` (status `pending_review`, powód odrzucenia czyszczony). Ponowne wywołanie nic nie zmienia. Do decyzji admina przewoźnik widzi tylko ekran „Account in verifica” (bez edycji). `submitted_at` null przy `pending_review` = „Registrazione incompleta”. Mail do admina (`ADMIN_NOTIFICATION_EMAIL`). |
| D101 | Decyzja admina | `/admin/padroncini`: **Approva** / **Rifiuta** (powód wymagany, ≤ 1000 znaków) → `decide_carrier_review(carrier, admin, approve, reason)` — tylko service role. Server Action najpierw sprawdza w sesji, że użytkownik jest adminem; `p_admin_id` zawsze z sesji, nigdy z formularza; funkcja sprawdza jeszcze, że to aktywny admin. Approva: ponowne sprawdzenie kompletności (D99), `active` + `activated_at/_by`, dokumenty i pojazdy istniejące w chwili wysłania → zatwierdzone (dodane później zostają `pending`). Rifiuta: `rejected` + `status_reason`, `submitted_at` = null — przewoźnik poprawia i wysyła ponownie. Druga decyzja dla tego samego wysłania → błąd (bez drugiego maila). Wpis w `audit_log` (bez danych osobowych); mail do przewoźnika `carrier_approved` / `carrier_rejected` przez outbox (D93). |
| D102 | Pojazd przewoźnika — dane | Typ (z `vehicle_types`), tablica (zapisywana wielkimi literami, bez spacji i myślników: `^[A-Z0-9]{5,10}$`), ładowność w kg (wymagana). Wymiary przestrzeni opcjonalne (potrzebne przy D87). |
| D103 | Podgląd dokumentów i pliki w Storage | Admin otwiera dokument przez signed URL (5 min) tworzony **sesją admina** (polityka Storage), nie service role. HEIC: zamiast podglądu przycisk „Scarica” (przeglądarki go nie wyświetlają). Przeglądarka przewoźnika wysyła plik prosto do Storage, potem serwer zapisuje wiersz. **Na później:** pliki bez wiersza w `carrier_documents` (osierocone po nieudanym zapisie) — sprzątanie jobem, teraz bez implementacji. |
| D104 | PWA przewoźnika | Manifest tylko dla `/padroncino` (podpięty w layoucie przewoźnika, `start_url` `/padroncino`), ikony tymczasowe: granatowe tło `#0B3B8C`, biała litera „T” (do podmiany). Service worker (`/padroncino/sw.js`, zakres `/padroncino`) zapisuje tylko pliki statyczne i stronę offline — nigdy stron po zalogowaniu ani odpowiedzi API/Supabase. Kolejka offline — później (sekcja 8). |
| D105 | Blokada danych firmy przewoźnika | Ragione sociale, P.IVA, codice fiscale, PEC, codice SDI i adres siedziby (od nich zależą e-faktury i wypłaty — Etap 6) można zmieniać bezpośrednio tylko, gdy konto nie zostało wysłane do weryfikacji: `status ∈ {pending_review, rejected}` i `submitted_at` null (także po odrzuceniu). W każdym innym stanie (czeka na decyzję, `active`, `suspended`) trigger `lock_carrier_company_data()` odrzuca zmianę (`42501`) od ról API — `authenticated`, `anon` **i** `service_role` — wyłącznie na podstawie roli; żadna flaga sesji ani ustawienie tego nie odblokowuje (test na poziomie SQL z `set_config`). Jedyna droga aplikacji: `admin_update_carrier_company(carrier, admin, changes)` (tylko service role; `p_admin_id` z sesji admina, sprawdzany w bazie; tylko te 9 pól; puste → null) — zmienia dane i w tej samej transakcji zapisuje `audit_log` (`carrier.company_data_updated`, `data.fields` = nazwy zmienionych pól, **bez wartości**). Brak zmian = brak zapisu i wpisu. **Zmiany przez SQL Editor (właściciel bazy) omijają blokadę i audyt — tylko w sytuacjach awaryjnych**, z ręczną notatką w zgłoszeniu. Bez zmian polityk RLS. |
| D106 | Wysłanie do weryfikacji — wynik i mail | `submit_carrier_for_review()` zwraca `submitted_at` i `newly_submitted`: `true` tylko dla wywołania, które faktycznie ustawiło `submitted_at` (wiersz przewoźnika zablokowany `for update` — z dwóch równoległych wysłań dokładnie jedno). Mail do admina `carrier_submitted` wysyłany **tylko** przy `newly_submitted = true`; serwer nie sprawdza stanu przed wywołaniem. Ponowne wysłanie po odrzuceniu to nowe wysłanie (nowy mail). |
| D107 | Zatwierdzenie pojazdu przewoźnika | Dla **każdej roli** (`anon`, `authenticated`, `service_role`, także właściciel bazy), bez flag sesji: **tablica** pojazdu, który był kiedykolwiek zatwierdzony (`first_approved_at` ustawione), nie może się zmienić — błąd `23514`, w aplikacji: „La targa di un veicolo approvato non si può modificare. Aggiungi un nuovo veicolo e disattiva quello vecchio.” (z przyciskiem „Aggiungi nuovo veicolo”). Przed pierwszym zatwierdzeniem tablicę można zmieniać. Zmiana **typu** lub **ładowności** czyści `approved_at` (dokumenty pojazdu bez zmian). `is_active` (dezaktywacja/ponowna aktywacja) i wymiary `cargo_*` nie wpływają na zatwierdzenie. `first_approved_at` = pierwsze niepuste `approved_at`, ustawiane tylko przez trigger i nigdy niezmieniane. Funkcje decyzji admina ustawiają tylko `approved_at`, więc nie potrzebują wyjątku. Ponowne zatwierdzenie pojedynczego pojazdu — lista „Veicoli da verificare” w `/admin/padroncini` (Etap 4.1, krok 4). |
| D108 | Telefon i Stripe a wysłanie do weryfikacji | Weryfikacja telefonu (SMS) i Stripe Connect **nie blokują** wysłania do weryfikacji ani zatwierdzenia; na liście kroków przewoźnika widoczne jako „disponibile a breve”. Wymóg dodajemy w ich krokach. |
| D109 | Edycja w trakcie weryfikacji | Gdy konto czeka na decyzję (`pending_review` + `submitted_at`), pojazdy i dokumenty blokują Server Actions i interfejs (ekran „Account in verifica” tylko do odczytu). W bazie bez pełnej blokady — dane firmy chroni D105, pojazdy D107; dokumenty i pojazdy dodane po wysłaniu zostają `pending` (D101). |
| D110 | Mail do admina o wysłaniu do weryfikacji | `carrier_submitted` na `ADMIN_NOTIFICATION_EMAIL` przez outbox (D93): nazwa firmy, ID przewoźnika, link do `/admin/padroncini`. **Bez** P.IVA, adresów i telefonów. |
| D111 | Zajęta tablica | Przy próbie dodania pojazdu z tablicą już zarejestrowaną (`unique(plate)`): „Questa targa è già registrata. Se il veicolo è tuo, contatta l'assistenza Transigo.” |
| D112 | Kiedy przewoźnik edytuje pojazdy | Pojazdy (dodanie, zmiana, dezaktywacja/ponowna aktywacja) i dokumenty (nowy plik, np. odnowione RCA; dokument pojazdu tylko dla aktywnego pojazdu) przewoźnik zmienia w stanach „Registrazione incompleta”, po odrzuceniu **i przy aktywnym koncie** (nowy pojazd albo zmiana typu/ładowności wracają do admina wg D107). Zablokowane, gdy konto czeka na decyzję (D109). Przy **zawieszonym** koncie pojazdy i dane firmy zablokowane, ale **upload dokumentów (firmy i pojazdu) dozwolony** — to jedyna droga powrotu (np. po wygasłym RCA); wgranie niczego nie odblokowuje, konto wraca do `active` tylko decyzją admina. Ekran zawieszonego konta pokazuje powód i link „Carica documenti aggiornati”. Przy zatwierdzonym pojeździe zmiana typu/ładowności wymaga potwierdzenia w przeglądarce („Il veicolo tornerà in verifica…”). Dane firmy — tylko przed wysłaniem i po odrzuceniu (D105). Sprawdza logika serwera (`src/lib/carriers/server.ts`), w bazie bez dodatkowej blokady. |

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
   - *Breve periodo* — krótkie składowanie (do `storage_short_term_max_days`, domyślnie 30 dni — D55),
   - *Lungo periodo* — długie składowanie (dni powyżej progu po stawce długiej, progresja — D55).
   Rozliczanie za dzień lub za paletę (wybór admina w wersji cennika — D55).
   Składowanie **płatne z góry** za okres wybrany w kreatorze; przedłużenie przez link płatności Stripe wysyłany klientowi (D9). Przychód z magazynu w 100% dla Transigo.

## 2a. Obszar obsługi (D10, D13)

- Admin ustawia listę obsługiwanych prowincji (na start jeden region) oraz maksymalny dystans trasy w km.
- Adres **odbioru** musi leżeć w obsługiwanej prowincji (prowincja z Google Geocoding / Places).
- Adres **dostawy** może być dowolny, jeśli dystans trasy ≤ maksymalny dystans.
- Poza obszarem (odbiór spoza prowincji lub zbyt długa trasa) kreator nie pokazuje ceny, tylko komunikat („Al momento non serviamo questa zona”) i formularz kontaktowy (zapis do tabeli zapytań + e-mail do admina).

## 3. Silnik cenowy

### 3.1 Wzór

```
dla każdego odcinka (D47):
  km         = ceil(distance_m / 1000)                                   (D48)
  transport  = max(km × rate_per_km_cents[vehicle_type], min_price_cents[vehicle_type])
  surcharges = urgent + weekend/holiday (od transportu odcinka, D49–D52) + floors (D53)
services   = porters + packing                                           (D54)
  porters  = persons × included_hours[kategoria] × porter_hour            (D67; nadgodziny po wykonaniu — D68, D69)
storage    = storageCost(days, pallets): transbordo | dni ≤ próg × krótka + dni > próg × długa (D55)
subtotal   = Σ odcinki + services + storage
vat        = round_half_up(subtotal × vat_rate)   (IVA 22%, rozdział na pozycje — D56)
total      = subtotal + vat

carrier_amount = Σ odcinki carrier_share(transport_part)   # transport + dopłaty odcinka (pilne, weekend, piętra) — D14, D57
               + carrier_share(porters_part)
               + carrier_share(packing_part)
               # storage → 0 (100% Transigo)
carrier_share(x) = round(x × percent)  |  fixed_cents   # osobna reguła dla każdej z 3 usług (D6)
```

- Wszystkie kwoty w centach (`integer`). Zaokrąglenie: half-up do pełnego centa, jednokrotnie na każdym składniku (D56). Kwota przewoźnika liczona od netto (D57, D58).
- Implementacja: czyste funkcje `calculatePrice(input, config)` i `storageCost(...)` w `src/lib/pricing/` (bez bazy i Google Maps — dystans przychodzi jako parametr).
- Dystans z Google Maps (trasa drogowa), nie w linii prostej.
- Dopłaty mogą być kwotowe (centy) lub procentowe — typ zapisany w regule.
- Cena jest zapisywana w zleceniu jako **snapshot** (rozbicie pozycji + wersja cennika), żeby późniejsze zmiany cennika nie zmieniały historycznych zleceń.
- Wycena liczona zawsze po stronie serwera; front tylko wyświetla. Kwota w Stripe Checkout pochodzi z serwera.

### 3.2 Prezentacja cen (D3) **[DO POTWIERDZENIA Z COMMERCIALISTA]**
- Typ klienta (`private` / `business`) wybierany przy rejestracji.
- Przed zalogowaniem kreator pozwala przełączyć widok „Privato / Azienda” (domyślnie Privato).
- Privato: ceny z IVA (brutto). Azienda: netto + IVA osobno + brutto.
- Silnik zawsze liczy netto, IVA i brutto — różni się tylko prezentacja.

### 3.3 Rozstrzygnięte pytania cenowe
- Dojazd przewoźnika do odbioru nie jest liczony (D48).
- „Pilne” = odbiór za < 24 h, naliczane automatycznie (D49); „weekend” = sobota, niedziela i święta krajowe z tabeli `holidays`, wg daty odbioru w strefie Europe/Rome (D51).
- Wycena ważna 30 min i przeliczana przy płatności (D62).

## 4. Statusy zlecenia

```
draft → pending_payment → paid → assigned → picked_up → in_transit → delivered → completed
                    ↘ expired      ↘ cancelled / refunded (admin)
                    ↘ payment_review (kwota/waluta ≠, spóźniona płatność — D96) → paid | refunded (admin, Etap 6)
                                   paid → cancelled (klient, D33)
                                   assigned → cancellation_review → cancelled (decyzja admina, D33)
```

| Status (kod) | UI (IT) | Kiedy |
|---|---|---|
| `draft` | Bozza | Kreator w toku |
| `pending_payment` | In attesa di pagamento | Zlecenie zapisane, czeka na płatność w Checkout do terminu D88 |
| `expired` | Scaduto | Termin płatności minął bez płatności albo klient anulował niezapłacone zlecenie (D91, D92) |
| `paid` | Pagato | Webhook `checkout.session.completed`, kwota zgodna (D89) — kurs widoczny dla przewoźników |
| `payment_review` | Pagamento da verificare | Pieniądze pobrane, ale niezgodne ze zleceniem — decyzja admina (D96) |
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

- Ustawienia admina (`settings`): `free_cancellation_hours` (domyślnie 24) i `late_cancellation_fee_bp` (domyślnie 5000 = 50 %) — **[DO USTALENIA]** (D94).
- Zlecenie niezapłacone (`pending_payment`) klient anuluje bez opłat → `expired` (D92).
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

Trasa `/prenota`. Kroki (pasek postępu, cena na żywo w panelu bocznym / dolnym na mobile od kroku „Veicolo”):

1. **Percorso** — adres odbioru i dostawy (Google Places autocomplete, tylko Włochy), piętro i winda przy każdym adresie, bez przystanków pośrednich w MVP (D20). Sprawdzenie obszaru obsługi (sekcja 2a: prowincja odbioru + maks. dystans): „Al momento non serviamo questa zona” / „Il percorso supera la distanza massima di X km” (formularz kontaktowy — Etap 2c).
2. **Data e ora** — data i okno odbioru (D73); checkbox „Urgente” informacyjny (D49). Za mało wyprzedzenia: „Prenota almeno X ore prima del ritiro” (D50). Dopłaty pilne/weekend/święto system nalicza sam.
3. **Merce e facchinaggio** — opis towaru, liczba sztuk, rodzaj transportu (kategoria, D83), waga łączna, wymiary największego przedmiotu, liczba palet EUR (D86); tragarze per odcinek (D74): kategoria ładunku (D67) i ewentualnie więcej osób. Pod wyborem zdanie „Nel prezzo X h di lavoro; ogni ora successiva iniziata Y € a persona” (z `Quote.porters[]`, D68; dla firmy Y netto + IVA).
4. **Veicolo** — karty aktywnych typów pojazdów: parametry (ładowność, wymiary, objętość, palety) i cena wyliczona przez serwer; propozycja „Consigliato” z powodem (D82, D83); pojazdy za małe zablokowane, poniżej minimum kategorii — ostrzeżenie (D84).
5. **Servizi extra** — pakowanie (liczba sztuk); magazyn (D72, D73): data i okno odbioru z magazynu, liczba palet (gdy cennik liczy za paletę). Z magazynem zlecenie ma dwa odcinki (A→magazyn, magazyn→B), a kreator pyta o tragarzy osobno przy odbiorze w A i przy dostawie do B (D74).
6. **Preventivo** — pełne rozbicie ceny (privato brutto, azienda netto + IVA + razem, D3), przełącznik Privato/Azienda przed zalogowaniem, ważność wyceny (D62, D76).
7. **Account** — logowanie lub rejestracja (Privato/Azienda; pola wg D43/D44), powrót do kreatora z zachowanym stanem (D70). Po zalogowaniu cena przeliczana dla typu klienta z konta.
8. **Contatti** — osoba kontaktowa przy odbiorze i dostawie (imię, telefon), notatki.
9. **Riepilogo** — rozbicie ceny, dane do faktury (osoba prywatna: codice fiscale + adres — wymagane, D43; firma: adres, dane z rejestracji do sprawdzenia/zmiany, D36, D44; profil bez zmian), akceptacja regulaminu, „Conferma prenotazione”. Serwer sprawdza wycenę (D76) i zapisuje zlecenie `pending_payment` z numerem (D71, D77).
10. **Pagamento** — przycisk „Conferma e paga” zapisuje zlecenie i przekierowuje do Stripe Checkout; powrót na stronę zlecenia `/cliente/ordini/[id]` („Pagamento in verifica”, strona odświeża się, aż webhook ustawi `paid`). Gdy sesji nie udało się utworzyć: numer zlecenia i „Vai all'ordine e paga” (D88, D89).

Kroki 1–6 (wycena) dostępne bez logowania; konto jest obowiązkowe przed zapisem zlecenia (D8, D70). Brak zamówień jako gość. Stan kreatora w przeglądarce wg D78 (bez danych osobowych, czyszczony po zamówieniu); zlecenie w bazie powstaje dopiero po zalogowaniu. Wycenę liczy wyłącznie serwer (D76); przeglądarka nie dostaje kwot przewoźnika ani marży.

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
3. Dokumenty (upload do prywatnego bucketu Supabase Storage, data ważności zależna od typu): zestaw i reguły wg D97, D98.
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
- **Veicoli:** CRUD typów pojazdów (nazwa, ładowność, wymiary, kolejność wielkości, aktywny) — D7. Stawka/km i cena minimalna edytowane w Listino (wersja cennika, D18); tu widoczne tylko do odczytu.
- **Listino prezzi (cennik):** dopłaty (kwotowe/procentowe), stawki usług (tragarze, pakowanie), stawki magazynowe (dzień/paleta), stawka IVA, **reguły kwoty przewoźnika: osobno dla transportu, tragarzy i pakowania** (procent lub kwota; magazyn zawsze 0) — D6. Wersjonowanie cennika + podgląd przykładowej wyceny przed zapisem.
- **Area di servizio:** lista obsługiwanych prowincji odbioru i maksymalny dystans trasy w km (D10, D13); zapytania z formularza kontaktowego spoza obszaru.
- **Magazzino:** jeden magazyn w MVP (tabela `warehouses`, gotowa na kolejne) — D9. Lista pozycji (zlecenie, klient, liczba palet, data wejścia, opłacone do, naliczone dni), przyjęcie/wydanie, lokalizacja w magazynie. Pozycje z kończącym się okresem → przycisk „Invia link di pagamento” (Stripe Payment Link / Checkout na przedłużenie; po webhooku przesuwa datę „opłacone do” i wystawia fakturę).
- **Fatture:** faktury wystawione klientom (status SDI: inviata, consegnata, scartata) z ponowieniem; faktury przewoźników (podgląd, akceptacja/odrzucenie).
- **Pagamenti / Payouts:** lista wypłat wg statusów (sekcja 4), kolejka **„Da verificare”** (podgląd faktury przewoźnika vs `carrier_amount`, akceptuj / odrzuć z powodem), **wstrzymaj / zwolnij** z powodem, ponowienie nieudanej, **potrącenia** (`payout_adjustments`: przewoźnik, kwota w centach, powód, powiązane zlecenie; rozliczane przy następnej wypłacie; nie zmieniają faktury przewoźnika, dokument potrącenia generowany osobno — D12).
- **Impostazioni:** dane firmy Transigo (do faktur), okno wypłaty w godzinach (domyślnie 24), polityka anulowania (X h bezpłatnie, Y % opłaty — D33), szablony e-mail/SMS, użytkownicy admin.

## 10. Płatności i wypłaty — reguły

- **Checkout:** sesja Stripe Checkout tworzona na serwerze z kwotą ze snapshotu zlecenia (`order_charges.total_cents`); `metadata.order_id` + `order_number`. Zlecenie `paid` tylko po zweryfikowanym (podpis) webhooku; obsługa idempotentna (tabela przetworzonych `event.id`). Szczegóły: D88–D96.
- **Model Connect:** „separate charges and transfers” — płatność na konto Transigo, a po spełnieniu warunków `Transfer` na konto Express przewoźnika (`transfer_group` = numer zlecenia, D90).
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
