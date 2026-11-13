# Plan: osobna pomoc przy załadunku i rozładunku (B1, uwaga właściciela 2026-11-13)

Status: **zatwierdzony 2026-11-13** (D182). Godziny 1–4 na stronę, domyślnie 1 h.

## Cel

W kreatorze Trasporto, w kroku „Percorso”, zamiast jednego „Aiuto per carico e scarico” (0–4 osoby, 1 h w cenie
na całość) są dwie osobne opcje:

- **Aiuto al carico** (przy odbiorze) — liczba osób 1–4 i liczba godzin,
- **Aiuto allo scarico** (przy dostawie) — liczba osób 1–4 i liczba godzin.

Każdą zaznacza się osobno, np. załadunek 1 osoba × 1 h, rozładunek 2 osoby × 2 h.

## Cena

- Ta sama stawka dla obu stron: reguła `porter_hour` z cennika (za osobę i godzinę).
- Załadunek = osoby × godziny × `porter_hour`. Rozładunek liczony tak samo, osobno.
- W wycenie dwie pozycje: „Aiuto al carico: 1 persona × 1 h” i „Aiuto allo scarico: 2 persone × 2 h”.
- Udział przewoźnika: ta sama reguła co dziś dla tragarzy (`carrier_share_porters`).
- Nadgodziny osobno dla każdej strony: czas tej strony > godziny w cenie + tolerancja → stawka
  `porter_overtime_hour` za każdą rozpoczętą godzinę na osobę (jak dziś, tylko per strona).

## Baza (migracja — tylko za zgodą)

`order_legs`, nowe kolumny (snapshot, niezmienne jak reszta zlecenia):

| kolumna | typ | znaczenie |
|---|---|---|
| `loading_porters` | smallint 0–4 | osoby przy załadunku (0 = bez pomocy) |
| `loading_hours` | smallint 1–4, null gdy 0 osób | godziny w cenie przy załadunku |
| `unloading_porters` | smallint 0–4 | osoby przy rozładunku |
| `unloading_hours` | smallint 1–4, null gdy 0 osób | godziny w cenie przy rozładunku |
| `loading_worked_minutes`, `unloading_worked_minutes` | integer | zmierzony czas (zapisuje tylko baza przy dostawie) |

- Stare kolumny (`porter_package_code`, `porters_count`, `porters_included_hours`, `porters_worked_minutes`) zostają
  dla zleceń już złożonych; nowe zlecenia transportowe używają tylko nowych kolumn (CHECK: albo stary, albo nowy
  zapis, nigdy oba).
- `create_transport_order` zapisuje nowe kolumny z payloadu.
- `order_porters_worked_minutes`: dziś sumuje (załadowano − przyjazd na odbiór) + (rozładowano − przyjazd na
  dostawę); po zmianie zwraca oba czasy osobno.
- Lista kursów i przyjęcie kursu: przewoźnik musi zapewnić `max(loading_porters, unloading_porters)` osób (dziś:
  `porters_count`).
- Testy RLS: zapis tylko przez funkcję, klient czyta swoje, przewoźnik przypisane, czas liczy tylko baza.

## Aplikacja

1. **Silnik cenowy** (bez bazy, testy): `PriceInput.porters` → `{ legIndex, side: "loading" | "unloading",
   persons, hours }`; `QuotePorters` per strona.
2. **Migracja** + testy RLS (lokalnie; staging po Twojej zgodzie).
3. **Kreator Trasporto**: dwa pola wyboru w „Percorso”, po zaznaczeniu osoby (1–4) i godziny (1–4); payload, wycena
   na serwerze, podsumowanie w „Preventivo” i „Riepilogo”.
4. **Widoki**: klient, admin, PWA przewoźnika (karta kursu, „Le mie corse”), czas pracy per strona, nadgodziny.
5. **Seed demo** z przykładem 1 × 1 h / 2 × 2 h + test ręczny.

## Poza zakresem

- Facchinaggio jako osobna usługa (kreator Facchini) — bez zmian.
- Zlecenia już złożone — bez zmian (stary zapis).
