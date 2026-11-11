import Link from "next/link";
import { ActionForm } from "@/components/admin/action-form";
import { retryInvoiceAction } from "@/app/(admin)/admin/fatture/actions";
import { ADMIN_DOC_STATUS, canDownload, DOC_KIND_LABEL, errorLabel, INVOICE_PDF_PATH, SDI_STATUS_LABEL, type DocRow } from "@/lib/einvoice/view";
import { ADMIN_ORDER_PATHS } from "@/lib/orders/dispatch";
import { formatCents } from "@/lib/pricing/money";

// Admin table of invoices / credit notes (D144–D148): state, SDI, attempts and the error CODE (from
// admin_invoice_errors(), session), "Scarica PDF" (60 s signed URL at the click) and "Riprova" for documents not issued.

export type AdminDoc = DocRow & { orders?: { order_number: string } | null };
export type DocTech = { invoice_id: string; attempts: number; last_error_code: string | null; last_attempt_at: string | null };

const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");

export function AdminInvoiceTable({ docs, tech, showOrder }: { docs: AdminDoc[]; tech: Map<string, DocTech>; showOrder: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="py-2 pr-3 font-medium">Documento</th>
            {showOrder ? <th className="py-2 pr-3 font-medium">Ordine</th> : null}
            <th className="py-2 pr-3 font-medium">Stato</th>
            <th className="py-2 pr-3 text-right font-medium">Totale</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const t = tech.get(d.id);
            return (
              <tr key={d.id} className="border-t border-zinc-100 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium text-zinc-900">
                    {DOC_KIND_LABEL[d.kind]} {d.number ?? <span className="text-zinc-400">senza numero</span>}
                    {d.is_demo ? <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700">DEMO</span> : null}
                  </div>
                  <div className="text-xs text-zinc-500">{d.status === "issued" ? `emessa ${rome(d.issued_at)}` : `creata ${rome(d.created_at)}`}</div>
                </td>
                {showOrder ? (
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <Link href={ADMIN_ORDER_PATHS.detail(d.order_id)} className="text-blue-700 hover:underline">{d.orders?.order_number ?? "ordine"}</Link>
                  </td>
                ) : null}
                <td className="py-2 pr-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${d.status === "issued" ? "bg-green-50 text-green-800" : d.status === "failed" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}>
                    {ADMIN_DOC_STATUS[d.status]}
                  </span>
                  {d.sdi_status ? <div className="mt-1 text-xs text-zinc-500">{SDI_STATUS_LABEL[d.sdi_status]}</div> : null}
                  {t && d.status !== "issued" ? (
                    <div className="mt-1 text-xs text-zinc-600">
                      tentativi: {t.attempts}{t.last_attempt_at ? ` · ultimo ${rome(t.last_attempt_at)}` : ""}
                      {t.last_error_code ? <> · <span className="text-red-700">{errorLabel(t.last_error_code)}</span></> : null}
                    </div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right whitespace-nowrap">
                  {d.kind === "credit_note" ? "−" : ""}{formatCents(d.total_cents)}
                  <div className="text-xs text-zinc-500">IVA {formatCents(d.vat_cents)}</div>
                </td>
                <td className="py-2">
                  {canDownload(d) ? <a href={INVOICE_PDF_PATH(d.id)} className="text-blue-700 hover:underline">Scarica PDF</a> : null}
                  {d.status !== "issued" ? (
                    <ActionForm action={retryInvoiceAction} submitLabel="Riprova" variant="secondary">
                      <input type="hidden" name="invoiceId" value={d.id} />
                    </ActionForm>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const ADMIN_DOC_COLUMNS = "id, kind, order_id, invoice_id, refund_id, status, sdi_status, number, issued_at, is_demo, net_cents, vat_cents, total_cents, pdf_path, created_at";
