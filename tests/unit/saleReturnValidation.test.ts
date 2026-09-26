import { describe, expect, it } from "vitest";
import { createSaleReturnSchema, inspectSaleReturnSchema, receiveSaleReturnSchema } from "../../schemas/saleReturnV2";

describe("Phase 2B-4A return validation", () => {
  const passedChecks = { packagingIntact: "PASSED", sealIntact: "PASSED", correctProduct: "PASSED", correctQuantity: "PASSED", expiryChecked: "PASSED", visibleDamage: "PASSED", returnReasonConfirmed: "PASSED" } as const;
  it("rejects caller authority and duplicate draft lines", () => {
    const line = { originalSaleItemId: 1, quantityInOrderUnit: 1 };
    expect(createSaleReturnSchema.safeParse({ reason: "Valid reason", items: [line] }).success).toBe(true);
    expect(createSaleReturnSchema.safeParse({ reason: "Valid reason", items: [{ ...line, quantityBase: 99 }] }).success).toBe(false);
    expect(createSaleReturnSchema.safeParse({ reason: "Valid reason", items: [line, line] }).success).toBe(false);
  });

  it("requires one warehouse per receive line and rejects duplicates", () => {
    const line = { saleReturnItemId: 1, warehouseId: 2 };
    expect(receiveSaleReturnSchema.safeParse({ receivedAt: "2026-07-21T10:00:00.000Z", items: [line, line] }).success).toBe(false);
  });

  it("requires a complete checklist and validates outcome compatibility", () => {
    const base = { saleReturnItemId: 1, sourceBatchId: crypto.randomUUID(), warehouseId: 1, quantityInOrderUnit: 1, inspectedAt: "2026-07-21T12:00:00.000Z" };
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "SELLABLE", notes: "Verified" }).success).toBe(false);
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "SELLABLE", notes: "Verified", checks: { ...passedChecks, correctProduct: "FAILED" } }).success).toBe(false);
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "SELLABLE", notes: "Verified", checks: passedChecks }).success).toBe(true);
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "DAMAGED", notes: "short", checks: passedChecks }).success).toBe(false);
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "DAMAGED", notes: "Visible damage confirmed", checks: { ...passedChecks, visibleDamage: "FAILED" } }).success).toBe(true);
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "REJECTED", notes: "Rejected after seal inspection", checks: passedChecks }).success).toBe(false);
    expect(inspectSaleReturnSchema.safeParse({ ...base, outcome: "REJECTED", notes: "Rejected after seal inspection", checks: { ...passedChecks, sealIntact: "FAILED" } }).success).toBe(true);
  });
});
