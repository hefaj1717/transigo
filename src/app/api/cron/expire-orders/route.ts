import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/payments/cron-auth";
import { reconcileOverdueOrders } from "@/lib/payments/server";
import { createServiceClient } from "@/lib/supabase/service";

// Periodic job (D91): expires overdue unpaid orders and catches payments whose webhook was missed.
// Called by the scheduler with "Authorization: Bearer $CRON_SECRET"; locally:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/expire-orders
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await reconcileOverdueOrders(createServiceClient());
    return NextResponse.json(report);
  } catch (e) {
    console.error("[cron] expire-orders:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
