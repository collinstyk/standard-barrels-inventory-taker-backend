import { describe, expect, it } from "vitest";
import { createPurchaseReturnSchema, postPurchaseReturnSchema } from "../../schemas/purchaseReturnV2";

describe("Phase 2B-4B supplier-return validation", () => {
  const line = { originalPurchaseItemId: 1, sourceBatchId: crypto.randomUUID(), sourceWarehouseId: 1, quantityInOrderUnit: 2, refundedUnitCost: "3.5000" };

  it("accepts the strict documented draft contract", () => {
    expect(createPurchaseReturnSchema.safeParse({ reason: "Supplier approved return", notes: "Physical return authorized", refundAmount: "7.00", items: [line] }).success).toBe(true);
  });

  it("rejects duplicate batches and caller-controlled authority fields", () => {
    expect(createPurchaseReturnSchema.safeParse({ reason: "Supplier return", refundAmount: "0", items: [line, line] }).success).toBe(false);
    expect(createPurchaseReturnSchema.safeParse({ reason: "Supplier return", refundAmount: "0", items: [{ ...line, quantityBase: 999 }] }).success).toBe(false);
    expect(createPurchaseReturnSchema.safeParse({ reason: "Supplier return", refundAmount: "0", items: [{ ...line, unitMultiplier: 999 }] }).success).toBe(false);
  });

  it("rejects malformed money and unknown posting fields", () => {
    expect(createPurchaseReturnSchema.safeParse({ reason: "Supplier return", refundAmount: "-1", items: [line] }).success).toBe(false);
    expect(createPurchaseReturnSchema.safeParse({ reason: "Supplier return", refundAmount: "1.001", items: [line] }).success).toBe(false);
    expect(postPurchaseReturnSchema.safeParse({ force: true }).success).toBe(false);
  });
});
