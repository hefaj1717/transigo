import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CustomerShell } from "@/components/cliente/customer-shell";
import { requireArea } from "@/lib/auth/session";
import { canOpenClaim, CLAIM_MSG, CLAIM_WINDOW_DAYS } from "@/lib/claims/claims";
import { createClient } from "@/lib/supabase/server";
import { ClaimForm } from "./claim-form";

export const metadata = { title: "Apri un reclamo – Transigo" };

// "Apri un reclamo" (D138) for a delivered order, within 14 days. Read with the customer's session; an open claim
// of this order → the claims page. The database checks everything again (open_claim).
export default function Page({ params }: PageProps<"/cliente/ordini/[id]/reclamo">) {
  return (
    <CustomerShell title="Apri un reclamo">
      <Content params={params} />
    </CustomerShell>
  );
}

async function Content({ params }: Pick<PageProps<"/cliente/ordini/[id]/reclamo">, "params">) {
  const { id } = await params;
  await requireArea("cliente", `/cliente/ordini/${id}/reclamo`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: o } = await supabase
    .from("orders")
    .select("id, order_number, status, delivered_at, claims(id, status)")
    .eq("id", id)
    .maybeSingle<{ id: string; order_number: string; status: string; delivered_at: string | null; claims: { id: string; status: string }[] }>();
  if (!o) notFound();
  if (o.claims.some((c) => c.status === "open")) redirect("/cliente/reclami");

  const back = <Link href={`/cliente/ordini/${o.id}`} className="font-medium text-brand-700 hover:text-brand-900">← Ordine {o.order_number}</Link>;
  if (!canOpenClaim(o, new Date())) {
    return (
      <div className="space-y-4">
        <p className="text-sm">{back}</p>
        <Card>
          <p className="text-sm text-zinc-700">
            {o.delivered_at ? CLAIM_MSG.tooLate : CLAIM_MSG.notDelivered}{" "}
            <Link href="/contatti" className="font-medium underline">Contattaci</Link>
          </p>
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm">{back}</p>
      <Card>
        <p className="mb-5 text-sm text-zinc-600">
          Ordine <strong>{o.order_number}</strong>. Puoi aprire un reclamo entro {CLAIM_WINDOW_DAYS} giorni dalla consegna; il nostro team ti risponde via e-mail.
        </p>
        <ClaimForm orderId={o.id} />
      </Card>
    </div>
  );
}
