import { describe, expect, it } from "vitest";
import { bpToPercentInput, changedFields, companySchema, rulesSchema } from "./settings";

const emptyCompany = {
  company_name: "", company_vat_number: "", company_fiscal_code: "", company_street: "", company_city: "", company_postal_code: "",
  company_province: "", company_pec: "", company_sdi_code: "", company_email: "", company_phone: "",
};

describe("companySchema", () => {
  it("empty fields → null; codes upper-cased; values trimmed", () => {
    const v = companySchema.parse({ ...emptyCompany, company_name: "  Transigo S.r.l. ", company_province: "mi", company_sdi_code: "abc1234", company_fiscal_code: "12345678901" });
    expect(v).toMatchObject({ company_name: "Transigo S.r.l.", company_province: "MI", company_sdi_code: "ABC1234", company_vat_number: null, company_email: null });
  });

  it("refuses malformed P.IVA, CAP, province, e-mail, SDI", () => {
    for (const bad of [
      { company_vat_number: "1234" }, { company_postal_code: "2012" }, { company_province: "MIL" },
      { company_email: "not-an-email" }, { company_pec: "x@y" }, { company_sdi_code: "12345" }, { company_phone: "abc" },
    ]) {
      expect(companySchema.safeParse({ ...emptyCompany, ...bad }).success).toBe(false);
    }
  });
});

describe("rulesSchema", () => {
  it("percent → basis points without floats", () => {
    expect(rulesSchema.parse({ free_cancellation_hours: "24", late_cancellation_fee_bp: "50", payout_window_hours: "24", unassigned_alert_hours: "4" }))
      .toEqual({ free_cancellation_hours: 24, late_cancellation_fee_bp: 5000, payout_window_hours: 24, unassigned_alert_hours: 4 });
    expect(rulesSchema.parse({ free_cancellation_hours: "0", late_cancellation_fee_bp: "12,5", payout_window_hours: "0", unassigned_alert_hours: "1" }).late_cancellation_fee_bp).toBe(1250);
  });
  it("limits", () => {
    const base = { free_cancellation_hours: "24", late_cancellation_fee_bp: "50", payout_window_hours: "24", unassigned_alert_hours: "4" };
    for (const bad of [{ late_cancellation_fee_bp: "101" }, { late_cancellation_fee_bp: "-1" }, { free_cancellation_hours: "1,5" }, { unassigned_alert_hours: "0" }, { payout_window_hours: "999" }]) {
      expect(rulesSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("changedFields keeps only changes (null = empty)", () => {
    expect(changedFields({ a: 1, b: null, c: "x" }, { a: 1, b: null, c: "y" })).toEqual({ c: "y" });
    expect(changedFields(null, { a: null, b: 2 })).toEqual({ b: 2 });
  });
  it("bpToPercentInput", () => {
    expect(bpToPercentInput(5000)).toBe("50");
    expect(bpToPercentInput(1250)).toBe("12,5");
    expect(bpToPercentInput(0)).toBe("0");
  });
});
