// Company data shown in the public footer. Italian law (art. 2250 c.c., art. 35 DPR 633/72) requires the
// website to show the legal name (ragione sociale), registered office (sede legale) and VAT number (P.IVA).
// Source: the `settings` row (company_* columns), edited by the owner.

export type CompanyRow = {
  company_name: string | null;
  company_vat_number: string | null;
  company_street: string | null;
  company_city: string | null;
  company_postal_code: string | null;
  company_province: string | null;
  company_email: string | null;
  company_phone: string | null;
  company_pec: string | null;
};

export type CompanyInfo = {
  /** Ragione sociale; falls back to the brand name until the owner fills the settings. */
  name: string;
  /** "Via Roma 1, 20100 Milano (MI)" — null when the street or the city is missing. */
  registeredOffice: string | null;
  vatNumber: string | null;
  email: string | null;
  phone: string | null;
  pec: string | null;
};

const clean = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

export function toCompanyInfo(row: CompanyRow | null): CompanyInfo {
  const street = clean(row?.company_street);
  const city = clean(row?.company_city);
  const cap = clean(row?.company_postal_code);
  const province = clean(row?.company_province)?.toUpperCase() ?? null;
  const registeredOffice =
    street && city ? `${street}, ${[cap, city].filter(Boolean).join(" ")}${province ? ` (${province})` : ""}` : null;
  return {
    name: clean(row?.company_name) ?? "Transigo",
    registeredOffice,
    vatNumber: clean(row?.company_vat_number),
    email: clean(row?.company_email),
    phone: clean(row?.company_phone),
    pec: clean(row?.company_pec),
  };
}
