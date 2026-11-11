// Provider choice and the production guard (pure, tested).
import { EInvoiceError, PROVIDER_NAMES, type ProviderName } from "./provider";

type Env = Record<string, string | undefined>;

/** EINVOICE_PROVIDER=demo|fatture_in_cloud; unset → demo. Anything else is a configuration error. */
export function providerNameFrom(env: Env): ProviderName {
  const v = env.EINVOICE_PROVIDER?.trim() || "demo";
  if (!(PROVIDER_NAMES as readonly string[]).includes(v)) throw new EInvoiceError("provider_config", `Unknown EINVOICE_PROVIDER: ${v}`);
  return v as ProviderName;
}

/** Production = the Vercel production deployment or the indexable site (D126). */
export function isProduction(env: Env): boolean {
  return env.VERCEL_ENV === "production" || env.SITE_INDEXING === "on";
}

/** The DEMO adapter never runs on production (D144): documents without fiscal value must not reach real customers. */
export function assertDemoAllowed(env: Env): void {
  if (isProduction(env)) throw new EInvoiceError("demo_on_production", "The DEMO e-invoice adapter is disabled on production");
}
