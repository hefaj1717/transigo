import { describe, expect, it } from "vitest";
import { toCompanyInfo, type CompanyRow } from "./company";

const row: CompanyRow = {
  company_name: "Transigo S.r.l.",
  company_vat_number: "12345678901",
  company_street: "Via Roma 1",
  company_city: "Milano",
  company_postal_code: "20121",
  company_province: "mi",
  company_email: "info@example.it",
  company_phone: " ",
  company_pec: null,
};

describe("toCompanyInfo", () => {
  it("formats the legal data for the footer", () => {
    expect(toCompanyInfo(row)).toEqual({
      name: "Transigo S.r.l.",
      registeredOffice: "Via Roma 1, 20121 Milano (MI)",
      vatNumber: "12345678901",
      email: "info@example.it",
      phone: null,
      pec: null,
    });
  });

  it("falls back to the brand name and hides an incomplete address", () => {
    expect(toCompanyInfo(null)).toMatchObject({ name: "Transigo", registeredOffice: null, vatNumber: null });
    expect(toCompanyInfo({ ...row, company_city: "" }).registeredOffice).toBeNull();
    expect(toCompanyInfo({ ...row, company_postal_code: null, company_province: null }).registeredOffice).toBe("Via Roma 1, Milano");
  });
});
