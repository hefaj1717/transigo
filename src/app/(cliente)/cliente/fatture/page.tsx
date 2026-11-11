import { Suspense } from "react";
import Link from "next/link";
import { Card, CustomerShell } from "@/components/cliente/customer-shell";
import { CUSTOMER_DOC_COLUMNS, InvoiceList, type CustomerDoc } from "@/components/cliente/invoice-list";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { groupDocuments } from "@/lib/einvoice/view";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Le mie fatture – Transigo" };

// "Fatture" (spec 7, D144–D148): the customer's invoices and credit notes, read with the customer's session (RLS:
// own documents, without the technical columns).
export default function Page() {
  return (
    <CustomerShell title="Le mie fatture" subtitle="La fattura viene emessa dopo il pagamento; un rimborso genera una nota di credito.">
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </CustomerShell>
  );
}

async function Content() {
  const ctx = await requireArea("cliente", "/cliente/fatture");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select(`${CUSTOMER_DOC_COLUMNS}, orders(order_number)`)
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<CustomerDoc[]>();
  if (error) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">Non è stato possibile caricare le fatture. Riprova.</p>;
  const groups = groupDocuments(data ?? []);
  const demo = (data ?? []).some((d) => d.is_demo);
  return (
    <div className="space-y-4">
      {demo ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">Ambiente di prova: i documenti DEMO non hanno valore fiscale e non sono trasmessi allo SDI.</p>
      ) : null}
      <Card>
        {groups.length ? (
          <InvoiceList groups={groups} business={ctx.customerType === "business"} showOrder />
        ) : (
          <p className="text-sm text-zinc-600">Non hai ancora fatture. <Link href="/cliente" className="font-medium underline">Vai ai tuoi ordini</Link></p>
        )}
      </Card>
    </div>
  );
}
