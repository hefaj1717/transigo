import { describe, expect, it } from "vitest";
import {
  codiceFiscaleCheckChar,
  compactUpper,
  isValidBusinessFiscalCode,
  isValidCap,
  isValidCodiceFiscale,
  isValidPartitaIva,
  isValidProvince,
  isValidSdiCode,
  normalizePartitaIva,
  normalizePhone,
  PROVINCES,
} from "./italian-ids";

describe("codice fiscale", () => {
  it("accepts valid codes (including omocodia)", () => {
    expect(isValidCodiceFiscale("RSSMRA85T10A562S")).toBe(true); // official example
    expect(isValidCodiceFiscale("RSSMRA80A01H501U")).toBe(true);
    expect(isValidCodiceFiscale("RSSMRA85T10A56NH")).toBe(true); // last digit of town code replaced by N
  });
  it("rejects a wrong check character", () => {
    expect(isValidCodiceFiscale("RSSMRA85T10A562T")).toBe(false);
  });
  it("rejects wrong length, lowercase and invalid month letter", () => {
    expect(isValidCodiceFiscale("RSSMRA85T10A562")).toBe(false);
    expect(isValidCodiceFiscale("rssmra85t10a562s")).toBe(false);
    expect(isValidCodiceFiscale("RSSMRA85Z10A562S")).toBe(false); // Z is not a month
  });
  it("computes the check character", () => {
    expect(codiceFiscaleCheckChar("RSSMRA85T10A562")).toBe("S");
  });
});

describe("partita IVA", () => {
  it("accepts valid numbers", () => {
    for (const v of ["00743110157", "01114601006", "07643520567", "12345678903"]) {
      expect(isValidPartitaIva(v), v).toBe(true);
    }
  });
  it("rejects a wrong check digit, wrong length, letters and all zeros", () => {
    for (const v of ["00743110158", "0074311015", "007431101570", "0074311015A", "00000000000"]) {
      expect(isValidPartitaIva(v), v).toBe(false);
    }
  });
  it("normalizes spaces and the IT prefix", () => {
    expect(normalizePartitaIva(" it 0074 3110 157 ")).toBe("00743110157");
  });
});

describe("business fiscal code", () => {
  it("accepts an 11-digit company code or a personal 16-character code", () => {
    expect(isValidBusinessFiscalCode("00743110157")).toBe(true);
    expect(isValidBusinessFiscalCode("RSSMRA85T10A562S")).toBe(true);
  });
  it("rejects invalid values", () => {
    expect(isValidBusinessFiscalCode("00743110158")).toBe(false);
    expect(isValidBusinessFiscalCode("RSSMRA85T10A562T")).toBe(false);
    expect(isValidBusinessFiscalCode("ABC")).toBe(false);
  });
});

describe("SDI, CAP, province", () => {
  it("SDI: exactly 7 uppercase letters/digits", () => {
    expect(isValidSdiCode("M5UXCR1")).toBe(true);
    expect(isValidSdiCode("0000000")).toBe(true);
    expect(isValidSdiCode("M5UXCR")).toBe(false);
    expect(isValidSdiCode("M5UXCR1X")).toBe(false);
    expect(isValidSdiCode("M5UX-R1")).toBe(false);
  });
  it("CAP: 5 digits", () => {
    expect(isValidCap("20121")).toBe(true);
    expect(isValidCap("2012")).toBe(false);
    expect(isValidCap("2012A")).toBe(false);
  });
  it("province: known sigla only", () => {
    expect(isValidProvince("MI")).toBe(true);
    expect(isValidProvince("SU")).toBe(true);
    expect(isValidProvince("XX")).toBe(false);
    expect(isValidProvince("mi")).toBe(false);
    expect(PROVINCES.size).toBe(107);
  });
  it("compactUpper removes whitespace and uppercases", () => {
    expect(compactUpper(" m5ux cr1 ")).toBe("M5UXCR1");
  });
});

describe("phone → E.164", () => {
  it("adds +39 to Italian mobile and landline numbers", () => {
    expect(normalizePhone("333 123 4567")).toBe("+393331234567");
    expect(normalizePhone("02-1234567")).toBe("+39021234567");
  });
  it("accepts +39 and 0039 prefixes and separators", () => {
    expect(normalizePhone("+39 333.123.4567")).toBe("+393331234567");
    expect(normalizePhone("0039 (02) 1234567")).toBe("+39021234567");
  });
  it("keeps foreign numbers in E.164", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("rejects implausible numbers", () => {
    for (const v of ["123", "abc", "+39 12345", "+39 1234567890", "+0 123456789", "", "5551234567"]) {
      expect(normalizePhone(v), v).toBeNull();
    }
  });
});
