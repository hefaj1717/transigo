import { Suspense } from "react";
import { AuthCard } from "@/components/auth-card";
import { Loading } from "@/components/panel-shell";
import { enforce, getAccountContext } from "@/lib/auth/session";
import { resolveCompleteProfilePage } from "@/lib/auth/routing";
import { createServiceClient } from "@/lib/supabase/service";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Completa il profilo – Transigo" };

// D80: accounts created without the sign-up form (e.g. Supabase dashboard) complete the customer profile
// here after the first sign-in, then continue to `next` (customer panel or booking wizard).
export default function Page({ searchParams }: PageProps<"/completa-profilo">) {
  return (
    <AuthCard title="Completa il tuo profilo" subtitle="Ci servono ancora alcuni dati prima di continuare.">
      <Suspense fallback={<Loading />}>
        <Gate searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function Gate({ searchParams }: Pick<PageProps<"/completa-profilo">, "searchParams">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";
  const ctx = await getAccountContext();
  enforce(resolveCompleteProfilePage(ctx, next));
  if (ctx.state !== "signed_in") return null;

  // Prefill with what the account already has (read by id from the session only).
  const { data: profile } = await createServiceClient()
    .from("profiles")
    .select("first_name, last_name, phone")
    .eq("id", ctx.userId)
    .single();

  return (
    <ProfileForm
      next={next}
      hasCustomerRow={ctx.customerType !== null}
      initial={{ firstName: profile?.first_name ?? "", lastName: profile?.last_name ?? "", phone: profile?.phone ?? "" }}
    />
  );
}
