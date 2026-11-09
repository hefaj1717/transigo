import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { CarrierShell } from "@/components/padroncino/carrier-shell";
import { CompanyForm } from "@/components/padroncino/company-form";
import { requireArea } from "@/lib/auth/session";
import { canEditOnboarding, CARRIER_PATHS, ONBOARDING_MSG } from "@/lib/carriers/onboarding";
import { loadCarrier } from "@/lib/carriers/pages";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dati aziendali – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.company);
  const { carrier, view } = await loadCarrier(await createClient(), ctx.userId);
  const back = { href: CARRIER_PATHS.home, label: "Torna alla registrazione" };
  const c = carrier;

  if (c && canEditOnboarding(view)) {
    return (
      <CarrierShell title="Dati aziendali" back={back}>
        <CompanyForm
          initial={{
            companyName: c.company_name ?? "", vatNumber: c.vat_number ?? "", fiscalCode: c.fiscal_code ?? "",
            hqStreet: c.hq_street ?? "", hqCity: c.hq_city ?? "", hqPostalCode: c.hq_postal_code ?? "", hqProvince: c.hq_province ?? "",
            sdiCode: c.sdi_code ?? "", pec: c.pec ?? "",
          }}
        />
      </CarrierShell>
    );
  }

  // D105: locked after sending for review, when active and when suspended.
  const rows: [string, string | null | undefined][] = [
    ["Ragione sociale", c?.company_name],
    ["Partita IVA", c?.vat_number],
    ["Codice fiscale", c?.fiscal_code],
    ["Sede", c ? [c.hq_street, [c.hq_postal_code, c.hq_city].filter(Boolean).join(" "), c.hq_province ? `(${c.hq_province})` : null].filter(Boolean).join(", ") : null],
    ["Codice destinatario SDI", c?.sdi_code],
    ["PEC", c?.pec],
  ];
  return (
    <CarrierShell title="Dati aziendali" back={{ href: CARRIER_PATHS.home, label: "Indietro" }}>
      <p className="rounded-lg bg-zinc-100 p-3 text-sm text-zinc-700">
        {view === "in_review" ? ONBOARDING_MSG.inReview : ONBOARDING_MSG.companyLocked}
      </p>
      <dl className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
        {rows.map(([label, value]) => (
          <div key={label} className="px-4 py-3">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="mt-0.5 text-zinc-900">{value || "—"}</dd>
          </div>
        ))}
      </dl>
    </CarrierShell>
  );
}
