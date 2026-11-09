import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as master from "../../services/masterData";
import { createDraftReceipt, createV2PurchaseOrder, postPurchaseReceipt } from "../../services/inventory/orderWorkflows";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

describe.skipIf(!process.env.TEST_DATABASE_URL)("product cost snapshots on disposable PostgreSQL", () => {
  let h: IntegrationHarness;
  beforeAll(async () => { h = createIntegrationHarness(); await clearDisposableDatabase(h); }, 60_000);
  afterEach(async () => clearDisposableDatabase(h));
  afterAll(async () => { await h?.client.$disconnect(); });

  it("uses default base cost for a carton, preserves agreed cost and updates last received cost only after posting", async () => {
    const suffix = randomUUID();
    const user = await h.client.user.create({ data: { name: "Admin", email: `${suffix}@cost.test`, password: "local", role: "ADMIN" } });
    const category = await master.createCategory(h.client, { name: `Oils ${suffix}` });
    const product = await master.createProduct(h.client, {
      name: "Palm oil", baseUnit: "bottle", categoryId: category.id, reorderPoint: 0, defaultCostBase: "500",
      units: [{ name: "Bottle", multiplier: 1, price: "750", sku: `B-${suffix}` },
        { name: "Carton", multiplier: 24, price: "16500", sku: `C-${suffix}` }],
    });
    const carton = product.units.find((unit) => unit.multiplier === 24)!;
    expect(carton.defaultCostInUnit).toBe("12000.0000");
    const warehouse = await master.createWarehouse(h.client, { name: `Shop ${suffix}` });
    const purchase = await createV2PurchaseOrder(h.client, {
      transactionStatus: "PENDING", amountPaid: "0", extraCost: "0",
      items: [{ productId: product.id, unitId: carton.id, quantityOrdered: 2 }],
    }, user.id, `cost-po-${suffix}`);
    expect(purchase.purchase.items[0]!.agreedUnitCost?.toString()).toBe("12000");
    const draft = await createDraftReceipt(h.client, purchase.purchase.id, {
      receivedAt: "2026-10-30T10:00:00.000Z",
      items: [{ purchaseItemId: purchase.purchase.items[0]!.id, warehouseId: warehouse.id,
        quantityInOrderUnit: 2, actualUnitCost: "11400" }],
    }, user.id, `cost-receipt-${suffix}`);
    expect((await master.getProduct(h.client, product.id)).lastReceivedCostBase).toBeNull();
    await postPurchaseReceipt(h.client, purchase.purchase.id, draft.receipt.id, user.id, `cost-post-${suffix}`);
    const updated = await master.getProduct(h.client, product.id);
    expect(updated.defaultCostBase?.toString()).toBe("500");
    expect(updated.lastReceivedCostBase?.toString()).toBe("475");
    expect(updated.units.find((unit) => unit.id === carton.id)?.price.toString()).toBe("16500");
    const batch = await h.client.inventoryBatch.findFirstOrThrow({ where: { purchaseReceiptItem: { receiptId: draft.receipt.id } } });
    expect(batch.unitCostBase?.toString()).toBe("475");
  });
});
