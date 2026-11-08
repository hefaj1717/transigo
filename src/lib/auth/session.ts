import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { loadAccountContext } from "./account-context";
import { resolveAreaAccess, type AccountContext, type Area, type Decision } from "./routing";

// Data Access Layer for the current request (D46). Call it in every protected page and Server Action;
// layouts are not enough (they don't re-render on navigation). React cache() dedupes within one request only:
// the context is deliberately not cached across requests, so a block by the admin takes effect immediately.

export const getAccountContext = cache(async (): Promise<AccountContext> => {
  // Session-dependent output must render only for a real request. With partialPrefetching, cookies()
  // resolves during the runtime prefetch (App Shell), and supabase-js then compares the token expiry
  // with Date.now() → "Blocking Route: unstable value Date.now()". connection() stops prerendering here
  // (the Suspense fallback is used in prefetches); in Server Actions / requests it resolves immediately.
  // We do not use "use cache: private" instead: it would keep a stale context (e.g. a just-blocked account) for minutes.
  await connection();
  const supabase = await createClient();
  return loadAccountContext(supabase, createServiceClient());
});

export type SignedInContext = Extract<AccountContext, { state: "signed_in" }>;

/** Redirects unless the current user may see `area`; returns the signed-in context otherwise. */
export async function requireArea(area: Area, currentPath?: string): Promise<SignedInContext> {
  const ctx = await getAccountContext();
  enforce(resolveAreaAccess(ctx, area, currentPath));
  return ctx as SignedInContext;
}

/** Applies a routing decision (redirect() throws, so call outside try/catch). */
export function enforce(decision: Decision): void {
  if (decision.kind === "redirect") redirect(decision.to);
}
