import { Suspense } from "react";
import { Loading, PanelShell } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";

export const metadata = { title: "Area cliente – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("cliente", "/cliente");
  return (
    <PanelShell title={`Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`}>
      <p>Benvenuto nella tua area cliente. Qui troverai presto i tuoi ordini e le fatture.</p>
    </PanelShell>
  );
}
