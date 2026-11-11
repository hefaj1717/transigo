"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PhotoPicker, usePhotoJobs } from "@/components/cliente/claim-photos";
import { CLAIM_CATEGORIES, CLAIM_CATEGORY_LABEL, CLAIM_MAX_PHOTOS } from "@/lib/claims/claims";
import { openClaimAction } from "../../../reclami/actions";

/** "Apri un reclamo" (D138): category + description, then the photos (optional, max 5) into the new claim. */
export function ClaimForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { jobs, add, remove, uploadAll } = usePhotoJobs(CLAIM_MAX_PHOTOS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [photosFailed, setPhotosFailed] = useState(0);

  async function submit(form: HTMLFormElement) {
    setBusy(true);
    setMessage(null);
    try {
      let id = claimId;
      if (!id) {
        const fd = new FormData(form);
        const r = await openClaimAction({ orderId, category: fd.get("category"), description: fd.get("description") });
        if (!r.ok) {
          setErrors(r.errors ?? {});
          setMessage(r.message);
          return;
        }
        id = r.claimId;
        setClaimId(id);
        setErrors({});
      }
      const failed = await uploadAll(id, jobs);
      setPhotosFailed(failed);
      if (failed === 0) router.push("/cliente/reclami?inviato=1");
    } catch {
      setMessage("Connessione assente o lenta. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      {message ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{message}</p> : null}
      {claimId && photosFailed > 0 ? (
        <div role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Il reclamo è stato inviato, ma {photosFailed === 1 ? "una foto non è stata caricata" : `${photosFailed} foto non sono state caricate`}. Puoi riprovare oppure{" "}
          <Link href="/cliente/reclami" className="font-medium underline">andare ai reclami</Link> e aggiungerle dopo.
        </div>
      ) : null}

      <fieldset disabled={!!claimId || busy}>
        <legend className="text-sm font-medium text-zinc-800">Qual è il problema? <span className="text-red-600">*</span></legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {CLAIM_CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50">
              <input type="radio" name="category" value={c} required />
              {CLAIM_CATEGORY_LABEL[c]}
            </label>
          ))}
        </div>
        {errors.category ? <p className="mt-1 text-sm text-red-600">{errors.category}</p> : null}
      </fieldset>

      <div>
        <label htmlFor="claim-description" className="block text-sm font-medium text-zinc-800">Descrizione <span className="text-red-600">*</span></label>
        <textarea
          id="claim-description" name="description" rows={5} maxLength={4000} disabled={!!claimId || busy}
          placeholder="Cosa è successo? Indica quali oggetti sono coinvolti."
          className={`mt-1 block w-full rounded-md border px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500 ${errors.description ? "border-red-500" : "border-zinc-300"}`}
        />
        {errors.description ? <p className="mt-1 text-sm text-red-600">{errors.description}</p> : null}
      </div>

      <div>
        <p className="text-sm font-medium text-zinc-800">Foto (facoltative, massimo {CLAIM_MAX_PHOTOS})</p>
        <p className="mb-2 text-xs text-zinc-500">Le foto ci aiutano a capire subito il problema.</p>
        <PhotoPicker jobs={jobs} add={add} remove={remove} max={CLAIM_MAX_PHOTOS} disabled={busy} />
      </div>

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-brand-800 px-4 py-2 font-semibold text-white hover:bg-brand-900 disabled:opacity-60">
          {busy ? "Invio in corso…" : claimId ? "Riprova a caricare le foto" : "Invia il reclamo"}
        </button>
        <Link href={`/cliente/ordini/${orderId}`} className="rounded-md border border-zinc-300 px-4 py-2 text-zinc-800 hover:bg-zinc-50">Annulla</Link>
      </div>
    </form>
  );
}
