import type { PriceRuleCode, PriceRuleKind } from "./types";

// Admin UI metadata for pricing rules (Italian labels). Allowed kinds mirror the check constraint
// in the pricing migration.
export type RuleMeta = { label: string; section: "Supplementi" | "Servizi" | "Deposito" | "Quota padroncino"; kinds: PriceRuleKind[]; unit?: string };

export const RULE_META: Record<PriceRuleCode, RuleMeta> = {
  surcharge_urgent: { label: "Urgenza (ritiro entro le ore indicate)", section: "Supplementi", kinds: ["percent", "fixed"] },
  surcharge_weekend_holiday: { label: "Weekend e festivi", section: "Supplementi", kinds: ["percent", "fixed"] },
  surcharge_floor_no_elevator: { label: "Piano senza ascensore", section: "Supplementi", kinds: ["per_unit"], unit: "piano" },
  porter_hour: { label: "Facchinaggio", section: "Servizi", kinds: ["per_unit"], unit: "persona/ora" },
  packing_flat: { label: "Imballaggio, forfait", section: "Servizi", kinds: ["fixed"] },
  packing_per_item: { label: "Imballaggio, per collo", section: "Servizi", kinds: ["per_unit"], unit: "collo" },
  transshipment_flat: { label: "Trasbordo (0 giorni)", section: "Deposito", kinds: ["fixed"] },
  storage_day: { label: "Deposito breve, per giorno", section: "Deposito", kinds: ["per_unit"], unit: "giorno" },
  storage_pallet_day: { label: "Deposito breve, per pallet/giorno", section: "Deposito", kinds: ["per_unit"], unit: "pallet/giorno" },
  storage_day_long: { label: "Deposito lungo, per giorno", section: "Deposito", kinds: ["per_unit"], unit: "giorno" },
  storage_pallet_day_long: { label: "Deposito lungo, per pallet/giorno", section: "Deposito", kinds: ["per_unit"], unit: "pallet/giorno" },
  carrier_share_transport: { label: "Trasporto e supplementi", section: "Quota padroncino", kinds: ["percent", "fixed"] },
  carrier_share_porters: { label: "Facchinaggio", section: "Quota padroncino", kinds: ["percent", "fixed"] },
  carrier_share_packing: { label: "Imballaggio", section: "Quota padroncino", kinds: ["percent", "fixed"] },
};

export const KIND_LABEL: Record<PriceRuleKind, string> = { percent: "%", fixed: "€ fisso", per_unit: "€ per unità" };
