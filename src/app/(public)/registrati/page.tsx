import { Suspense } from "react";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Loading } from "@/components/panel-shell";
import { getAccountContext, enforce } from "@/lib/auth/session";
import { resolveGuestPage } from "@/lib/auth/routing";
import { CustomerForm } from "./customer-form";
import { CarrierForm } from "./carrier-form";

export const metadata = { title: "Registrati – Transigo" };

export default function Page({ searchParams }: PageProps<"/registrati">) {
  return (
    <AuthCard
      title="Crea il tuo account"
      subtitle={<>Hai già un account? <Link href="/accedi" className="text-blue-700 underline">Accedi</Link></>}
    >
      <Suspense fallback={<Loading />}>
        <Gate searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function Gate({ searchParams }: Pick<PageProps<"/registrati">, "searchParams">) {
  enforce(resolveGuestPage(await getAccountContext()));
  const { tipo } = await searchParams;

  if (tipo === "cliente" || tipo === "padroncino") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-600">
          {tipo === "cliente" ? "Account cliente" : "Account padroncino"} ·{" "}
          <Link href="/registrati" className="text-blue-700 underline">cambia</Link>
        </p>
        {tipo === "cliente" ? <CustomerForm /> : <CarrierForm />}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ChoiceCard href="/registrati?tipo=cliente" title="Sono un cliente" text="Privato o azienda: prenota trasporti e servizi." />
      <ChoiceCard href="/registrati?tipo=padroncino" title="Sono un padroncino" text="Trasportatore con partita IVA: ricevi corse." />
    </div>
  );
}

function ChoiceCard({ href, title, text }: { href: string; title: string; text: string }) {
  return (
    <Link href={href} className="block rounded-lg border border-zinc-300 p-4 hover:border-blue-600 hover:bg-blue-50">
      <span className="block font-semibold text-zinc-900">{title}</span>
      <span className="mt-1 block text-sm text-zinc-600">{text}</span>
    </Link>
  );
}
