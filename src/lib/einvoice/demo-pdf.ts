// PDF of a DEMO document (pdf-lib). Every page carries the watermark "DEMO — documento senza valore fiscale".
// Standard Helvetica (WinAnsi): Italian letters and € are fine; any other character is replaced with "?".
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatBp, formatCents } from "../pricing/money";
import type { CreditNoteDocument, InvoiceDocument } from "./document";

export const DEMO_WATERMARK = "DEMO — documento senza valore fiscale";

const A4: [number, number] = [595.28, 841.89];
const M = 48; // margin
const GREY = rgb(0.4, 0.4, 0.4);

const dateIt = (d: Date) => new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);

/** Keeps only characters the standard font can encode. */
function safe(font: PDFFont, text: string): string {
  let out = "";
  const mapped = text.normalize("NFC").replace(/[\r\n\t]+/g, " ").replace(/[→⟶➔]/g, "-").replace(/[✓✔]/g, "");
  for (const ch of mapped) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

/** Cuts the text to `width` with "…" (descriptions are single-line). */
function fit(font: PDFFont, text: string, size: number, width: number): string {
  let t = safe(font, text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

export async function renderDemoPdf(doc: InvoiceDocument | CreditNoteDocument, number: string, issuedAt: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const title = doc.kind === "invoice" ? "Fattura" : "Nota di credito";
  pdf.setTitle(`${title} ${number} (DEMO)`);
  pdf.setProducer("Transigo DEMO");
  pdf.setCreator("Transigo");

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const text = (s: string, x: number, size = 9, f = font, color = rgb(0, 0, 0)) => page.drawText(safe(f, s), { x, y, size, font: f, color });
  const right = (s: string, xRight: number, size = 9, f = font) => {
    const t = safe(f, s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f });
  };
  const newPage = () => {
    page = pdf.addPage(A4);
    pages.push(page);
    y = A4[1] - M;
  };

  newPage();
  // Header: seller | document
  text(doc.seller.name, M, 13, bold);
  text(`${title} n. ${number}`, 330, 13, bold);
  y -= 16;
  const sellerLines = [
    doc.seller.registeredOffice ?? "Sede legale: —",
    `P.IVA: ${doc.seller.vatNumber ?? "—"}`,
    ...(doc.seller.pec ? [`PEC: ${doc.seller.pec}`] : []),
    ...(doc.seller.email ? [`E-mail: ${doc.seller.email}`] : []),
  ];
  const docLines = [
    `Data: ${dateIt(issuedAt)}`,
    `Ordine: ${doc.orderNumber}`,
    ...(doc.kind === "credit_note" ? [`Rif. fattura n. ${doc.original.number} del ${dateIt(doc.original.issuedAt)}`] : []),
  ];
  for (let i = 0; i < Math.max(sellerLines.length, docLines.length); i++) {
    if (sellerLines[i]) text(sellerLines[i], M);
    if (docLines[i]) text(docLines[i], 330);
    y -= 12;
  }

  // Buyer
  y -= 14;
  text("Cliente", M, 10, bold);
  y -= 13;
  const b = doc.buyer;
  for (const l of [
    b.name,
    b.address,
    b.vatNumber ? `P.IVA: ${b.vatNumber}` : null,
    b.fiscalCode ? `Codice fiscale: ${b.fiscalCode}` : null,
    b.customerType === "business" ? (b.sdiCode ? `Codice destinatario SDI: ${b.sdiCode}` : null) : null,
    b.customerType === "business" && b.pec ? `PEC: ${b.pec}` : null,
  ]) {
    if (!l) continue;
    text(l, M);
    y -= 12;
  }

  // Lines
  // right edges of the number columns
  const COL = { desc: M, qty: 330, net: 400, vat: 475, gross: A4[0] - M };
  const header = () => {
    y -= 14;
    text("Descrizione", COL.desc, 9, bold);
    right("Q.tà", COL.qty, 9, bold);
    right("Imponibile", COL.net, 9, bold);
    right(`IVA ${formatBp(doc.vatRateBp)}%`, COL.vat, 9, bold);
    right("Totale", COL.gross, 9, bold);
    y -= 5;
    page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: GREY });
    y -= 12;
  };
  header();
  for (const l of doc.lines) {
    if (y < M + 120) {
      newPage();
      header();
    }
    page.drawText(fit(font, l.description, 9, COL.qty - COL.desc - 40), { x: COL.desc, y, size: 9, font });
    right(String(l.quantity), COL.qty);
    right(formatCents(l.netCents), COL.net);
    right(formatCents(l.vatCents), COL.vat);
    right(formatCents(l.grossCents), COL.gross);
    y -= 13;
  }

  // Totals
  if (y < M + 90) newPage();
  y -= 6;
  page.drawLine({ start: { x: 330, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: GREY });
  y -= 14;
  for (const [label, cents, f] of [
    ["Imponibile", doc.netCents, font],
    [`IVA ${formatBp(doc.vatRateBp)}%`, doc.vatCents, font],
    [doc.kind === "invoice" ? "Totale documento" : "Totale da stornare", doc.totalCents, bold],
  ] as const) {
    text(label, 330, 10, f);
    right(formatCents(cents), COL.gross, 10, f);
    y -= 14;
  }
  y -= 8;
  if (doc.kind === "invoice") {
    text(`Pagato con carta (Stripe) il ${dateIt(doc.payment.paidAt)}.`, M, 9, font, GREY);
  } else {
    text(`Importo rimborsato sulla carta di pagamento${doc.refundedAt ? ` il ${dateIt(doc.refundedAt)}` : ""}.`, M, 9, font, GREY);
  }

  // Watermark and footer on every page
  pages.forEach((p, i) => {
    const size = 28;
    const w = bold.widthOfTextAtSize(safe(bold, DEMO_WATERMARK), size);
    p.drawText(safe(bold, DEMO_WATERMARK), {
      x: A4[0] / 2 - (w / 2) * Math.cos(Math.PI / 5),
      y: A4[1] / 2 - (w / 2) * Math.sin(Math.PI / 5),
      size, font: bold, color: rgb(0.85, 0.1, 0.1), opacity: 0.18, rotate: degrees(36),
    });
    p.drawText(safe(font, `${DEMO_WATERMARK} · non trasmesso allo SDI · pagina ${i + 1} di ${pages.length}`), { x: M, y: 24, size: 8, font, color: rgb(0.75, 0.1, 0.1) });
  });

  return pdf.save();
}
