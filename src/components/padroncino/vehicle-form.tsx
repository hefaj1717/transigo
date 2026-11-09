"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { createVehicleAction, setVehicleActiveAction, updateVehicleAction } from "@/app/(padroncino)/padroncino/actions";
import { FormMessage, SelectField, TextField } from "@/components/form-field";
import { initialCarrierFormState } from "@/lib/carriers/form-state";
import { CARRIER_PATHS } from "@/lib/carriers/onboarding";
import { changesApprovalFields, MAX_PAYLOAD_KG, MIN_DIMENSION_CM, MIN_PAYLOAD_KG, VEHICLE_MSG } from "@/lib/carriers/vehicles";
import { bigButton, bigButtonSecondary } from "./carrier-shell";

export type VehicleValues = {
  vehicleTypeId: string;
  plate: string;
  payloadKg: string;
  cargoLengthCm: string;
  cargoWidthCm: string;
  cargoHeightCm: string;
};

export const EMPTY_VEHICLE: VehicleValues = { vehicleTypeId: "", plate: "", payloadKg: "", cargoLengthCm: "", cargoWidthCm: "", cargoHeightCm: "" };

type Props = {
  /** null = new vehicle */
  vehicleId: string | null;
  initial: VehicleValues;
  types: { value: string; label: string }[];
  /** D107: the vehicle was approved once — its plate cannot change. */
  plateLocked: boolean;
  /** Currently approved: a change of type or payload sends it back to verification → ask first. */
  approved?: boolean;
};

// Vehicle form (D102, D107, D111). Units are always visible next to the fields; lower/upper bounds catch
// tonnes or metres typed instead of kg / cm (form only).
export function VehicleForm({ vehicleId, initial, types, plateLocked, approved = false }: Props) {
  const action = vehicleId ? updateVehicleAction.bind(null, vehicleId) : createVehicleAction;
  const [state, formAction, pending] = useActionState(action, initialCarrierFormState);
  const e = state.errors ?? {};
  const v = { ...initial, ...state.values };
  const formRef = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);
  const [asking, setAsking] = useState(false);

  // Confirmation only in the browser (no database change): an approved vehicle whose type or payload changes.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!approved || confirmed.current) {
      confirmed.current = false;
      return;
    }
    const form = new FormData(event.currentTarget);
    if (changesApprovalFields(initial, { vehicleTypeId: String(form.get("vehicleTypeId") ?? ""), payloadKg: String(form.get("payloadKg") ?? "") })) {
      event.preventDefault();
      setAsking(true);
    }
  }
  function confirm() {
    confirmed.current = true;
    setAsking(false);
    formRef.current?.requestSubmit();
  }

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className="space-y-5" noValidate>
      <FormMessage error={e._form} success={state.message} />
      <SelectField label="Tipo di veicolo" name="vehicleTypeId" options={types} defaultValue={v.vehicleTypeId} error={e.vehicleTypeId} required placeholder="Scegli il tipo" />

      <div>
        <TextField
          label="Targa"
          name="plate"
          defaultValue={plateLocked ? initial.plate : v.plate}
          error={e.plate}
          required
          maxLength={14}
          placeholder="es. AB123CD"
          readOnly={plateLocked}
          hint={plateLocked ? VEHICLE_MSG.plateLocked : "Senza spazi né trattini: li togliamo noi."}
        />
        {plateLocked || state.offerNewVehicle ? (
          <Link href={CARRIER_PATHS.newVehicle} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-[#0B3B8C] underline">
            Aggiungi nuovo veicolo
          </Link>
        ) : null}
      </div>

      <TextField
        label="Portata"
        name="payloadKg"
        inputMode="numeric"
        suffix="kg"
        placeholder="es. 1200"
        defaultValue={v.payloadKg}
        error={e.payloadKg}
        required
        hint={`Peso massimo del carico, in kg (da ${MIN_PAYLOAD_KG} a ${MAX_PAYLOAD_KG.toLocaleString("it-IT")}).`}
      />

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-zinc-900">Vano di carico (facoltativo)</legend>
        <p className="-mt-2 text-xs text-zinc-500">Misure interne in cm (almeno {MIN_DIMENSION_CM} cm).</p>
        <div className="grid grid-cols-3 gap-3">
          <TextField label="Lunghezza" name="cargoLengthCm" inputMode="numeric" suffix="cm" placeholder="es. 240" defaultValue={v.cargoLengthCm} error={e.cargoLengthCm} />
          <TextField label="Larghezza" name="cargoWidthCm" inputMode="numeric" suffix="cm" placeholder="es. 170" defaultValue={v.cargoWidthCm} error={e.cargoWidthCm} />
          <TextField label="Altezza" name="cargoHeightCm" inputMode="numeric" suffix="cm" placeholder="es. 180" defaultValue={v.cargoHeightCm} error={e.cargoHeightCm} />
        </div>
      </fieldset>

      {vehicleId ? (
        <p className="text-xs text-zinc-500">Se cambi tipo o portata di un veicolo approvato, il team Transigo dovrà verificarlo di nuovo.</p>
      ) : null}
      {asking ? (
        <div role="alertdialog" aria-labelledby="reverify-text" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p id="reverify-text" className="text-sm text-amber-900">{VEHICLE_MSG.reverifyConfirm}</p>
          <button type="button" onClick={confirm} className={bigButton}>Sì, salva</button>
          <button type="button" onClick={() => setAsking(false)} className={bigButtonSecondary}>Annulla</button>
        </div>
      ) : (
        <button type="submit" disabled={pending} className={bigButton}>
          {pending ? "Salvataggio…" : vehicleId ? "Salva modifiche" : "Aggiungi veicolo"}
        </button>
      )}
    </form>
  );
}

/** Deactivate / reactivate (no delete; the approval is kept, D107). */
export function VehicleActiveToggle({ vehicleId, isActive }: { vehicleId: string; isActive: boolean }) {
  const [state, action, pending] = useActionState(setVehicleActiveAction, initialCarrierFormState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="active" value={isActive ? "false" : "true"} />
      <FormMessage error={state.errors?._form} success={state.message} />
      <button type="submit" disabled={pending} className={bigButtonSecondary}>
        {pending ? "Attendere…" : isActive ? "Disattiva veicolo" : "Riattiva veicolo"}
      </button>
      <p className="text-xs text-zinc-500">
        {isActive
          ? "Un veicolo disattivato non viene usato per le corse. Puoi riattivarlo in qualsiasi momento."
          : "Il veicolo è disattivato e non viene usato per le corse."}
      </p>
    </form>
  );
}
