import "server-only";
import { createServiceClient } from "../supabase/service";
import { providerNameFrom } from "./config";
import { createDemoProvider } from "./demo";
import { EInvoiceError, type EInvoiceProvider } from "./provider";

// The configured e-invoice provider (server only). EINVOICE_PROVIDER=demo|fatture_in_cloud (default demo).
// Fatture in Cloud (D1) = a new adapter here; nothing else changes.

export function getEInvoiceProvider(env: Record<string, string | undefined> = process.env): EInvoiceProvider {
  const name = providerNameFrom(env);
  if (name === "demo") {
    return createDemoProvider({
      env,
      reserveNumber: async (invoiceId) => {
        const { data, error } = await createServiceClient().rpc("reserve_demo_invoice_number", { p_invoice_id: invoiceId });
        if (error || typeof data !== "string") throw new EInvoiceError("demo_number_reserve_failed");
        return data;
      },
    });
  }
  throw new EInvoiceError("provider_not_configured", "Fatture in Cloud adapter not built yet (D1)");
}
