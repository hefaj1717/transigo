"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import { createPhotoUploadAction, registerPhotoAction } from "@/app/(padroncino)/padroncino/le-mie-corse/[id]/actions";
import { compressPhoto, PhotoUnreadableError } from "@/lib/browser/compress-photo";
import { uploadWithProgress } from "@/lib/browser/upload-with-progress";
import { EXEC_MSG, uploadErrorMessage, type PhotoKind } from "@/lib/carriers/execution";
import { photoQueue } from "@/lib/carriers/execution-ui";

type Local = { file: File; blob: Blob | null; preview: string };

/**
 * Local id of a photo on this screen. Not crypto.randomUUID(): it exists only in secure contexts (https,
 * localhost) and the phone test over the Wi-Fi address is plain http. getRandomValues works everywhere.
 */
function localId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Photos taken on this screen until they are registered: compress in the browser → signed upload URL (session)
 * → PUT with progress straight to Storage → register_order_photo. A failure keeps the file AND its path
 * ("Riprova" sends the same file to the same path; an upload that had arrived is found there).
 */
export function usePhotoUploads(orderId: string, savedPaths: readonly string[]) {
  const router = useRouter();
  const [queue, dispatch] = useReducer(photoQueue, []);
  const files = useRef(new Map<string, Local>());
  const paths = useRef(new Map<string, string>());

  useEffect(() => {
    const map = files.current;
    return () => map.forEach((f) => URL.revokeObjectURL(f.preview));
  }, []);

  useEffect(() => {
    for (const q of queue) {
      if (q.phase === "registering" && q.path && savedPaths.includes(q.path)) {
        const local = files.current.get(q.localId);
        if (local) URL.revokeObjectURL(local.preview);
        files.current.delete(q.localId);
        paths.current.delete(q.localId);
        dispatch({ type: "registered", localId: q.localId });
      }
    }
  }, [queue, savedPaths]);

  const run = useCallback(
    async (localId: string, legIndex: number, kind: PhotoKind) => {
      const local = files.current.get(localId);
      if (!local) return;
      const fail = (message: string, refresh = false) => {
        dispatch({ type: "failed", localId, error: message });
        if (refresh) router.refresh();
      };
      try {
        if (!local.blob) {
          try {
            local.blob = await compressPhoto(local.file);
          } catch (e) {
            return fail(e instanceof PhotoUnreadableError ? "Questa foto non si può leggere. Scattane un'altra." : EXEC_MSG.generic);
          }
        }
        const ticket = await createPhotoUploadAction({ orderId, legIndex, kind, path: paths.current.get(localId) });
        if (!ticket.ok) return fail(ticket.message, ticket.refresh);
        paths.current.set(localId, ticket.path);
        dispatch({ type: "ticket", localId, path: ticket.path });
        if (!ticket.alreadyUploaded && ticket.signedUrl) {
          const err = await uploadWithProgress(ticket.signedUrl, local.blob, "image/jpeg", (p) => dispatch({ type: "progress", localId, progress: p }));
          const view = uploadErrorMessage(err, "photo");
          if (view) return fail(view.message, view.refresh);
        }
        dispatch({ type: "uploaded", localId });
        const reg = await registerPhotoAction({ orderId, legIndex, kind, path: ticket.path });
        if (!reg.ok) return fail(reg.message, reg.refresh);
        // The saved photo comes back from the server (with its preview URL); the effect below then drops it from
        // the queue — so the button never flickers to "Aggiungi almeno una foto" in between.
        router.refresh();
      } catch {
        // Server action unreachable (offline): keep everything for "Riprova".
        fail(EXEC_MSG.network);
      }
    },
    [orderId, router],
  );

  const add = useCallback(
    (file: File, legIndex: number, kind: PhotoKind) => {
      const id = localId();
      files.current.set(id, { file, blob: null, preview: URL.createObjectURL(file) });
      dispatch({ type: "add", localId: id, legIndex, kind });
      void run(id, legIndex, kind);
    },
    [run],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = queue.find((q) => q.localId === localId);
      if (!item) return;
      dispatch({ type: "retry", localId });
      void run(localId, item.legIndex, item.kind);
    },
    [queue, run],
  );

  const discard = useCallback((localId: string) => {
    const local = files.current.get(localId);
    if (local) URL.revokeObjectURL(local.preview);
    files.current.delete(localId);
    paths.current.delete(localId);
    dispatch({ type: "discard", localId });
  }, []);

  const preview = useCallback((localId: string) => files.current.get(localId)?.preview ?? null, []);

  return { queue, add, retry, discard, preview };
}
