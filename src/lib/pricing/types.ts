// Pricing engine types. Mirrors the price tables (supabase/migrations/*_pricing.sql) and
// order_lines (Stage 2b). All amounts in EUR cents, percentages in basis points.

export const PRICE_RULE_CODES = [
  "surcharge_urgent",
  "surcharge_weekend_holiday",
  "surcharge_floor_no_elevator",
  "porter_hour",
  "porter_overtime_hour",
  "porters_floor_no_elevator",
  "packing_flat",
  "packing_per_item",
  "storage_day",
  "storage_pallet_day",
  "storage_day_long",
  "storage_pallet_day_long",
  "transshipment_flat",
  "carrier_share_transport",
  "carrier_share_porters",
  "carrier_share_packing",
] as const;
export type PriceRuleCode = (typeof PRICE_RULE_CODES)[number];

/** Fixed load-size categories for porters (D67). Values per price list version. */
export const PORTER_PACKAGE_CODES = ["parcels", "monolocale", "bilocale", "trilocale_plus"] as const;
export type PorterPackageCode = (typeof PORTER_PACKAGE_CODES)[number];

export type PorterPackage = {
  code: PorterPackageCode;
  portersCount: number; // minimum persons; the customer may add more (max 4, D54)
  includedHours: number;
  isEnabled: boolean;
};

export type PriceRuleKind = "fixed" | "percent" | "per_unit";
export type StorageBillingUnit = "day" | "pallet_day";
export type StorageType = "transshipment" | "short_term" | "long_term";
export type CustomerType = "private" | "business";

export type OrderLineType =
  | "transport"
  | "surcharge_urgent"
  | "surcharge_weekend_holiday"
  | "surcharge_floors"
  | "porters"
  | "porters_floors" // porters-only service (D157); DB enum value added with the orders migration (D151)
  | "packing"
  | "storage";

export type CarrierShareGroup = "transport" | "porters" | "packing" | "none";

export type PriceRule = {
  code: PriceRuleCode;
  kind: PriceRuleKind;
  amountCents: number | null; // fixed / per_unit
  percentBp: number | null; // percent
  isEnabled: boolean;
};

export type VehicleRate = {
  vehicleTypeId: string;
  nameIt: string;
  ratePerKmCents: number;
  minPriceCents: number;
};

/** Porters-only service settings of a price list (D151, D157). Rate per person-hour = rule porter_hour. */
export type PortersServiceConfig = {
  minPersons: number; // D157: at least 2
  minHours: number; // minimum billed hours per person
  floorNoElevatorCents: number | null; // per floor without elevator; null = no surcharge
};

/** Storage box for private customers (D154). Price = full 30-day months × month + remaining days × day. */
export type StorageBox = {
  code: string;
  labelIt: string;
  volumeM3: number;
  dayCents: number;
  monthCents: number;
  isEnabled: boolean;
};

/** Everything calculatePrice needs besides the order itself. Built by the server-side loader. */
export type PricingConfig = {
  priceListId: string;
  priceListVersion: number;
  vatRateBp: number;
  urgentLeadHours: number; // D49
  storageShortTermMaxDays: number; // D55
  storageBillingUnit: StorageBillingUnit; // D55
  porterOvertimeGraceMinutes: number; // D68
  porterPackages: PorterPackage[]; // D67
  portersService: PortersServiceConfig | null; // D151; null = porters-only service not offered
  storageBoxes: StorageBox[]; // D154, ordered by size
  vehicleRates: VehicleRate[]; // active vehicle types with a rate in this price list
  rules: PriceRule[];
  holidays: string[]; // "YYYY-MM-DD" (Europe/Rome calendar dates), D27
  serviceAreaProvinces: string[]; // active province codes (sigle), D13
  maxRouteDistanceM: number; // D13
  minBookingLeadHours: number; // D50
};

/** One transport leg (D47). A warehouse order has two legs: A→warehouse and warehouse→B. */
export type PriceLeg = {
  distanceM: number; // road distance from Google Routes (server)
  vehicleTypeId: string;
  pickupAt: Date; // start of the pickup window
  pickupProvince: string; // sigla of the pickup address
  pickupFloor: number;
  pickupHasElevator: boolean;
  deliveryFloor: number;
  deliveryHasElevator: boolean;
};

export type PorterRequest = { legIndex: number; packageCode: PorterPackageCode; count?: number };

export type PriceInput = {
  customerType: CustomerType;
  now: Date; // quote time (urgent / lead-time checks)
  legs: PriceLeg[];
  /**
   * Porters per leg (D74): at most one entry per leg, each with its own load-size package (D67).
   * count defaults to the package's persons and may only be higher (max 4).
   */
  porters?: PorterRequest[];
  packing?: { itemsCount: number; legIndex?: number };
  storage?: { days: number; pallets?: number }; // days = 0 → transshipment
};

export type QuoteLine = {
  lineType: OrderLineType;
  labelIt: string;
  legIndex: number | null; // null for storage
  quantity: number;
  unitAmountCents: number | null;
  netCents: number;
  vatCents: number;
  grossCents: number;
  carrierShareGroup: CarrierShareGroup;
  carrierAmountCents: number;
};

export type QuoteWarning = { code: "negative_margin"; group: CarrierShareGroup; legIndex: number | null };

/**
 * Porter terms of the quote (D67, D68). Shown in the wizard ("In cena X h…") and stored with the order,
 * so overtime after the job is settled with the terms the customer bought (porterOvertimeCost).
 */
export type QuotePorters = {
  legIndex: number; // D74: terms per leg
  packageCode: PorterPackageCode;
  persons: number;
  includedHours: number;
  overtimeRatePerPersonCents: number | null; // null = overtime disabled in the price list
  overtimeGraceMinutes: number;
  /** Carrier share of this leg's porters group, to apply the same share to overtime. */
  carrierShare: { kind: "percent"; percentBp: number } | { kind: "ratio"; carrierCents: number; netCents: number } | null;
};

export type Quote = {
  priceListId: string;
  priceListVersion: number;
  customerType: CustomerType;
  /** D3: private customers see gross prices, businesses net + VAT. Amounts are the same. */
  display: "gross" | "net_plus_vat";
  vatRateBp: number;
  lines: QuoteLine[];
  subtotalCents: number; // net
  vatCents: number;
  totalCents: number; // gross = amount charged in Stripe
  carrierAmountCents: number;
  carrierAmountByLegCents: number[];
  storageType: StorageType | null;
  porters: QuotePorters[]; // one entry per leg with porters, ordered by legIndex (D74)
  isUrgentByLeg: boolean[];
  warnings: QuoteWarning[];
};

export type PricingError =
  | { code: "pickup_province"; legIndex: number; province: string }
  | { code: "max_distance"; legIndex: number; distanceM: number; maxDistanceM: number }
  | { code: "too_soon"; legIndex: number }
  | { code: "vehicle_not_priced"; legIndex: number; vehicleTypeId: string }
  | { code: "service_unavailable"; service: "porters" | "packing" | "storage" }
  | { code: "invalid_input"; message: string };

export type PriceResult = { ok: true; quote: Quote } | { ok: false; error: PricingError };
