"use client";

import { useCallback, useEffect, useState } from "react";
import { createClaimPhotoUploadAction, registerClaimPhotoAction } from "@/app/(cliente)/cliente/reclami/actions";
import { compressPhoto, PhotoUnreadableError } from "@/lib/browser/compress-photo";
import { uploadWithProgress } from "@/lib/browser/upload-with-progress";
import { CLAIM_MSG, claimUploadErrorMessage } from "@/lib/claims/claims";

// Claim photos (D138): compressed to JPEG in the browser, signed upload URL made with the customer's session,
// PUT straight to Storage, then register_claim_photo. Sequential and resumable: a failed photo keeps its path, so
// "Riprova" sends the same file to the same path (an upload that had arrived is found and only registered).

export type PhotoJob = { key: string; file: File; preview: string; state: "waiting" | "uploading" | "done" | "failed"; progress: number; error?: string; path?: string };

/** Not crypto.randomUUID(): it exists only on https / localhost (the phone test over Wi-Fi is plain http). */
function localKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function usePhotoJobs(max: number) {
  const [jobs, setJobs] = useState<PhotoJob[]>([]);
  useEffect(() => () => jobs.forEach((j) => URL.revokeObjectURL(j.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      setJobs((cur) => {
        const room = Math.max(max - cur.filter((j) => j.state !== "done").length, 0);
        const added = Array.from(files).slice(0, room).map((file) => ({ key: localKey(), file, preview: URL.createObjectURL(file), state: "waiting" as const, progress: 0 }));
        return [...cur, ...added];
      });
    },
    [max],
  );
  const remove = useCallback((key: string) => {
    setJobs((cur) => {
      const j = cur.find((x) => x.key === key);
      if (j) URL.revokeObjectURL(j.preview);
      return cur.filter((x) => x.key !== key);
    });
  }, []);

  const patch = (key: string, p: Partial<PhotoJob>) => setJobs((cur) => cur.map((j) => (j.key === key ? { ...j, ...p } : j)));

  /** Uploads every waiting / failed photo to the claim. Returns how many failed. */
  const uploadAll = useCallback(async (claimId: string, list: PhotoJob[]): Promise<number> => {
    let failed = 0;
    for (const job of list.filter((j) => j.state !== "done")) {
      patch(job.key, { state: "uploading", progress: 0, error: undefined });
      const fail = (message: string) => {
        failed++;
        patch(job.key, { state: "failed", error: message });
      };
      try {
        let blob: Blob;
        try {
          blob = await compressPhoto(job.file);
        } catch (e) {
          fail(e instanceof PhotoUnreadableError ? "Questa foto non si può leggere. Scegline un'altra." : CLAIM_MSG.generic);
          continue;
        }
        const ticket = await createClaimPhotoUploadAction({ claimId, path: job.path });
        if (!ticket.ok) {
          fail(ticket.message);
          continue;
        }
        job.path = ticket.path;
        patch(job.key, { path: ticket.path });
        if (!ticket.alreadyUploaded && ticket.signedUrl) {
          const err = await uploadWithProgress(ticket.signedUrl, blob, "image/jpeg", (p) => patch(job.key, { progress: p }));
          const message = claimUploadErrorMessage(err);
          if (message) {
            fail(message);
            continue;
          }
        }
        const reg = await registerClaimPhotoAction({ claimId, path: ticket.path });
        if (!reg.ok) {
          fail(reg.message);
          continue;
        }
        patch(job.key, { state: "done", progress: 100 });
      } catch {
        fail(CLAIM_MSG.network);
      }
    }
    return failed;
  }, []);

  return { jobs, add, remove, uploadAll };
}

export function PhotoPicker({ jobs, add, remove, max, disabled }: { jobs: PhotoJob[]; add: (f: FileList | null) => void; remove: (key: string) => void; max: number; disabled?: boolean }) {
  const left = max - jobs.length;
  return (
    <div>
      {jobs.length ? (
        <ul className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {jobs.map((j) => (
            <li key={j.key} className="relative overflow-hidden rounded-md border border-zinc-200 bg-zinc-50">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
              <img src={j.preview} alt="" className="aspect-square w-full object-cover" />
              {j.state === "uploading" ? <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 text-center text-xs text-white">{Math.round(j.progress)}%</span> : null}
              {j.state === "done" ? <span className="absolute inset-x-0 bottom-0 bg-accent-700/90 px-1 text-center text-xs text-white">Caricata</span> : null}
              {j.state === "failed" ? <span className="absolute inset-x-0 bottom-0 bg-red-700/90 px-1 text-center text-xs text-white" title={j.error}>Non caricata</span> : null}
              {j.state === "waiting" || j.state === "failed" ? (
                <button type="button" disabled={disabled} onClick={() => remove(j.key)} aria-label="Rimuovi foto" className="absolute right-1 top-1 rounded-full bg-white/90 px-2 text-sm text-zinc-800 shadow">
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {jobs.filter((j) => j.state === "failed").map((j) => (
        <p key={j.key} role="alert" className="mb-1 text-sm text-red-700">{j.file.name}: {j.error}</p>
      ))}
      {left > 0 ? (
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 ${disabled ? "pointer-events-none opacity-60" : ""}`}>
          <input type="file" accept="image/*" multiple className="sr-only" disabled={disabled} onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          Aggiungi foto
          <span className="text-xs text-zinc-500">(ancora {left})</span>
        </label>
      ) : null}
    </div>
  );
}
