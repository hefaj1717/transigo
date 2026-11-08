"use server";

// Warehouses (D9, D72): admin only. The address is resolved on the server from the Google place ID.
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";
import { getMapsProvider, MapsError } from "@/lib/maps";

const placeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,300}$/);

async function resolveAddress(placeId: string) {
  try {
    const p = await getMapsProvider().placeDetails(placeId);
    if (p.countryCode !== "IT" || !p.provinceCode || !p.city) return { error: "Indirizzo non valido: serve un indirizzo in Italia con città e provincia." };
    return {
      address: {
        address: p.formattedAddress,
        street: p.street,
        city: p.city,
        postal_code: p.postalCode,
        province: p.provinceCode,
        place_id: p.placeId,
        lat: p.location.lat,
        lng: p.location.lng,
      },
    };
  } catch (e) {
    return { error: e instanceof MapsError && e.code === "not_found" ? "Indirizzo non trovato." : "Servizio mappe non disponibile. Riprova." };
  }
}

/** D72: the warehouse province must be an active service-area province (the engine checks every leg's pickup). */
async function provinceWarning(db: Awaited<ReturnType<typeof adminAction>>["db"], province: string, active: boolean) {
  if (!active) return null;
  const { data } = await db.from("service_area_provinces").select("is_active").eq("province_code", province).maybeSingle();
  return data?.is_active ? null : `La provincia ${province} non è attiva in “Area di servizio”: attivala, altrimenti il deposito non sarà prenotabile.`;
}

export async function saveWarehouseAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = String(fd.get("id") ?? "");
  const name = String(fd.get("name") ?? "").trim();
  const placeId = String(fd.get("place_id") ?? "");
  const isActive = fd.get("is_active") === "on";
  if (!name || name.length > 200) return { error: "Inserisci il nome del magazzino." };

  const patch: Record<string, unknown> = { name, is_active: isActive };
  if (placeId) {
    if (!placeIdSchema.safeParse(placeId).success) return { error: "Indirizzo non valido." };
    const r = await resolveAddress(placeId);
    if (r.error) return { error: r.error };
    Object.assign(patch, r.address);
  } else if (!id) {
    return { error: "Seleziona l'indirizzo dall'elenco." };
  }

  const query = id ? db.from("warehouses").update(patch).eq("id", id) : db.from("warehouses").insert(patch);
  const { data, error } = await query.select("id, province, is_active").single();
  if (error) {
    if (error.code === "23505") return { error: "Nel MVP può esserci un solo magazzino attivo. Disattiva prima l'altro." };
    return dbError(error);
  }
  await audit(ctx, id ? "warehouse.update" : "warehouse.create", "warehouses", data.id, { name, is_active: isActive, province: data.province, address_changed: !!placeId });
  refresh();
  const warning = await provinceWarning(db, data.province, data.is_active);
  return warning ? { error: `Salvato. ${warning}` } : ok("Magazzino salvato.");
}
