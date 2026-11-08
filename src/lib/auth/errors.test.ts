import { describe, expect, it } from "vitest";
import { AUTH_MSG, authErrorMessage, isVatTakenError } from "./errors";

describe("authErrorMessage (Italian messages)", () => {
  it("wrong password", () => {
    expect(authErrorMessage({ code: "invalid_credentials", status: 400 })).toBe(AUTH_MSG.invalidCredentials);
  });
  it("e-mail not confirmed", () => {
    expect(authErrorMessage({ code: "email_not_confirmed" })).toBe(AUTH_MSG.emailNotConfirmed);
  });
  it("e-mail already taken", () => {
    expect(authErrorMessage({ code: "user_already_exists" })).toBe(AUTH_MSG.emailTaken);
    expect(authErrorMessage({ code: "email_exists" })).toBe(AUTH_MSG.emailTaken);
  });
  it("rate limits, including bare HTTP 429", () => {
    expect(authErrorMessage({ code: "over_email_send_rate_limit" })).toBe(AUTH_MSG.rateLimited);
    expect(authErrorMessage({ status: 429 })).toBe(AUTH_MSG.rateLimited);
  });
  it("expired or invalid link", () => {
    expect(authErrorMessage({ code: "otp_expired" })).toBe(AUTH_MSG.linkInvalid);
  });
  it("weak and same password", () => {
    expect(authErrorMessage({ code: "weak_password" })).toBe(AUTH_MSG.weakPassword);
    expect(authErrorMessage({ code: "same_password" })).toBe(AUTH_MSG.samePassword);
  });
  it("unknown errors never leak technical details", () => {
    expect(authErrorMessage({ code: "unexpected_failure", message: "db exploded at row 7" })).toBe(AUTH_MSG.generic);
    expect(authErrorMessage(null)).toBe(AUTH_MSG.generic);
  });
});

describe("isVatTakenError", () => {
  it("detects the unique violation on carriers.vat_number", () => {
    expect(isVatTakenError({ code: "23505", message: 'duplicate key value violates unique constraint "carriers_vat_number_key"' })).toBe(true);
  });
  it("ignores other unique violations and other errors", () => {
    expect(isVatTakenError({ code: "23505", message: 'violates unique constraint "carriers_pkey"' })).toBe(false);
    expect(isVatTakenError({ code: "23514", message: "vat_number check" })).toBe(false);
  });
});
