"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps as sessionAdminDeps } from "@/lib/admin/deps";
import { ADMIN_CARRIER_MSG, ADMIN_CARRIER_PATHS, formValues } from "@/lib/carriers/admin";
import {
  approveVehicle,
  decideCarrier,
  reviewDocument,
  setCarrierPorters,
  setSuspension,
  updateCarrierCompany,
  type AdminResult,
} from "@/lib/carriers/admin-server";
import type { CarrierFormState } from "@/lib/carriers/form-state";

// Admin actions on carriers (D101, D105, D113–D115). EVERY action starts with adminDeps(): the DAL checks the
// session (anonymous, other roles and blocked accounts are redirected before anything else runs) and the admin
// id passed to the database is always the session's — never a form field. The database functions are
// service-role only and check the admin once more. src/app/(admin)/admin/padroncini/actions.test.ts calls every
// export of this file as a non-admin.

const adminDeps = () => sessionAdminDeps(ADMIN_CARRIER_PATHS.list);


async function respond(where: string, fn: () => Promise<AdminResult>): Promise<ActionResult> {
  let result: AdminResult;
  try {
    result = await fn();
  } catch (e) {
    console.error(`[admin-carriers] ${where}:`, e instanceof Error ? e.message : e);
    return { error: ADMIN_CARRIER_MSG.generic };
  }
  if (!result.ok) return { error: result.error };
  refresh();
  return { message: result.message, at: Date.now() };
}

/** Approva / Rifiuta a submitted account (D101). Form: id, decision (approve|reject), reason. */
export async function decideCarrierAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps();
  return respond("decideCarrier", () => decideCarrier(deps, formValues(fd)));
}

/** Approva / Rifiuta one document of an active or suspended carrier (D113). Form: id, decision, reason. */
export async function reviewDocumentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps();
  return respond("reviewDocument", () => reviewDocument(deps, formValues(fd)));
}

/** Approva veicolo together with its pending documents (D114). Form: id. */
export async function approveVehicleAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps();
  return respond("approveVehicle", () => approveVehicle(deps, formValues(fd)));
}

/** Sospendi / Riattiva (D115). Form: id, decision (suspend|reactivate), reason. */
export async function setSuspensionAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps();
  return respond("setSuspension", () => setSuspension(deps, formValues(fd)));
}

/** Offre facchinaggio + squadra (D152, D167). Form: id, offers ("on"), team (2–4). */
export async function setCarrierPortersAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps();
  return respond("setCarrierPorters", () => setCarrierPorters(deps, formValues(fd)));
}

/** Dati aziendali through admin_update_carrier_company() (D105). Form: carrierId + the company fields. */
export async function updateCompanyAction(_prev: CarrierFormState, fd: FormData): Promise<CarrierFormState> {
  const deps = await adminDeps();
  const { carrierId = "", ...values } = formValues(fd);
  try {
    const result = await updateCarrierCompany(deps, carrierId, values);
    if (!result.ok) return { errors: result.errors, values };
    refresh();
    return { message: result.message };
  } catch (e) {
    console.error("[admin-carriers] updateCompany:", e instanceof Error ? e.message : e);
    return { errors: { _form: ADMIN_CARRIER_MSG.generic }, values };
  }
}
