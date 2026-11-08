import { describe, expect, it } from "vitest";
import { billingDetails, businessBillingSchema, contactsSchema, fieldErrors, privateBillingSchema } from "./checkout";

const address = { street: "Via Roma 1", city: "Milano", postalCode: "20121", province: "mi" };

describe("contacts", () => {
  it("normalises phones to E.164 and requires both people", () => {
    const ok = contactsSchema.parse({ pickupName: "Mario", pickupPhone: "333 123 4567", deliveryName: "Lucia", deliveryPhone: "+39 333 7654321" });
    expect(ok).toMatchObject({ pickupPhone: "+393331234567", deliveryPhone: "+393337654321", notes: "" });
    const bad = contactsSchema.safeParse({ pickupName: "", pickupPhone: "12", deliveryName: "L", deliveryPhone: "" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(Object.keys(fieldErrors(bad.error)).sort()).toEqual(["deliveryPhone", "pickupName", "pickupPhone"]);
  });
});

describe("billing (D43, D44)", () => {
  it("private: valid codice fiscale and address required", () => {
    expect(privateBillingSchema.parse({ fiscalCode: "rssmra80a01f205x", ...address })).toMatchObject({ fiscalCode: "RSSMRA80A01F205X", province: "MI" });
    const bad = privateBillingSchema.safeParse({ fiscalCode: "RSSMRA80A01F205A", ...address, postalCode: "201" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(fieldErrors(bad.error)).toMatchObject({ fiscalCode: "Codice fiscale non valido", postalCode: "Il CAP ha 5 cifre" });
  });

  it("business: P.IVA and SDI or PEC", () => {
    const base = { companyName: "Gamma Srl", vatNumber: "IT 00743110157", ...address };
    expect(businessBillingSchema.parse({ ...base, sdiCode: "m5uxcr1" })).toMatchObject({ vatNumber: "00743110157", sdiCode: "M5UXCR1" });
    expect(businessBillingSchema.safeParse(base).success).toBe(false);
    expect(businessBillingSchema.safeParse({ ...base, sdiCode: "0000000" }).success).toBe(false);
    expect(businessBillingSchema.safeParse({ ...base, sdiCode: "0000000", pec: "gamma@pec.it" }).success).toBe(true);
  });

  it("snapshot for order_charges.billing_details", () => {
    const person = { firstName: "Mario", lastName: "Rossi", email: "m@example.com" };
    expect(billingDetails("private", person, privateBillingSchema.parse({ fiscalCode: "RSSMRA80A01F205X", ...address }))).toEqual({
      customer_type: "private", first_name: "Mario", last_name: "Rossi", email: "m@example.com",
      fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Milano", postal_code: "20121", province: "MI", country: "IT",
    });
    const business = businessBillingSchema.parse({ companyName: "Gamma Srl", vatNumber: "00743110157", pec: "gamma@pec.it", ...address });
    expect(billingDetails("business", person, business)).toMatchObject({ customer_type: "business", company_name: "Gamma Srl", sdi_code: null, pec: "gamma@pec.it" });
    expect(() => billingDetails("private", person, business)).toThrow();
  });
});
