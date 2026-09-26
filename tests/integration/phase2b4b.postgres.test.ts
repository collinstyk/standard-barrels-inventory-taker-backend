import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDraftReceipt, createV2PurchaseOrder, createV2SaleOrder, postPurchaseReceipt } from "../../services/inventory/orderWorkflows";
import { cancelPurchaseReturn, createPurchaseReturn, getPurchaseReturn, postPurchaseReturn } from "../../services/inventory/purchaseReturn";
import { createSaleReturn, inspectSaleReturn, receiveSaleReturn } from "../../services/inventory/saleReturn";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDatabase)("Phase 2B-4B supplier returns on disposable PostgreSQL", () => {
  let harness: IntegrationHarness;
  beforeAll(async () => { harness = createIntegrationHarness(); await clearDisposableDatabase(harness); }, 60_000);
  afterEach(async () => clearDisposableDatabase(harness));
  afterAll(async () => harness?.client.$disconnect());

  async function fixture(received = 8, split = false) {
    const suffix = randomUUID();
    const user = await harness.client.user.create({ data: { name: "Supplier Return Admin", email: `${suffix}@supplier-return.test`, password: "local-test-only", role: "ADMIN" } });
    const category = await harness.client.category.create({ data: { name: `Supplier return ${suffix}` } });
    const product = await harness.client.product.create({ data: { name: `Supplier product ${suffix}`, baseUnit: "piece", categoryId: category.id, quantityInStock: 0 } });
    const unit = await harness.client.productUnit.create({ data: { name: "piece", multiplier: 1, price: "3.5000", sku: `SUP-${suffix}`, productId: product.id } });
    const warehouse = await harness.client.warehouse.create({ data: { name: `Supplier warehouse ${suffix}` } });
    const secondWarehouse = await harness.client.warehouse.create({ data: { name: `Second supplier warehouse ${suffix}` } });
    const purchaseKey = `supplier-purchase-${suffix}`;
    const purchaseResult = await createV2PurchaseOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: product.id, unitId: unit.id, quantityOrdered: 10, agreedUnitCost: "3.5000" }] }, user.id, purchaseKey);
    const item = purchaseResult.purchase.items[0]!;
    const receiptKey = `supplier-receipt-${suffix}`;
    const receiptPostKey = `supplier-receipt-post-${suffix}`;
    const receipt = await createDraftReceipt(harness.client, purchaseResult.purchase.id, { receivedAt: "2026-07-21T09:00:00.000Z", items: split
      ? [{ purchaseItemId: item.id, warehouseId: warehouse.id, quantityInOrderUnit: received / 2, actualUnitCost: "3.5000", expiryDate: "2027-01-01" }, { purchaseItemId: item.id, warehouseId: secondWarehouse.id, quantityInOrderUnit: received / 2, actualUnitCost: "3.5000", expiryDate: "2027-01-01" }]
      : [{ purchaseItemId: item.id, warehouseId: warehouse.id, quantityInOrderUnit: received, actualUnitCost: "3.5000", expiryDate: "2027-01-01" }] }, user.id, receiptKey);
    await postPurchaseReceipt(harness.client, purchaseResult.purchase.id, receipt.receipt.id, user.id, receiptPostKey);
    const batches = await harness.client.inventoryBatch.findMany({ where: { purchaseReceiptItem: { purchaseItemId: item.id } }, orderBy: { warehouseId: "asc" } });
    return { user, product, unit, warehouse, secondWarehouse, purchase: purchaseResult.purchase, item, batches, purchaseKey, receiptKey, receiptPostKey };
  }

  const draftInput = (f: Awaited<ReturnType<typeof fixture>>, quantity: number, batchIndex = 0) => ({ reason: "Damaged goods returned to supplier", notes: "Supplier approved the physical return.", refundAmount: (quantity * 3.5).toFixed(2), items: [{ originalPurchaseItemId: f.item.id, sourceBatchId: f.batches[batchIndex]!.id, sourceWarehouseId: f.batches[batchIndex]!.warehouseId, quantityInOrderUnit: quantity, refundedUnitCost: "3.5000" }] });

  async function addSecondReceivedItem(f: Awaited<ReturnType<typeof fixture>>, quantity = 5) {
    const suffix = randomUUID();
    const product = await harness.client.product.create({ data: { name: `Second product ${suffix}`, baseUnit: "bottle", categoryId: f.product.categoryId, quantityInStock: quantity } });
    const unit = await harness.client.productUnit.create({ data: { name: "case", multiplier: 2, price: "4.0000", sku: `SECOND-${suffix}`, productId: product.id } });
    const item = await harness.client.purchaseItem.create({ data: { purchaseId: f.purchase.id, productId: product.id, quantityOrdered: quantity, quantityReceived: quantity, unitId: unit.id, unitPrice: "4", totalPrice: String(quantity * 4), unitMultiplierSnapshot: 2, agreedUnitCost: "4" } });
    const originalReceiptItem = await harness.client.purchaseReceiptItem.findUniqueOrThrow({ where: { id: f.batches[0]!.purchaseReceiptItemId! } });
    const receiptItem = await harness.client.purchaseReceiptItem.create({ data: { receiptId: originalReceiptItem.receiptId, purchaseItemId: item.id, warehouseId: f.secondWarehouse.id, quantityInOrderUnit: quantity, unitMultiplier: 2, quantityBase: quantity * 2, actualUnitCost: "4", expiryDate: null } });
    const batch = await harness.client.inventoryBatch.create({ data: { productId: product.id, warehouseId: f.secondWarehouse.id, quantityOnHandBase: quantity * 2, disposition: "SELLABLE", receivedAt: new Date("2026-07-21T09:00:00Z"), purchaseReceiptItemId: receiptItem.id } });
    return { product, unit, item, batch };
  }

  it("creates an inventory-neutral directly provenanced draft and replays only the same payload", async () => {
    const f = await fixture();
    const first = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 3), f.user.id, "supplier-draft-replay");
    const replay = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 3), f.user.id, "supplier-draft-replay");
    expect(replay.purchaseReturn.id).toBe(first.purchaseReturn.id);
    expect(first.purchaseReturn.items[0]).toMatchObject({ originalPurchaseItemId: f.item.id, sourceBatchId: f.batches[0]!.id, unitMultiplier: 1, quantityBase: 3 });
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batches[0]!.id } })).quantityOnHandBase).toBe(8);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(8);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "SUPPLIER_RETURN" } })).toBe(0);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 2), f.user.id, "supplier-draft-replay")).rejects.toThrow(/idempotency/i);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 1), f.user.id, f.purchaseKey)).rejects.toThrow(/idempotency/i);
  });

  it("validates aggregate draft quantities per purchase item before creating records", async () => {
    const f = await fixture(10, true);
    await harness.client.inventoryBatch.updateMany({ where: { id: { in: f.batches.map((batch) => batch.id) } }, data: { quantityOnHandBase: 6 } });
    const lines = f.batches.map((batch) => ({ originalPurchaseItemId: f.item.id, sourceBatchId: batch.id, sourceWarehouseId: batch.warehouseId, quantityInOrderUnit: 6, refundedUnitCost: "3.5000" }));
    await expect(createPurchaseReturn(harness.client, f.purchase.id, { reason: "Aggregate over-return", refundAmount: "42.00", items: lines }, f.user.id, "aggregate-over-draft")).rejects.toThrow(/aggregate.*receipt/i);
    expect(await harness.client.purchaseReturn.count()).toBe(0);
    expect(await harness.client.purchaseReturnItem.count()).toBe(0);
    const valid = await createPurchaseReturn(harness.client, f.purchase.id, { reason: "Aggregate valid return", refundAmount: "35.00", items: [lines[0]!, { ...lines[1]!, quantityInOrderUnit: 4 }] }, f.user.id, "aggregate-valid-draft");
    expect(valid.quantitySummary).toEqual({ lineCount: 2, products: [{ productId: f.product.id, totalBaseQuantity: 10, unitGroups: [{ unitId: f.unit.id, quantityInOrderUnit: 10, multiplierSnapshot: 1, baseQuantity: 10 }] }] });
    const replay = await createPurchaseReturn(harness.client, f.purchase.id, { reason: "Aggregate valid return", refundAmount: "35.00", items: [lines[0]!, { ...lines[1]!, quantityInOrderUnit: 4 }] }, f.user.id, "aggregate-valid-draft");
    expect(replay.purchaseReturn.id).toBe(valid.purchaseReturn.id);
    expect(await harness.client.purchaseReturn.count()).toBe(1);
  });

  it("groups mixed-product quantities independently and rejects aggregate overflow", async () => {
    const f = await fixture(10);
    const second = await addSecondReceivedItem(f, 5);
    const mixed = await createPurchaseReturn(harness.client, f.purchase.id, { reason: "Mixed product return", refundAmount: "30.50", items: [{ ...draftInput(f, 3).items[0]! }, { originalPurchaseItemId: second.item.id, sourceBatchId: second.batch.id, sourceWarehouseId: second.batch.warehouseId, quantityInOrderUnit: 2, refundedUnitCost: "4.0000" }] }, f.user.id, "mixed-product-draft");
    expect(mixed.quantitySummary.lineCount).toBe(2);
    expect(mixed.quantitySummary.products).toEqual(expect.arrayContaining([
      { productId: f.product.id, totalBaseQuantity: 3, unitGroups: [{ unitId: f.unit.id, quantityInOrderUnit: 3, multiplierSnapshot: 1, baseQuantity: 3 }] },
      { productId: second.product.id, totalBaseQuantity: 4, unitGroups: [{ unitId: second.unit.id, quantityInOrderUnit: 2, multiplierSnapshot: 2, baseQuantity: 4 }] },
    ]));
    expect(mixed.quantitySummary).not.toHaveProperty("totalReturnedOrderUnits");
    expect(mixed.quantitySummary).not.toHaveProperty("totalReturnedBase");
    const posted = await postPurchaseReturn(harness.client, f.purchase.id, mixed.purchaseReturn.id, f.user.id, "mixed-product-post");
    const replay = await postPurchaseReturn(harness.client, f.purchase.id, mixed.purchaseReturn.id, f.user.id, "mixed-product-post");
    expect(replay.result.quantitySummary).toEqual(posted.result.quantitySummary);

    await clearDisposableDatabase(harness);
    const overflow = await fixture(10);
    const receiptItemId = overflow.batches[0]!.purchaseReceiptItemId!;
    await harness.client.inventoryBatch.update({ where: { id: overflow.batches[0]!.id }, data: { quantityOnHandBase: 2_147_483_647 } });
    const extraBatch = await harness.client.inventoryBatch.create({ data: { productId: overflow.product.id, warehouseId: overflow.secondWarehouse.id, quantityOnHandBase: 2_147_483_647, disposition: "SELLABLE", receivedAt: new Date(), purchaseReceiptItemId: receiptItemId } });
    await expect(createPurchaseReturn(harness.client, overflow.purchase.id, { reason: "Overflow aggregate", refundAmount: "0", items: [{ originalPurchaseItemId: overflow.item.id, sourceBatchId: overflow.batches[0]!.id, sourceWarehouseId: overflow.batches[0]!.warehouseId, quantityInOrderUnit: 2_147_483_647 }, { originalPurchaseItemId: overflow.item.id, sourceBatchId: extraBatch.id, sourceWarehouseId: extraBatch.warehouseId, quantityInOrderUnit: 2_147_483_647 }] }, overflow.user.id, "overflow-aggregate-draft")).rejects.toThrow(/database range/i);
    expect(await harness.client.purchaseReturn.count()).toBe(0);
  });

  it("rejects unrelated, mismatched, ambiguous, zero, and over-balance source batches", async () => {
    const f = await fixture(); const other = await fixture();
    const unrelated = { ...draftInput(f, 1), items: [{ ...draftInput(f, 1).items[0]!, sourceBatchId: other.batches[0]!.id, sourceWarehouseId: other.batches[0]!.warehouseId }] };
    await expect(createPurchaseReturn(harness.client, f.purchase.id, unrelated, f.user.id, "unrelated-supplier-batch")).rejects.toThrow(/product|provenance/i);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, { ...draftInput(f, 1), items: [{ ...draftInput(f, 1).items[0]!, sourceWarehouseId: f.secondWarehouse.id }] }, f.user.id, "wrong-supplier-warehouse")).rejects.toThrow(/warehouse/i);
    const ambiguous = await harness.client.inventoryBatch.create({ data: { productId: f.product.id, warehouseId: f.warehouse.id, quantityOnHandBase: 2, disposition: "SELLABLE", receivedAt: new Date() } });
    await expect(createPurchaseReturn(harness.client, f.purchase.id, { ...draftInput(f, 1), items: [{ ...draftInput(f, 1).items[0]!, sourceBatchId: ambiguous.id }] }, f.user.id, "ambiguous-supplier-batch")).rejects.toThrow(/provenance/i);
    await harness.client.inventoryBatch.update({ where: { id: f.batches[0]!.id }, data: { quantityOnHandBase: 0 } });
    await expect(createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 1), f.user.id, "zero-supplier-batch")).rejects.toThrow(/insufficient/i);
    await harness.client.inventoryBatch.update({ where: { id: f.batches[0]!.id }, data: { quantityOnHandBase: 9 } });
    await expect(createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 9), f.user.id, "over-received-supplier-batch")).rejects.toThrow(/receipt quantity/i);
  });

  it("rejects cancelled purchases while treating posted receipt provenance as eligibility authority", async () => {
    const f = await fixture();
    await harness.client.purchaseOrder.update({ where: { id: f.purchase.id }, data: { transactionStatus: "CANCELLED" } });
    await expect(createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 1), f.user.id, "cancelled-purchase-return")).rejects.toThrow(/cancelled/i);
    expect(await harness.client.purchaseReturn.count()).toBe(0);

    await clearDisposableDatabase(harness);
    const suffix = randomUUID();
    const user = await harness.client.user.create({ data: { name: "No receipt admin", email: `${suffix}@no-receipt.test`, password: "local-test-only", role: "ADMIN" } });
    const category = await harness.client.category.create({ data: { name: `No receipt ${suffix}` } });
    const product = await harness.client.product.create({ data: { name: `No receipt product ${suffix}`, baseUnit: "piece", categoryId: category.id, quantityInStock: 1 } });
    const unit = await harness.client.productUnit.create({ data: { name: "piece", multiplier: 1, price: "1", sku: `NO-RECEIPT-${suffix}`, productId: product.id } });
    const warehouse = await harness.client.warehouse.create({ data: { name: `No receipt warehouse ${suffix}` } });
    const purchase = await createV2PurchaseOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: product.id, unitId: unit.id, quantityOrdered: 1 }] }, user.id, "no-receipt-purchase");
    const batch = await harness.client.inventoryBatch.create({ data: { productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: 1, disposition: "SELLABLE", receivedAt: new Date() } });
    await expect(createPurchaseReturn(harness.client, purchase.purchase.id, { reason: "No posted receipt", refundAmount: "0", items: [{ originalPurchaseItemId: purchase.purchase.items[0]!.id, sourceBatchId: batch.id, sourceWarehouseId: warehouse.id, quantityInOrderUnit: 1 }] }, user.id, "no-receipt-return")).rejects.toThrow(/provenance/i);
    expect(await harness.client.purchaseReturn.count()).toBe(0);
  });

  it("posts one immutable selected-batch movement, decrements sellable cache, and replays", async () => {
    const f = await fixture();
    const created = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 3), f.user.id, "supplier-post-draft");
    const first = await postPurchaseReturn(harness.client, f.purchase.id, created.purchaseReturn.id, f.user.id, "supplier-post-key");
    const replay = await postPurchaseReturn(harness.client, f.purchase.id, created.purchaseReturn.id, f.user.id, "supplier-post-key");
    expect(replay.postingId).toBe(first.postingId);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batches[0]!.id } })).quantityOnHandBase).toBe(5);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(5);
    expect(await harness.client.stockMovement.findMany({ where: { postingId: first.postingId } })).toEqual([expect.objectContaining({ batchId: f.batches[0]!.id, warehouseId: f.warehouse.id, sourceWarehouseId: f.warehouse.id, type: "SUPPLIER_RETURN", quantityChangeBase: -3 })]);
    expect((await harness.client.purchaseReturn.findUniqueOrThrow({ where: { id: created.purchaseReturn.id } })).status).toBe("POSTED");
    await expect(postPurchaseReturn(harness.client, f.purchase.id, created.purchaseReturn.id, f.user.id, "different-supplier-post-key")).rejects.toThrow(/idempotency/i);
  });

  it("returns directly provenanced non-sellable stock without decrementing sellable cache", async () => {
    const f = await fixture();
    await harness.client.inventoryBatch.update({ where: { id: f.batches[0]!.id }, data: { disposition: "DAMAGED" } });
    const created = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 2), f.user.id, "damaged-supplier-draft");
    await postPurchaseReturn(harness.client, f.purchase.id, created.purchaseReturn.id, f.user.id, "damaged-supplier-post");
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batches[0]!.id } })).quantityOnHandBase).toBe(6);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(8);
  });

  it("rolls back a multi-line post and a sellable-cache inconsistency completely", async () => {
    const f = await fixture(8, true);
    const input = { reason: "Multi-batch supplier return", notes: "Both batches selected explicitly", refundAmount: "14.00", items: f.batches.map((batch) => ({ originalPurchaseItemId: f.item.id, sourceBatchId: batch.id, sourceWarehouseId: batch.warehouseId, quantityInOrderUnit: 2, refundedUnitCost: "3.5000" })) };
    const created = await createPurchaseReturn(harness.client, f.purchase.id, input, f.user.id, "multi-supplier-draft");
    await harness.client.inventoryBatch.update({ where: { id: f.batches[1]!.id }, data: { quantityOnHandBase: 1 } });
    await expect(postPurchaseReturn(harness.client, f.purchase.id, created.purchaseReturn.id, f.user.id, "multi-supplier-post")).rejects.toThrow(/concurrently|retry/i);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batches[0]!.id } })).quantityOnHandBase).toBe(4);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "SUPPLIER_RETURN" } })).toBe(0);

    await clearDisposableDatabase(harness);
    const cache = await fixture();
    const cacheReturn = await createPurchaseReturn(harness.client, cache.purchase.id, draftInput(cache, 2), cache.user.id, "cache-supplier-draft");
    await harness.client.product.update({ where: { id: cache.product.id }, data: { quantityInStock: 1 } });
    await expect(postPurchaseReturn(harness.client, cache.purchase.id, cacheReturn.purchaseReturn.id, cache.user.id, "cache-supplier-post")).rejects.toThrow(/cache/i);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: cache.batches[0]!.id } })).quantityOnHandBase).toBe(8);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "SUPPLIER_RETURN" } })).toBe(0);
  });

  it("prevents cumulative and concurrent returns from exceeding authoritative receipts", async () => {
    const f = await fixture(8);
    const first = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 5), f.user.id, "cumulative-first-draft");
    const second = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 4), f.user.id, "cumulative-second-draft");
    await postPurchaseReturn(harness.client, f.purchase.id, first.purchaseReturn.id, f.user.id, "cumulative-first-post");
    await expect(postPurchaseReturn(harness.client, f.purchase.id, second.purchaseReturn.id, f.user.id, "cumulative-second-post")).rejects.toThrow(/cumulative/i);

    await clearDisposableDatabase(harness);
    const concurrent = await fixture(8);
    const a = await createPurchaseReturn(harness.client, concurrent.purchase.id, draftInput(concurrent, 5), concurrent.user.id, "concurrent-return-a");
    const b = await createPurchaseReturn(harness.client, concurrent.purchase.id, draftInput(concurrent, 5), concurrent.user.id, "concurrent-return-b");
    const outcomes = await Promise.allSettled([postPurchaseReturn(harness.client, concurrent.purchase.id, a.purchaseReturn.id, concurrent.user.id, "concurrent-post-a"), postPurchaseReturn(harness.client, concurrent.purchase.id, b.purchaseReturn.id, concurrent.user.id, "concurrent-post-b")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "SUPPLIER_RETURN" } })).toBe(1);
  });

  it("serializes same-key create and post calls to one persisted identity", async () => {
    const f = await fixture();
    const drafts = await Promise.all([createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 2), f.user.id, "same-supplier-draft"), createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 2), f.user.id, "same-supplier-draft")]);
    expect(drafts[0].purchaseReturn.id).toBe(drafts[1].purchaseReturn.id);
    const posts = await Promise.all([postPurchaseReturn(harness.client, f.purchase.id, drafts[0].purchaseReturn.id, f.user.id, "same-supplier-post"), postPurchaseReturn(harness.client, f.purchase.id, drafts[0].purchaseReturn.id, f.user.id, "same-supplier-post")]);
    expect(posts[0].postingId).toBe(posts[1].postingId);
    expect(await harness.client.purchaseReturn.count()).toBe(1);
    expect(await harness.client.stockMovement.count({ where: { type: "SUPPLIER_RETURN" } })).toBe(1);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batches[0]!.id } })).quantityOnHandBase).toBe(6);
  });

  it("rejects global V2 key reuse across orders, receipts, customer returns, inspections, and supplier posting", async () => {
    const f = await fixture();
    const supplierInput = draftInput(f, 1);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, supplierInput, f.user.id, f.receiptKey)).rejects.toThrow(/idempotency/i);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, supplierInput, f.user.id, f.receiptPostKey)).rejects.toThrow(/idempotency/i);
    const saleKey = "cross-command-sale-key";
    await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "5", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }] }] }, f.user.id, saleKey);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, supplierInput, f.user.id, saleKey)).rejects.toThrow(/idempotency/i);
    const issued = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "5", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }] }] }, f.user.id, "cross-command-issued-sale");
    const customerKey = "cross-command-customer-return";
    const customer = await createSaleReturn(harness.client, issued.sale.id, { reason: "Customer return evidence", items: [{ originalSaleItemId: issued.sale.items[0]!.id, quantityInOrderUnit: 1 }] }, f.user.id, customerKey);
    await expect(createPurchaseReturn(harness.client, f.purchase.id, supplierInput, f.user.id, customerKey)).rejects.toThrow(/idempotency/i);
    await receiveSaleReturn(harness.client, issued.sale.id, customer.saleReturn.id, { receivedAt: "2026-07-21T11:00:00.000Z", items: [{ saleReturnItemId: customer.saleReturn.items[0]!.id, warehouseId: f.secondWarehouse.id }] }, f.user.id, "cross-command-customer-receive");
    const quarantine = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: customer.saleReturn.items[0]!.id, disposition: "QUARANTINED" } });
    const inspectionKey = "cross-command-inspection";
    await inspectSaleReturn(harness.client, issued.sale.id, customer.saleReturn.id, { saleReturnItemId: customer.saleReturn.items[0]!.id, sourceBatchId: quarantine.id, warehouseId: f.secondWarehouse.id, quantityInOrderUnit: 1, outcome: "SELLABLE", inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Returned product passed inspection", checks: { packagingIntact: "PASSED", sealIntact: "PASSED", correctProduct: "PASSED", correctQuantity: "PASSED", expiryChecked: "NOT_APPLICABLE", visibleDamage: "PASSED", returnReasonConfirmed: "PASSED" } }, f.user.id, inspectionKey);
    const supplier = await createPurchaseReturn(harness.client, f.purchase.id, supplierInput, f.user.id, "cross-command-supplier-create");
    await expect(postPurchaseReturn(harness.client, f.purchase.id, supplier.purchaseReturn.id, f.user.id, inspectionKey)).rejects.toThrow(/idempotency/i);
    await expect(postPurchaseReturn(harness.client, f.purchase.id, supplier.purchaseReturn.id, f.user.id, "cross-command-supplier-create")).rejects.toThrow(/idempotency/i);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "SUPPLIER_RETURN" } })).toBe(0);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batches[0]!.id } })).quantityOnHandBase).toBe(7);
  });

  it("serializes supplier return against sale allocation on the same batch", async () => {
    const f = await fixture(8);
    const supplier = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 5), f.user.id, "sale-race-supplier-draft");
    const saleInput = { transactionStatus: "PENDING" as const, amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 5, quantityDelivered: 0, confirmedUnitSalePrice: "5", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 5 }] }] };
    const outcomes = await Promise.allSettled([postPurchaseReturn(harness.client, f.purchase.id, supplier.purchaseReturn.id, f.user.id, "sale-race-supplier-post"), createV2SaleOrder(harness.client, saleInput, f.user.id, "sale-race-sale")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const remaining = (await harness.client.inventoryBatch.aggregate({ where: { productId: f.product.id, disposition: "SELLABLE" }, _sum: { quantityOnHandBase: true } }))._sum.quantityOnHandBase ?? 0;
    expect(remaining).toBe(3);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(remaining);
    expect(await harness.client.stockMovement.count({ where: { OR: [{ type: "SUPPLIER_RETURN" }, { type: "SALE_ISSUE" }] } })).toBe(1);

    await clearDisposableDatabase(harness);
    const sufficient = await fixture(8);
    const smaller = await createPurchaseReturn(harness.client, sufficient.purchase.id, draftInput(sufficient, 3), sufficient.user.id, "sufficient-race-draft");
    const smallerSale = { transactionStatus: "PENDING" as const, amountPaid: "0", extraCost: "0", items: [{ productId: sufficient.product.id, unitId: sufficient.unit.id, quantityOrdered: 3, quantityDelivered: 0, confirmedUnitSalePrice: "5", fulfillments: [{ warehouseId: sufficient.warehouse.id, quantityInOrderUnit: 3 }] }] };
    const successful = await Promise.allSettled([postPurchaseReturn(harness.client, sufficient.purchase.id, smaller.purchaseReturn.id, sufficient.user.id, "sufficient-race-post"), createV2SaleOrder(harness.client, smallerSale, sufficient.user.id, "sufficient-race-sale")]);
    expect(successful.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: sufficient.product.id } })).quantityInStock).toBe(2);
  });

  it("cancels drafts only and applies explicit financial read visibility", async () => {
    const f = await fixture();
    const draft = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 2), f.user.id, "cancel-supplier-draft");
    expect((await cancelPurchaseReturn(harness.client, f.purchase.id, draft.purchaseReturn.id)).status).toBe("CANCELLED");
    await expect(postPurchaseReturn(harness.client, f.purchase.id, draft.purchaseReturn.id, f.user.id, "cancelled-supplier-post")).rejects.toThrow(/cancelled/i);
    const posted = await createPurchaseReturn(harness.client, f.purchase.id, draftInput(f, 1), f.user.id, "posted-cancel-draft");
    await postPurchaseReturn(harness.client, f.purchase.id, posted.purchaseReturn.id, f.user.id, "posted-cancel-post");
    await expect(cancelPurchaseReturn(harness.client, f.purchase.id, posted.purchaseReturn.id)).rejects.toThrow(/reversal/i);
    const financial = await getPurchaseReturn(harness.client, f.purchase.id, posted.purchaseReturn.id, true);
    const restricted = await getPurchaseReturn(harness.client, f.purchase.id, posted.purchaseReturn.id, false);
    expect(financial.financialSummary).toEqual({ declaredRefundAmount: "3.5", calculatedLineRefundAmount: "3.5", refundDifference: "0", lineRefundComplete: true });
    expect(restricted.financialSummary).toBeUndefined();
    expect(restricted.items[0]).not.toHaveProperty("refundedUnitCost");
    const completeInput = draftInput(f, 1); const { refundedUnitCost: _omitted, ...incompleteLine } = completeInput.items[0]!; const incompleteInput = { ...completeInput, items: [incompleteLine] };
    const incomplete = await createPurchaseReturn(harness.client, f.purchase.id, incompleteInput, f.user.id, "incomplete-refund-draft");
    expect((await getPurchaseReturn(harness.client, f.purchase.id, incomplete.purchaseReturn.id, true)).financialSummary).toEqual({ declaredRefundAmount: "3.5", calculatedLineRefundAmount: null, refundDifference: null, lineRefundComplete: false });
  });
});
