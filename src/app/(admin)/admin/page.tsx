import { Suspense } from "react";
import { Loading, PanelShell } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";

export const metadata = { title: "Amministrazione – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("admin", "/admin");
  return (
    <PanelShell title={`Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`}>
      <p>Pannello di amministrazione Transigo.</p>
    </PanelShell>
  );
}
