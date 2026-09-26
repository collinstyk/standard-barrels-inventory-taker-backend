import { afterEach, describe, expect, it } from "vitest";
import { isInventoryV2Enabled } from "../../services/inventory/featureFlag";
import { dateOnlySchema, receiptCreateSchema, v2PurchaseCreateSchema, v2PurchaseUpdateSchema, v2SaleCreateSchema } from "../../schemas/inventoryV2";

describe("Phase 2B-3 runtime safety", () => {
  const original = process.env.INVENTORY_V2_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.INVENTORY_V2_ENABLED;
    else process.env.INVENTORY_V2_ENABLED = original;
  });

  it("enables Inventory V2 only for an explicit true value", () => {
    expect([undefined, "", "yes", "1", "enabled", "production"].map(isInventoryV2Enabled)).toEqual([false, false, false, false, false, false]);
    expect(isInventoryV2Enabled(" true ")).toBe(true);
    expect(isInventoryV2Enabled("FALSE")).toBe(false);
    process.env.INVENTORY_V2_ENABLED = "not-false-but-truthy";
    expect(isInventoryV2Enabled()).toBe(false);
  });

  it("accepts calendar-valid date-only values and rejects rollover dates", () => {
    expect(dateOnlySchema.safeParse("2028-02-29").success).toBe(true);
    expect(dateOnlySchema.safeParse("2027-02-29").success).toBe(false);
    expect(dateOnlySchema.safeParse("2027-02-28T00:00:00Z").success).toBe(false);
  });

  it("rejects unsafe IDs, quantities, money, and unexpected authority fields", () => {
    const purchase = { transactionStatus: "DRAFT", amountPaid: "0", items: [{ productId: crypto.randomUUID(), unitId: 1, quantityOrdered: 1, agreedUnitCost: "1.25" }] };
    expect(v2PurchaseCreateSchema.safeParse(purchase).success).toBe(true);
    expect(v2PurchaseCreateSchema.safeParse({ ...purchase, totalPurchaseCost: 1 }).success).toBe(false);
    expect(v2PurchaseCreateSchema.safeParse({ ...purchase, amountPaid: Infinity }).success).toBe(false);
    expect(v2PurchaseCreateSchema.safeParse({ ...purchase, items: [{ ...purchase.items[0], unitId: 2_147_483_648 }] }).success).toBe(false);
  });

  it("requires sale price and complete fulfilments while rejecting client multiplier and totals", () => {
    const item = { productId: crypto.randomUUID(), unitId: 1, quantityOrdered: 1, fulfillments: [{ warehouseId: 1, quantityInOrderUnit: 1 }], confirmedUnitSalePrice: "9.50" };
    expect(v2SaleCreateSchema.safeParse({ transactionStatus: "DRAFT", amountPaid: 0, items: [item] }).success).toBe(true);
    expect(v2SaleCreateSchema.safeParse({ transactionStatus: "DRAFT", amountPaid: 0, items: [{ ...item, unitMultiplierSnapshot: 99 }] }).success).toBe(false);
    expect(v2SaleCreateSchema.safeParse({ transactionStatus: "PENDING", amountPaid: 0, items: [{ ...item, fulfillments: [] }] }).success).toBe(false);
    expect(v2SaleCreateSchema.safeParse({ transactionStatus: "PENDING", amountPaid: 0, items: [{ ...item, quantityOrdered: 2 }] }).success).toBe(false);
    expect(v2SaleCreateSchema.safeParse({ transactionStatus: "PENDING", amountPaid: 0, items: [{ ...item, fulfillments: [...item.fulfillments, ...item.fulfillments] }] }).success).toBe(false);
  });

  it("rejects duplicate receipt item/warehouse/expiry lines", () => {
    const line = { purchaseItemId: 1, warehouseId: 1, quantityInOrderUnit: 1, actualUnitCost: "1", expiryDate: "2027-01-01" };
    expect(receiptCreateSchema.safeParse({ receivedAt: "2026-07-21T00:00:00.000Z", items: [line, line] }).success).toBe(false);
  });

  it("rejects direct cancelled creation and inventory fields in purchase updates", () => {
    const purchase = { transactionStatus: "CANCELLED", amountPaid: "0", items: [{ productId: crypto.randomUUID(), unitId: 1, quantityOrdered: 1 }] };
    expect(v2PurchaseCreateSchema.safeParse(purchase).success).toBe(false);
    expect(v2PurchaseUpdateSchema.safeParse({ transactionStatus: "PENDING", quantityReceived: 1 }).success).toBe(false);
  });
});
