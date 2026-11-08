import { describe, expect, it } from "vitest";
import {
  carrierRegistrationSchema,
  customerRegistrationSchema,
  formDataToObject,
  forgotPasswordSchema,
  MSG,
  resetPasswordSchema,
  signInSchema,
  toFieldErrors,
} from "./schemas";
import type { z } from "zod";

function errorsOf(schema: z.ZodType, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected failure, got ${JSON.stringify(r.data)}`);
  return toFieldErrors(r.error);
}

const account = {
  firstName: " Maria ",
  lastName: "Rossi",
  email: " Maria.Rossi@Example.COM ",
  password: "segreta123",
  passwordConfirm: "segreta123",
  acceptTerms: "on",
  acceptPrivacy: "on",
};

const privateInput = { customerType: "private", ...account };
const businessInput = {
  customerType: "business",
  ...account,
  companyName: "Beta Srl",
  vatNumber: "IT 00743110157",
  sdiCode: "m5uxcr1",
};
const carrierInput = {
  ...account,
  phone: "333 123 4567",
  companyName: "Trasporti Rossi",
  vatNumber: "00743110157",
  fiscalCode: "rssmra85t10a562s",
  hqStreet: "Via Roma 1",
  hqCity: "Milano",
  hqPostalCode: "20121",
  hqProvince: "mi",
  pec: "Trasporti@PEC.it",
};

describe("customer registration: private (D43)", () => {
  it("accepts name, e-mail, password and consents only; normalizes values", () => {
    const r = customerRegistrationSchema.parse(privateInput);
    expect(r).toMatchObject({
      customerType: "private",
      firstName: "Maria",
      email: "maria.rossi@example.com",
      acceptTerms: true,
      acceptPrivacy: true,
    });
    expect(r.phone).toBeUndefined();
  });
  it("does not ask for codice fiscale or billing address", () => {
    const r = customerRegistrationSchema.parse({ ...privateInput, fiscalCode: "garbage" });
    expect(r).not.toHaveProperty("fiscalCode");
  });
  it("optional phone is normalized to E.164, invalid phone is rejected", () => {
    expect(customerRegistrationSchema.parse({ ...privateInput, phone: "333 1234567" }).phone).toBe("+393331234567");
    expect(customerRegistrationSchema.parse({ ...privateInput, phone: "  " }).phone).toBeUndefined();
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, phone: "123" })).toEqual({ phone: MSG.phone });
  });
  it("requires first and last name", () => {
    const e = errorsOf(customerRegistrationSchema, { ...privateInput, firstName: "  ", lastName: undefined });
    expect(e.firstName).toBe(MSG.required);
    expect(e.lastName).toBe(MSG.required);
  });
  it("rejects an invalid e-mail", () => {
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, email: "maria@" }).email).toBe(MSG.email);
  });
});

describe("customer registration: business (D44)", () => {
  it("accepts company name, P.IVA and SDI; normalizes P.IVA and SDI", () => {
    const r = customerRegistrationSchema.parse(businessInput);
    expect(r).toMatchObject({ customerType: "business", companyName: "Beta Srl", vatNumber: "00743110157", sdiCode: "M5UXCR1" });
  });
  it("accepts PEC instead of SDI", () => {
    const r = customerRegistrationSchema.parse({ ...businessInput, sdiCode: "", pec: " Beta@PEC.it " });
    expect(r).toMatchObject({ pec: "beta@pec.it" });
    expect(r).toMatchObject({ sdiCode: undefined });
  });
  it("requires SDI or PEC", () => {
    expect(errorsOf(customerRegistrationSchema, { ...businessInput, sdiCode: "" })).toEqual({ sdiCode: MSG.einvoiceChannel });
  });
  it("SDI 0000000 requires a PEC", () => {
    expect(errorsOf(customerRegistrationSchema, { ...businessInput, sdiCode: "0000000" })).toEqual({ pec: MSG.pecRequiredWithZeroSdi });
    expect(customerRegistrationSchema.safeParse({ ...businessInput, sdiCode: "0000000", pec: "a@pec.it" }).success).toBe(true);
  });
  it("rejects invalid P.IVA, SDI and PEC", () => {
    const e = errorsOf(customerRegistrationSchema, { ...businessInput, vatNumber: "00743110158", sdiCode: "ABC", pec: "x" });
    expect(e).toMatchObject({ vatNumber: MSG.vat, sdiCode: MSG.sdi, pec: MSG.pec });
  });
  it("requires company name and P.IVA", () => {
    const e = errorsOf(customerRegistrationSchema, { ...businessInput, companyName: "", vatNumber: "" });
    expect(e).toMatchObject({ companyName: MSG.required, vatNumber: MSG.required });
  });
});

describe("customer registration: common rules", () => {
  it("requires choosing private or business", () => {
    expect(errorsOf(customerRegistrationSchema, { ...account }).customerType).toBe(MSG.customerType);
    expect(errorsOf(customerRegistrationSchema, { ...account, customerType: "admin" }).customerType).toBe(MSG.customerType);
  });
  it("requires both consents separately (D42)", () => {
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, acceptTerms: undefined })).toEqual({ acceptTerms: MSG.terms });
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, acceptPrivacy: "off" })).toEqual({ acceptPrivacy: MSG.privacy });
  });
  it("password: length, strength and confirmation", () => {
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, password: "abc1", passwordConfirm: "abc1" }).password).toBe(MSG.passwordLength);
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, password: "abcdefgh", passwordConfirm: "abcdefgh" }).password).toBe(MSG.passwordStrength);
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, password: `a1${"x".repeat(71)}`, passwordConfirm: "" }).password).toBe(MSG.passwordTooLong);
    expect(errorsOf(customerRegistrationSchema, { ...privateInput, passwordConfirm: "segreta124" })).toEqual({ passwordConfirm: MSG.passwordMismatch });
  });
  it("ignores unknown fields such as role", () => {
    const r = customerRegistrationSchema.parse({ ...privateInput, role: "admin" });
    expect(r).not.toHaveProperty("role");
  });
});

describe("carrier registration (D45)", () => {
  it("accepts complete data and normalizes it", () => {
    const r = carrierRegistrationSchema.parse(carrierInput);
    expect(r).toMatchObject({
      phone: "+393331234567",
      fiscalCode: "RSSMRA85T10A562S",
      hqProvince: "MI",
      pec: "trasporti@pec.it",
    });
    expect(r.sdiCode).toBeUndefined();
  });
  it("accepts an 11-digit company fiscal code", () => {
    expect(carrierRegistrationSchema.parse({ ...carrierInput, fiscalCode: "00743110157" }).fiscalCode).toBe("00743110157");
  });
  it("requires phone, company data and HQ address", () => {
    const e = errorsOf(carrierRegistrationSchema, {
      ...carrierInput, phone: "", companyName: "", vatNumber: "", fiscalCode: "", hqStreet: "", hqCity: "", hqPostalCode: "", hqProvince: "",
    });
    for (const k of ["phone", "companyName", "vatNumber", "fiscalCode", "hqStreet", "hqCity", "hqPostalCode", "hqProvince"]) {
      expect(e[k], k).toBe(MSG.required);
    }
  });
  it("validates formats", () => {
    const e = errorsOf(carrierRegistrationSchema, {
      ...carrierInput, phone: "12", fiscalCode: "RSSMRA85T10A562T", hqPostalCode: "2012", hqProvince: "XX",
    });
    expect(e).toMatchObject({ phone: MSG.phone, fiscalCode: MSG.fiscalCode, hqPostalCode: MSG.cap, hqProvince: MSG.province });
  });
  it("requires SDI or PEC", () => {
    expect(errorsOf(carrierRegistrationSchema, { ...carrierInput, pec: "" })).toEqual({ sdiCode: MSG.einvoiceChannel });
  });
  it("requires both consents", () => {
    const e = errorsOf(carrierRegistrationSchema, { ...carrierInput, acceptTerms: undefined, acceptPrivacy: undefined });
    expect(e).toMatchObject({ acceptTerms: MSG.terms, acceptPrivacy: MSG.privacy });
  });
});

describe("sign-in and password reset", () => {
  it("sign-in requires e-mail and password", () => {
    expect(signInSchema.parse({ email: " A@B.it ", password: "x" })).toEqual({ email: "a@b.it", password: "x" });
    expect(errorsOf(signInSchema, { email: "", password: "" })).toEqual({ email: MSG.required, password: MSG.required });
  });
  it("forgot password requires a valid e-mail", () => {
    expect(errorsOf(forgotPasswordSchema, { email: "nope" })).toEqual({ email: MSG.email });
  });
  it("new password follows the same rules and must match", () => {
    expect(resetPasswordSchema.safeParse({ password: "nuova1234", passwordConfirm: "nuova1234" }).success).toBe(true);
    expect(errorsOf(resetPasswordSchema, { password: "corta1", passwordConfirm: "corta1" })).toEqual({ password: MSG.passwordLength });
    expect(errorsOf(resetPasswordSchema, { password: "nuova1234", passwordConfirm: "nuova12345" })).toEqual({ passwordConfirm: MSG.passwordMismatch });
  });
});

describe("helpers", () => {
  it("formDataToObject keeps strings and ignores files", () => {
    const fd = new FormData();
    fd.set("email", "a@b.it");
    fd.set("acceptTerms", "on");
    fd.set("file", new Blob(["x"]), "x.txt");
    expect(formDataToObject(fd)).toEqual({ email: "a@b.it", acceptTerms: "on" });
  });
});
