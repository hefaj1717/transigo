import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 "proxy" (formerly middleware).
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Skip static assets, images, Stripe/SDI webhooks (they have no user session) and the public carrier PWA
    // files (service worker, manifest, offline page — they must load without a session, D104).
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|padroncino/(?:sw\\.js|offline\\.html|manifest\\.webmanifest)$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
