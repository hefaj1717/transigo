import "server-only";
import { headers } from "next/headers";
import { getAppUrl } from "@/lib/supabase/env";
import { createServiceClient } from "@/lib/supabase/service";
import { CONTACT_MSG, parseContactForm, type ContactFormState } from "./form";
import { clientIp, hashIp } from "./ip";
import { submitContactRequest, type OutOfAreaRoute } from "./server";

/**
 * Shared body of the public contact Server Actions (/contatti and the wizard's "out of area" form, D125).
 * Order matters: honeypot and validation first, then the secret and the IP hash, then the route (Google, only
 * for valid "out of area" requests) and only then the service-role client — nothing reaches the database or
 * the maps API for bots or invalid input. A bot gets the normal success message.
 */
export async function submitContactForm(fd: FormData, resolveRoute?: () => Promise<OutOfAreaRoute>): Promise<ContactFormState> {
  const parsed = parseContactForm(fd);
  if (parsed.kind === "bot") return { status: "sent", message: CONTACT_MSG.sent };
  if (parsed.kind === "invalid") return parsed.state;

  const { name, email, phone, message } = parsed.input;
  const values = { name, email, phone, message };
  const secret = process.env.CONTACT_IP_HASH_SECRET ?? "";
  if (secret.length < 32) {
    console.error("[contact] CONTACT_IP_HASH_SECRET missing or shorter than 32 characters");
    return { status: "error", message: CONTACT_MSG.generic, values };
  }

  try {
    const h = await headers();
    const ipHash = hashIp(clientIp((n) => h.get(n)), secret);
    const route = resolveRoute ? await resolveRoute() : null;
    const result = await submitContactRequest(
      { db: createServiceClient(), ipHash, appUrl: getAppUrl(), adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null },
      parsed.input,
      route,
    );
    if (result.status === "rate_limited") return { status: "error", message: CONTACT_MSG.rateLimited, values };
    return { status: "sent", message: CONTACT_MSG.sent };
  } catch (e) {
    console.error("[contact] submit failed:", e instanceof Error ? e.message : e);
    return { status: "error", message: CONTACT_MSG.generic, values };
  }
}
