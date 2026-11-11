"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { completeDeliveryAction, createSignatureUploadAction } from "@/app/(padroncino)/padroncino/le-mie-corse/[id]/actions";
import { currentPosition, uploadWithProgress } from "@/lib/browser/upload-with-progress";
import { EXEC_MSG, recipientNameSchema, SIGNATURE_MAX_BYTES, uploadErrorMessage, type PorterSummary } from "@/lib/carriers/execution";
import { bigButton, stickyActionBar } from "../carrier-shell";
import { ConfirmSheet } from "./confirm-sheet";
import { PorterTime } from "./porter-time";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";

type Phase = "idle" | "uploading" | "saving";

/**
 * "Conferma consegna" (POD, D130): porter time BEFORE the signature (the recipient confirms it by signing),
 * recipient name (required), finger signature, in-app confirmation. Then: signature PNG → signed upload URL
 * (session) → PUT with progress → complete_delivery. A failure keeps name, signature and its path ("Riprova"
 * re-sends the same file; a repeated confirmation is a no-op in the database and never a second e-mail).
 */
export function DeliveryForm({
  orderId,
  orderNumber,
  contactName,
  porters,
  multiLeg,
  doneHref,
}: {
  orderId: string;
  orderNumber: string;
  contactName: string | null;
  porters: readonly PorterSummary[];
  multiLeg: boolean;
  doneHref: string;
}) {
  const router = useRouter();
  const pad = useRef<SignaturePadHandle>(null);
  const sigPath = useRef<string | null>(null);
  const sigBlob = useRef<Blob | null>(null);
  const sending = useRef(false);
  const [name, setName] = useState("");
  const [signed, setSigned] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = phase !== "idle";

  function open() {
    const parsed = recipientNameSchema.safeParse(name);
    setNameError(parsed.success ? null : parsed.error.issues[0].message);
    if (!signed) setError(EXEC_MSG.signatureEmpty);
    else setError(null);
    if (parsed.success && signed) setConfirmOpen(true);
  }

  async function submit() {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      if (!sigBlob.current) sigBlob.current = (await pad.current?.toBlob()) ?? null;
      const blob = sigBlob.current;
      if (!blob) return setError(EXEC_MSG.signatureEmpty);
      if (blob.size > SIGNATURE_MAX_BYTES) return setError(EXEC_MSG.signature);

      setPhase("uploading");
      setProgress(0);
      const ticket = await createSignatureUploadAction({ orderId, path: sigPath.current ?? undefined });
      if (!ticket.ok) {
        setError(ticket.message);
        if (ticket.refresh) router.refresh();
        return;
      }
      sigPath.current = ticket.path;
      if (!ticket.alreadyUploaded && ticket.signedUrl) {
        const view = uploadErrorMessage(await uploadWithProgress(ticket.signedUrl, blob, "image/png", setProgress), "signature");
        if (view) return setError(view.message);
      }
      setPhase("saving");
      const pos = await currentPosition();
      const r = await completeDeliveryAction({ orderId, recipientName: name, signaturePath: ticket.path, lat: pos?.lat ?? null, lng: pos?.lng ?? null });
      if (!r.ok) {
        setError(r.message);
        if (r.refresh) router.refresh();
        return;
      }
      setConfirmOpen(false);
      router.replace(doneHref);
      router.refresh();
    } catch {
      setError(EXEC_MSG.network);
    } finally {
      sending.current = false;
      setPhase("idle");
    }
  }

  /** A new signature → a new file (the failed one may already be in Storage at the old path). */
  function signatureChanged(enough: boolean) {
    setSigned(enough);
    sigBlob.current = null;
    sigPath.current = null;
    if (enough) setError(null);
  }

  return (
    <div className="space-y-4">
      <PorterTime porters={porters} multiLeg={multiLeg} title="Tempo di lavoro dei facchini da confermare" />

      <section className="rounded-2xl border border-zinc-200 bg-white p-4">
        <label htmlFor="recipient" className="font-semibold text-zinc-900">Nome di chi riceve la merce</label>
        <input
          id="recipient"
          name="recipientName"
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="done"
          maxLength={200}
          value={name}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(null);
          }}
          aria-invalid={!!nameError}
          aria-describedby={nameError ? "recipient-error" : undefined}
          placeholder={contactName ?? "Nome e cognome"}
          className="mt-2 block min-h-12 w-full rounded-xl border border-zinc-300 px-3 text-base text-zinc-900"
        />
        {contactName && !name ? (
          <button type="button" onClick={() => setName(contactName)} disabled={busy} className="mt-2 min-h-11 text-sm font-semibold text-[#0B3B8C] underline">
            Riceve {contactName}
          </button>
        ) : null}
        {nameError ? <p id="recipient-error" role="alert" className="mt-2 text-sm text-red-700">{nameError}</p> : null}
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-4">
        <h2 className="font-semibold text-zinc-900">Firma del destinatario</h2>
        <p className="mb-3 text-sm text-zinc-600">Firmando, il destinatario conferma di aver ricevuto la merce{porters.length ? " e il tempo di lavoro dei facchini" : ""}.</p>
        <SignaturePad ref={pad} onChange={signatureChanged} disabled={busy} />
      </section>

      <div className={stickyActionBar}>
        {error && !confirmOpen ? <p role="alert" className="mb-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">{error}</p> : null}
        <button type="button" onClick={open} disabled={busy} className={bigButton}>
          Conferma consegna
        </button>
      </div>

      <ConfirmSheet
        open={confirmOpen}
        title={`Confermi la consegna della corsa ${orderNumber}?`}
        confirmLabel={error ? "Riprova" : "Sì, consegna effettuata"}
        pendingLabel={phase === "uploading" ? `Invio firma… ${Math.round(progress)}%` : "Conferma in corso…"}
        pending={busy}
        onConfirm={submit}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>Riceve: <span className="font-semibold text-zinc-900">{name.trim()}</span></p>
        <p className="mt-2">Dopo la conferma la consegna non si può annullare.</p>
        {phase === "uploading" ? (
          <div role="progressbar" aria-label="Invio firma" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200">
            <div className="h-full bg-[#0B3B8C]" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-3 rounded-lg bg-red-50 p-2 text-red-800">{error}</p> : null}
      </ConfirmSheet>
    </div>
  );
}
