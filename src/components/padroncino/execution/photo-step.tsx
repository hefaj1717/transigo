"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deletePhotoAction } from "@/app/(padroncino)/padroncino/le-mie-corse/[id]/actions";
import { STEP_HINT, type LegStep, type PhotoKind } from "@/lib/carriers/execution";
import { photosLeft, type PendingPhoto } from "@/lib/carriers/execution-ui";
import type { ExecPhoto } from "@/lib/carriers/execution-server";
import { PHOTOS_MAX_PER_STEP } from "@/lib/carriers/execution";

/**
 * Photos of the open step (≥ 1 before "Carico/Scarico completato"): camera of the phone (capture), thumbnails,
 * progress bar, "Riprova" / remove for a failed one, × on a saved one while the step is open.
 */
export function PhotoStep({
  orderId,
  legIndex,
  kind,
  step,
  saved,
  pending,
  preview,
  onAdd,
  onRetry,
  onDiscard,
  disabled,
}: {
  orderId: string;
  legIndex: number;
  kind: PhotoKind;
  step: LegStep;
  saved: readonly ExecPhoto[];
  pending: readonly PendingPhoto[];
  preview: (localId: string) => string | null;
  onAdd: (file: File) => void;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
  disabled: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = photosLeft(saved.length, pending.length);

  async function remove(photoId: string) {
    if (deleting) return;
    setDeleting(photoId);
    setError(null);
    try {
      const r = await deletePhotoAction({ photoId, orderId });
      if (!r.ok) setError(r.message);
      router.refresh();
    } catch {
      setError("Connessione assente o lenta. Riprova.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section aria-label="Foto" className="rounded-2xl border border-zinc-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold text-zinc-900">{kind === "pickup" ? "Foto del carico" : "Foto della consegna"}</h2>
        <span className="text-sm text-zinc-500 tabular-nums">{saved.length}/{PHOTOS_MAX_PER_STEP}</span>
      </div>
      {STEP_HINT[step] ? <p className="mt-1 text-sm text-zinc-600">{STEP_HINT[step]}</p> : null}

      {saved.length || pending.length ? (
        <ul className="mt-3 grid grid-cols-3 gap-2">
          {saved.map((p) => (
            <li key={p.id} className="relative aspect-square overflow-hidden rounded-lg bg-zinc-100">
              {p.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, no optimizer
                <img src={p.url} alt="Foto salvata" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-xs text-zinc-500">Foto salvata</span>
              )}
              <button
                type="button"
                onClick={() => remove(p.id)}
                disabled={disabled || deleting !== null}
                aria-label="Elimina foto"
                className="absolute top-1 right-1 flex size-9 items-center justify-center rounded-full bg-black/60 text-lg text-white disabled:opacity-50"
              >
                {deleting === p.id ? "…" : "×"}
              </button>
            </li>
          ))}
          {pending.map((p) => {
            const src = preview(p.localId);
            return (
              <li key={p.localId} className="relative aspect-square overflow-hidden rounded-lg bg-zinc-100">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview (blob: URL) */}
                {src ? <img src={src} alt="Foto in caricamento" className={`size-full object-cover ${p.phase === "error" ? "opacity-40" : "opacity-70"}`} /> : null}
                {p.phase === "error" ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-1">
                    <button type="button" onClick={() => onRetry(p.localId)} className="min-h-9 w-full rounded-md bg-[#0B3B8C] px-2 text-xs font-semibold text-white">
                      Riprova
                    </button>
                    <button type="button" onClick={() => onDiscard(p.localId)} className="min-h-9 w-full rounded-md bg-white px-2 text-xs font-semibold text-zinc-900">
                      Elimina
                    </button>
                  </div>
                ) : (
                  <div className="absolute inset-x-1 bottom-1">
                    <div role="progressbar" aria-label="Caricamento foto" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.progress} className="h-2 overflow-hidden rounded-full bg-white/80">
                      <div className="h-full bg-[#0B3B8C] transition-[width]" style={{ width: `${p.phase === "preparing" ? 5 : p.progress}%` }} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {pending.filter((p) => p.phase === "error").map((p) => (
        <p key={p.localId} role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">{p.error}</p>
      ))}
      {error ? <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">{error}</p> : null}

      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid={`photo-input-${legIndex}-${kind}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // the same picture can be chosen again
          if (file) onAdd(file);
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled || left === 0}
        className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#0B3B8C] bg-blue-50 px-4 text-base font-semibold text-[#0B3B8C] disabled:opacity-50"
      >
        <span aria-hidden>📷</span> {left === 0 ? "Numero massimo di foto raggiunto" : saved.length || pending.length ? "Scatta un'altra foto" : "Scatta foto"}
      </button>
    </section>
  );
}
