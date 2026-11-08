import { AuthCard } from "@/components/auth-card";

export const metadata = { title: "Informativa sulla privacy – Transigo" };

// Placeholder: the legal text arrives in Stage 8. Its version is settings.privacy_version (D42).
export default function Page() {
  return (
    <AuthCard title="Informativa sulla privacy">
      <p className="text-sm text-zinc-600">Il testo dell&apos;Informativa sulla privacy sarà pubblicato a breve.</p>
    </AuthCard>
  );
}
