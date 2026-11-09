# Transigo — instrukcje projektu

Włoska platforma do obsługi zleceń transportowych (model podobny do zipmend.com).
Szczegółowa specyfikacja funkcji, ekranów i reguł: **[docs/spec.md](docs/spec.md)**. Czytaj ją przed pracą nad każdą funkcją.

## Produkt

Klient zamawia transport online po cenie wyliczanej na żywo i płaci z góry. Zlecenie trafia do sieci drobnych przewoźników (*padroncini*), którzy przyjmują kursy w aplikacji PWA. Transigo wystawia klientowi e-fakturę (SDI) i po każdej dostawie automatycznie wypłaca przewoźnikowi jego część.

**Usługi:** transport (różne typy pojazdów), *facchinaggio* (tragarze), *imballaggio* (pakowanie), *deposito merci* (przeładunek, krótkie składowanie, długie składowanie).

## Role

| Rola (w kodzie) | Kto | Najważniejsze możliwości |
|---|---|---|
| `cliente` | Osoba prywatna lub firma | Rezerwacja z wyceną na żywo, płatność kartą z góry, śledzenie pojazdu na mapie, potwierdzenie dostawy (podpis + zdjęcie), faktury |
| `padroncino` | Drobny przewoźnik z P.IVA | Rejestracja z dokumentami (licencja, OC, pojazd, IBAN), aktywacja przez admina, lista dostępnych kursów z kwotą dla siebie, „Accetta la Corsa”, zmiana statusów, GPS, zdjęcia, podpis odbiorcy, wgranie własnej faktury dla Transigo |
| `admin` | Zespół Transigo | Cennik, zlecenia, przewoźnicy, klienci, magazyn, faktury, wypłaty, zwroty, wstrzymywanie wypłat, dashboard |

## Kluczowe przepływy

**Zlecenie:** rezerwacja → Stripe Checkout → webhook `checkout.session.completed` → status „opłacone” → widoczne dla przewoźników → przyjęte → odbiór → w drodze → `consegnato` (podpis + zdjęcie).
Zlecenie jest opłacone **wyłącznie** po webhooku Stripe — nigdy na podstawie przekierowania z Checkout.

**Pieniądze:**
1. Klient płaci przy rezerwacji (Stripe Checkout). Wycena bez logowania, konto obowiązkowe przed płatnością.
2. Zaraz po webhooku płatności Transigo wystawia klientowi e-fakturę SDI przez **Fatture in Cloud** — zawsze przez adapter (`lib/einvoice`), żeby dało się zmienić dostawcę.
3. Wypłata Stripe Connect (Express) po **każdej** dostawie, automatycznie, gdy: `consegnato` z podpisem/zdjęciem + faktura przewoźnika wgrana i kwotowo zgodna (inaczej „Da verificare” → admin) + minęło okno (domyślnie 24 h, konfigurowalne) + brak otwartej reklamacji.
4. Admin może wstrzymać wypłatę i zwrócić pieniądze klientowi. Zwrot po wykonanej wypłacie = koszt Transigo; admin może dodać potrącenie do następnej wypłaty (`payout_adjustments`). Faktura przewoźnika jest zawsze na pełną kwotę przewoźnika; potrącenia zmniejszają tylko przelew i mają osobny dokument.

**Cena:** `dystans (Google Maps) × stawka/km typu pojazdu + dopłaty (pilne, weekend, winda, tragarze, pakowanie) + magazyn (za dzień lub paletę)`. Kwota dla przewoźnika = osobna reguła (procent lub kwota) dla transportu, tragarzy i pakowania; magazyn w 100% dla Transigo. Typy pojazdów, cennik, okno wypłaty i obszar obsługi (prowincje odbioru + maks. dystans trasy) edytowalne w panelu admina. Klient prywatny widzi ceny z IVA, firma netto + IVA.

Pełna lista decyzji: [docs/spec.md, sekcja 0](docs/spec.md#0-rejestr-decyzji-2026-11-08). Decyzje D1–D3 (e-faktury, moment faktury, prezentacja IVA) oraz dokument potrącenia z D12 czekają na potwierdzenie z commercialista — budujemy według nich.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase: Postgres, Auth, Storage, Realtime, Row Level Security
- Stripe (Checkout, webhooki, Refunds) + Stripe Connect (Express)
- Google Maps API (Places autocomplete, Distance Matrix/Routes, mapa trackingu)
- Resend (e-maile), Twilio (SMS)
- E-faktury SDI: Fatture in Cloud (za adapterem, wymienny dostawca)
- Hosting: Vercel. Aplikacja przewoźnika to PWA w tym samym projekcie.

Uwagi techniczne:
- Next.js 16: middleware nazywa się **proxy** (`src/proxy.ts`); odświeża sesję Supabase. Przed pisaniem kodu Next sprawdzaj `node_modules/next/dist/docs/`.
- Supabase CLI 3.x domyślnie celuje w lokalny stack. Staging (chmura): zawsze `--remote` (skrypty `npm run db:push`, `npm run db:list`). Lokalny stack (Docker) służy **wyłącznie do testów RLS** (D64): `npm run db:local:start` / `db:local:stop` / `db:local:reset`, porty 553xx (`supabase/config.toml`; 543xx zajmuje inny projekt na tym komputerze).
- **Zmiany w bazie w chmurze:** `npm run db:push` (i potwierdzenie `--yes`, którego CLI wymaga w trybie agenta) uruchamiamy **tylko po wyraźnej zgodzie właściciela w danej rozmowie** — zgoda z wcześniejszej rozmowy lub z planu nie wystarcza. CLI oznacza obecny projekt (`bacabuzzevwwdxrswbnc`, staging) jako „production”; to jedyny projekt w chmurze.
- **Staging = osobny projekt Supabase, nigdy baza produkcyjna** (dziś `bacabuzzevwwdxrswbnc`; produkcja dostanie własny projekt). Seed danych demo/testowych na stagingu tylko z **jawną flagą** w poleceniu i za zgodą właściciela w danej rozmowie; domyślnie każdy seed działa wyłącznie na lokalnej bazie. Na produkcji żadnego seeda.
- **Gdy powstanie osobny projekt produkcyjny:** każde polecenie na nim (push, reset, SQL, zmiany w panelu, sekrety) wymaga osobnego potwierdzenia właściciela, w którym pada **nazwa projektu**. Przed takim poleceniem pokazać, na który projekt (nazwa + ref) celuje CLI.
- Testy bezpieczeństwa RLS: `npm run test:rls` (`tests/rls/`) — **tylko na lokalnym Supabase** (D64): `global-setup.ts` bierze klucze z `supabase status`, odrzuca każdy inny adres niż `http://127.0.0.1:55321` i przed uruchomieniem resetuje lokalną bazę (wszystkie migracje z repo). Wymaga włączonego Dockera i `npm run db:local:start`. Nigdy nie kierować ich na staging/produkcję. Każda migracja z tabelą/polityką dostaje testy w tym folderze.

## Zasady pracy

- **Język:** interfejs aplikacji po włosku; kod, nazwy w bazie i komentarze po angielsku. Komunikacja z właścicielem projektu po polsku.
- **Pieniądze:** kwoty zawsze w centach (`integer`, EUR), nigdy `float`. Zaokrąglenia jawne i opisane w kodzie.
- **Schemat bazy:** przed każdą zmianą schematu (migracja, tabela, kolumna, polityka RLS) pokaż plan i **poczekaj na zgodę**.
- **RLS na każdej tabeli:** klient widzi tylko swoje dane, przewoźnik tylko przypisane mu zlecenia (oraz zanonimizowaną listę kursów dostępnych do przyjęcia), admin wszystko. Operacje uprzywilejowane tylko po stronie serwera (service role nigdy w kliencie).
- **Testy:** logika cen i wypłat ma testy jednostkowe — bez nich zmiana nie jest skończona.
- **Konta:** konta adminów i przewoźników blokujemy, nie usuwamy (D66). Usuwanie kont tylko w testach lub na żądanie GDPR (D35).
- **Audit log:** każdą akcję admina zapisuje `audit(ctx, …)` (`src/lib/admin/server.ts`) — log jest append-only i trzyma `actor_id` + `actor_email` (D65). W `audit_log.data` nie zapisujemy danych osobowych klientów (adresy, telefony itp.), tylko ID i zmienione wartości biznesowe.
- **Decyzje:** nowe ustalenia dopisuj do rejestru decyzji w `docs/spec.md` (sekcja 0).
- **Stripe tylko w trybie testowym**, dopóki właściciel nie powie inaczej. Klucze wyłącznie w `.env*`, nigdy w kodzie ani w commitach.
- **Małe kroki:** jedno zadanie naraz, po każdym działającym kroku commit, a po commicie `git push` na `origin` (prywatne repo `hefaj1717/transigo`).
- **Gdy czegoś nie wiesz — pytaj, zamiast zgadywać.**

## W toku: demo dla klienta (od 2026-11-09)

- **Krok 1 — obsługa zleceń przez admina (D122, D123):** migracja `20261110110000_admin_order_dispatch.sql` (`admin_job_candidates`, `admin_assign_job`, `admin_unassign_job` z kodem powodu, `admin_advance_order`, `orders.delivered_without_pod` + trigger) i `tests/rls/admin-dispatch.test.ts` — **lokalnie; na staging dopiero, gdy będą gotowe strona publiczna i panel klienta (za zgodą)**. Wspólne fixtures testów kursów: `tests/rls/job-fixtures.ts`.
- **Krok 2 — ekrany `/admin/ordini`** (zrobione 2026-11-09): filtry „Da assegnare”/„In corso”/„Consegnati”, kolumna Padroncino, szczegóły `/admin/ordini/[id]` (Assegna z listy kandydatów, Rimuovi padroncino z kodem powodu, następny status, znacznik „senza firma e foto”). Logika `src/lib/orders/dispatch.ts` (czysta) i `dispatch-server.ts`; akcje `src/app/(admin)/admin/ordini/actions.ts` z testem „każdy eksport jako nie-admin”. Wspólne `adminDeps()` w `src/lib/admin/deps.ts` (sesja → dopiero potem service role) — używają go też akcje `/admin/padroncini`.
- **Krok 3 — seed demo** (zrobione 2026-11-09): `npm run db:local:reset && npm run db:local:seed-demo` (tylko lokalnie: kontrola adresu 127.0.0.1:55321/55322, SQL w kontenerze z kontrolą gniazda; daty zleceń zakończonych w przeszłości; na końcu loginy, hasło `Prova-12345!`).
- **Krok 4 — przegląd i kreator** (zrobione 2026-11-09): `/admin/ordini` sprawdzone w przeglądarce na danych demo (Assegna, Rimuovi padroncino, statusy do „Consegnato”, znacznik bez POD); poprawione zagnieżdżenie `order_leg_carrier_terms` pod `order_legs` (klucz obcy do odcinków, nie do zleceń). Lista testu ręcznego: `docs/testy-reczne/admin-ordini.md`. **„Stoccaggio lungo termine” ukryte** (D117): `planLegs(..., maxStorageDays)` → `storage_too_long`, serwer podaje `storageShortTermMaxDays` z cennika, pole daty w kreatorze ma `max`.
- **Na czym skończyliśmy (2026-11-09):** demo dla admina gotowe lokalnie; migracja `admin_order_dispatch` **nie jest na stagingu** (dopiero razem ze stroną publiczną i panelem klienta, za zgodą). Nazwę projektu `bacabuzzevwwdxrswbnc` właściciel zmienia sam na „TransiGo staging”.
- **Etap 2c — strona publiczna (od 2026-11-09, plan zatwierdzony; D124, D125):**
  - [x] Krok 1: layout `(public)` (nagłówek, menu mobilne, stopka z danymi prawnymi z `settings.company_*`), logo tekstowe i kolory `brand-*`/`accent-*` w `globals.css`, strona główna (hero z mini-formularzem → `/prenota`, usługi, „Come funziona”, pojazdy, „Diventa partner”, FAQ). `AddressField` przeniesione do `src/components/`. Treści w `src/lib/public/content.ts` (szkic do przeglądu właściciela).
  - [x] Krok 2: `/servizi` + `/servizi/trasporto|facchinaggio|imballaggio|deposito-merci` — wspólny szablon `src/components/site/service-page.tsx` (4 osobne foldery: w Next 16 z `cacheComponents` nie ma `dynamicParams`), teksty `SERVICE_DETAILS` w `content.ts`, dane z cennika (pojazdy, kategorie tragarzy, limit dni i jednostka magazynu) bez cen; usługa niedostępna w aktywnym cenniku → „non è prenotabile online” + link do kontaktu (logika `src/lib/public/services.ts` + testy). Magazyn tylko krótko (D117). Na stagingu facchinaggio i deposito są niedostępne (cennik v9 bez kategorii tragarzy, brak aktywnego magazynu).
  - [x] Krok 3: `/come-funziona` (kroki klienta i przewoźnika), `/domande-frequenti` (grupy, kotwice, JSON-LD `FAQPage` przez `jsonLdString()` z ucieczką `<`), `/diventa-partner` (zielony, korzyści, kroki, wymagania, dokumenty z `CARRIER_DOCUMENT_TYPES` przez `partnerDocuments()` — zmiana dokumentów w onboardingu zmienia stronę, FAQ przewoźników, link do `/registrati?tipo=padroncino`). FAQ z polami `group` i `home` w `content.ts`. Teksty opisują docelowy produkt (np. wypłata po każdej dostawie, Stripe Connect) — przed startem sprawdzić, że wszystko działa.
  - [x] Krok 4 (D125): migracja `20261110120000_contact_requests.sql` — **lokalnie, nie na stagingu** (na staging razem z `admin_order_dispatch`, stroną publiczną i panelem klienta, za zgodą); testy `tests/rls/contact-requests.test.ts` (w tym wyścig 10 wysłań z jednego IP i kod serwera na prawdziwej bazie). `/contatti` (akcja `src/app/(public)/contatti/actions.ts`: ukryte pole i zod → hash IP → dopiero service role; test kolejności), logika `src/lib/contact/` (`form.ts`, `ip.ts`, `server.ts`), mail `contact_request` bez danych osobowych, `/admin/richieste` (+ `[id]`, „Segna come gestita” / „Riapri”, test „każdy eksport jako nie-admin”), cron `/api/cron/purge-contact-requests`.
    - Nowy sekret **`CONTACT_IP_HASH_SECRET`** (≥ 32 znaki): jest w `.env.local`; **dodać na Vercel** przed wdrożeniem. Bez niego formularz zwraca błąd (nic nie zapisuje).
    - Na stagingu (dev na `localhost:3000`) formularz `/contatti` do czasu migracji kończy się „Invio non riuscito” — działa tylko walidacja.
    - `global-setup.ts` testów RLS czeka po resecie, aż REST API odbuduje cache schematu (wcześniej losowe „Could not query the database for the schema cache”).
  - [ ] Krok 5: formularz spoza obszaru w kreatorze. Krok 6: `/cookie` + baner „Ok”, metadata, `sitemap.ts`, `robots.ts`, `noindex` na stagingu. Krok 7: przegląd w przeglądarce, `docs/testy-reczne/strona-publiczna.md`.
  - Link do `/cookie` (krok 6) do tego czasu daje 404.
- Potem panel klienta (status zlecenia i historia dla klienta).

## Odłożone: PWA przewoźnika (priorytet: najpierw demo dla klienta, 2026-11-09)

Decyzje właściciela (D117–D121 w spec):
- **Magazyn:** teraz model A (kurs = całe zlecenie, jeden przewoźnik na oba odcinki). Model B (kurs i wypłata per odcinek) **przed Etapem 7 i przed startem produkcyjnym** — do tego czasu kreator **bez „stoccaggio lungo termine”**.
- **`payouts_enabled`** (D21) — dopiero w kroku Stripe Connect (D118).
- **Rezygnacja:** opcja b (D121) — „Rinuncia” w ciągu 15 min od przyjęcia albo ≥ 48 h przed odbiorem; każda rezygnacja → e-mail do admina, kurs wraca na listę.
- **Przed/po przyjęciu** (D119) i **dopasowanie pojazdu** (D120) zaakceptowane; na karcie kursu przed przyjęciem dystans w km i szacowany czas jazdy.

Stan:
- **Baza gotowa** (migracja `20261110100000_carrier_jobs.sql` — na stagingu od 2026-11-09, testy `tests/rls/carrier-jobs.test.ts`, w tym wyścig 2 i 5 przewoźników): `carrier_job_eligibility()`, `list_available_jobs()`, `accept_job()`, `release_job()`, blokada pojazdu w kursie (trigger). Funkcje działają w sesji przewoźnika (`auth.uid()`), nie service role.
- **Do zrobienia po powrocie:** ekrany `/padroncino/corse` (+ `[id]` z „Accetta la Corsa”), `/padroncino/le-mie-corse` (+ „Rinuncia” z mailem do admina), Server Actions z testem „każdy eksport jako nie-przewoźnik”, seed z kursami (w tym kurs przypisany przewoźnikowi → ostrzeżenie D116 przy „Sospendi”, dopisać do `docs/testy-reczne/admin-padroncini.md`), `docs/testy-reczne/corse-padroncino.md`.
- **TODO (krok Stripe Connect, D118):** lista i `accept_job()` wymagają `carriers.stripe_payouts_enabled` — migracja + test RLS.
- Dalej (bez zmian): statusy w PWA, GPS, podpis i zdjęcia (Etap 4/5), „Segnala un problema” (D39), Stripe Connect, SMS.

## Struktura folderów (docelowa)

```
/
├── CLAUDE.md
├── docs/
│   └── spec.md               # specyfikacja funkcji
├── src/
│   ├── app/
│   │   ├── (public)/         # strona publiczna, kreator rezerwacji
│   │   ├── (cliente)/        # panel klienta
│   │   ├── (padroncino)/     # PWA przewoźnika
│   │   ├── (admin)/          # panel admina
│   │   └── api/              # route handlers, webhooki (stripe, sdi)
│   ├── components/           # współdzielone komponenty UI
│   ├── lib/
│   │   ├── pricing/          # silnik cenowy (czysta logika + testy)
│   │   ├── payouts/          # logika wypłat (czysta logika + testy)
│   │   ├── supabase/         # klienci Supabase (browser/server/service)
│   │   ├── stripe/
│   │   ├── maps/
│   │   ├── notifications/    # Resend, Twilio
│   │   └── einvoice/         # adapter dostawcy e-faktur
│   └── types/
├── supabase/
│   ├── migrations/           # migracje SQL (schemat + RLS)
│   └── seed.sql
├── public/                   # manifest PWA, ikony
├── .env.example
└── .gitignore
```

## Etapy

- [x] 0. Fundament (repo, CLAUDE.md, spec, .gitignore, .env.example)
- [x] 1. Szkielet Next.js + Supabase, logowanie z rolami cliente/padroncino/admin, schemat bazy, RLS — **reset hasła do ponownego testu ręcznego** (limit maili Supabase)
  - Powstało: migracje `accounts`, `vehicles_documents`, `settings_audit`, `consents` (D42–D44); ekrany `/registrati`, `/accedi`, `/password-dimenticata`, `/reimposta-password`, `/auth/confirm`, `/account-sospeso`, panele `/cliente`, `/padroncino` (ekran „Account in attesa di verifica”), `/admin`; walidatory i schematy zod w `src/lib/auth/`; testy jednostkowe + `tests/rls/` (w tym routing ról na prawdziwej bazie).
  - Pamiętać:
    - Każda strona/akcja zależna od sesji sprawdza dostęp przez DAL (`requireArea()` / `getAccountContext()` z `src/lib/auth/session.ts`) wewnątrz `<Suspense>`; layout i proxy nie wystarczą (proxy tylko przekierowuje niezalogowanych).
    - `getAccountContext()` woła `connection()` (inaczej błąd „Date.now() while prerendering” przy `partialPrefetching`); nie cache'ujemy kontekstu (`use cache: private`), żeby blokada konta działała od razu.
    - Zablokowany użytkownik nie czyta własnego profilu przez RLS — DAL czyta profil klientem service role (`src/lib/supabase/service.ts`, tylko po id z sesji).
    - Rejestracja: wiersz `customers`/`carriers` i zgody zapisuje serwer; przy błędzie konto auth jest usuwane (rollback).
    - Klient prywatny nie ma CF po rejestracji — przed utworzeniem Checkout (Etap 3) serwer musi wymagać CF i adresu z „Riepilogo” (D43).
    - Panel Supabase: szablony e-mail używają `{{ .RedirectTo }}?token_hash=…&type=email|recovery`; każdy adres aplikacji (localhost, Vercel) musi być w Redirect URLs jako `…/auth/confirm`.
    - Wymuszony jasny motyw (`globals.css`); tryb ciemny przy pracy nad wyglądem.
- [ ] 2. Silnik cenowy, kreator rezerwacji, strona publiczna
  - [x] **2a. Silnik cenowy** (D47–D63): migracje `pricing` i `service_area_holidays`; `calculatePrice()` / `storageCost()` w `src/lib/pricing/` (czyste, z testami), `loadPricingConfig()` (serwer); adapter Google Maps `src/lib/maps/` (tylko serwer) + `/api/maps/autocomplete`, `/api/maps/place`; panele admina `/admin/listini`, `/admin/veicoli`, `/admin/area-di-servizio`, `/admin/festivita`; testy RLS `tests/rls/pricing.test.ts`.
    - Pamiętać:
      - Cennik tylko admin (D59) — publiczna wycena czyta go klientem service role przez `loadPricingConfig(createServiceClient())`.
      - Opublikowanego cennika nie da się edytować (trigger, także service role); zmiana = „Crea bozza” → edycja → „Pubblica”.
      - Wszystkie prowincje są nieaktywne — bez włączenia regionu w „Area di servizio” każda wycena zwraca `pickup_province`.
      - Stawki wersji 1 to placeholdery. Na stagingu aktywna jest v9 (kopia v1 z czasów, gdy testy RLS działały w chmurze — treść bez zmian).
      - `/api/maps/*` są publiczne — przed produkcją dodać rate limiting.
      - Tragarze wg kategorii ładunku (D67) i nadgodzin (D68): `porterOvertimeCost()` w `src/lib/pricing/overtime.ts`. Aktywny cennik sprzed D67 nie ma kategorii → tragarze niedostępni do publikacji nowej wersji.
  - [x] **2b. Kreator rezerwacji** (D70–D80): migracje `warehouses`, `orders` (`orders`, `order_legs`, `order_charges`, `order_lines`, `order_leg_carrier_terms`, `order_status_history`, `quotes`, `create_order()`); testy RLS `tests/rls/orders.test.ts`; logika `src/lib/booking/` (czysta + testy) i `server.ts`; `/api/booking/quote`; kreator `/prenota`; `/completa-profilo` (D80); lista zleceń w `/cliente`; `/admin/magazzino`.
    - Pamiętać:
      - Dane zlecenia podzielone wg widoczności (D77): klient nie czyta `order_leg_carrier_terms`, przewoźnik nie czyta `order_charges`/`order_lines`. Nowe kolumny dodawać do właściwej grupy.
      - Zlecenie tworzy tylko `create_order(jsonb)` (service role); payload buduje `buildOrderPayload()`. Snapshot niezmienny (triggery, także service role); usuwać można tylko nieopłacone zlecenia; konta ze zleceniami nie da się usunąć.
      - Przeglądarka dostaje wycenę tylko przez `toPublicQuote()`; kwoty przewoźnika zostają w `quotes` (tylko service role).
      - Na stagingu do testów kreatora: opublikować nowy cennik (v9 nie ma kategorii tragarzy), włączyć prowincje w „Area di servizio”, dodać aktywny magazyn w `/admin/magazzino`.
      - Mapa z trasą w kroku „Percorso” jeszcze nie zrobiona (jest tylko dystans); formularz kontaktowy spoza obszaru → 2c.
      - Status `pending_payment` w 2b oznacza zapisane zlecenie bez płatności; w Etapie 3 — sesję Checkout (wygaszanie nieopłaconych do zrobienia).
      - `/api/booking/quote` i `/api/maps/*` publiczne — przed produkcją rate limiting.
  - [ ] **2c. Strona publiczna**
  - **TODO przed Etapem 3** (maile z potwierdzeniem zamówienia): Resend + SMTP dla Supabase Auth, instrukcja w D79 (kupić domenę, DNS SPF/DKIM, klucz API, SMTP w Supabase, Rate Limits).
- [x] 3. Płatność klienta (Stripe Checkout + webhook) — **ukończony 2026-11-09** (D88–D96): migracje na stagingu; test E2E na stagingu: 4242, 0002 (odrzucona), 3155 (3D Secure), „Paga ora” po wyjściu z Checkout, „Annulla ordine” (zlecenie `expired`, sesja wygaszona w Stripe), `stripe events resend` → `[200]` bez zmian w bazie.
  - Powstało: migracje `payments_enum`, `payments` (`payments`, `refunds` — model, `stripe_events`, `email_outbox`, `orders.payment_due_at`, kolumny anulowania, funkcje `start_order_payment` / `confirm_order_payment` / `expire_*`); `src/lib/stripe/` (klucze tylko testowe), `src/lib/payments/` (parametry sesji, webhook, serwer, cron), `src/lib/notifications/` (adapter maili + szablon `order_paid`); `/api/webhooks/stripe`, `/api/cron/expire-orders`; `/cliente/ordini/[id]` („Paga ora”, „Annulla ordine”, „Pagamento in verifica”); `/admin/ordini`; testy jednostkowe + `tests/rls/payments.test.ts`.
  - Pamiętać:
    - `paid` ustawia **tylko** `confirm_order_payment()` z webhooka; powrót z Checkout niczego nie zmienia. `payments` zapisują wyłącznie funkcje w bazie (nawet service role nie ma `INSERT/UPDATE`).
    - Jedna otwarta sesja na zlecenie; wygasa z terminem płatności (D88). Nowe metody płatności włącza się w Stripe Dashboard (API nie ma `payment_method_types`); Adaptive Pricing wyłączone.
    - Lokalnie webhooki przez Stripe CLI (osobny terminal, cały czas włączony):
      `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to localhost:3000/api/webhooks/stripe`
      Wypisany `whsec_…` → `STRIPE_WEBHOOK_SECRET` w `.env.local` (stały dla konta CLI; po zmianie restart `npm run dev`). Bez `--events` przychodzą wszystkie zdarzenia — też działa (zapisywane jako zignorowane), tylko zaśmieca `stripe_events`. Bez działającego `stripe listen` zlecenia nie przejdą w `paid` od razu (zadanie `/api/cron/expire-orders` dogania opłacone sesje po terminie).
    - Test idempotencji: `stripe events resend <evt_id>` — stan w bazie ma się nie zmienić (w terminalu `stripe listen` odpowiedź `[200]`).
    - Zadanie okresowe ręcznie: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/expire-orders` (zwraca raport `checked/paid/review/expired/stillOpen/errors`).
    - Konto Stripe wysyła zdarzenia w swojej domyślnej wersji API (sandbox: `2026-10-28.endive`), SDK `stripe@23.0.1` ma typy dla `2026-09-30.endive`; używane pola sesji i PaymentIntent są w obu takie same. Przy aktualizacji SDK sprawdzić zgodność.
    - Maile: `EMAIL_TRANSPORT=outbox` — trafiają do `email_outbox` (`captured_dev`), nie są wysyłane. Transport `resend` do podłączenia po weryfikacji domeny (D79).
    - Do decyzji przed wdrożeniem: harmonogram zadania okresowego (D91), wartości anulowania (D94), okno płatności (D88).
    - Status `payment_review` (D96): obsługa przez admina (oznacz jako opłacone / zwrot) — Etap 6.
- [ ] 4. PWA przewoźnika (rejestracja, Stripe Connect, kursy, realizacja, GPS, faktura)
  - [ ] **4.1 Onboarding i weryfikacja przewoźnika** (D97–D112): migracja `carrier_onboarding` + `tests/rls/carrier-onboarding.test.ts` (na stagingu od 2026-11-09); blokada danych firmy `carrier_company_lock` (na stagingu od 2026-11-09); migracja `carrier_submit_vehicle_approval` (D106, D107; na stagingu od 2026-11-09); PWA (manifest, SW, ikony, `CarrierShell`) — do sprawdzenia na telefonie; **krok 3 (ekrany onboardingu) zrobiony 2026-11-09 — do testu ręcznego na telefonie**; **krok 4 `/admin/padroncini` zrobiony 2026-11-09 (D113–D116), test ręczny lokalnie zaliczony (`docs/testy-reczne/admin-padroncini.md`); migracja `carrier_admin_actions` na stagingu od 2026-11-09**.
    - Typy dokumentów: tabela `carrier_document_types` = `src/lib/carriers/document-types.ts` — zmieniać razem (nowa migracja + plik).
    - `decide_carrier_review()` tylko service role; Server Action sprawdza admina w sesji, `p_admin_id` z sesji.
    - Dane firmy przewoźnika zablokowane po wysłaniu do weryfikacji, w `active` i `suspended` (D105), także dla service role: zmiana tylko przez `admin_update_carrier_company()` (audit z nazwami pól). SQL Editor omija audyt — tylko awaryjnie.
    - PWA (D104): `public/padroncino/` — `manifest.webmanifest`, `sw.js` (zakres `/padroncino`, nagłówki w `next.config.ts`, wyłączony z proxy), `offline.html`, ikony tymczasowe z `scripts/generate-pwa-icons.mjs`. SW rejestrowany tylko w buildzie produkcyjnym (`npm run build && npx next start -p 3100`). Po zmianie `sw.js` lub plików precache podbić `VERSION`. SW nigdy nie zapisuje stron ani odpowiedzi API.
    - Testy RLS mogą wykonać SQL w lokalnym kontenerze bazy: `localSql()` z `tests/rls/helpers.ts` (`docker exec supabase_db_TransiGo psql`), np. `set_config` + `set local role`.
    - `submit_carrier_for_review()` zwraca `(submitted_at, newly_submitted)`; mail `carrier_submitted` tylko przy `newly_submitted` (D106).
    - Pojazdy (D107): tablica po pierwszym zatwierdzeniu (`first_approved_at`) niezmienna dla każdej roli; zmiana typu/ładowności czyści `approved_at`.
    - Ekrany onboardingu: `/padroncino/dati-aziendali`, `/padroncino/veicoli` (+ `nuovo`, `[id]`). Logika w `src/lib/carriers/server.ts` (klient sesji przewoźnika, nigdy service role; testy `tests/rls/carrier-screens.test.ts`), akcje w `src/app/(padroncino)/padroncino/actions.ts`. Pojazdy edytowalne także przy aktywnym koncie (D112).
    - Strona główna `/padroncino` (`onboarding-home.tsx`): „Registrazione incompleta” / „Registrazione non approvata” (checklista, „Cosa manca”, „Invia per la verifica”), „Account in verifica” (tylko odczyt), „Account sospeso” (powód + „Carica documenti aggiornati”). Wysłanie: `submitCarrierForReview()` — mail `carrier_submitted` tylko przy `newly_submitted`; wymaga `ADMIN_NOTIFICATION_EMAIL` w `.env.local` i na Vercel (bez niego konto i tak zostaje wysłane, błąd w logach).
    - Dokumenty: `/padroncino/documenti` (firma) i sekcja na stronie pojazdu. Przeglądarka wgrywa plik do Storage (`{carrier_id}/{uuid}.{ext}`), potem `registerCarrierDocument()` sprawdza ścieżkę, datę i **metadane z Storage** (rozmiar, typ zgodny z rozszerzeniem) i zapisuje wiersz sesją przewoźnika. Podgląd: signed URL 5 min sesją przewoźnika, HEIC jako „Scarica”.
    - Panel admina (krok 4): lista `/admin/padroncini` (zakładki wg stanu + kolejki „Veicoli da verificare” i „Documenti da verificare” od `active`/`suspended`), szczegóły `/admin/padroncini/[id]` (dane firmy z edycją, dokumenty z historią, pojazdy z „Approva veicolo” tylko pod ich dokumentami, Approva/Rifiuta, Sospendi/Riattiva, ostrzeżenie o kursach w toku). Odczyty sesją admina (`src/lib/carriers/admin-pages.ts`), decyzje w `src/lib/carriers/admin-server.ts` (service role tylko po sprawdzeniu sesji), akcje w `src/app/(admin)/admin/padroncini/actions.ts`.
    - Każda akcja w tym pliku zaczyna od `adminDeps()` (DAL); `actions.test.ts` wywołuje **każdy eksport** jako niezalogowany / cliente / padroncino / zablokowany admin i sprawdza, że nic nie dotarło do serwera ani service role. Nowa akcja → dopisać jej nazwę do listy w teście.
    - Funkcje D113–D115 zapisują `audit_log` w tej samej transakcji; `decide_carrier_review()` nie — audit `carrier.approved`/`carrier.rejected` pisze `decideCarrier()`. Powody (wolny tekst) nie trafiają do logu.
    - Test ręczny panelu: lista kroków i polecenia w `docs/testy-reczne/admin-padroncini.md`. Na lokalnej bazie: `npm run db:local:seed-carriers` (admin + po jednym przewoźniku w każdym stanie; `test:rls` je kasuje). `npm run dev` na lokalnej bazie: `.env.development.local` z `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` z `npx supabase status` (ma pierwszeństwo przed `.env.local`; usunąć po teście i zrestartować dev).
    - Maile do przewoźnika: `carrier_approved`, `carrier_rejected`, `carrier_document_rejected`, `carrier_suspended`, `carrier_reactivated` (`src/lib/notifications/templates/carrier-decisions.ts`); błąd maila nie cofa decyzji.
  - Zawieszony przewoźnik (D116): nie widzi i nie przyjmuje nowych kursów, przyjęte zostają u niego, wypłaty za zrealizowane dostawy idą normalnie.
    - **TODO (krok z listą kursów i „Accetta la Corsa”):** lista dostępnych kursów i przyjęcie wymagają `carriers.status = active` (D21) — w bazie, z testem RLS, że `suspended` (oraz `pending_review`, `rejected`) nie widzi listy i nie przyjmie kursu. Seed (`scripts/seed-local-carriers.mjs`) tworzy kurs przypisany przewoźnikowi (w toku) i ręcznie sprawdzamy ostrzeżenie o kursach w toku w `/admin/padroncini` przy „Sospendi” i u zawieszonego (D116) — dopisać do `docs/testy-reczne/admin-padroncini.md`.
    - **TODO (krok z realizacją kursu):** zmiana statusów, GPS, zdjęcia i podpis działają dla przypisanego kursu także przy `suspended` (test). Ekran „Account sospeso” pokazuje też kursy w toku.
    - **TODO (Etap 6):** warunki wypłaty (D4) nie sprawdzają statusu konta — test, że wypłata dla `suspended` idzie normalnie; wstrzymanie tylko ręczne.
  - **Kursy dla przewoźnika — patrz sekcja „Odłożone: PWA przewoźnika” niżej.** Baza gotowa (migracja `carrier_jobs`), ekrany odłożone.
  - Pojazd przewoźnika musi spełniać wymagania zlecenia (waga, największy przedmiot, palety) przy „Accetta la Corsa”; prawo jazdy kat. C dla camion — do ustalenia (D87).
    - **TODO (krok z „Accetta la Corsa”):** blokada **w bazie** (nie tylko w UI) dezaktywacji pojazdu i zmiany typu lub ładowności, gdy pojazd jest przypisany do kursu w toku albo zaplanowanego.
  - Czas pracy tragarzy statusami (przyjazd na odbiór → załadowano, przyjazd na dostawę → rozładowano; bez jazdy), potwierdzenie podpisem klienta (D69).
- [ ] 5. Tracking na żywo i potwierdzenie dostawy dla klienta
- [ ] 6. E-faktury SDI i automatyczne wypłaty
  - **TODO (D123):** automatyczna wypłata **tylko** gdy `orders.delivered_without_pod = false` (dostawa z POD z PWA); zlecenie z flagą `true` wyłącznie decyzją admina — test.
  - **TODO (D122):** zlecenie odpięte przez admina („Rimuovi padroncino”) z **minionym oknem odbioru** wraca do `paid`, ale nikt go nie przyjmie (`too_late`) — potrzebna zmiana terminu albo zwrot (audit ma `pickup_window_passed`). Do tego czasu admin obsługuje ręcznie.
  - Dopłata za nadgodziny tragarzy: link od admina, osobna e-faktura, kwota przewoźnika do wypłaty (D69). Przed etapem rozstrzygnąć otwartą kwestię D69 (wypłata, gdy klient nie zapłaci dopłaty).
- [ ] 7. Magazyn i dashboard admina
  - **TWARDE TODO (przed Etapem 7 i przed startem produkcyjnym, D117):** model B — każdy odcinek zlecenia z magazynem to osobny kurs (osobny przewoźnik, statusy per odcinek) z **osobną wypłatą per odcinek**. Do tego czasu kreator **nie oferuje** „stoccaggio lungo termine” (`long_term`).
- [ ] 8. Testy end-to-end, dokumenty prawne, wdrożenie
  - Na stagingu „Confirm email” w Supabase Auth jest **wyłączone**; na produkcji musi być **włączone**, z własnym SMTP (Resend, D79).
  - **Przed startem:** model B kursów per odcinek (D117, TODO w Etapie 7) — warunek startu.
  - **Przed startem** założyć osobny projekt Supabase na produkcję; obecny `bacabuzzevwwdxrswbnc` zostaje stagingiem (testy ręczne). Testy RLS działają lokalnie (D64).
