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

export type Faq = { q: string; a: string };

export const FAQS: Faq[] = [
  {
    q: "Come viene calcolato il prezzo?",
    a: "In base alla distanza del percorso, al veicolo scelto e ai servizi aggiunti (facchinaggio, imballaggio, deposito). Eventuali supplementi per urgenza, weekend o festivi sono calcolati automaticamente e mostrati prima del pagamento.",
  },
  {
    q: "Devo registrarmi per vedere il prezzo?",
    a: "No: il preventivo è gratuito e senza registrazione. L'account serve solo per confermare e pagare la prenotazione.",
  },
  {
    q: "Quando pago?",
    a: "Al momento della prenotazione, con carta, tramite un pagamento sicuro. La prenotazione è confermata quando il pagamento è andato a buon fine.",
  },
  {
    q: "Ricevo la fattura?",
    a: "Sì, emettiamo fattura elettronica per ogni ordine, sia ai privati sia alle aziende.",
  },
  {
    q: "Chi esegue il trasporto?",
    a: "Trasportatori professionisti con partita IVA, verificati da noi: documenti, assicurazione e veicolo.",
  },
  {
    q: "Posso annullare la prenotazione?",
    a: "Sì, dalla pagina dell'ordine. Le eventuali spese di annullamento dipendono da quanto manca al ritiro e sono indicate prima della conferma.",
  },
  {
    q: "In quali zone siete attivi?",
    a: "Il ritiro deve trovarsi in una delle province servite. Inserisci gli indirizzi: se la zona non è ancora coperta, puoi lasciarci una richiesta e ti ricontattiamo.",
  },
  {
    q: "Sono un trasportatore: come posso lavorare con voi?",
    a: "Registrati come partner con la tua partita IVA, carica i documenti e il veicolo. Dopo la verifica ricevi le corse disponibili nell'app e vieni pagato dopo ogni consegna.",
  },
];

/** Questions also shown on the home page. */
export const HOME_FAQ_COUNT = 4;
