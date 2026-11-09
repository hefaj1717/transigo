// Static texts of the public site (Italian UI). Kept in one place so the home page, the service pages and the
// FAQ page (Stage 2c, steps 2–3) show the same wording. Draft texts — the owner reviews them.

export const NAV_LINKS = [
  { href: "/servizi", label: "Servizi" },
  { href: "/come-funziona", label: "Come funziona" },
  { href: "/domande-frequenti", label: "FAQ" },
  { href: "/contatti", label: "Contatti" },
] as const;

export const LEGAL_LINKS = [
  { href: "/termini", label: "Termini e condizioni" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cookie", label: "Cookie policy" },
] as const;

export type ServiceCode = "trasporto" | "facchinaggio" | "imballaggio" | "deposito-merci";

export const SERVICES: { code: ServiceCode; title: string; summary: string }[] = [
  {
    code: "trasporto",
    title: "Trasporto",
    summary: "Dal pacco al carico completo: scegli il veicolo giusto, dall'auto al camion con sponda idraulica.",
  },
  {
    code: "facchinaggio",
    title: "Facchinaggio",
    summary: "Facchini per caricare e scaricare, anche ai piani senza ascensore. Ore incluse già nel prezzo.",
  },
  {
    code: "imballaggio",
    title: "Imballaggio",
    summary: "Imballiamo i tuoi oggetti prima del ritiro, così arrivano a destinazione come sono partiti.",
  },
  {
    code: "deposito-merci",
    title: "Deposito merci",
    // D117: only transshipment and short-term storage are offered for now.
    summary: "Transbordo o deposito a breve termine nel nostro magazzino, tra il ritiro e la consegna.",
  },
];

export const HOW_IT_WORKS = [
  {
    title: "Calcola il prezzo",
    text: "Inserisci ritiro, consegna e data. Il prezzo si aggiorna in tempo reale mentre scegli veicolo e servizi.",
  },
  {
    title: "Prenota e paga online",
    text: "Paghi con carta al momento della prenotazione. Ricevi la conferma e la fattura elettronica.",
  },
  {
    title: "Segui la consegna",
    text: "Un trasportatore verificato esegue il servizio. La consegna è confermata con firma e foto.",
  },
];

export type FaqGroup = "prenotazione" | "pagamento" | "servizio" | "trasportatori";

export const FAQ_GROUPS: { code: FaqGroup; title: string }[] = [
  { code: "prenotazione", title: "Prenotazione e prezzi" },
  { code: "pagamento", title: "Pagamento e fatture" },
  { code: "servizio", title: "Il servizio" },
  { code: "trasportatori", title: "Per i trasportatori" },
];

/** `home`: also shown on the home page. */
export type Faq = { q: string; a: string; group: FaqGroup; home?: boolean };

export const FAQS: Faq[] = [
  {
    group: "prenotazione",
    home: true,
    q: "Come viene calcolato il prezzo?",
    a: "In base alla distanza del percorso, al veicolo scelto e ai servizi aggiunti (facchinaggio, imballaggio, deposito). Eventuali supplementi per urgenza, weekend, festivi o piani senza ascensore sono calcolati automaticamente e mostrati prima del pagamento.",
  },
  {
    group: "prenotazione",
    home: true,
    q: "Devo registrarmi per vedere il prezzo?",
    a: "No: il preventivo è gratuito e senza registrazione. L'account serve solo per confermare e pagare la prenotazione.",
  },
  {
    group: "prenotazione",
    q: "In quali zone siete attivi?",
    a: "Il ritiro deve trovarsi in una delle province servite. Inserisci gli indirizzi: se la zona non è ancora coperta, puoi lasciarci una richiesta e ti ricontattiamo.",
  },
  {
    group: "prenotazione",
    q: "Con quanto anticipo devo prenotare?",
    a: "Puoi prenotare anche per lo stesso giorno, rispettando l'anticipo minimo indicato nella prenotazione. Per i ritiri con poco preavviso si applica un supplemento di urgenza, mostrato nel preventivo.",
  },
  {
    group: "prenotazione",
    q: "Posso annullare la prenotazione?",
    a: "Sì, dalla pagina dell'ordine. Le eventuali spese di annullamento dipendono da quanto manca al ritiro e sono indicate prima della conferma.",
  },
  {
    group: "pagamento",
    home: true,
    q: "Quando pago?",
    a: "Al momento della prenotazione, con carta, tramite un pagamento sicuro. La prenotazione è confermata quando il pagamento è andato a buon fine.",
  },
  {
    group: "pagamento",
    home: true,
    q: "Ricevo la fattura?",
    a: "Sì, emettiamo fattura elettronica per ogni ordine, sia ai privati sia alle aziende.",
  },
  {
    group: "pagamento",
    q: "I prezzi includono l'IVA?",
    a: "Per i privati i prezzi sono mostrati IVA inclusa. Per le aziende vedi l'importo netto, l'IVA e il totale.",
  },
  {
    group: "servizio",
    q: "Chi esegue il trasporto?",
    a: "Trasportatori professionisti con partita IVA, verificati da noi: documenti, assicurazione e veicolo.",
  },
  {
    group: "servizio",
    q: "Posso seguire la consegna?",
    a: "Sì: nella pagina dell'ordine vedi lo stato aggiornato. Alla consegna il destinatario firma e il trasportatore scatta una foto, che trovi nell'ordine.",
  },
  {
    group: "servizio",
    q: "Cosa succede se c'è un problema con la consegna?",
    a: "Puoi aprire un reclamo dalla pagina dell'ordine, con una descrizione e delle foto. Il nostro team lo gestisce direttamente con il trasportatore.",
  },
  {
    group: "trasportatori",
    q: "Sono un trasportatore: come posso lavorare con voi?",
    a: "Registrati come partner con la tua partita IVA, inserisci i dati aziendali, il veicolo e i documenti. Dopo la verifica ricevi le corse disponibili nell'app.",
  },
  {
    group: "trasportatori",
    q: "Posso scegliere le corse?",
    a: "Sì. Per ogni corsa vedi le città di ritiro e consegna, la distanza, la data, il carico e il compenso per te, prima di accettarla.",
  },
  {
    group: "trasportatori",
    q: "Quando vengo pagato?",
    a: "Dopo ogni consegna confermata con firma e foto, quando hai caricato la tua fattura per Transigo: il pagamento parte in automatico sul tuo conto.",
  },
  {
    group: "trasportatori",
    q: "Devo installare un'app?",
    a: "No, l'app si apre dal browser del telefono e si può aggiungere alla schermata home, senza passare dagli store.",
  },
];

export const HOME_FAQS = FAQS.filter((f) => f.home);

/** "Come funziona" — customer side, in detail. */
export const CUSTOMER_STEPS = [
  { title: "Inserisci percorso e data", text: "Indirizzi di ritiro e consegna, piano e ascensore, giorno e fascia oraria di 2 ore." },
  { title: "Descrivi il carico e scegli il veicolo", text: "Peso, misure e pallet: ti consigliamo il veicolo adatto. Aggiungi facchini, imballaggio o deposito se ti servono." },
  { title: "Controlla il preventivo", text: "Vedi il prezzo completo, con tutti i supplementi, prima di registrarti. Privati IVA inclusa, aziende netto più IVA." },
  { title: "Crea l'account e paga", text: "Inserisci i contatti per ritiro e consegna e i dati per la fattura, poi paghi con carta in modo sicuro." },
  { title: "Un trasportatore verificato prende l'incarico", text: "Ricevi la conferma e segui lo stato dell'ordine dalla tua area personale." },
  { title: "Consegna con firma e foto", text: "Il destinatario firma alla consegna e il trasportatore scatta una foto. Ricevi la fattura elettronica." },
];

/** "Come funziona" / "Diventa partner" — carrier side. */
export const CARRIER_STEPS = [
  { title: "Registrati", text: "Crea l'account partner con la tua partita IVA." },
  { title: "Completa il profilo", text: "Dati aziendali, veicoli e documenti, caricati direttamente dal telefono." },
  { title: "Verifica", text: "Il nostro team controlla i documenti e attiva il tuo account." },
  { title: "Scegli le corse", text: "Vedi le corse disponibili con il compenso per te e accetti quelle che ti convengono." },
  { title: "Esegui la corsa", text: "Aggiorni lo stato dall'app; alla consegna raccogli firma e foto." },
  { title: "Vieni pagato", text: "Carichi la tua fattura per Transigo e il pagamento parte in automatico dopo ogni consegna." },
];

export const PARTNER_BENEFITS = [
  { title: "Scegli tu le corse", text: "Nessun obbligo: accetti solo le corse adatte al tuo veicolo e ai tuoi orari." },
  { title: "Compenso chiaro", text: "Vedi quanto guadagni prima di accettare, con il dettaglio per trasporto, facchinaggio e imballaggio." },
  { title: "Pagamento dopo ogni consegna", text: "Niente attese di fine mese: il pagamento parte dopo ogni consegna confermata." },
  { title: "Tutto dal telefono", text: "Corse, stati, foto e firma nell'app, senza installazioni dagli store." },
];

/** Service pages (/servizi/…). Draft texts — the owner reviews them. */
export type ServiceDetail = {
  title: string;
  metaDescription: string;
  lead: string;
  includes: string[];
  /** What the price depends on. */
  pricing: string[];
};

export const SERVICE_DETAILS: Record<ServiceCode, ServiceDetail> = {
  trasporto: {
    title: "Trasporto",
    metaDescription: "Trasporto di oggetti, mobili e merci con prezzo online. Scegli il veicolo, prenota e paga in pochi minuti.",
    lead: "Dal singolo oggetto al carico completo. Inserisci il percorso, scegli il veicolo e conosci subito il prezzo.",
    includes: [
      "Ritiro e consegna agli indirizzi indicati, in una fascia oraria di 2 ore",
      "Il veicolo adatto al carico: lo consigliamo noi in base a peso, misure e pallet",
      "Trasportatore professionista con partita IVA, verificato da noi",
      "Conferma di consegna con firma e foto",
    ],
    pricing: [
      "Distanza del percorso e veicolo scelto",
      "Supplemento per ritiro urgente, nel weekend o nei giorni festivi, calcolato in automatico",
      "Supplemento per ogni piano senza ascensore, al ritiro e alla consegna",
    ],
  },
  facchinaggio: {
    title: "Facchinaggio",
    metaDescription: "Facchini per carico e scarico, anche ai piani senza ascensore. Persone e ore incluse nel prezzo, prenotazione online.",
    lead: "Facchini che caricano e scaricano per te, anche ai piani senza ascensore. Scegli la dimensione del carico: persone e ore di lavoro sono già nel prezzo.",
    includes: [
      "Carico al ritiro e scarico alla consegna",
      "Numero di facchini adatto al carico, che puoi aumentare fino a 4",
      "Ore di lavoro incluse nel prezzo, indicate prima del pagamento",
      "L'autista non è conteggiato tra i facchini",
    ],
    pricing: [
      "Dimensione del carico (persone e ore incluse)",
      "Facchini aggiuntivi, se li scegli",
      "Se il lavoro dura più delle ore incluse, ogni ora successiva iniziata è addebitata a persona, dopo una breve tolleranza: la tariffa è indicata nel preventivo",
    ],
  },
  imballaggio: {
    title: "Imballaggio",
    metaDescription: "Servizio di imballaggio al ritiro: i tuoi oggetti protetti durante il trasporto. Si aggiunge con un clic alla prenotazione.",
    lead: "Imballiamo i tuoi oggetti al momento del ritiro, così arrivano a destinazione come sono partiti.",
    includes: [
      "Imballaggio eseguito al ritiro, prima del carico",
      "Si aggiunge con un clic durante la prenotazione",
      "Prezzo chiaro, indicato nel preventivo",
    ],
    pricing: ["Numero di colli da imballare"],
  },
  "deposito-merci": {
    title: "Deposito merci",
    metaDescription: "Transbordo e deposito a breve termine nel nostro magazzino tra il ritiro e la consegna. Prezzo online, pagamento anticipato.",
    lead: "Serve una sosta tra ritiro e consegna? Portiamo la merce nel nostro magazzino e la consegniamo nel giorno e nella fascia oraria che scegli tu.",
    includes: [
      "Transbordo: sosta breve in magazzino e consegna nello stesso giorno",
      "Deposito a breve termine tra il ritiro e la consegna", // + max days, added by the page (D117: short term only)
      "Ritiro, deposito e consegna in un unico ordine",
      "Deposito pagato in anticipo per il periodo scelto",
    ],
    pricing: ["Giorni di deposito", "Trasporto al magazzino e dal magazzino alla consegna"], // + billing unit, added by the page
  },
};
