import Link from "next/link";

// Service switcher above the three booking wizards (D151: Trasporto, Facchinaggio and Deposito are peers).
// Plain links: each wizard keeps its own state, so switching starts the other wizard from the beginning.
const TABS = [
  { key: "trasporto", label: "Trasporto", href: "/prenota" },
  { key: "facchinaggio", label: "Facchini", href: "/prenota/facchini" },
  { key: "deposito", label: "Deposito", href: "/prenota/deposito" },
] as const;

export type BookingService = (typeof TABS)[number]["key"];

export function BookingServiceTabs({ active }: { active: BookingService }) {
  return (
    <nav aria-label="Scegli il servizio" className="mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1 sm:inline-flex">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={
            "flex-1 rounded-md px-4 py-2 text-center text-sm font-semibold sm:flex-none " +
            (t.key === active ? "bg-white text-brand-800 shadow-sm" : "text-zinc-600 hover:text-zinc-900")
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
