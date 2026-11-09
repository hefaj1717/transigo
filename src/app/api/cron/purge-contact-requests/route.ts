import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/payments/cron-auth";
import { createServiceClient } from "@/lib/supabase/service";

// Retention of contact requests (D125): handled requests are deleted 24 months after handling, IP hashes are
// cleared after 30 days. Called by the scheduler (schedule decided at deployment) with
// "Authorization: Bearer $CRON_SECRET"; locally:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/purge-contact-requests
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data, error } = await createServiceClient().rpc("purge_contact_requests");
  if (error) {
    console.error("[cron] purge-contact-requests:", error.code, error.message);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
  const row = (data as { deleted: number; ip_hashes_cleared: number }[] | null)?.[0] ?? { deleted: 0, ip_hashes_cleared: 0 };
  return NextResponse.json({ deleted: row.deleted, ipHashesCleared: row.ip_hashes_cleared });
}
