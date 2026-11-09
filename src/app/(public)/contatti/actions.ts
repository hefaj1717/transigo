"use server";

import { headers } from "next/headers";
import { CONTACT_MSG, parseContactForm, type ContactFormState } from "@/lib/contact/form";
import { clientIp, hashIp } from "@/lib/contact/ip";
import { submitContactRequest } from "@/lib/contact/server";
import { getAppUrl } from "@/lib/supabase/env";
import { createServiceClient } from "@/lib/supabase/service";

// Public contact form (D125). Order matters: honeypot and validation first, then the IP hash, and only then
// the service-role client — nothing reaches the database for bots or invalid input. A bot gets the normal
// success message (it should not learn that it was filtered). actions.test.ts checks this order.
export async function sendContactAction(_prev: ContactFormState, fd: FormData): Promise<ContactFormState> {
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
    const ipHash = hashIp(clientIp((name) => h.get(name)), secret);
    const result = await submitContactRequest(
      { db: createServiceClient(), ipHash, appUrl: getAppUrl(), adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null },
      parsed.input,
    );
    if (result.status === "rate_limited") return { status: "error", message: CONTACT_MSG.rateLimited, values };
    return { status: "sent", message: CONTACT_MSG.sent };
  } catch (e) {
    console.error("[contact] submit failed:", e instanceof Error ? e.message : e);
    return { status: "error", message: CONTACT_MSG.generic, values };
  }
}
