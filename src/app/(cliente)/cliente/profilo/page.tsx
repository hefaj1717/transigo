import { Card, CustomerShell } from "@/components/cliente/customer-shell";
import { requireArea } from "@/lib/auth/session";
import { billingComplete, billingFormValues, type CustomerRow } from "@/lib/customers/profile";
import { createClient } from "@/lib/supabase/server";
import { BillingForm, PasswordForm, PersonalForm } from "./profile-forms";

export const metadata = { title: "Profilo – Transigo" };

// "Profilo" (spec 7): personal data, default billing data (D36) and password. Read with the customer's own
// session (RLS: own rows only).
export default function Page() {
  return (
    <CustomerShell title="Profilo" subtitle="I tuoi dati, i dati per la fattura e la password.">
      <Content />
    </CustomerShell>
  );
}

async function Content() {
  const ctx = await requireArea("cliente", "/cliente/profilo");
  const supabase = await createClient();
  const [{ data: profile }, { data: customer }] = await Promise.all([
    supabase.from("profiles").select("first_name, last_name, phone").eq("id", ctx.userId).single(),
    supabase
      .from("customers")
      .select("customer_type, company_name, vat_number, fiscal_code, sdi_code, pec, billing_street, billing_city, billing_postal_code, billing_province")
      .eq("profile_id", ctx.userId)
      .single<CustomerRow>(),
  ]);

  if (!profile || !customer) {
    return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">Non è stato possibile caricare il profilo. Riprova tra qualche istante.</p>;
  }

  const isBusiness = customer.customer_type === "business";
  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-lg font-semibold text-zinc-900">Dati personali</h2>
        <p className="mt-1 text-sm text-zinc-600">
          E-mail di accesso: <span className="font-medium text-zinc-800">{ctx.email}</span>
        </p>
        <div className="mt-4">
          <PersonalForm initial={{ firstName: profile.first_name ?? "", lastName: profile.last_name ?? "", phone: profile.phone ?? "" }} />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-zinc-900">Dati di fatturazione</h2>
        <p className="mt-1 text-sm text-zinc-600">
          {isBusiness ? "Account aziendale." : "Account privato."} Questi dati compilano in automatico il riepilogo della prenotazione; puoi
          modificarli anche per un singolo ordine. Le fatture già emesse non cambiano.
        </p>
        {!billingComplete(customer) ? (
          <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            {isBusiness ? "Completa l'indirizzo di fatturazione." : "Aggiungi codice fiscale e indirizzo: servono per la fattura prima del pagamento."}
          </p>
        ) : null}
        <div className="mt-4">
          <BillingForm customerType={customer.customer_type} initial={billingFormValues(customer)} />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-zinc-900">Password</h2>
        <div className="mt-4">
          <PasswordForm />
        </div>
      </Card>
    </div>
  );
}
