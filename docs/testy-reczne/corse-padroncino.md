# Test ręczny: kursy przewoźnika (`/padroncino/corse`, „Le mie corse”)

Plan: `docs/plany/corse-padroncino.md`. Decyzje: D21, D116, D119–D121. Test na **lokalnej** bazie (Docker), aplikacja na `localhost:3000`.

> Na razie tylko przygotowanie i konta demo. Kroki testu (lista, „Accetta la Corsa”, „Rinuncia”) dojdą razem z ekranami (krok 4a/4b planu) i przeglądem w przeglądarce (krok 6).

## Przygotowanie

1. Lokalny Supabase, czysta baza i oba seedy:

   ```sh
   npm run db:local:start
   npm run db:local:reset
   npm run db:local:seed-demo
   npm run db:local:seed-carriers
   ```

   - Skrypty działają **tylko na lokalnej bazie**: odmawiają, gdy `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` wskazuje gdzie indziej albo `supabase status` nie pokazuje `127.0.0.1:55321` / `:55322`.
   - **Ponowne uruchomienie niczego nie dokłada** — wypisuje istniejące zlecenia i loginy. Jeśli poprzednie uruchomienie się przerwało, skrypt każe zacząć od `db:local:reset`.
   - Kursy zależą od zegara (np. „Rinuncia bloccata” = przyjęty ponad 15 min temu, odbiór jutro). Na następny dzień testów: `db:local:reset` i oba seedy od nowa.
   - `npm run test:rls` kasuje dane — po nim uruchom seedy ponownie.

2. **Hasło** (wspólne dla wszystkich kont seeda) nie jest w repo: przy pierwszym uruchomieniu skrypt losuje je i zapisuje w `.seed-local/password` (ignorowany przez git):

   ```sh
   cat .seed-local/password
   ```

   Własne hasło: `SEED_PASSWORD='…' npm run db:local:seed-demo` (min. 10 znaków) — skrypt ustawia je na wszystkich kontach seeda, także przy ponownym uruchomieniu.

3. `npm run dev` na lokalnej bazie — `.env.development.local` jak w `docs/testy-reczne/admin-ordini.md` (krok 3 przygotowania), restart dev. Po teście usuń plik i zrestartuj dev.

4. Do testu dwóch przewoźników naraz: druga przeglądarka albo okno prywatne (osobna sesja).

## Konta demo

Numery zleceń jak na czystej bazie (`seed-demo` przed `seed-carriers`). Skrypt wypisuje je na końcu z datą odbioru.

| Konto | Kto | Co ma pokazać |
|---|---|---|
| `padroncino@example.com` | Marco Ferri, **Ferri Trasporti Srl**, aktywny, furgone medio `FT123AB` (1200 kg) | **Corse:** 000002, 000003 (z magazynem), 000010 (furgone piccolo — mniejszy pojazd też pasuje), 000011. **Nie widzi** 000012 (camion, 6 palet, 2,2 t) ani 000013 (blat 4 m, furgone grande). **Le mie corse:** 000004 (przypisane przez admina), 000005 (ritirato), 000006 (in viaggio), 000007 i 000008 (consegnati), **000014** — przyjęty 2 h temu, odbiór jutro → „Rinuncia” **zablokowana** (po terminie „Contatta Transigo”), **000015** — odbiór za 6 dni → „Rinuncia” **możliwa** (≥ 48 h). |
| `padroncino2@example.com` | Luca Galli, **Galli Logistica Srl**, aktywny, camion con sponda `GL456CD` (3000 kg) | **Corse:** 000002, 000003, 000010, 000011, **000012 i 000013** (za duże dla furgonu). **Le mie corse:** puste. Test „già accettata”: Ferri i Galli otwierają 000011, jeden przyjmuje, drugi dostaje komunikat D120 i odświeżoną listę. |
| `bianchi@example.com` | Trasporti Bianchi Srl, aktywny (seed padroncini) | **Corse:** jak Ferri (furgone medio `BI100CC`; `BI100AA` czeka na ponowną weryfikację, `BI100BB` nowy — nie liczą się do przyjęcia). **Le mie corse:** 000016 (przypisane przez admina). |
| `neri@example.com` | Trasporti Neri Srl, **zawieszony** (D116) | **Corse:** zamiast listy wyjaśnienie (konto zawieszone). **Le mie corse:** 000017 (odbiór za 5 dni) — zostaje u niego i **może zrezygnować**. |
| `verdi@example.com`, `viola@example.com` | w weryfikacji | Brak listy kursów (blokada „in verifica”); „Rinuncia” → „Operazione non consentita.” |
| `rosa@example.com` | odrzucony | j.w. |
| `gialli@example.com` | rejestracja niekompletna | Brak listy kursów, ekran onboardingu. |
| `cliente@example.com` | Giulia Conti, klient | Zlecenia 000001–000015; po „Accetta la Corsa” mail `order_assigned` w outboxie. |
| `admin@example.com` | Anna Admin (wspólny dla obu seedów) | `/admin/ordini`: przyjęcia i rezygnacje przewoźników w historii; po „Rinuncia” mail `carrier_released_job` do `ADMIN_NOTIFICATION_EMAIL`. |

Pozostałe zlecenia z `seed-demo` (000001 do zapłaty, 000009 wygasłe) nie są widoczne dla przewoźników.
