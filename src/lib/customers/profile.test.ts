import { describe, expect, it } from "vitest";
import { MSG } from "@/lib/auth/schemas";
import {
  billingComplete,
  billingFormValues,
  billingRow,
  billingSchemaFor,
  changePasswordSchema,
  personalDataRow,
  personalDataSchema,
  PROFILE_MSG,
  type CustomerRow,
} from "./profile";

const address = { street: "Via Dante 12", city: "Milano", postalCode: "20121", province: "mi" };
const emptyRow: CustomerRow = {
  customer_type: "private", company_name: null, vat_number: null, fiscal_code: null, sdi_code: null, pec: null,
  billing_street: null, billing_city: null, billing_postal_code: null, billing_province: null,
};

describe("personal data", () => {
  it("normalizes the phone and maps to profiles columns", () => {
    const d = personalDataSchema.parse({ firstName: " Giulia ", lastName: "Conti", phone: "340 111 2233" });
    expect(personalDataRow(d)).toEqual({ first_name: "Giulia", last_name: "Conti", phone: "+393401112233" });
  });

  it("an empty phone clears it", () => {
    expect(personalDataRow(personalDataSchema.parse({ firstName: "G", lastName: "C", phone: "" })).phone).toBeNull();
  });

  it("requires name and surname", () => {
    expect(personalDataSchema.safeParse({ firstName: " ", lastName: "", phone: "" }).success).toBe(false);
  });
});

describe("billing data", () => {
  it("private: codice fiscale + address, no company fields", () => {
    const d = billingSchemaFor("private").parse({ fiscalCode: "rssmra85t10a562s", ...address, companyName: "X Srl", vatNumber: "01234567897" });
    expect(billingRow("private", d)).toEqual({
      fiscal_code: "RSSMRA85T10A562S", billing_street: "Via Dante 12", billing_city: "Milano", billing_postal_code: "20121", billing_province: "MI", billing_country: "IT",
    });
  });

  it("private: an invalid codice fiscale is refused", () => {
    const r = billingSchemaFor("private").safeParse({ fiscalCode: "ABC", ...address });
    expect(r.success).toBe(false);
  });

  it("business: company data and SDI or PEC, no codice fiscale", () => {
    const d = billingSchemaFor("business").parse({ companyName: "Conti Srl", vatNumber: "IT 01234567897", sdiCode: "m5uxcr1", pec: "", ...address, fiscalCode: "RSSMRA85T10A562S" });
    const row = billingRow("business", d);
    expect(row).toMatchObject({ company_name: "Conti Srl", vat_number: "01234567897", sdi_code: "M5UXCR1", pec: null, billing_province: "MI" });
    expect(row).not.toHaveProperty("fiscal_code");
  });

  it("business: without SDI and PEC is refused", () => {
    const r = billingSchemaFor("business").safeParse({ companyName: "Conti Srl", vatNumber: "01234567897", ...address });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe(MSG.einvoiceChannel);
  });

  it("data of the other type throws (the type never changes)", () => {
    const d = billingSchemaFor("private").parse({ fiscalCode: "RSSMRA85T10A562S", ...address });
    expect(() => billingRow("business", d)).toThrow();
  });

  it("row → form values and completeness", () => {
    expect(billingFormValues(emptyRow).fiscalCode).toBe("");
    expect(billingComplete(emptyRow)).toBe(false);
    const full = { ...emptyRow, fiscal_code: "RSSMRA85T10A562S", billing_street: "Via Dante 12", billing_city: "Milano", billing_postal_code: "20121", billing_province: "MI" };
    expect(billingComplete(full)).toBe(true);
  });
});

describe("password change", () => {
  const ok = { currentPassword: "vecchia123", password: "nuova12345", passwordConfirm: "nuova12345" };

  it("accepts a valid change", () => {
    expect(changePasswordSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses a mismatch, a weak password and the same password", () => {
    const issue = (input: typeof ok) => {
      const r = changePasswordSchema.safeParse(input);
      return r.success ? null : r.error.issues[0];
    };
    expect(issue({ ...ok, passwordConfirm: "altra12345" })?.message).toBe(MSG.passwordMismatch);
    expect(issue({ ...ok, password: "solo", passwordConfirm: "solo" })?.message).toBe(MSG.passwordLength);
    expect(issue({ ...ok, password: "vecchia123", passwordConfirm: "vecchia123" })?.message).toBe(PROFILE_MSG.samePassword);
    expect(issue({ ...ok, currentPassword: "" })?.path).toEqual(["currentPassword"]);
  });
});
