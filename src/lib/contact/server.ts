import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/notifications/email";
import { CONTACT_REQUEST_TEMPLATE, renderContactRequestEmail } from "@/lib/notifications/templates/contact-request";
import type { ContactFormInput } from "./form";

// Saving a contact request (D125). Called by the Server Action only after validation and the honeypot check.

export const ADMIN_CONTACT_PATHS = {
  list: "/admin/richieste",
  detail: (id: string) => `/admin/richieste/${id}`,
} as const;

export type SubmitDeps = {
  /** Service-role client (submit_contact_request is service role only). */
  db: SupabaseClient;
  ipHash: string;
  appUrl: string;
  /** ADMIN_NOTIFICATION_EMAIL; null = not configured (the request is still saved, the error is logged). */
  adminEmail: string | null;
};

export type OutOfAreaRoute = { pickupCity: string | null; pickupProvince: string | null; deliveryCity: string | null; deliveryProvince: string | null; distanceKm: number | null };

export type SubmitResult = { status: "created"; id: string } | { status: "rate_limited" };

export async function submitContactRequest(deps: SubmitDeps, input: ContactFormInput, route: OutOfAreaRoute | null = null): Promise<SubmitResult> {
  const kind = route ? "out_of_area" : "general";
  const { data, error } = await deps.db.rpc("submit_contact_request", {
    p_kind: kind,
    p_name: input.name,
    p_email: input.email,
    p_phone: input.phone || null,
    p_message: input.message,
    p_privacy_accepted: input.privacy === "on",
    p_ip_hash: deps.ipHash,
    p_pickup_city: route?.pickupCity ?? null,
    p_pickup_province: route?.pickupProvince ?? null,
    p_delivery_city: route?.deliveryCity ?? null,
    p_delivery_province: route?.deliveryProvince ?? null,
    p_route_distance_km: route?.distanceKm ?? null,
  });
  if (error) throw new Error(`submit_contact_request failed: ${error.code} ${error.message}`);
  const row = (data as { request_id: string | null; result: string }[] | null)?.[0];
  if (!row) throw new Error("submit_contact_request returned no row");
  if (row.result === "rate_limited") return { status: "rate_limited" };
  if (row.result !== "created" || !row.request_id) throw new Error(`submit_contact_request: unexpected result ${row.result}`);

  // The e-mail never undoes the saved request.
  if (!deps.adminEmail) {
    console.error("[contact] ADMIN_NOTIFICATION_EMAIL not set — contact_request e-mail not queued", { id: row.request_id });
  } else {
    try {
      await sendEmail(deps.db, {
        templateCode: CONTACT_REQUEST_TEMPLATE,
        to: deps.adminEmail,
        ...renderContactRequestEmail({ kind, requestId: row.request_id, adminUrl: `${deps.appUrl}${ADMIN_CONTACT_PATHS.detail(row.request_id)}` }),
      });
    } catch (e) {
      console.error("[contact] e-mail failed", { id: row.request_id, error: e instanceof Error ? e.message : e });
    }
  }
  return { status: "created", id: row.request_id };
}

export type AdminContactDeps = { admin: { userId: string; email: string }; serviceDb: SupabaseClient };
export type AdminContactResult = { ok: true; message: string } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** "Segna come gestita" / "Riapri". The admin id always comes from the session (deps), never from the form. */
export async function setContactRequestStatus(deps: AdminContactDeps, values: { id: string; status: string }): Promise<AdminContactResult> {
  if (!UUID.test(values.id) || (values.status !== "new" && values.status !== "handled")) return { ok: false, error: "Richiesta non valida." };
  const { error } = await deps.serviceDb.rpc("admin_set_contact_request_status", { p_request_id: values.id, p_status: values.status, p_admin_id: deps.admin.userId });
  if (error) {
    if (error.code === "55000") return { ok: false, error: "Lo stato della richiesta è già cambiato. Ricarica la pagina." };
    if (error.code === "42501") return { ok: false, error: "Operazione non consentita." };
    console.error("[contact] set status failed", { code: error.code, message: error.message });
    return { ok: false, error: "Operazione non riuscita." };
  }
  return { ok: true, message: values.status === "handled" ? "Richiesta segnata come gestita." : "Richiesta riaperta." };
}
