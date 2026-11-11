import { ActionForm } from "@/components/admin/action-form";
import { inputClass } from "@/components/admin/admin-nav";
import type { AdminExecutionView, ViewPhoto } from "@/lib/orders/execution-read";
import {
  ADMIN_NOTE_LABEL,
  earlyStartLegs,
  groupPhotos,
  PHOTO_KIND_LABEL,
  positionUrl,
  revertTarget,
  stepTitle,
} from "@/lib/orders/execution-view";
import { allowEarlyStartAction, revertLastStepAction } from "../actions";

// "Esecuzione" on /admin/ordini/[id]: recorded steps (with reverted ones, who and where), photos, POD, porter time,
// the corrections "Annulla ultimo passo" / "Consenti inizio anticipato", and the internal notes. Server component;
// every value comes from loadAdminExecution() (admin session).

type Leg = { leg_index: number; pickup_window_start: string; early_start_allowed_at: string | null };

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
const section = "mt-8";
const h2 = "mb-3 text-lg font-semibold text-zinc-900";
const h3 = "mb-2 text-sm font-semibold text-zinc-800";

export function Execution({ orderId, status, legs, exec, actorName }: {
  orderId: string;
  status: string;
  legs: Leg[];
  exec: AdminExecutionView;
  actorName: (id: string | null) => string | null;
}) {
  const revert = revertTarget(status, exec.steps.map((s) => ({ leg_index: s.legIndex, step: s.step, reverted_at: s.revertedAt })));
  const early = earlyStartLegs(status, legs, exec.steps.map((s) => ({ leg_index: s.legIndex, step: s.step, reverted_at: s.revertedAt })));
  const allowedLegs = legs.filter((l) => l.early_start_allowed_at);
  const nothing = !exec.steps.length && !exec.photos.length && !exec.proof && !exec.notes.length && !revert && !early.length && !allowedLegs.length;
  if (nothing) return null;
  const multi = legs.length > 1;

  return (
    <>
      <section className={section} aria-labelledby="execution">
        <h2 id="execution" className={h2}>Esecuzione</h2>

        {exec.steps.length ? (
          <ol className="space-y-1 text-sm">
            {exec.steps.map((s) => {
              const where = positionUrl(s.lat, s.lng);
              return (
                <li key={s.id} className={s.revertedAt ? "text-zinc-400" : undefined}>
                  <span className={s.revertedAt ? "line-through" : "font-medium text-zinc-900"}>{stepTitle(s.legIndex, s.step, legs.length)}</span>
                  <span className={s.revertedAt ? "" : "text-zinc-500"}> · {rome(s.createdAt)}{actorName(s.createdBy) ? ` · ${actorName(s.createdBy)}` : ""}</span>
                  {where ? <> · <a href={where} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">posizione</a></> : null}
                  {s.revertedAt ? (
                    <span> — annullato {rome(s.revertedAt)}{s.revertedBy ? ` da ${actorName(s.revertedBy) ?? "admin"}` : " (cambio padroncino)"}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-zinc-600">Il padroncino non ha ancora registrato nessun passo.</p>
        )}

        {allowedLegs.length ? (
          <p className="mt-2 text-sm text-zinc-700">
            {allowedLegs.map((l) => `Inizio anticipato consentito${multi ? ` (tratta ${l.leg_index + 1})` : ""} il ${rome(l.early_start_allowed_at!)}`).join(" · ")}
          </p>
        ) : null}

        {revert || early.length ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {revert ? (
              <ActionForm action={revertLastStepAction} submitLabel="Annulla ultimo passo" variant="danger" className="rounded-md border border-zinc-200 p-3">
                <input type="hidden" name="orderId" value={orderId} />
                <input type="hidden" name="leg" value={revert.legIndex} />
                <input type="hidden" name="step" value={revert.step} />
                <p className="text-sm text-zinc-800">Passo da annullare: <strong>{stepTitle(revert.legIndex, revert.step, legs.length)}</strong></p>
                <p className="mt-1 text-xs text-zinc-500">
                  Per correggere un errore del padroncino: il passo torna da fare.
                  {revert.legIndex === 0 && (revert.step === "loaded" || revert.step === "departed") ? " Lo stato dell'ordine torna indietro." : ""} Le foto restano.
                </p>
                <label htmlFor="revert-reason" className="mt-2 block text-sm font-medium text-zinc-800">Motivo (obbligatorio)</label>
                <textarea id="revert-reason" name="reason" required maxLength={1000} rows={2} className={`${inputClass} mt-1 w-full`} />
                <p className="mt-1 text-xs text-zinc-500">Il motivo è interno: lo vedono solo gli amministratori.</p>
              </ActionForm>
            ) : null}
            {early.map((leg) => (
              <ActionForm key={leg} action={allowEarlyStartAction} submitLabel="Consenti inizio anticipato" variant="secondary" className="rounded-md border border-zinc-200 p-3">
                <input type="hidden" name="orderId" value={orderId} />
                <input type="hidden" name="leg" value={leg} />
                <p className="text-sm text-zinc-800">
                  {multi ? `Tratta ${leg + 1}: ` : ""}il padroncino potrà iniziare prima del giorno di ritiro
                  ({new Date(legs.find((l) => l.leg_index === leg)!.pickup_window_start).toLocaleDateString("it-IT", { timeZone: "Europe/Rome", dateStyle: "medium" })}).
                </p>
                <label htmlFor={`early-reason-${leg}`} className="mt-2 block text-sm font-medium text-zinc-800">Motivo (obbligatorio)</label>
                <textarea id={`early-reason-${leg}`} name="reason" required maxLength={1000} rows={2} className={`${inputClass} mt-1 w-full`} />
                <p className="mt-1 text-xs text-zinc-500">Il motivo è interno: lo vedono solo gli amministratori.</p>
              </ActionForm>
            ))}
          </div>
        ) : null}

        {exec.porters.length ? (
          <div className="mt-4">
            <h3 className={h3}>Facchini</h3>
            <ul className="space-y-1 text-sm">
              {exec.porters.map((p) => (
                <li key={p.legIndex}>
                  {multi ? `Tratta ${p.legIndex + 1}: ` : ""}
                  <span className="font-medium">{p.workedLabel}</span> lavorati ({p.workedMinutes} min) su {p.includedLabel} inclusi
                  {p.complete ? "" : <span className="text-zinc-500"> · in corso</span>}
                  {p.overtimeHours > 0 ? <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">straordinario: {p.overtimeHours} h a persona</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {exec.proof ? (
          <div className="mt-4">
            <h3 className={h3}>Prova di consegna</h3>
            <div className="flex flex-wrap items-start gap-4 text-sm">
              <div>
                <p>Ricevuto da <strong>{exec.proof.recipientName}</strong></p>
                <p className="text-zinc-500">
                  {rome(exec.proof.signedAt)}{actorName(exec.proof.createdBy) ? ` · ${actorName(exec.proof.createdBy)}` : ""}
                  {positionUrl(exec.proof.lat, exec.proof.lng) ? (
                    <> · <a href={positionUrl(exec.proof.lat, exec.proof.lng)!} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">posizione</a></>
                  ) : null}
                </p>
              </div>
              {exec.proof.signatureUrl ? (
                <a href={exec.proof.signatureUrl} target="_blank" rel="noopener noreferrer" className="block rounded border border-zinc-200 bg-white p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, no optimizer */}
                  <img src={exec.proof.signatureUrl} alt={`Firma di ${exec.proof.recipientName}`} className="h-20 w-auto" />
                </a>
              ) : <p className="text-zinc-500">Firma non disponibile.</p>}
            </div>
          </div>
        ) : null}

        {exec.photos.length ? <Photos photos={exec.photos} multi={multi} /> : null}
      </section>

      {exec.notes.length ? (
        <section className={section} aria-labelledby="notes">
          <h2 id="notes" className={h2}>Note interne</h2>
          <ol className="space-y-2 text-sm">
            {exec.notes.map((n) => (
              <li key={n.id} className="rounded-md bg-zinc-50 p-2">
                <p className="text-xs text-zinc-500">
                  {rome(n.createdAt)} · {ADMIN_NOTE_LABEL[n.kind] ?? n.kind}{multi && n.legIndex !== null ? ` (tratta ${n.legIndex + 1})` : ""}
                  {actorName(n.createdBy) ? ` · ${actorName(n.createdBy)}` : ""}
                </p>
                <p className="whitespace-pre-line text-zinc-900">{n.body}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function Photos({ photos, multi }: { photos: ViewPhoto[]; multi: boolean }) {
  return (
    <div className="mt-4 space-y-3">
      {groupPhotos(photos).map((g) => (
        <div key={`${g.legIndex}-${g.kind}`}>
          <h3 className={h3}>Foto {PHOTO_KIND_LABEL[g.kind].toLowerCase()}{multi ? ` · tratta ${g.legIndex + 1}` : ""} ({g.photos.length})</h3>
          <ul className="flex flex-wrap gap-2">
            {g.photos.map((p) => (
              <li key={p.id}>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="block size-24 overflow-hidden rounded border border-zinc-200" title={rome(p.createdAt)}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, no optimizer */}
                    <img src={p.url} alt={`Foto ${PHOTO_KIND_LABEL[p.kind].toLowerCase()} del ${rome(p.createdAt)}`} className="size-full object-cover" />
                  </a>
                ) : (
                  <span className="flex size-24 items-center justify-center rounded border border-dashed border-zinc-300 text-center text-xs text-zinc-500">non disponibile</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
