"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps } from "@/lib/admin/deps";
import { formValues } from "@/lib/carriers/admin";
import { ADMIN_ORDER_PATHS, DISPATCH_MSG } from "@/lib/orders/dispatch";
import { advanceOrder, allowEarlyStart, assignHandover, assignJob, revertLastStep, unassignJob, type DispatchResult } from "@/lib/orders/dispatch-server";

// Admin dispatch actions (D122, D123). EVERY action starts with adminDeps(): the DAL checks the session
// (anonymous, other roles and blocked accounts are redirected before anything else runs) and the admin id passed
// to the database is always the session's — never a form field. src/app/(admin)/admin/ordini/actions.test.ts
// calls every export of this file as a non-admin.

async function respond(where: string, fn: () => Promise<DispatchResult>): Promise<ActionResult> {
  let result: DispatchResult;
  try {
    result = await fn();
  } catch (e) {
    console.error(`[dispatch] ${where}:`, e instanceof Error ? e.message : e);
    return { error: DISPATCH_MSG.generic };
  }
  if (!result.ok) return { error: result.error };
  refresh();
  return { message: result.message, at: Date.now() };
}

/** Assegna: form orderId + candidate ("carrierId:vehicleId"). */
export async function assignJobAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_ORDER_PATHS.list);
  return respond("assignJob", () => assignJob(deps, formValues(fd)));
}

/** Rimuovi padroncino: form orderId + reason (code). */
export async function unassignJobAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_ORDER_PATHS.list);
  return respond("unassignJob", () => unassignJob(deps, formValues(fd)));
}

/** Next status: form orderId + to. */
export async function advanceOrderAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_ORDER_PATHS.list);
  return respond("advanceOrder", () => advanceOrder(deps, formValues(fd)));
}

/** "Da gestire": form orderId + candidate + address (where the goods are now) + reason (internal). */
export async function assignHandoverAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_ORDER_PATHS.list);
  return respond("assignHandover", () => assignHandover(deps, formValues(fd)));
}

/** Annulla ultimo passo: form orderId + leg + step (what the admin saw) + reason (internal). */
export async function revertLastStepAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_ORDER_PATHS.list);
  return respond("revertLastStep", () => revertLastStep(deps, formValues(fd)));
}

/** Consenti inizio anticipato: form orderId + leg + reason (internal). */
export async function allowEarlyStartAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_ORDER_PATHS.list);
  return respond("allowEarlyStart", () => allowEarlyStart(deps, formValues(fd)));
}
