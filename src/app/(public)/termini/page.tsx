import { AuthCard } from "@/components/auth-card";

export const metadata = { title: "Termini e condizioni – Transigo" };

// Placeholder: the legal text arrives in Stage 8. Its version is settings.terms_version (D42).
export default function Page() {
  return (
    <AuthCard title="Termini e condizioni">
      <p className="text-sm text-zinc-600">Il testo dei Termini e condizioni sarà pubblicato a breve.</p>
    </AuthCard>
  );
}
