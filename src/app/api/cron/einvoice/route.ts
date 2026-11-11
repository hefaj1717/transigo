import { NextResponse } from "next/server";
import { runEInvoiceCatchUp } from "@/lib/einvoice/server";
import { isAuthorizedCron } from "@/lib/payments/cron-auth";
import { createServiceClient } from "@/lib/supabase/service";

// Periodic job (D147): catches up customer documents — invoices of payments that missed the webhook, pending and
// failed documents (max 5 automatic attempts, then "Riprova" in the admin panel), credit notes that waited for their
// invoice (D146). Called with "Authorization: Bearer $CRON_SECRET"; locally:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/einvoice
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runEInvoiceCatchUp(createServiceClient()));
  } catch (e) {
    console.error("[cron] einvoice:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
