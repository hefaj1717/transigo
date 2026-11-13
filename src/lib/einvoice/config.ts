// Provider choice and the production guard (pure, tested).
import { EInvoiceError, PROVIDER_NAMES, type ProviderName } from "./provider";

type Env = Record<string, string | undefined>;

/** EINVOICE_PROVIDER=demo|fatture_in_cloud; unset → demo. Anything else is a configuration error. */
export function providerNameFrom(env: Env): ProviderName {
  const v = env.EINVOICE_PROVIDER?.trim() || "demo";
  if (!(PROVIDER_NAMES as readonly string[]).includes(v)) throw new EInvoiceError("provider_config", `Unknown EINVOICE_PROVIDER: ${v}`);
  return v as ProviderName;
}

/** The only Supabase project the DEMO adapter may use on Vercel: staging (the production one is a separate project). */
export const STAGING_SUPABASE_URL = "https://bacabuzzevwwdxrswbnc.supabase.co";

/**
 * Production = the indexable site (D126), or a Vercel production deployment on any database other than staging.
 * The demo address (transigo-staging.vercel.app, alias of transigo-psi.vercel.app) is the Vercel "production" deployment of the staging project, so
 * VERCEL_ENV alone is not enough (D180).
 */
export function isProduction(env: Env): boolean {
  if (env.SITE_INDEXING === "on") return true;
  return env.VERCEL_ENV === "production" && env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") !== STAGING_SUPABASE_URL;
}

/** The DEMO adapter never runs on production (D144): documents without fiscal value must not reach real customers. */
export function assertDemoAllowed(env: Env): void {
  if (isProduction(env)) throw new EInvoiceError("demo_on_production", "The DEMO e-invoice adapter is disabled on production");
}
