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
- Supabase CLI 3.x domyślnie celuje w lokalny stack — nie używamy Dockera, więc zawsze `--remote` (skrypty `npm run db:push`, `npm run db:list`).
- Testy bezpieczeństwa RLS: `npm run test:rls` (`tests/rls/`, działają na projekcie w chmurze, tworzą i usuwają użytkowników testowych). Każda migracja z tabelą/polityką dostaje testy w tym folderze.

## Zasady pracy

- **Język:** interfejs aplikacji po włosku; kod, nazwy w bazie i komentarze po angielsku. Komunikacja z właścicielem projektu po polsku.
- **Pieniądze:** kwoty zawsze w centach (`integer`, EUR), nigdy `float`. Zaokrąglenia jawne i opisane w kodzie.
- **Schemat bazy:** przed każdą zmianą schematu (migracja, tabela, kolumna, polityka RLS) pokaż plan i **poczekaj na zgodę**.
- **RLS na każdej tabeli:** klient widzi tylko swoje dane, przewoźnik tylko przypisane mu zlecenia (oraz zanonimizowaną listę kursów dostępnych do przyjęcia), admin wszystko. Operacje uprzywilejowane tylko po stronie serwera (service role nigdy w kliencie).
- **Testy:** logika cen i wypłat ma testy jednostkowe — bez nich zmiana nie jest skończona.
- **Decyzje:** nowe ustalenia dopisuj do rejestru decyzji w `docs/spec.md` (sekcja 0).
- **Stripe tylko w trybie testowym**, dopóki właściciel nie powie inaczej. Klucze wyłącznie w `.env*`, nigdy w kodzie ani w commitach.
- **Małe kroki:** jedno zadanie naraz, po każdym działającym kroku commit.
- **Gdy czegoś nie wiesz — pytaj, zamiast zgadywać.**

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
      - Stawki wersji 1 to placeholdery. Test RLS publikacji tworzy przy każdym uruchomieniu nową aktywną kopię listy (numer wersji rośnie).
      - `/api/maps/*` są publiczne — przed produkcją dodać rate limiting.
  - [ ] **2b. Kreator rezerwacji** — warunek ukończenia: zielone testy RLS zleceń (D63); odcinki zlecenia wg D47; ważność wyceny D62.
  - [ ] **2c. Strona publiczna**
  - **Przed Etapem 3:** Kupić domenę, skonfigurować Resend (DNS SPF/DKIM), podpiąć SMTP w Supabase i podnieść Rate Limits.
- [ ] 3. Płatność klienta (Stripe Checkout + webhook)
- [ ] 4. PWA przewoźnika (rejestracja, Stripe Connect, kursy, realizacja, GPS, faktura)
- [ ] 5. Tracking na żywo i potwierdzenie dostawy dla klienta
- [ ] 6. E-faktury SDI i automatyczne wypłaty
- [ ] 7. Magazyn i dashboard admina
- [ ] 8. Testy end-to-end, dokumenty prawne, wdrożenie
  - Założyć osobny projekt Supabase na produkcję; obecny projekt zostaje jako staging do testów (w tym test:rls).
