import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createV2SaleOrder } from "../../services/inventory/orderWorkflows";
import { cancelSaleReturn, createSaleReturn, getSaleReturn, inspectSaleReturn, receiveSaleReturn } from "../../services/inventory/saleReturn";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDatabase)("Phase 2B-4A customer returns on disposable PostgreSQL", () => {
  let harness: IntegrationHarness;
  beforeAll(async () => { harness = createIntegrationHarness(); await clearDisposableDatabase(harness); }, 60_000);
  afterEach(async () => clearDisposableDatabase(harness));
  afterAll(async () => harness?.client.$disconnect());

  async function fixture(quantity = 10) {
    const suffix = randomUUID();
    const user = await harness.client.user.create({ data: { name: "Return Admin", email: `${suffix}@returns.test`, password: "local-test-only", role: "ADMIN" } });
    const category = await harness.client.category.create({ data: { name: `Return ${suffix}` } });
    const product = await harness.client.product.create({ data: { name: `Return product ${suffix}`, baseUnit: "piece", categoryId: category.id, quantityInStock: quantity } });
    const unit = await harness.client.productUnit.create({ data: { name: "piece", multiplier: 1, price: "2", sku: `RET-${suffix}`, productId: product.id } });
    const issueWarehouse = await harness.client.warehouse.create({ data: { name: `Issue ${suffix}` } });
    const returnWarehouse = await harness.client.warehouse.create({ data: { name: `Return ${suffix}` } });
    await harness.client.inventoryBatch.create({ data: { productId: product.id, warehouseId: issueWarehouse.id, quantityOnHandBase: quantity, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" } });
    const sale = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: product.id, unitId: unit.id, quantityOrdered: quantity, quantityDelivered: 0, confirmedUnitSalePrice: "10", fulfillments: [{ warehouseId: issueWarehouse.id, quantityInOrderUnit: quantity }] }] }, user.id, `issued-${suffix}`);
    return { user, product, unit, issueWarehouse, returnWarehouse, sale: sale.sale, saleItem: sale.sale.items[0]! };
  }

  async function draft(f: Awaited<ReturnType<typeof fixture>>, quantity: number, key = `draft-${randomUUID()}`, expiryDate?: string | null) {
    return createSaleReturn(harness.client, f.sale.id, { reason: "Customer returned item", items: [{ originalSaleItemId: f.saleItem.id, quantityInOrderUnit: quantity, expiryDate }] }, f.user.id, key);
  }

  async function receive(f: Awaited<ReturnType<typeof fixture>>, created: Awaited<ReturnType<typeof draft>>, key = `receive-${randomUUID()}`) {
    return receiveSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ saleReturnItemId: created.saleReturn.items[0]!.id, warehouseId: f.returnWarehouse.id }] }, f.user.id, key);
  }

  const passedChecks = { packagingIntact: "PASSED", sealIntact: "PASSED", correctProduct: "PASSED", correctQuantity: "PASSED", expiryChecked: "PASSED", visibleDamage: "PASSED", returnReasonConfirmed: "PASSED" } as const;
  const checksFor = (outcome: "SELLABLE" | "DAMAGED" | "REJECTED") => outcome === "SELLABLE"
    ? passedChecks
    : outcome === "DAMAGED"
      ? { ...passedChecks, visibleDamage: "FAILED" as const }
      : { ...passedChecks, sealIntact: "FAILED" as const };

  it("creates an inventory-neutral draft linked to the issued sale and replays only the same payload", async () => {
    const f = await fixture();
    const first = await draft(f, 3, "return-draft-replay");
    const replay = await draft(f, 3, "return-draft-replay");
    expect(replay.saleReturn.id).toBe(first.saleReturn.id);
    expect(first.saleReturn.items[0]).toMatchObject({ originalSaleItemId: f.saleItem.id, unitMultiplier: 1, quantityBase: 3 });
    expect(await harness.client.inventoryBatch.count({ where: { disposition: "QUARANTINED" } })).toBe(0);
    await expect(draft(f, 2, "return-draft-replay")).rejects.toThrow(/idempotency/i);
  });

  it("rejects impossible draft quantities and sale items with no issued allocation", async () => {
    const f = await fixture(5);
    await expect(draft(f, 6, "draft-over-issued")).rejects.toThrow(/exceeds/i);
    const unallocated = await harness.client.saleItem.create({ data: { saleId: f.sale.id, productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, unitMultiplierSnapshot: 1, confirmedUnitSalePrice: "10", unitPrice: "10", totalPrice: "10" } });
    await expect(createSaleReturn(harness.client, f.sale.id, { reason: "Unallocated item", items: [{ originalSaleItemId: unallocated.id, quantityInOrderUnit: 1 }] }, f.user.id, "draft-zero-allocation")).rejects.toThrow(/issued allocation/i);
    expect(await harness.client.saleReturn.count()).toBe(0);
    expect((await draft(f, 2, "valid-partial-draft")).saleReturn.items[0]!.quantityBase).toBe(2);
  });

  it("serializes concurrent same-key draft creation and replays one persisted return", async () => {
    const f = await fixture();
    const outcomes = await Promise.all([draft(f, 3, "concurrent-same-draft"), draft(f, 3, "concurrent-same-draft")]);
    expect(outcomes[0].saleReturn.id).toBe(outcomes[1].saleReturn.id);
    expect(await harness.client.saleReturn.count()).toBe(1);
    expect(await harness.client.saleReturnItem.count()).toBe(1);
  });

  it("rejects unrelated or unissued sale items", async () => {
    const f = await fixture();
    const unrelated = await fixture();
    await expect(createSaleReturn(harness.client, f.sale.id, { reason: "Wrong item", items: [{ originalSaleItemId: unrelated.saleItem.id, quantityInOrderUnit: 1 }] }, f.user.id, "unrelated-return")).rejects.toThrow(/not found/i);
    const draftSale = await harness.client.saleOrder.create({ data: { sellerId: f.user.id, transactionStatus: "DRAFT", paymentStatus: "NOT_PAID", deliveryStatus: "NOT_DELIVERED", amountPaid: 0, totalSaleAmount: 0 } });
    await expect(createSaleReturn(harness.client, draftSale.id, { reason: "Unissued", items: [{ originalSaleItemId: f.saleItem.id, quantityInOrderUnit: 1 }] }, f.user.id, "unissued-return")).rejects.toThrow(/issued/i);
  });

  it("receives into the explicitly selected warehouse as quarantine without changing sellable cache and replays", async () => {
    const f = await fixture();
    const created = await draft(f, 4);
    const first = await receive(f, created, "return-receive-replay");
    const replay = await receive(f, created, "return-receive-replay");
    expect(replay.postingId).toBe(first.postingId);
    const batch = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: created.saleReturn.items[0]!.id } });
    expect(batch).toMatchObject({ warehouseId: f.returnWarehouse.id, disposition: "QUARANTINED", quantityOnHandBase: 4 });
    expect(batch.warehouseId).not.toBe(f.issueWarehouse.id);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
    expect(await harness.client.stockMovement.count({ where: { postingId: first.postingId } })).toBe(1);
    await expect(receiveSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { receivedAt: "2026-07-21T10:00:00.000Z", items: [{ saleReturnItemId: created.saleReturn.items[0]!.id, warehouseId: f.issueWarehouse.id }] }, f.user.id, "return-receive-replay")).rejects.toThrow(/idempotency/i);
    await expect(receive(f, created, "different-receive-key")).rejects.toThrow(/idempotency/i);
  });

  it("enforces prior and concurrent cumulative accepted quantities", async () => {
    const f = await fixture(5);
    const first = await draft(f, 3); await receive(f, first);
    const second = await draft(f, 3); await expect(receive(f, second)).rejects.toThrow(/exceeds/i);
    expect((await harness.client.saleReturn.findUniqueOrThrow({ where: { id: second.saleReturn.id } })).status).toBe("DRAFT");
    expect(await harness.client.inventoryBatch.count({ where: { disposition: "QUARANTINED" } })).toBe(1);

    await clearDisposableDatabase(harness);
    const concurrent = await fixture(5);
    const a = await draft(concurrent, 3); const b = await draft(concurrent, 3);
    const outcomes = await Promise.allSettled([receive(concurrent, a), receive(concurrent, b)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await harness.client.inventoryBatch.count({ where: { disposition: "QUARANTINED" } })).toBe(1);
  });

  it("partially inspects quarantine into sellable, damaged, and rejected outcomes", async () => {
    const f = await fixture();
    const created = await draft(f, 10, undefined, "2026-08-01"); await receive(f, created);
    const itemId = created.saleReturn.items[0]!.id;
    const source = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: itemId, disposition: "QUARANTINED" } });
    const inspect = (quantity: number, outcome: "SELLABLE" | "DAMAGED" | "REJECTED", key: string) => inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { saleReturnItemId: itemId, sourceBatchId: source.id, warehouseId: f.returnWarehouse.id, quantityInOrderUnit: quantity, outcome, inspectedAt: "2026-07-21T12:00:00.000Z", notes: `${outcome} inspection evidence`, checks: checksFor(outcome) }, f.user.id, key);
    const sellable = await inspect(7, "SELLABLE", "inspect-sellable");
    expect((await harness.client.saleReturn.findUniqueOrThrow({ where: { id: created.saleReturn.id } })).status).toBe("PARTLY_INSPECTED");
    await inspect(2, "DAMAGED", "inspect-damaged");
    await inspect(1, "REJECTED", "inspect-rejected");
    const replay = await inspect(7, "SELLABLE", "inspect-sellable");
    expect(replay.postingId).toBe(sellable.postingId);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHandBase).toBe(0);
    const derived = await harness.client.inventoryBatch.findMany({ where: { sourceBatchId: source.id }, orderBy: { disposition: "asc" } });
    expect(derived.map((batch) => [batch.disposition, batch.quantityOnHandBase])).toEqual(expect.arrayContaining([["SELLABLE", 7], ["DAMAGED", 2]]));
    expect(derived.every((batch) => batch.sourceBatchId === source.id)).toBe(true);
    expect(derived.every((batch) => batch.expiryDate?.toISOString().slice(0, 10) === "2026-08-01")).toBe(true);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(7);
    expect((await harness.client.saleReturn.findUniqueOrThrow({ where: { id: created.saleReturn.id } })).status).toBe("INSPECTED");
    expect(await harness.client.returnInspection.count()).toBe(3);
    const persisted = await harness.client.returnInspection.findFirstOrThrow({ where: { idempotencyKey: "inspect-sellable" } });
    expect(persisted).toMatchObject({ ...passedChecks, inspectorId: f.user.id, finalCondition: "SELLABLE", quantityBase: 7 });
    const read = await getSaleReturn(harness.client, f.sale.id, created.saleReturn.id);
    expect(read.outcomeSummary).toEqual({ sellableQuantityBase: 7, damagedQuantityBase: 2, rejectedQuantityBase: 1, remainingQuarantineQuantityBase: 0 });
    expect(read.items[0]!.intakeCondition).toBe("QUARANTINED");
    expect(read.items[0]!.inspections[0]!.inspector).toMatchObject({ id: f.user.id, role: "ADMIN" });
  });

  it("rejects unsupported inspection evidence without persisting any mutation", async () => {
    const f = await fixture();
    const created = await draft(f, 3, "invalid-evidence-draft", "2026-08-01"); await receive(f, created);
    const item = created.saleReturn.items[0]!;
    const source = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: item.id } });
    const base = { saleReturnItemId: item.id, sourceBatchId: source.id, warehouseId: f.returnWarehouse.id, quantityInOrderUnit: 1, outcome: "SELLABLE" as const, inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Evidence rejected" };
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...base, checks: { ...passedChecks, correctProduct: "FAILED" } }, f.user.id, "failed-product-evidence")).rejects.toThrow(/identity/i);
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...base, checks: { ...passedChecks, visibleDamage: "FAILED" } }, f.user.id, "failed-damage-evidence")).rejects.toThrow(/damage/i);
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...base, checks: { ...passedChecks, expiryChecked: "NOT_APPLICABLE" } }, f.user.id, "missing-expiry-evidence")).rejects.toThrow(/expiryChecked/i);
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...base, outcome: "DAMAGED", notes: "short", checks: passedChecks }, f.user.id, "missing-damaged-evidence")).rejects.toThrow(/damaged/i);
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...base, outcome: "REJECTED", notes: "Rejected explanation", checks: passedChecks }, f.user.id, "missing-rejected-evidence")).rejects.toThrow(/failed relevant/i);
    expect(await harness.client.returnInspection.count()).toBe(0);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "RETURN_INSPECTION_RECLASSIFICATION" } })).toBe(0);
    expect(await harness.client.stockMovement.count({ where: { type: { in: ["CUSTOMER_RETURN_SELLABLE", "CUSTOMER_RETURN_DAMAGED", "CUSTOMER_RETURN_REJECTED", "RETURN_INSPECTION_RECLASSIFICATION"] } } })).toBe(0);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHandBase).toBe(3);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
  });

  it("serializes concurrent same-key inspection and conflicts on a changed checklist", async () => {
    const f = await fixture();
    const created = await draft(f, 4); await receive(f, created);
    const item = created.saleReturn.items[0]!;
    const source = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: item.id } });
    const input = { saleReturnItemId: item.id, sourceBatchId: source.id, warehouseId: f.returnWarehouse.id, quantityInOrderUnit: 2, outcome: "SELLABLE" as const, inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Concurrent sellable evidence", checks: passedChecks };
    const outcomes = await Promise.all([inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, input, f.user.id, "same-inspection-key"), inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, input, f.user.id, "same-inspection-key")]);
    expect(outcomes[0].postingId).toBe(outcomes[1].postingId);
    expect(outcomes[0].result.inspectionId).toBe(outcomes[1].result.inspectionId);
    expect(await harness.client.returnInspection.count()).toBe(1);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "RETURN_INSPECTION_RECLASSIFICATION" } })).toBe(1);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHandBase).toBe(2);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(2);
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...input, checks: { ...passedChecks, packagingIntact: "NOT_APPLICABLE" } }, f.user.id, "same-inspection-key")).rejects.toThrow(/idempotency/i);
  });

  it("rolls back over-inspection and prevents expired stock becoming sellable", async () => {
    const f = await fixture();
    const created = await draft(f, 2, undefined, "2026-07-20"); await receive(f, created);
    const item = created.saleReturn.items[0]!;
    const source = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: item.id } });
    const input = { saleReturnItemId: item.id, sourceBatchId: source.id, warehouseId: f.returnWarehouse.id, quantityInOrderUnit: 2, outcome: "SELLABLE" as const, inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Verified sellable", checks: passedChecks };
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, input, f.user.id, "expired-inspection")).rejects.toThrow(/expired/i);
    await expect(inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { ...input, quantityInOrderUnit: 3, outcome: "DAMAGED", notes: "Damaged evidence" }, f.user.id, "over-inspection")).rejects.toThrow(/exceeds/i);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHandBase).toBe(2);
    expect(await harness.client.returnInspection.count()).toBe(0);
  });

  it("serializes concurrent inspection so quarantine cannot be consumed twice", async () => {
    const f = await fixture();
    const created = await draft(f, 10); await receive(f, created);
    const item = created.saleReturn.items[0]!;
    const source = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: item.id } });
    const inspect = (key: string) => inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { saleReturnItemId: item.id, sourceBatchId: source.id, warehouseId: f.returnWarehouse.id, quantityInOrderUnit: 6, outcome: "DAMAGED", inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Concurrent damage evidence", checks: checksFor("DAMAGED") }, f.user.id, key);
    const outcomes = await Promise.allSettled([inspect("concurrent-inspection-a"), inspect("concurrent-inspection-b")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHandBase).toBe(4);
    expect(await harness.client.returnInspection.count()).toBe(1);
  });

  it("reports requested, received, inspected, and remaining quantities", async () => {
    const f = await fixture();
    const created = await draft(f, 5); await receive(f, created);
    const item = created.saleReturn.items[0]!;
    const source = await harness.client.inventoryBatch.findFirstOrThrow({ where: { saleReturnItemId: item.id } });
    await inspectSaleReturn(harness.client, f.sale.id, created.saleReturn.id, { saleReturnItemId: item.id, sourceBatchId: source.id, warehouseId: f.returnWarehouse.id, quantityInOrderUnit: 2, outcome: "DAMAGED", inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Damage evidence", checks: checksFor("DAMAGED") }, f.user.id, "summary-inspection");
    const result = await getSaleReturn(harness.client, f.sale.id, created.saleReturn.id);
    expect(result.quantitySummary).toEqual({ requestedQuantityBase: 5, receivedQuantityBase: 5, inspectedQuantityBase: 2, remainingQuantityBase: 3 });
    expect(result.items[0]!.quantitySummary).toMatchObject({ requestedQuantityInOrderUnit: 5, receivedQuantityBase: 5, inspectedQuantityBase: 2, remainingQuantityBase: 3 });
  });

  it("allows cancellation only before quarantine receipt", async () => {
    const f = await fixture();
    const unreceived = await draft(f, 1);
    expect((await cancelSaleReturn(harness.client, f.sale.id, unreceived.saleReturn.id)).status).toBe("CANCELLED");
    await expect(receive(f, unreceived)).rejects.toThrow(/cancelled/i);
    const received = await draft(f, 1); await receive(f, received);
    await expect(cancelSaleReturn(harness.client, f.sale.id, received.saleReturn.id)).rejects.toThrow(/reversed/i);
  });
});
