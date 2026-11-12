// Static texts of the public site (Italian UI). Kept in one place so the home page, the service pages and the
// FAQ page (Stage 2c, steps 2–3) show the same wording. Draft texts — the owner reviews them.

/** Header links after the "Servizi" menu (SERVICES). */
export const NAV_LINKS = [
  { href: "/come-funziona", label: "Come funziona" },
  { href: "/domande-frequenti", label: "FAQ" },
  { href: "/contatti", label: "Contatti" },
] as const;

export const LEGAL_LINKS = [
  { href: "/termini", label: "Termini e condizioni" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cookie", label: "Cookie policy" },
] as const;

/** The three equal services (D151, D158). Imballaggio is an extra of the transport. */
export type ServiceCode = "trasporto" | "facchinaggio" | "deposito";

export const SERVICES: { code: ServiceCode; href: `/${ServiceCode}`; title: string; tab: string; summary: string }[] = [
  {
    code: "trasporto",
    href: "/trasporto",
    title: "Trasporto",
    tab: "Trasporto",
    summary: "Dal pacco al carico completo: scegli il veicolo giusto, dall'auto al camion con sponda idraulica. Facchini e imballaggio si aggiungono con un clic.",
  },
  {
    code: "facchinaggio",
    href: "/facchinaggio",
    title: "Facchinaggio",
    tab: "Facchini",
    summary: "Facchini a ore per salire e scendere le scale, caricare un furgone o spostare mobili in casa e in ufficio, anche senza trasporto.",
  },
  {
    code: "deposito",
    href: "/deposito",
    title: "Deposito",
    tab: "Deposito",
    summary: "Box per i privati e posti pallet per le aziende, per giorni o per mesi. Portaci la merce o la ritiriamo noi.",
  },
];

/** Home page "Per privati" / "Per aziende" (D151). */
export const AUDIENCES = [
  {
    title: "Per privati",
    lead: "Trasloco, mobili nuovi, un box mentre ristrutturi casa.",
    points: [
      "Trasloco completo: trasporto, facchini e deposito nella stessa prenotazione",
      "Facchini a ore anche senza trasporto, per scale e mobili pesanti",
      "Box in magazzino per giorni o mesi, con un unico pagamento alla prenotazione",
      "Prezzi IVA inclusa, fattura elettronica anche ai privati",
    ],
  },
  {
    title: "Per aziende",
    lead: "Consegne B2B, pallet e spazio di magazzino quando serve.",
    points: [
      "Trasporto di pallet e merci con il veicolo adatto, anche con sponda idraulica",
      "Transbordo in magazzino tra ritiro e consegna",
      "Stoccaggio di pallet a breve e lungo termine, prezzo per pallet al giorno",
      "Prezzi IVA esclusa e fattura elettronica su SDI",
    ],
  },
] as const;

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

/** Service pages (/trasporto, /facchinaggio, /deposito). Draft texts — the owner reviews them. */
export type ServicePageText = {
  title: string;
  metaTitle: string;
  metaDescription: string;
  lead: string;
  /** "A cosa serve": typical uses. */
  uses: { title: string; text: string }[];
  includes: string[];
  /** What the price depends on (shown next to the indicative price table). */
  pricing: string[];
  faqs: { q: string; a: string }[];
};

export const SERVICE_PAGES: Record<ServiceCode, ServicePageText> = {
  trasporto: {
    title: "Trasporto",
    metaTitle: "Trasporto di mobili, oggetti e pallet con prezzo online – Transigo",
    metaDescription: "Trasporto di oggetti, mobili e merci con prezzo online. Scegli il veicolo, aggiungi facchini e imballaggio, prenota e paga in pochi minuti.",
    lead: "Dal singolo oggetto al carico completo. Inserisci il percorso, scegli il veicolo e conosci subito il prezzo.",
    uses: [
      { title: "Mobili e acquisti", text: "Un divano, un armadio, gli acquisti di un negozio o di un mercatino." },
      { title: "Trasloco", text: "Furgone e facchini insieme, con imballaggio e, se serve, una sosta in magazzino." },
      { title: "Merci e pallet", text: "Consegne tra aziende, pallet e colli con il veicolo adatto al carico." },
    ],
    includes: [
      "Ritiro e consegna agli indirizzi indicati, in una fascia oraria di 2 ore",
      "Il veicolo adatto al carico: lo consigliamo noi in base a peso, misure e pallet",
      "Facchini e imballaggio da aggiungere nella stessa prenotazione",
      "Trasportatore professionista con partita IVA, verificato da noi",
      "Conferma di consegna con firma e foto",
    ],
    pricing: [
      "Distanza del percorso e veicolo scelto (con un prezzo minimo per veicolo)",
      "Supplemento per ritiro urgente, nel weekend o nei giorni festivi, calcolato in automatico",
      "Supplemento per ogni piano senza ascensore, al ritiro e alla consegna",
      "Facchini e imballaggio, se li aggiungi",
    ],
    faqs: [
      { q: "Quale veicolo devo scegliere?", a: "Indica peso, misure dell'oggetto più grande e numero di pallet: ti mostriamo solo i veicoli adatti e ti consigliamo il più piccolo che basta." },
      { q: "L'autista aiuta a caricare?", a: "Il trasporto comprende la guida. Per caricare e scaricare aggiungi i facchini nella prenotazione: scegli la dimensione del carico e le ore sono incluse nel prezzo." },
      { q: "Posso far imballare gli oggetti?", a: "Sì, l'imballaggio si aggiunge alla prenotazione del trasporto ed è eseguito al ritiro, prima del carico." },
      { q: "Posso lasciare la merce in magazzino prima della consegna?", a: "Sì: tra ritiro e consegna la merce può restare nel nostro magazzino, per un transbordo in giornata o per giorni e mesi." },
    ],
  },
  facchinaggio: {
    title: "Facchinaggio",
    metaTitle: "Facchinaggio a ore con prezzo online – Transigo",
    metaDescription: "Facchini a ore per salire e scendere le scale, caricare e scaricare, spostare mobili in casa o in ufficio. Prezzo indicativo online.",
    lead: "Facchini a ore, anche senza trasporto: per le scale senza ascensore, per caricare il furgone che hai noleggiato o per spostare mobili da una stanza all'altra.",
    uses: [
      { title: "Salita e discesa ai piani", text: "Mobili ed elettrodomestici su e giù per le scale, anche senza ascensore." },
      { title: "Carico e scarico", text: "Per un furgone noleggiato, un container o un camion in arrivo." },
      { title: "Spostamenti interni", text: "Riorganizzare casa, ufficio o magazzino senza fatica." },
    ],
    includes: [
      "Squadra da 2 a 4 facchini, a tua scelta",
      "Ore di lavoro indicate da te, con un minimo per persona",
      "Facchini professionisti, verificati da noi",
      "Prezzo chiaro prima del pagamento",
    ],
    pricing: [
      "Numero di facchini × ore di lavoro (con un minimo di ore)",
      "Supplemento per ogni piano senza ascensore",
      "Supplemento per lavori urgenti, nel weekend o nei giorni festivi",
    ],
    faqs: [
      { q: "Quanti facchini mi servono?", a: "Per la maggior parte dei lavori ne bastano 2. Per mobili molto pesanti, molti piani senza ascensore o tempi stretti puoi sceglierne fino a 4." },
      { q: "Cosa succede se il lavoro dura di più?", a: "Ogni ora successiva iniziata è addebitata a persona, dopo una breve tolleranza. La tariffa è indicata nel preventivo." },
      { q: "Cosa devo indicare nella prenotazione?", a: "Indirizzo, piano e ascensore, gli oggetti da spostare e le ore stimate. Se serve smontare mobili o un attrezzo particolare, scrivilo nella descrizione." },
      { q: "Posso prenotare facchini e trasporto insieme?", a: "Sì: nella prenotazione del trasporto aggiungi i facchini. Il facchinaggio da solo è pensato per i lavori senza un nostro veicolo." },
    ],
  },
  deposito: {
    title: "Deposito",
    metaTitle: "Deposito per privati e aziende: box e pallet – Transigo",
    metaDescription: "Box in magazzino per i privati e stoccaggio di pallet per le aziende, per giorni o mesi. Ritiro e consegna con i nostri trasportatori.",
    lead: "Spazio nel nostro magazzino per il tempo che ti serve: un box per i tuoi mobili durante un trasloco o una ristrutturazione, posti pallet per la tua azienda.",
    uses: [
      { title: "Box per privati", text: "Mobili e scatoloni al sicuro durante un trasloco o i lavori in casa." },
      { title: "Pallet per aziende", text: "Stoccaggio di merce pallettizzata a breve o lungo termine." },
      { title: "Transbordo", text: "Una sosta in magazzino tra ritiro e consegna, anche in giornata." },
    ],
    includes: [
      "Periodo fisso con data di inizio e di fine; per prolungarlo basta scriverci",
      "Porti tu la merce o la ritiriamo noi; alla fine la ritiri tu o la consegniamo noi",
      "Paghi tutto alla prenotazione, con carta, e ricevi la fattura elettronica",
    ],
    pricing: [
      "Privati: dimensione del box e durata (mesi interi più i giorni restanti)",
      "Aziende: numero di pallet × giorni, con tariffa ridotta per il lungo periodo",
      "Trasporto da e per il magazzino, se lo scegli",
    ],
    faqs: [
      { q: "Che box mi serve?", a: "Per ogni box indichiamo il volume in metri cubi. Se non sei sicuro, scegli quello più grande o scrivici: ti aiutiamo a valutare." },
      { q: "Posso prolungare il deposito?", a: "Sì, se il box o i posti pallet sono liberi anche nel nuovo periodo. Scrivici prima della data di fine indicando il numero dell'ordine: paghi solo i giorni in più." },
      { q: "Come si paga il deposito?", a: "Paghi l'intero periodo alla prenotazione, con carta. Ricevi la fattura elettronica subito dopo il pagamento." },
      { q: "Posso decidere dopo dove consegnare la merce?", a: "Sì: prenoti il deposito e quando sai dove consegnare la merce scrivici: organizziamo il trasporto, pagato a parte." },
    ],
  },
};
