"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * "Accedi" / "Il mio account" in the public header. The header itself stays static (prerendered pages), so the
 * session is checked here in the browser: getSession() only reads the local auth cookie (no request to Supabase
 * Auth). It is a display hint only — "Il mio account" goes to /accedi, whose server-side gate sends a signed-in
 * account to its own panel (cliente / padroncino / admin) and shows the login form otherwise.
 * Hidden until the check is done, so a signed-in user does not see "Accedi" flash first.
 */
export function AccountLink({ className }: { className: string }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => active && setSignedIn(Boolean(data.session)))
      .catch(() => active && setSignedIn(false));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return (
    <Link href="/accedi" className={`${className} ${signedIn === null ? "invisible" : ""}`}>
      {signedIn ? "Il mio account" : "Accedi"}
    </Link>
  );
}
