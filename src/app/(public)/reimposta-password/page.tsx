import { Suspense } from "react";
import { AuthCard } from "@/components/auth-card";
import { Loading } from "@/components/panel-shell";
import { getAccountContext, enforce } from "@/lib/auth/session";
import { resolveResetPasswordPage } from "@/lib/auth/routing";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata = { title: "Nuova password – Transigo" };

// Reached from the recovery link (/auth/confirm?type=recovery creates the session).
export default function Page() {
  return (
    <AuthCard title="Imposta una nuova password">
      <Suspense fallback={<Loading />}>
        <Gate />
      </Suspense>
    </AuthCard>
  );
}

async function Gate() {
  enforce(resolveResetPasswordPage(await getAccountContext()));
  return <ResetPasswordForm />;
}
