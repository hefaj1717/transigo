import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
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
    <AdminShell title={`Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`}>
      <p>Pannello di amministrazione Transigo.</p>
    </AdminShell>
  );
}
