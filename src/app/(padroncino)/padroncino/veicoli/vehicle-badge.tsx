import { vehicleApprovalState } from "@/lib/carriers/vehicles";

const LABEL = { approved: "Approvato", new: "In attesa di verifica", reverify: "Da verificare di nuovo" } as const;
const STYLE = {
  approved: "bg-green-100 text-green-800",
  new: "bg-amber-100 text-amber-900",
  reverify: "bg-amber-100 text-amber-900",
} as const;

export function VehicleBadge({ vehicle }: { vehicle: { is_active: boolean; approved_at: string | null; first_approved_at: string | null } }) {
  if (!vehicle.is_active) return <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700">Disattivato</span>;
  const state = vehicleApprovalState(vehicle);
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[state]}`}>{LABEL[state]}</span>;
}
