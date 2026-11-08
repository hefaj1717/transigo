import { Suspense } from "react";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Loading } from "@/components/panel-shell";
import { getAccountContext, enforce } from "@/lib/auth/session";
import { resolveGuestPage } from "@/lib/auth/routing";
import { AUTH_MSG } from "@/lib/auth/errors";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata = { title: "Password dimenticata – Transigo" };

const QUERY_ERRORS: Record<string, string> = {
  link: AUTH_MSG.linkInvalid,
  sessione: AUTH_MSG.sessionMissing,
};

export default function Page({ searchParams }: PageProps<"/password-dimenticata">) {
  return (
    <AuthCard
      title="Password dimenticata"
      subtitle="Inserisci l'e-mail del tuo account: ti invieremo un link per impostare una nuova password."
    >
      <Suspense fallback={<Loading />}>
        <Gate searchParams={searchParams} />
      </Suspense>
      <p className="mt-4 text-sm">
        <Link href="/accedi" className="text-blue-700 underline">Torna all&apos;accesso</Link>
      </p>
    </AuthCard>
  );
}

async function Gate({ searchParams }: Pick<PageProps<"/password-dimenticata">, "searchParams">) {
  enforce(resolveGuestPage(await getAccountContext()));
  const { errore } = await searchParams;
  return <ForgotPasswordForm initialError={typeof errore === "string" ? QUERY_ERRORS[errore] : undefined} />;
}
