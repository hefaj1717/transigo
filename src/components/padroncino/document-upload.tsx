"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { registerDocumentAction } from "@/app/(padroncino)/padroncino/actions";
import {
  checkDocumentExpiry,
  DOCUMENT_ACCEPT,
  DOCUMENT_MSG,
  documentStoragePath,
  resolveDocumentFile,
  romeToday,
} from "@/lib/carriers/documents";
import type { CarrierDocumentType } from "@/lib/carriers/document-types";
import { createClient } from "@/lib/supabase/client";
import { bigButton } from "./carrier-shell";

type Props = {
  carrierId: string;
  docType: CarrierDocumentType;
  vehicleId: string | null;
  /** Label of the date field; null = document without expiry date. */
  expiryLabel: string | null;
  hasCurrent: boolean;
};

// D103: the browser uploads the file straight to Storage (own folder), then the server records the row.
// The checks here only save the carrier a useless upload; the server checks again (path, date, Storage metadata).
export function DocumentUpload({ carrierId, docType, vehicleId, expiryLabel, hasCurrent }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const id = `${vehicleId ?? "carrier"}-${docType}`;
  const today = romeToday();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Scegli un file o scatta una foto.");
    const resolved = resolveDocumentFile(file);
    if (!resolved.ok) return setError(resolved.error);
    const expiry = checkDocumentExpiry(docType, expiresAt, today);
    if (!expiry.ok) return setError(expiry.error);

    setBusy(true);
    try {
      const path = documentStoragePath(carrierId, crypto.randomUUID(), resolved.ext);
      const { error: uploadError } = await createClient()
        .storage.from("carrier-documents")
        .upload(path, file, { contentType: resolved.mimeType, upsert: false });
      if (uploadError) return setError(DOCUMENT_MSG.upload);

      const result = await registerDocumentAction({
        docType,
        vehicleId: vehicleId ?? "",
        storagePath: path,
        fileName: file.name.slice(0, 255) || `documento.${resolved.ext}`,
        expiresAt: expiry.expiresAt ?? "",
      });
      const firstError = result.errors ? Object.values(result.errors)[0] : null;
      if (firstError) return setError(firstError);
      setMessage(result.message ?? null);
      setExpiresAt("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setError(DOCUMENT_MSG.upload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3" noValidate>
      <div>
        <label htmlFor={`file-${id}`} className="block text-sm font-medium text-zinc-800">
          {hasCurrent ? "Carica un nuovo file" : "File"} <span className="text-red-600">*</span>
        </label>
        <input
          ref={fileRef}
          id={`file-${id}`}
          type="file"
          accept={DOCUMENT_ACCEPT}
          className="mt-1 block w-full text-sm text-zinc-700 file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-zinc-200 file:px-4 file:font-medium file:text-zinc-900"
        />
        <p className="mt-1 text-xs text-zinc-500">PDF o foto (JPG, PNG, WEBP, HEIC), massimo 10 MB.</p>
      </div>
      {expiryLabel ? (
        <div>
          <label htmlFor={`date-${id}`} className="block text-sm font-medium text-zinc-800">
            {expiryLabel} <span className="text-red-600">*</span>
          </label>
          <input
            id={`date-${id}`}
            type="date"
            min={today}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="mt-1 block min-h-11 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900"
          />
        </div>
      ) : null}
      {error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {message ? <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-800">{message}</p> : null}
      <button type="submit" disabled={busy} className={bigButton}>{busy ? "Caricamento…" : "Carica documento"}</button>
    </form>
  );
}
