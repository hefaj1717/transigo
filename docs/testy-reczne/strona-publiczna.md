# Test ręczny: strona publiczna (Etap 2c)

Decyzje: D117 (bez „stoccaggio lungo termine”), D124 (wygląd, mini-formularz), D125 (zapytania kontaktowe), D126 (indeksowanie, cookies).

Strony informacyjne (kroki A–C) można sprawdzać na stagingu albo lokalnie. **Formularze kontaktowe i `/admin/richieste` (kroki D–F) tylko na lokalnej bazie**, dopóki migracja `contact_requests` nie trafi na staging — na stagingu wysłanie kończy się „Invio non riuscito”.

## Przygotowanie (lokalnie)

1. Lokalny Supabase, czysta baza i dane demo (aktywne prowincje MI, MB, BG, BS, CO, VA, TO, NO; magazyn w Mediolanie):

   ```sh
   npm run db:local:start
   npm run db:local:reset
   npm run db:local:seed-demo
   ```

2. `npm run dev` na lokalnej bazie — `.env.development.local` jak w `docs/testy-reczne/admin-ordini.md` (krok 3 przygotowania), potem restart `npm run dev`. Po teście usuń `.env.development.local` i zrestartuj dev.
3. W `.env.local` muszą być `CONTACT_IP_HASH_SECRET` (≥ 32 znaki) i `ADMIN_NOTIFICATION_EMAIL`.

Każdy krok sprawdź na komputerze **i na telefonie** (albo w trybie urządzenia w DevTools, szerokość ~390 px).

## A. Nagłówek, stopka, strona główna

| # | Krok | Oczekiwany wynik |
|---|---|---|
| A1 | Otwórz `/` | Logo: granatowe „TRANSi” + zielone „GO”. Menu: Servizi, Come funziona, FAQ, Contatti, „Diventa partner” (zielony), Accedi, „Prenota”. |
| A2 | Telefon: dotknij ☰ | Menu się rozwija; po wybraniu pozycji zamyka się i otwiera stronę. |
| A3 | Przewiń do stopki | Logo na granatowym tle, linki usług i stron, „Scrivici”; na dole **ragione sociale, sede legale, P.IVA** (z `settings.company_*`; puste pola nie są pokazywane), linki Termini / Privacy / Cookie policy. |
| A4 | Hero: wpisz adres odbioru w Mediolanie, wybierz z listy; to samo dla dostawy; wybierz datę; „Calcola il prezzo” | Otwiera się `/prenota` na kroku „Percorso” z oboma adresami i datą (krok „Data e ora”). |
| A5 | Hero bez wybrania adresu z listy → „Calcola il prezzo” | Komunikat pod polem „Seleziona l'indirizzo … dall'elenco”. |
| A6 | Sekcje strony głównej | Usługi (3 karty tej samej wysokości), „Per privati” / „Per aziende”, „Come funziona” (3 kroki), pojazdy z aktywnego cennika (bez cen), zielona sekcja partnera, 4 pytania FAQ (rozwijane), „Pronto a partire?”. |

## B. Usługi (D151, D158, D162)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| B1 | Strona główna, zakładki w hero „Trasporto | Facchini | Deposito” (też strzałki ←/→ na klawiaturze) | Trasporto = formularz trasy; Facchini i Deposito = kalkulator z ceną „Prezzo indicativo”. Privato → kwota z IVA, Azienda → netto „+ IVA (… totale)”. |
| B2 | Facchini: 2 osoby, 3 h, 4. piętro bez windy (cennik v14) | 268,40 € IVA inclusa (220,00 € + IVA). 1 h → liczona jako minimum, dopisek „Minimo 2 ore per facchino”. |
| B3 | Deposito: Privato → box S, „1 mese”; Azienda → 5 pallet, 20 giorni | 73,20 € IVA inclusa; 300,00 € + IVA. Powyżej 60 dni dopisek „Oppure N rate mensili da circa …”. |
| B4 | „Richiedi la prenotazione” w kalkulatorze | `/contatti` z zielonym „Prenotazione online in arrivo” i wiadomością wypełnioną wybranymi wartościami (do kroków 6–7 planu). Ręcznie zmieniony adres (np. `persone=9`, `box=<x>`) → zwykły formularz bez wypełnienia. |
| B5 | Menu „Servizi” w nagłówku (komputer: klik, Escape, klik obok; telefon: sekcja „Servizi” w menu) | 3 pozycje: Trasporto, Facchinaggio, Deposito. |
| B6 | `/trasporto`, `/facchinaggio`, `/deposito` | „A cosa serve”, „Cosa è incluso”, „Da cosa dipende il prezzo”, „Prezzi indicativi” z aktywnego cennika (netto i z IVA; facchinaggio i deposito z kalkulatorem), FAQ, „Altri servizi”. Trasporto: pojazdy i „Servizi aggiuntivi” (Facchini, Imballaggio). Usługa niedostępna w cenniku → „non è prenotabile online” + „Scrivici”, bez tabeli. |
| B7 | Źródło strony usługi | `application/ld+json` z `FAQPage`; w HTML nigdzie `carrier`, `share`, `overtime`. |
| B8 | `/servizi`, `/servizi/trasporto`, `/servizi/facchinaggio`, `/servizi/imballaggio`, `/servizi/deposito-merci`, `/servizi/cokolwiek` | 308 → `/#servizi`, `/trasporto`, `/facchinaggio`, `/trasporto#imballaggio`, `/deposito`, `/#servizi`. |
| B9 | Telefon (375 px) | Bez przewijania strony w bok; tabele cen przewijają się w swojej ramce. |

## C. Come funziona, FAQ, Diventa partner, Cookie

| # | Krok | Oczekiwany wynik |
|---|---|---|
| C1 | `/come-funziona` | 6 kroków klienta (granat), 6 kroków przewoźnika (zieleń), przycisk „Diventa partner”. |
| C2 | `/domande-frequenti` | 4 grupy z linkami u góry (kotwice działają), pytania rozwijane, „Scrivici” na dole. W źródle strony `"@type":"FAQPage"`. |
| C3 | `/diventa-partner` | Zielony nagłówek, „Registrati come partner” → `/registrati?tipo=padroncino`; dokumenty jak w onboardingu (Polizza RC vettoriale „se disponibile”, **bez** dokumentu tożsamości). |
| C4 | Okno prywatne, dowolna strona | Na dole baner „Usiamo solo cookie tecnici…” z linkiem do Cookie policy i „Ok”. Po „Ok” baner znika i nie wraca po przejściu na inne strony ani po odświeżeniu. |
| C5 | `/cookie` | Tabela: `sb-…-auth-token`, `transigo.booking.v1`, `transigo.cookie-notice.v1`. |
| C6 | `/robots.txt`, `/sitemap.xml`, źródło dowolnej strony | Bez `SITE_INDEXING=on`: `Disallow: /`, pusta mapa, `<meta name="robots" content="noindex, nofollow">` (D126). |

## D. Formularz `/contatti` (lokalnie)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| D1 | „Invia messaggio” bez wypełniania | Błędy przy imieniu, e-mailu, wiadomości (min. 10 znaków) i zgodzie. |
| D2 | Wypełnij poprawnie, bez zgody | Tylko błąd zgody; wpisane wartości zostają. |
| D3 | Wypełnij poprawnie ze zgodą | „Messaggio inviato”. |
| D4 | Sprawdź bazę i outbox: `docker exec -i supabase_db_TransiGo psql -U postgres -d postgres -c "select kind, status, name, length(ip_hash), privacy_version from contact_requests order by created_at desc limit 1;" -c "select subject, text_body from email_outbox where template_code='contact_request' order by created_at desc limit 1;"` | Wiersz `general` / `new`, `ip_hash` 64 znaki (samego IP nie ma), wersja Privacy. Mail „Nuova richiesta di contatto” **bez** imienia, e-maila i treści — tylko link do `/admin/richieste/…`. |
| D5 | Wyślij jeszcze 5 razy w ciągu godziny | Szóste zgłoszenie: „Hai inviato troppe richieste. Riprova più tardi.” (limit 5/h, 20/dobę na IP). |

## E. „Zona non servita” w kreatorze (lokalnie)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| E1 | `/prenota`: odbiór „Via del Corso 100, Roma”, dostawa „Via Toledo 100, Napoli” → „Avanti” | „Al momento non serviamo questa zona…” i pod spodem ramka „Lasciaci una richiesta” z formularzem. |
| E2 | Zmień adres odbioru | Ramka znika (pojawi się znowu po „Avanti”, jeśli zona dalej poza obszarem). |
| E3 | Wypełnij i wyślij | „Messaggio inviato”. W bazie wiersz `out_of_area` z `Roma`/`RM`, `Napoli`/`NA`, dystansem w km — **bez ulic**. |
| E4 | Odbiór w Mediolanie, dostawa daleko (np. Palermo) → „Avanti” | „Il percorso supera la distanza massima di … km” + ta sama ramka. |

## F. `/admin/richieste` (lokalnie, konto admina z seeda)

| # | Krok | Oczekiwany wynik |
|---|---|---|
| F1 | Menu admina → „Richieste” | Zakładka „Nuove” z zapytaniami z D i E (data, typ „Contatti” / „Zona non servita” z prowincją, nadawca, początek wiadomości). |
| F2 | Otwórz zapytanie | Imię, e-mail (link „mailto” z tematem), telefon, wiadomość; dla `out_of_area` trasa i dystans; data zgody i wersja Privacy. |
| F3 | „Segna come gestita” | „Richiesta segnata come gestita.”; stan „Gestita” z datą i e-mailem admina; zapytanie w zakładce „Gestite”. |
| F4 | „Riapri” | Wraca do „Nuove”. W `audit_log` wpisy `contact_request.handled` / `.reopened` tylko z ID i statusem. |
| F5 | Zaloguj się jako cliente / padroncino i otwórz `/admin/richieste` | Przekierowanie, brak dostępu. |
| F6 | `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/purge-contact-requests` | `{"deleted":0,"ipHashesCleared":0}` (świeże dane nie są usuwane). Bez nagłówka: 401. |
