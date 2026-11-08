import { Suspense } from "react";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Loading } from "@/components/panel-shell";
import { getAccountContext, enforce } from "@/lib/auth/session";
import { resolveGuestPage } from "@/lib/auth/routing";
import { AUTH_MSG } from "@/lib/auth/errors";
import { LoginForm } from "./login-form";

export const metadata = { title: "Accedi – Transigo" };

const QUERY_ERRORS: Record<string, string> = {
  link: AUTH_MSG.linkInvalid,
  account: "Il tuo account non è configurato correttamente. Contattaci per assistenza.",
};

export default function Page({ searchParams }: PageProps<"/accedi">) {
  return (
    <AuthCard
      title="Accedi"
      subtitle={<>Non hai un account? <Link href="/registrati" className="text-blue-700 underline">Registrati</Link></>}
    >
      <Suspense fallback={<Loading />}>
        <Gate searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function Gate({ searchParams }: Pick<PageProps<"/accedi">, "searchParams">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";
  enforce(resolveGuestPage(await getAccountContext(), next)); // signed in already → straight to next
  const errore = typeof sp.errore === "string" ? QUERY_ERRORS[sp.errore] : undefined;
  return <LoginForm next={next} initialError={errore} />;
}
