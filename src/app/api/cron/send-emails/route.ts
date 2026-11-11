import { NextResponse } from "next/server";
import { currentSender, processOutbox, supabaseOutboxStore } from "@/lib/notifications/outbox";
import { recoverDeliveredEmails } from "@/lib/orders/delivered-email-recovery";
import { isAuthorizedCron } from "@/lib/payments/cron-auth";
import { getAppUrl } from "@/lib/supabase/env";
import { createServiceClient } from "@/lib/supabase/service";

// E-mail retries (D131): every 15 minutes (scheduler to be decided — Vercel Hobby allows only daily crons, D131). 1) delivered orders of the last ~75 min without an
// order_delivered e-mail get it queued; 2) every queued email_outbox row below 5 attempts gets one attempt
// (claimed first — never sent twice); the 5th failure makes it "failed" for the admin list (/admin/email).
// "Authorization: Bearer $CRON_SECRET" (Vercel Cron sends it); locally:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/send-emails
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceClient();
  try {
    const recovered = await recoverDeliveredEmails(db, getAppUrl());
    const sender = currentSender();
    if (!sender) {
      console.warn("[cron] send-emails: Resend not configured, queue left as is");
      return NextResponse.json({ recovered, outbox: "not_configured" });
    }
    const outbox = await processOutbox(supabaseOutboxStore(db), sender);
    return NextResponse.json({ recovered, outbox });
  } catch (e) {
    console.error("[cron] send-emails:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
