import Link from "next/link";
import { AuthCard } from "@/components/auth-card";

export const metadata = { title: "Controlla la tua e-mail – Transigo" };

export default function Page() {
  return (
    <AuthCard title="Controlla la tua e-mail">
      <div className="space-y-3 text-sm text-zinc-700">
        <p>Ti abbiamo inviato un&apos;e-mail con un link per confermare il tuo indirizzo.</p>
        <p>Apri il link per attivare l&apos;account. Se non trovi l&apos;e-mail, controlla anche la cartella spam.</p>
        <p>
          <Link href="/accedi" className="text-blue-700 underline">Vai all&apos;accesso</Link>
        </p>
      </div>
    </AuthCard>
  );
}
