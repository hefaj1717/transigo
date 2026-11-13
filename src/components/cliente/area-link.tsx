"use client";

import Link, { useLinkStatus } from "next/link";
import type { ReactNode } from "react";

// Area link of the customer panel. Pages there block until fully rendered (no "Caricamento…", see
// src/app/(cliente)/layout.tsx), so the clicked link pulses until the new page shows.
export function AreaLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={className}>
      <Label>{children}</Label>
    </Link>
  );
}

function Label({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return <span className={pending ? "animate-pulse text-brand-800" : undefined}>{children}</span>;
}
