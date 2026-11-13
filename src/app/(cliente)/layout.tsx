import type { ReactNode } from "react";

// Customer area: navigation between pages blocks until the new page is fully rendered (orders, invoices,
// profile…) instead of showing a "Caricamento…" fallback first — the owner prefers the old page to stay
// until the new one is ready. The pages therefore read the session and their data without <Suspense>.
// The pending link shows a small indicator meanwhile (AreaLink in customer-shell.tsx).
export const instant = false;

export default function CustomerLayout({ children }: { children: ReactNode }) {
  return children;
}
