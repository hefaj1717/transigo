import { ActionForm } from "@/components/admin/action-form";
import { inputClass } from "@/components/admin/admin-nav";
import {
  activeRefundCents,
  canRetryRefund,
  cancellationDecisionSuggestion,
  centsToInput,
  MANUAL_REFUND_REASONS,
  PAYMENT_REVIEW_REASON_LABEL,
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
  type RefundLike,
} from "@/lib/orders/admin-refunds";
import { formatCents } from "@/lib/pricing/money";
import { decideCancellationAction, refundOrderAction, resolvePaymentReviewAction, retryRefundAction } from "../actions";

// "Pagamenti e rimborsi" of one order (D140–D142): the cancellation decision, payments to check, refunds with
// "Riprova", a manual refund. Data read by the page with the admin's session; every button goes through a Server
// Action and a database function that checks the amounts again.

export type MoneyPayment = {
  id: string; status: string; amount_cents: number; amount_received_cents: number | null; review_reason: string | null;
  reviewed_at: string | null; review_outcome: string | null; paid_at: string | null; created_at: string;
};
export type MoneyRefund = RefundLike & { kind: string; reason: string; payment_id: string; created_at: string };
export type MoneyData = {
  orderId: string;
  status: string;
  pickupWindowStart: string;
  totalCents: number;
  cancellationFeeCents: number | null;
  cancellationRequestedAt: string | null;
  cancellationReason: string | null;
  carrierAmountCents: number;
  lines: { line_type: string; gross_cents: number }[];
  payments: MoneyPayment[];
  refunds: MoneyRefund[];
  decision: { refund_cents: number; carrier_cents: number; decided_at: string } | null;
  settings: { freeHours: number; feeBp: number };
};

const REFUNDABLE_STATUSES = ["paid", "assigned", "picked_up", "in_transit", "delivered", "completed", "cancelled"];
const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");
const box = "rounded-md border border-zinc-200 p-3";

/** The payment the order stands on — the same rule as public.order_main_payment(). */
function mainPayment(payments: MoneyPayment[]) {
  return payments
    .filter((p) => p.status === "succeeded" && (!p.review_reason || p.review_outcome === "accepted"))
    .sort((a, b) => (a.paid_at ?? "").localeCompare(b.paid_at ?? ""))[0];
}

export function Money({ d }: { d: MoneyData }) {
  const succeeded = d.payments.filter((p) => p.status === "succeeded");
  const main = mainPayment(d.payments);
  const refundable = main ? (main.amount_received_cents ?? main.amount_cents) - activeRefundCents(d.refunds.filter((r) => r.payment_id === main.id)) : 0;
  const pickupPassed = new Date(d.pickupWindowStart) <= new Date();
  const refunds = [...d.refunds].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <section className="mt-8" aria-labelledby="payments">
      <h2 id="payments" className="mb-3 text-lg font-semibold text-zinc-900">Pagamenti e rimborsi</h2>

      {d.status === "cancellation_review" ? <Decision d={d} /> : null}

      {d.decision ? (
        <p className="mb-3 rounded-md bg-zinc-50 p-3 text-sm">
          Annullamento deciso il {rome(d.decision.decided_at)}: rimborso al cliente {formatCents(d.decision.refund_cents)}, al padroncino{" "}
          {formatCents(d.decision.carrier_cents)} (pagamento nella fase pagamenti), trattenuto {formatCents(d.cancellationFeeCents ?? 0)}.
        </p>
      ) : d.status === "cancelled" && d.cancellationFeeCents !== null ? (
        <p className="mb-3 text-sm text-zinc-700">Annullato dal cliente — penale {formatCents(d.cancellationFeeCents)}.</p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="text-sm">
          <p className="mb-1 font-medium text-zinc-900">Pagamenti Stripe</p>
          {succeeded.length ? (
            <ul className="space-y-2">
              {succeeded.map((p) => (
                <li key={p.id} className={box}>
                  <p>
                    {formatCents(p.amount_received_cents ?? p.amount_cents)} · {rome(p.paid_at)}
                    {p.amount_received_cents !== null && p.amount_received_cents !== p.amount_cents ? ` (atteso ${formatCents(p.amount_cents)})` : ""}
                  </p>
                  {p.review_reason ? (
                    <p className={p.reviewed_at ? "text-zinc-600" : "font-medium text-amber-900"}>
                      {PAYMENT_REVIEW_REASON_LABEL[p.review_reason] ?? p.review_reason}
                      {p.reviewed_at ? ` — ${p.review_outcome === "accepted" ? "accettato" : "rimborsato"} il ${rome(p.reviewed_at)}` : " — da verificare"}
                    </p>
                  ) : null}
                  {p.review_reason && !p.reviewed_at ? <ReviewButtons d={d} p={p} pickupPassed={pickupPassed} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-600">Nessun pagamento ricevuto.</p>
          )}
        </div>

        <div className="text-sm">
          <p className="mb-1 font-medium text-zinc-900">Rimborsi</p>
          {refunds.length ? (
            <ul className="space-y-2">
              {refunds.map((r) => (
                <li key={r.id} className={box}>
                  <p>
                    {formatCents(r.amount_cents)} · {REFUND_REASON_LABEL[r.reason] ?? r.reason} · {rome(r.created_at)}
                  </p>
                  <p className={r.status === "failed" ? "text-red-800" : r.status === "pending" ? "text-amber-900" : "text-green-800"}>
                    {REFUND_STATUS_LABEL[r.status] ?? r.status}
                    {r.retry_of ? " (nuovo tentativo)" : ""}
                    {r.status === "pending" && r.stripe_refund_id ? " — in elaborazione da Stripe" : ""}
                    {r.status === "pending" && !r.stripe_refund_id ? " — non ancora inviato a Stripe" : ""}
                  </p>
                  {canRetryRefund(r, d.refunds) ? (
                    <ActionForm action={retryRefundAction} submitLabel="Riprova" variant="secondary">
                      <input type="hidden" name="refundId" value={r.id} />
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-600">Nessun rimborso.</p>
          )}
          <p className="mt-2 text-xs text-zinc-500">Ogni rimborso riuscito genera una nota di credito (sezione «Fatture»), dopo l&apos;emissione della fattura.</p>
        </div>
      </div>

      {main && refundable > 0 && REFUNDABLE_STATUSES.includes(d.status) ? <ManualRefund d={d} refundable={refundable} /> : null}
    </section>
  );
}

function Decision({ d }: { d: MoneyData }) {
  const main = mainPayment(d.payments);
  const alreadyRefunded = activeRefundCents(d.refunds);
  const s = cancellationDecisionSuggestion({
    requestedAt: new Date(d.cancellationRequestedAt ?? d.pickupWindowStart), // always set in cancellation_review (constraint)
    pickupWindowStart: new Date(d.pickupWindowStart),
    freeHours: d.settings.freeHours,
    feeBp: d.settings.feeBp,
    totalCents: d.totalCents,
    refundedCents: alreadyRefunded,
    lines: d.lines,
  });
  const maxRefund = main ? (main.amount_received_cents ?? main.amount_cents) - alreadyRefunded : 0;
  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-950">Il cliente ha chiesto l&apos;annullamento il {rome(d.cancellationRequestedAt)} (padroncino già assegnato).</p>
      {d.cancellationReason ? <p className="mt-1 whitespace-pre-line text-zinc-800">Motivo del cliente: {d.cancellationReason}</p> : null}
      <p className="mt-1 text-zinc-800">
        Proposta secondo la regola standard ({d.settings.freeHours} h, {d.settings.feeBp / 100} %):{" "}
        {s.late ? `penale ${formatCents(s.feeCents)}, rimborso ${formatCents(s.refundCents)}.` : `annullamento gratuito, rimborso ${formatCents(s.refundCents)}.`}
        {" "}Il padroncino ha già ricevuto l&apos;e-mail che la corsa è annullata.
      </p>
      <ActionForm action={decideCancellationAction} submitLabel="Conferma annullamento" variant="danger" className="mt-3 grid gap-2 sm:max-w-md">
        <input type="hidden" name="orderId" value={d.orderId} />
        <label className="flex flex-col gap-1">
          <span className="font-medium text-zinc-800">Rimborso al cliente (€, massimo {formatCents(maxRefund)})</span>
          <input name="refund" required inputMode="decimal" defaultValue={centsToInput(Math.min(s.refundCents, maxRefund))} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium text-zinc-800">Importo per il padroncino (€, massimo {formatCents(d.carrierAmountCents)})</span>
          <input name="carrier" required inputMode="decimal" defaultValue="0,00" className={inputClass} />
          <span className="text-xs text-zinc-600">Nessun compenso automatico: verrà pagato con fattura del padroncino nella fase pagamenti.</span>
        </label>
        <p className="text-xs text-zinc-600">L&apos;ordine passa in «Annullato», il rimborso parte subito su Stripe e il cliente riceve un&apos;e-mail.</p>
      </ActionForm>
    </div>
  );
}

function ReviewButtons({ d, p, pickupPassed }: { d: MoneyData; p: MoneyPayment; pickupPassed: boolean }) {
  const canMarkPaid = p.review_reason !== "duplicate_payment" && d.status === "payment_review";
  return (
    <div className="mt-2 flex flex-wrap gap-3">
      {canMarkPaid ? (
        <ActionForm action={resolvePaymentReviewAction} submitLabel="Segna come pagato">
          <input type="hidden" name="paymentId" value={p.id} />
          <input type="hidden" name="action" value="mark_paid" />
          {pickupPassed ? <p className="text-xs text-amber-900">La finestra di ritiro è già iniziata: nessun padroncino potrà accettare. Valuta il rimborso.</p> : null}
        </ActionForm>
      ) : null}
      <ActionForm action={resolvePaymentReviewAction} submitLabel={`Rimborsa ${formatCents(p.amount_received_cents ?? p.amount_cents)}`} variant="danger">
        <input type="hidden" name="paymentId" value={p.id} />
        <input type="hidden" name="action" value="refund" />
        <p className="text-xs text-zinc-600">
          {p.review_reason === "duplicate_payment" ? "Rimborsa solo questo secondo pagamento; l'ordine resta pagato." : "Rimborso totale: l'ordine diventa «Rimborsato»."}
        </p>
      </ActionForm>
    </div>
  );
}

function ManualRefund({ d, refundable }: { d: MoneyData; refundable: number }) {
  const inProgress = ["assigned", "picked_up", "in_transit"].includes(d.status);
  return (
    <details className="mt-4 rounded-md border border-zinc-200 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-zinc-900">Rimborso manuale (ancora rimborsabile {formatCents(refundable)})</summary>
      <ActionForm action={refundOrderAction} submitLabel="Rimborsa" variant="danger" className="mt-3 grid gap-2 sm:max-w-md">
        <input type="hidden" name="orderId" value={d.orderId} />
        <label className="flex flex-col gap-1">
          <span className="font-medium text-zinc-800">Importo (€)</span>
          <input name="amount" required inputMode="decimal" placeholder={centsToInput(refundable)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium text-zinc-800">Motivo</span>
          <select name="reason" required defaultValue="" className={inputClass}>
            <option value="" disabled>Scegli…</option>
            {MANUAL_REFUND_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          <span className="text-xs text-zinc-600">I dettagli vanno nelle «Note interne».</span>
        </label>
        <p className="text-xs text-zinc-600">
          {inProgress
            ? "Corsa in corso: solo rimborso parziale (per quello totale rimuovi prima il padroncino)."
            : d.status === "cancelled"
              ? "L'ordine resta «Annullato»."
              : "Rimborsando tutto l'importo l'ordine diventa «Rimborsato»; un rimborso parziale non cambia lo stato."}
        </p>
      </ActionForm>
    </details>
  );
}
