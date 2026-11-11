import Link from "next/link";
import { formatCents } from "@/lib/pricing/money";
import { canDownload, CUSTOMER_DOC_STATUS, DOC_KIND_LABEL, INVOICE_PDF_PATH, type DocRow, type InvoiceGroup } from "@/lib/einvoice/view";

// Customer invoices with their credit notes (plan docs/plany/faktury.md, section 4). "Scarica PDF" goes to the route
// that creates a 60 s signed URL with the customer's session at the click (D148). Business customers see net + VAT
// (D3), private customers the total with VAT.

export type CustomerDoc = DocRow & { orders?: { order_number: string } | null };

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" }) : null);

function Amount({ d, business }: { d: DocRow; business: boolean }) {
  const sign = d.kind === "credit_note" ? "−" : "";
  return business ? (
    <span className="text-right">
      <span className="block font-semibold text-zinc-900">{sign}{formatCents(d.total_cents)}</span>
      <span className="block text-xs text-zinc-500">imponibile {formatCents(d.net_cents)} + IVA {formatCents(d.vat_cents)}</span>
    </span>
  ) : (
    <span className="text-right">
      <span className="block font-semibold text-zinc-900">{sign}{formatCents(d.total_cents)}</span>
      <span className="block text-xs text-zinc-500">IVA inclusa</span>
    </span>
  );
}

function DocLine({ d, business, showOrder, nested }: { d: CustomerDoc; business: boolean; showOrder: boolean; nested?: boolean }) {
  return (
    <li className={`flex flex-wrap items-start justify-between gap-3 py-3 ${nested ? "pl-4 border-l-2 border-zinc-200 ml-1" : ""}`}>
      <div className="min-w-0">
        <p className="font-medium text-zinc-900">
          {DOC_KIND_LABEL[d.kind]} {d.number ? <span className="whitespace-nowrap">n. {d.number}</span> : null}
          {d.is_demo ? <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700">DEMO</span> : null}
        </p>
        <p className="text-sm text-zinc-500">
          {d.status === "issued" ? `Emessa il ${date(d.issued_at)}` : CUSTOMER_DOC_STATUS[d.status]}
          {showOrder && d.orders ? <> · ordine <Link href={`/cliente/ordini/${d.order_id}`} className="underline">{d.orders.order_number}</Link></> : null}
        </p>
      </div>
      <div className="flex items-start gap-4">
        <Amount d={d} business={business} />
        {canDownload(d) ? (
          <a href={INVOICE_PDF_PATH(d.id)} className="whitespace-nowrap rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-brand-800 hover:bg-zinc-50">Scarica PDF</a>
        ) : null}
      </div>
    </li>
  );
}

export function InvoiceList({ groups, business, showOrder }: { groups: InvoiceGroup<CustomerDoc>[]; business: boolean; showOrder: boolean }) {
  return (
    <ul className="divide-y divide-zinc-100">
      {groups.map((g) => (
        <li key={g.invoice.id}>
          <ul>
            <DocLine d={g.invoice} business={business} showOrder={showOrder} />
            {g.notes.map((n) => <DocLine key={n.id} d={n} business={business} showOrder={false} nested />)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export const CUSTOMER_DOC_COLUMNS = "id, kind, order_id, invoice_id, refund_id, status, sdi_status, number, issued_at, is_demo, net_cents, vat_cents, total_cents, pdf_path, created_at";
