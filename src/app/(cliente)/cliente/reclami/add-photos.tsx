"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PhotoPicker, usePhotoJobs } from "@/components/cliente/claim-photos";

/** "Aggiungi foto" to an open claim (up to the remaining slots of the 5). */
export function AddClaimPhotos({ claimId, slots }: { claimId: string; slots: number }) {
  const router = useRouter();
  const { jobs, add, remove, uploadAll } = usePhotoJobs(slots);
  const [busy, setBusy] = useState(false);
  const pending = jobs.filter((j) => j.state !== "done");
  return (
    <div className="space-y-2">
      <PhotoPicker jobs={jobs} add={add} remove={remove} max={slots} disabled={busy} />
      {pending.length ? (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const failed = await uploadAll(claimId, jobs);
            setBusy(false);
            if (failed === 0) router.refresh();
          }}
          className="rounded-md bg-brand-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-900 disabled:opacity-60"
        >
          {busy ? "Caricamento…" : `Invia ${pending.length === 1 ? "la foto" : `${pending.length} foto`}`}
        </button>
      ) : null}
    </div>
  );
}
