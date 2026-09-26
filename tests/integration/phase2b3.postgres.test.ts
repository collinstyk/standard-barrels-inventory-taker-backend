import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDraftReceipt,
  createV2PurchaseOrder,
  createV2SaleOrder,
  postPurchaseReceipt,
  updateV2PurchaseOrder,
  updateV2SaleOrder,
} from "../../services/inventory/orderWorkflows";
import { getWarehouseAvailability } from "../../services/inventory/availability";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDatabase)("Phase 2B-3 atomic order workflows on disposable PostgreSQL", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = createIntegrationHarness();
    await clearDisposableDatabase(harness);
  }, 60_000);
  afterEach(async () => clearDisposableDatabase(harness));
  afterAll(async () => harness?.client.$disconnect());

  async function fixture(multiplier = 2) {
    const suffix = randomUUID();
    const user = await harness.client.user.create({ data: { name: "Phase 2B-3", email: `${suffix}@phase2b3.test`, password: "local-test-only", role: "ADMIN" } });
    const category = await harness.client.category.create({ data: { name: `Category ${suffix}` } });
    const product = await harness.client.product.create({ data: { name: `Product ${suffix}`, baseUnit: "piece", categoryId: category.id, quantityInStock: 0 } });
    const unit = await harness.client.productUnit.create({ data: { name: "case", multiplier, price: "4.25", sku: `SKU-${suffix}`, productId: product.id } });
    const warehouse = await harness.client.warehouse.create({ data: { name: `Warehouse ${suffix}` } });
    return { user, product, unit, warehouse };
  }

  async function purchaseFixture(quantityOrdered = 10) {
    const f = await fixture();
    const result = await createV2PurchaseOrder(harness.client, {
      transactionStatus: "PENDING", amountPaid: "0", extraCost: "0",
      items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered, agreedUnitCost: "3.75" }],
    }, f.user.id, `purchase-${randomUUID()}`);
    return { ...f, purchase: result.purchase, item: result.purchase.items[0]! };
  }

  it("creates an idempotent purchase with cost and multiplier snapshots but no inventory", async () => {
    const f = await fixture(3);
    const input = { transactionStatus: "PENDING" as const, amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 4, agreedUnitCost: "7.125" }] };
    const first = await createV2PurchaseOrder(harness.client, input, f.user.id, "purchase-create-replay");
    const replay = await createV2PurchaseOrder(harness.client, input, f.user.id, "purchase-create-replay");
    expect(replay.purchase.id).toBe(first.purchase.id);
    await expect(createV2PurchaseOrder(harness.client, { ...input, amountPaid: "1" }, f.user.id, "purchase-create-replay")).rejects.toThrow(/idempotency/i);
    expect(first.purchase.items[0]).toMatchObject({ unitMultiplierSnapshot: 3, quantityReceived: 0 });
    expect(first.purchase.items[0]!.agreedUnitCost?.toString()).toBe("7.125");
    expect(await harness.client.inventoryBatch.count()).toBe(0);
    expect(await harness.client.stockMovement.count()).toBe(0);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
  });

  it("keeps a draft receipt inventory-neutral", async () => {
    const f = await purchaseFixture();
    const receipt = await createDraftReceipt(harness.client, f.purchase.id, {
      receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: 2, actualUnitCost: "3.50", expiryDate: "2027-02-28" }],
    }, f.user.id, "receipt-draft");
    expect(receipt.receipt.status).toBe("DRAFT");
    expect(await harness.client.inventoryBatch.count()).toBe(0);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
  });

  it("posts partial and multiple receipts, preserves DATE, caches totals, and replays without duplication", async () => {
    const f = await purchaseFixture(5);
    const create = (key: string, quantity: number, expiry: string | null) => createDraftReceipt(harness.client, f.purchase.id, {
      receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: quantity, actualUnitCost: "3.50", expiryDate: expiry }],
    }, f.user.id, key);
    const first = await create("receipt-one", 2, "2027-02-28");
    const posted = await postPurchaseReceipt(harness.client, f.purchase.id, first.receipt.id, f.user.id, "post-one");
    const replay = await postPurchaseReceipt(harness.client, f.purchase.id, first.receipt.id, f.user.id, "post-one");
    expect(replay).toMatchObject({ replayed: true, postingId: posted.postingId, result: posted.result });
    expect(await harness.client.inventoryBatch.count()).toBe(1);
    expect(await harness.client.stockMovement.count()).toBe(1);
    const second = await create("receipt-two", 3, null);
    await postPurchaseReceipt(harness.client, f.purchase.id, second.receipt.id, f.user.id, "post-two");
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(10);
    expect((await harness.client.purchaseItem.findUniqueOrThrow({ where: { id: f.item.id } })).quantityReceived).toBe(5);
    expect((await harness.client.purchaseOrder.findUniqueOrThrow({ where: { id: f.purchase.id } })).receivingStatus).toBe("FULLY_RECEIVED");
    const dated = await harness.client.inventoryBatch.findFirstOrThrow({ where: { expiryDate: { not: null } } });
    expect(dated.expiryDate?.toISOString().slice(0, 10)).toBe("2027-02-28");
  });

  it("rejects cumulative over-receipt and leaves the second receipt draft", async () => {
    const f = await purchaseFixture(2);
    for (const [index, quantity] of [2, 1].entries()) {
      const draft = await createDraftReceipt(harness.client, f.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: quantity, actualUnitCost: "1" }] }, f.user.id, `over-draft-${index}`);
      if (index === 0) await postPurchaseReceipt(harness.client, f.purchase.id, draft.receipt.id, f.user.id, "over-post-one");
      else await expect(postPurchaseReceipt(harness.client, f.purchase.id, draft.receipt.id, f.user.id, "over-post-two")).rejects.toThrow("exceed");
    }
    expect(await harness.client.inventoryBatch.count()).toBe(1);
    expect(await harness.client.purchaseReceipt.count({ where: { status: "DRAFT" } })).toBe(1);
  });

  async function stockedSaleFixture(quantityBase = 10) {
    const f = await fixture(2);
    await harness.client.inventoryBatch.create({ data: { productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: quantityBase, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" } });
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: quantityBase } });
    return f;
  }

  it("creates an inventory-neutral draft sale with authoritative snapshots and selling price", async () => {
    const f = await stockedSaleFixture();
    const result = await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 2, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 2 }], confirmedUnitSalePrice: "12.50" }] }, f.user.id, "draft-sale");
    expect(result.posting).toBeNull();
    expect(result.sale.items[0]).toMatchObject({ unitMultiplierSnapshot: 2, sourceWarehouseId: f.warehouse.id });
    expect(result.sale.items[0]!.confirmedUnitSalePrice?.toString()).toBe("12.5");
    expect(result.sale.items[0]!.unitPrice.toString()).toBe("12.5");
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(10);
  });

  it("creates and issues a non-draft sale atomically and replays its sale/posting identity", async () => {
    const f = await stockedSaleFixture();
    const input = { transactionStatus: "PENDING" as const, amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 3, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 3 }], confirmedUnitSalePrice: "9" }] };
    const first = await createV2SaleOrder(harness.client, input, f.user.id, "sale-create-replay");
    const replay = await createV2SaleOrder(harness.client, input, f.user.id, "sale-create-replay");
    expect(replay.sale.id).toBe(first.sale.id);
    expect(replay.posting?.postingId).toBe(first.posting?.postingId);
    expect(first.posting?.result.totalIssued).toBe(6);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(4);
    expect(await harness.client.inventoryPosting.count()).toBe(1);
  });

  it("rolls back the complete non-draft sale when allocation fails", async () => {
    const f = await stockedSaleFixture(1);
    await expect(createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 2, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 2 }], confirmedUnitSalePrice: "9" }] }, f.user.id, "sale-insufficient")).rejects.toThrow();
    expect(await harness.client.saleOrder.count()).toBe(0);
    expect(await harness.client.inventoryPosting.count()).toBe(0);
    expect((await harness.client.inventoryBatch.findFirstOrThrow()).quantityOnHandBase).toBe(1);
  });

  it("activates a draft once, permits non-draft transition, and rejects returning to draft", async () => {
    const f = await stockedSaleFixture();
    const draft = await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 2, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 2 }], confirmedUnitSalePrice: "9" }] }, f.user.id, "activation-draft");
    const activated = await updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "activation-post");
    const replay = await updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "activation-post");
    await updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "COMPLETED" }, f.user.id);
    expect(activated.posting?.result.totalIssued).toBe(4);
    expect(replay.posting?.postingId).toBe(activated.posting?.postingId);
    expect(await harness.client.inventoryPosting.count()).toBe(1);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(6);
    await expect(updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "DRAFT" }, f.user.id)).rejects.toThrow("cannot return");
  });

  it("prevents concurrent draft activation from posting twice", async () => {
    const f = await stockedSaleFixture();
    const draft = await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 2, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 2 }], confirmedUnitSalePrice: "9" }] }, f.user.id, "concurrent-draft");
    const outcomes = await Promise.allSettled([
      updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "concurrent-activation-a"),
      updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "concurrent-activation-b"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await harness.client.inventoryPosting.count({ where: { saleOrderId: draft.sale.id } })).toBe(1);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(6);
  });

  it("rolls back a multi-item sale when one selected warehouse lacks stock", async () => {
    const f = await stockedSaleFixture(10);
    const emptyWarehouse = await harness.client.warehouse.create({ data: { name: `Empty ${randomUUID()}` } });
    await expect(createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [
      { productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }], confirmedUnitSalePrice: "9" },
      { productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, fulfillments: [{ warehouseId: emptyWarehouse.id, quantityInOrderUnit: 1 }], confirmedUnitSalePrice: "9" },
    ] }, f.user.id, "multi-item-rollback")).rejects.toThrow();
    expect(await harness.client.saleOrder.count()).toBe(0);
    expect((await harness.client.inventoryBatch.findFirstOrThrow()).quantityOnHandBase).toBe(10);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(10);
  });

  it("allocates different sale items only from their selected warehouses", async () => {
    const f = await stockedSaleFixture(4);
    const secondWarehouse = await harness.client.warehouse.create({ data: { name: `Second ${randomUUID()}` } });
    await harness.client.inventoryBatch.create({ data: { productId: f.product.id, warehouseId: secondWarehouse.id, quantityOnHandBase: 4, receivedAt: new Date("2026-01-02T00:00:00Z"), disposition: "SELLABLE" } });
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 8 } });
    const result = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [
      { productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }], confirmedUnitSalePrice: "9" },
      { productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, fulfillments: [{ warehouseId: secondWarehouse.id, quantityInOrderUnit: 1 }], confirmedUnitSalePrice: "9" },
    ] }, f.user.id, "multi-warehouse-sale");
    const allocations = await harness.client.saleAllocation.findMany({ where: { saleItem: { saleId: result.sale.id } }, include: { batch: true } });
    expect(new Set(allocations.map((allocation) => allocation.batch.warehouseId))).toEqual(new Set([f.warehouse.id, secondWarehouse.id]));
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(4);
  });

  it("previews eligible sellable inventory per warehouse without exposing cost", async () => {
    const f = await fixture(2);
    const second = await harness.client.warehouse.create({ data: { name: `Availability B ${randomUUID()}`, location: "North" } });
    await harness.client.inventoryBatch.createMany({ data: [
      { productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 3, receivedAt: new Date("2026-01-01T00:00:00Z"), expiryDate: new Date("2099-07-21T00:00:00Z"), disposition: "SELLABLE" },
      { productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 2, receivedAt: new Date("2026-01-02T00:00:00Z"), disposition: "SELLABLE" },
      { productId: f.product.id, warehouseId: second.id, quantityOnHandBase: 4, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
      { productId: f.product.id, warehouseId: second.id, quantityOnHandBase: 50, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "DAMAGED" },
      { productId: f.product.id, warehouseId: second.id, quantityOnHandBase: 50, receivedAt: new Date("2026-01-01T00:00:00Z"), expiryDate: new Date("2000-07-20T00:00:00Z"), disposition: "SELLABLE" },
    ] });
    const preview = await getWarehouseAvailability(harness.client, f.product.id, f.unit.id, 2);
    expect(preview.warehouses).toHaveLength(2);
    expect(preview.warehouses.map((warehouse) => [warehouse.sellableQuantityBase, warehouse.availableQuantityInRequestedUnit, warehouse.baseUnitRemainder])).toEqual(expect.arrayContaining([[5, 2, 1], [4, 2, 0]]));
    expect(preview.warehouses.find((warehouse) => warehouse.sellableQuantityBase === 5)).toMatchObject({ earliestEligibleExpiryDate: "2099-07-21", inventoryComposition: "MIXED", sufficientForRequestedQuantity: true });
    expect(JSON.stringify(preview)).not.toMatch(/price|cost/i);
  });

  it("splits one sale item across warehouses and links FEFO allocations to each fulfilment", async () => {
    const f = await fixture(2);
    const second = await harness.client.warehouse.create({ data: { name: `Split ${randomUUID()}` } });
    await harness.client.inventoryBatch.createMany({ data: [
      { id: "split-a-early", productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 2, receivedAt: new Date("2026-01-02T00:00:00Z"), expiryDate: new Date("2026-08-01T00:00:00Z"), disposition: "SELLABLE" },
      { id: "split-a-late", productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 4, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
      { id: "split-b", productId: f.product.id, warehouseId: second.id, quantityOnHandBase: 2, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
    ] });
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 8 } });
    const result = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{
      productId: f.product.id, unitId: f.unit.id, quantityOrdered: 3, quantityDelivered: 0, confirmedUnitSalePrice: "9",
      fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 2 }, { warehouseId: second.id, quantityInOrderUnit: 1 }],
    }] }, f.user.id, "split-sale");
    expect(result.sale.items[0]!.sourceWarehouseId).toBeNull();
    expect(result.sale.items[0]!.fulfillments).toHaveLength(2);
    const allocations = await harness.client.saleAllocation.findMany({ where: { saleItemId: result.sale.items[0]!.id }, include: { fulfillment: true, batch: true } });
    expect(allocations.every((allocation) => allocation.fulfillmentId !== null && allocation.fulfillment!.warehouseId === allocation.batch.warehouseId)).toBe(true);
    expect(allocations.some((allocation) => allocation.batchId === "split-a-early")).toBe(true);
    expect(new Set((await harness.client.stockMovement.findMany({ where: { postingId: result.posting!.postingId } })).map((movement) => movement.warehouseId))).toEqual(new Set([f.warehouse.id, second.id]));
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(2);
  });

  it("does not rebalance a short fulfilment from another selected warehouse", async () => {
    const f = await fixture(1);
    const second = await harness.client.warehouse.create({ data: { name: `No rebalance ${randomUUID()}` } });
    await harness.client.inventoryBatch.createMany({ data: [
      { productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 1, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
      { productId: f.product.id, warehouseId: second.id, quantityOnHandBase: 20, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
    ] });
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 21 } });
    await expect(createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{
      productId: f.product.id, unitId: f.unit.id, quantityOrdered: 4, quantityDelivered: 0, confirmedUnitSalePrice: "9",
      fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 2 }, { warehouseId: second.id, quantityInOrderUnit: 2 }],
    }] }, f.user.id, "no-rebalance")).rejects.toThrow();
    expect(await harness.client.saleOrder.count()).toBe(0);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(21);
  });

  it("supports multiple sale items each split across multiple warehouses under one posting", async () => {
    const f = await fixture(2);
    const second = await harness.client.warehouse.create({ data: { name: `Matrix ${randomUUID()}` } });
    await harness.client.inventoryBatch.createMany({ data: [
      { productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 8, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
      { productId: f.product.id, warehouseId: second.id, quantityOnHandBase: 8, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" },
    ] });
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 16 } });
    const item = { productId: f.product.id, unitId: f.unit.id, quantityOrdered: 2, quantityDelivered: 0, confirmedUnitSalePrice: "9", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }, { warehouseId: second.id, quantityInOrderUnit: 1 }] };
    const result = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [item, item] }, f.user.id, "multi-item-multi-warehouse");
    expect(result.sale.items).toHaveLength(2);
    expect(await harness.client.saleItemFulfillment.count({ where: { saleItem: { saleId: result.sale.id } } })).toBe(4);
    const movements = await harness.client.stockMovement.findMany({ where: { postingId: result.posting!.postingId }, orderBy: { sequence: "asc" } });
    expect(movements.map((movement) => movement.sequence)).toEqual([1, 2, 3, 4]);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(8);
  });

  it("isolates V2 purchase updates from legacy inventory and allows untouched cancellation", async () => {
    const draft = await purchaseFixture(5);
    const cancelled = await updateV2PurchaseOrder(harness.client, draft.purchase.id, { transactionStatus: "CANCELLED" });
    expect(cancelled.transactionStatus).toBe("CANCELLED");
    expect(await harness.client.stockLevel.count()).toBe(0);
    expect(await harness.client.stockLog.count()).toBe(0);
    await expect(updateV2PurchaseOrder(harness.client, draft.purchase.id, { transactionStatus: "PENDING" })).rejects.toThrow(/terminal/i);
    await expect(createDraftReceipt(harness.client, draft.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: draft.item.id, warehouseId: draft.warehouse.id, quantityInOrderUnit: 1, actualUnitCost: "1" }] }, draft.user.id, "cancelled-receipt")).rejects.toThrow(/cancelled/i);
  });

  it("rejects direct creation of cancelled purchase and sale orders", async () => {
    const f = await fixture();
    await expect(createV2PurchaseOrder(harness.client, { transactionStatus: "CANCELLED", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1 }] }, f.user.id, "cancelled-purchase-create")).rejects.toThrow(/cannot be created/i);
    await expect(createV2SaleOrder(harness.client, { transactionStatus: "CANCELLED", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "1", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }] }] }, f.user.id, "cancelled-sale-create")).rejects.toThrow(/cannot be created/i);
    expect(await harness.client.purchaseOrder.count()).toBe(0);
    expect(await harness.client.saleOrder.count()).toBe(0);
  });

  it("blocks purchase cancellation after receipt posting and blocks a draft receipt after cancellation", async () => {
    const posted = await purchaseFixture(2);
    const receipt = await createDraftReceipt(harness.client, posted.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: posted.item.id, warehouseId: posted.warehouse.id, quantityInOrderUnit: 1, actualUnitCost: "1" }] }, posted.user.id, "posted-before-cancel");
    await postPurchaseReceipt(harness.client, posted.purchase.id, receipt.receipt.id, posted.user.id, "post-before-cancel");
    await expect(updateV2PurchaseOrder(harness.client, posted.purchase.id, { transactionStatus: "CANCELLED" })).rejects.toThrow(/reversed or returned/i);

    await clearDisposableDatabase(harness);
    const cancelled = await purchaseFixture(2);
    const draftReceipt = await createDraftReceipt(harness.client, cancelled.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: cancelled.item.id, warehouseId: cancelled.warehouse.id, quantityInOrderUnit: 1, actualUnitCost: "1" }] }, cancelled.user.id, "draft-before-cancel");
    await updateV2PurchaseOrder(harness.client, cancelled.purchase.id, { transactionStatus: "CANCELLED" });
    await expect(postPurchaseReceipt(harness.client, cancelled.purchase.id, draftReceipt.receipt.id, cancelled.user.id, "post-after-cancel")).rejects.toThrow(/cancelled/i);
    expect((await harness.client.purchaseReceipt.findUniqueOrThrow({ where: { id: draftReceipt.receipt.id } })).status).toBe("DRAFT");
  });

  it("validates aggregate current split receipt quantity before any mutation", async () => {
    const f = await purchaseFixture(10);
    const second = await harness.client.warehouse.create({ data: { name: `Receipt split ${randomUUID()}` } });
    const invalid = await createDraftReceipt(harness.client, f.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [
      { purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: 6, actualUnitCost: "1" },
      { purchaseItemId: f.item.id, warehouseId: second.id, quantityInOrderUnit: 6, actualUnitCost: "1" },
    ] }, f.user.id, "split-over-receipt");
    await expect(postPurchaseReceipt(harness.client, f.purchase.id, invalid.receipt.id, f.user.id, "split-over-post")).rejects.toThrow(/exceeds/i);
    expect(await harness.client.inventoryBatch.count()).toBe(0);
    expect(await harness.client.stockMovement.count()).toBe(0);
    expect(await harness.client.inventoryPosting.count()).toBe(0);
    expect((await harness.client.purchaseItem.findUniqueOrThrow({ where: { id: f.item.id } })).quantityReceived).toBe(0);
  });

  it("accepts a valid split receipt whose aggregate equals quantity ordered", async () => {
    const f = await purchaseFixture(10);
    const second = await harness.client.warehouse.create({ data: { name: `Valid split ${randomUUID()}` } });
    const receipt = await createDraftReceipt(harness.client, f.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [
      { purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: 6, actualUnitCost: "1" },
      { purchaseItemId: f.item.id, warehouseId: second.id, quantityInOrderUnit: 4, actualUnitCost: "1" },
    ] }, f.user.id, "valid-split-receipt");
    await postPurchaseReceipt(harness.client, f.purchase.id, receipt.receipt.id, f.user.id, "valid-split-post");
    expect((await harness.client.purchaseItem.findUniqueOrThrow({ where: { id: f.item.id } })).quantityReceived).toBe(10);
    expect(await harness.client.inventoryBatch.count()).toBe(2);
  });

  it("serializes concurrent receipts so cumulative quantity cannot exceed the order", async () => {
    const f = await purchaseFixture(10);
    const second = await harness.client.warehouse.create({ data: { name: `Concurrent receipt ${randomUUID()}` } });
    const first = await createDraftReceipt(harness.client, f.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: 6, actualUnitCost: "1" }] }, f.user.id, "concurrent-receipt-a");
    const other = await createDraftReceipt(harness.client, f.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: f.item.id, warehouseId: second.id, quantityInOrderUnit: 6, actualUnitCost: "1" }] }, f.user.id, "concurrent-receipt-b");
    const outcomes = await Promise.allSettled([
      postPurchaseReceipt(harness.client, f.purchase.id, first.receipt.id, f.user.id, "concurrent-post-a"),
      postPurchaseReceipt(harness.client, f.purchase.id, other.receipt.id, f.user.id, "concurrent-post-b"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await harness.client.purchaseItem.findUniqueOrThrow({ where: { id: f.item.id } })).quantityReceived).toBe(6);
    expect(await harness.client.purchaseReceipt.count({ where: { status: "POSTED" } })).toBe(1);
  });

  it("serializes purchase cancellation against receipt posting without an inconsistent winner", async () => {
    const f = await purchaseFixture(2);
    const receipt = await createDraftReceipt(harness.client, f.purchase.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ purchaseItemId: f.item.id, warehouseId: f.warehouse.id, quantityInOrderUnit: 1, actualUnitCost: "1" }] }, f.user.id, "cancel-post-race-draft");
    const outcomes = await Promise.allSettled([
      updateV2PurchaseOrder(harness.client, f.purchase.id, { transactionStatus: "CANCELLED" }),
      postPurchaseReceipt(harness.client, f.purchase.id, receipt.receipt.id, f.user.id, "cancel-post-race-post"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const purchase = await harness.client.purchaseOrder.findUniqueOrThrow({ where: { id: f.purchase.id } });
    const persistedReceipt = await harness.client.purchaseReceipt.findUniqueOrThrow({ where: { id: receipt.receipt.id } });
    expect(purchase.transactionStatus === "CANCELLED" && persistedReceipt.status === "POSTED").toBe(false);
    expect(await harness.client.inventoryBatch.count()).toBe(persistedReceipt.status === "POSTED" ? 1 : 0);
  });

  it("permits draft sale cancellation but blocks cancellation or reactivation after issue", async () => {
    const f = await stockedSaleFixture(4);
    const draft = await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "1", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }] }] }, f.user.id, "sale-cancel-draft");
    const cancelled = await updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "CANCELLED" }, f.user.id);
    expect(cancelled.sale.transactionStatus).toBe("CANCELLED");
    expect(await harness.client.inventoryPosting.count()).toBe(0);
    await expect(updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "activate-cancelled")).rejects.toThrow(/terminal/i);

    await clearDisposableDatabase(harness);
    const issuedFixture = await stockedSaleFixture(4);
    const issued = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: issuedFixture.product.id, unitId: issuedFixture.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "1", fulfillments: [{ warehouseId: issuedFixture.warehouse.id, quantityInOrderUnit: 1 }] }] }, issuedFixture.user.id, "issued-before-cancel");
    await expect(updateV2SaleOrder(harness.client, issued.sale.id, { transactionStatus: "CANCELLED" }, issuedFixture.user.id)).rejects.toThrow(/reversed/i);
    expect(await harness.client.inventoryPosting.count()).toBe(1);
  });

  it("returns the same posting for concurrent same-key activation and conflicts a different key", async () => {
    const f = await stockedSaleFixture(4);
    const draft = await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "1", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }] }] }, f.user.id, "activation-key-draft");
    const same = await Promise.all([
      updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "same-activation-key"),
      updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "same-activation-key"),
    ]);
    expect(same[0].posting?.postingId).toBe(same[1].posting?.postingId);
    expect(same.every((result) => result.posting !== null)).toBe(true);
    await expect(updateV2SaleOrder(harness.client, draft.sale.id, { transactionStatus: "PENDING" }, f.user.id, "different-activation-key")).rejects.toThrow(/idempotency/i);
    expect(await harness.client.inventoryPosting.count()).toBe(1);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(2);
  });
});
