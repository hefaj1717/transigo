import { describe, expect, it } from "vitest";
import { blockSchema, CUSTOMER_ADMIN_MSG, customerDisplayName, customerSearchTerm } from "./admin";

const ID = "33333333-3333-4333-8333-333333333333";

describe("customerSearchTerm", () => {
  it("removes wildcards and PostgREST filter syntax", () => {
    expect(customerSearchTerm("  Rossi  ")).toBe("Rossi");
    expect(customerSearchTerm("a%b_c*d,e(f)g\\h")).toBe("a b c d e f g h");
    expect(customerSearchTerm("x),email.eq.y")).toBe("x email.eq.y");
    expect(customerSearchTerm("mario@example.com")).toBe("mario@example.com");
  });
  it("too short, empty or not a string → null; long input cut", () => {
    for (const v of ["", " ", "a", "%%", undefined, ["Rossi"]]) expect(customerSearchTerm(v)).toBeNull();
    expect(customerSearchTerm("x".repeat(300))).toHaveLength(100);
  });
});

describe("blockSchema", () => {
  it("block needs a reason from the list; unblock does not", () => {
    expect(blockSchema.safeParse({ customerId: ID, block: "1", reason: "abuse" }).success).toBe(true);
    expect(blockSchema.safeParse({ customerId: ID, block: "1" }).success).toBe(false);
    expect(blockSchema.safeParse({ customerId: ID, block: "1", reason: "boh" }).success).toBe(false);
    expect(blockSchema.safeParse({ customerId: ID, block: "0" }).success).toBe(true);
    expect(blockSchema.safeParse({ customerId: "x", block: "0" }).success).toBe(false);
  });
});

describe("labels", () => {
  it("display name and block message", () => {
    expect(customerDisplayName({ customer_type: "business", company_name: "Studio Conti", first_name: "Giulia", last_name: "Conti", email: "g@x.it" })).toBe("Studio Conti");
    expect(customerDisplayName({ customer_type: "private", company_name: null, first_name: "Giulia", last_name: null, email: "g@x.it" })).toBe("Giulia");
    expect(customerDisplayName({ customer_type: "private", company_name: null, first_name: null, last_name: null, email: "g@x.it" })).toBe("g@x.it");
    expect(CUSTOMER_ADMIN_MSG.blocked(0)).toBe("Cliente bloccato: non può più accedere.");
    expect(CUSTOMER_ADMIN_MSG.blocked(2)).toContain("2 ordini in corso");
  });
});
