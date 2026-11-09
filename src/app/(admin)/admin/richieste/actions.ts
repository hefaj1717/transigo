"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps } from "@/lib/admin/deps";
import { ADMIN_CONTACT_PATHS, setContactRequestStatus } from "@/lib/contact/server";

// Admin actions on contact requests (D125). EVERY action starts with adminDeps(): the DAL checks the session
// before anything else; the admin id passed to the database is the session's, never a form field.
// actions.test.ts calls every export of this file as a non-admin.

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** Segna come gestita / Riapri. Form: id, status (handled | new). */
export async function setContactStatusAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_CONTACT_PATHS.list);
  try {
    const result = await setContactRequestStatus(deps, { id: str(fd, "id"), status: str(fd, "status") });
    if (!result.ok) return { error: result.error };
    refresh();
    return { message: result.message, at: Date.now() };
  } catch (e) {
    console.error("[admin-contact] set status:", e instanceof Error ? e.message : e);
    return { error: "Operazione non riuscita." };
  }
}
