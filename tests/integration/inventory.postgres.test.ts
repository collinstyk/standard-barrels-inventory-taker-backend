import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  allocateInventory,
  BatchConcurrencyConflictError,
  executeInventoryPosting,
  getBusinessDate,
  IdempotencyConflictError,
  InsufficientStockError,
  prepareSaleIssue,
} from "../../services/inventory";
import type { BusinessDate, InventoryTransaction, SaleIssueCommand } from "../../services/inventory";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDatabase)("inventory infrastructure on disposable PostgreSQL", () => {
  let harness: IntegrationHarness;
  const today = "2026-07-21" as BusinessDate;

  beforeAll(async () => {
    harness = createIntegrationHarness();
    await clearDisposableDatabase(harness);
  }, 60_000);

  afterEach(async () => clearDisposableDatabase(harness));
  afterAll(async () => harness?.client.$disconnect());

  async function fixture() {
    const suffix = randomUUID();
    const user = await harness.client.user.create({
      data: { name: "Inventory Test", email: `${suffix}@phase2b2.test`, password: "not-a-real-secret", role: "STAFF" },
    });
    const category = await harness.client.category.create({ data: { name: `Category ${suffix}` } });
    const product = await harness.client.product.create({
      data: { name: `Product ${suffix}`, baseUnit: "bottle", categoryId: category.id, quantityInStock: 0 },
    });
    const unit = await harness.client.productUnit.create({
      data: { name: "bottle", multiplier: 1, price: 1, sku: `SKU-${suffix}`, productId: product.id },
    });
    const warehouse = await harness.client.warehouse.create({ data: { name: `Warehouse ${suffix}` } });
    const otherWarehouse = await harness.client.warehouse.create({ data: { name: `Other ${suffix}` } });
    return { user, category, product, unit, warehouse, otherWarehouse };
  }

  async function batch(input: {
    productId: string;
    warehouseId: number;
    quantity: number;
    expiry?: string | null;
    receivedAt?: string;
    disposition?: "SELLABLE" | "DAMAGED" | "QUARANTINED";
    id?: string;
  }) {
    return harness.client.inventoryBatch.create({
      data: {
        id: input.id,
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantityOnHandBase: input.quantity,
        expiryDate: input.expiry ? new Date(`${input.expiry}T00:00:00.000Z`) : null,
        receivedAt: new Date(input.receivedAt ?? "2026-01-01T00:00:00.000Z"),
        disposition: input.disposition ?? "SELLABLE",
      },
    });
  }

  async function plan(productId: string, warehouseId: number, quantityBase: number) {
    return harness.client.$transaction((tx) => allocateInventory({
      tx,
      productId,
      warehouseId,
      quantityBase,
      businessToday: today,
    }));
  }

  async function sale(f: Awaited<ReturnType<typeof fixture>>, quantity: number, saleOrderId?: number) {
    const order = saleOrderId
      ? await harness.client.saleOrder.findUniqueOrThrow({ where: { id: saleOrderId } })
      : await harness.client.saleOrder.create({ data: {
        sellerId: f.user.id,
        transactionStatus: "PENDING",
        paymentStatus: "NOT_PAID",
        deliveryStatus: "NOT_DELIVERED",
        amountPaid: 0,
        totalSaleAmount: 0,
      } });
    const item = await harness.client.saleItem.create({ data: {
      saleId: order.id,
      productId: f.product.id,
      quantityOrdered: quantity,
      unitId: f.unit.id,
      unitPrice: 1,
      totalPrice: quantity,
      sourceWarehouseId: f.warehouse.id,
      unitMultiplierSnapshot: 1,
    } });
    return { order, item };
  }

  it("allocates expiring FEFO, ties by receivedAt then ID, and uses non-expiring FIFO last", async () => {
    const f = await fixture();
    const ids = ["d-batch", "b-batch", "a-batch", "c-batch"];
    await batch({ id: ids[0], productId: f.product.id, warehouseId: f.warehouse.id, quantity: 1, expiry: null, receivedAt: "2025-01-01T00:00:00Z" });
    await batch({ id: ids[1], productId: f.product.id, warehouseId: f.warehouse.id, quantity: 1, expiry: "2026-08-01", receivedAt: "2026-01-02T00:00:00Z" });
    await batch({ id: ids[2], productId: f.product.id, warehouseId: f.warehouse.id, quantity: 1, expiry: "2026-08-01", receivedAt: "2026-01-02T00:00:00Z" });
    await batch({ id: ids[3], productId: f.product.id, warehouseId: f.warehouse.id, quantity: 1, expiry: "2026-08-01", receivedAt: "2026-01-01T00:00:00Z" });
    expect((await plan(f.product.id, f.warehouse.id, 4)).allocations.map((entry) => entry.batchId))
      .toEqual(["c-batch", "a-batch", "b-batch", "d-batch"]);
  });

  it("excludes expired, damaged, quarantined, zero, and other-warehouse batches", async () => {
    const f = await fixture();
    await batch({ id: "valid", productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2, expiry: "2026-07-21" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 10, expiry: "2026-07-20" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 10, disposition: "DAMAGED" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 10, disposition: "QUARANTINED" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 0 });
    await batch({ productId: f.product.id, warehouseId: f.otherWarehouse.id, quantity: 10 });
    expect((await plan(f.product.id, f.warehouse.id, 2)).allocations.map((entry) => entry.batchId)).toEqual(["valid"]);
    await expect(plan(f.product.id, f.warehouse.id, 3)).rejects.toThrow(InsufficientStockError);
  });

  it("spans batches and leaves all balances unchanged when stock is insufficient", async () => {
    const f = await fixture();
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2, expiry: "2026-08-01" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 3 });
    expect((await plan(f.product.id, f.warehouse.id, 5)).allocations).toHaveLength(2);
    await expect(plan(f.product.id, f.warehouse.id, 6)).rejects.toThrow(InsufficientStockError);
    expect(await harness.client.inventoryBatch.aggregate({ _sum: { quantityOnHandBase: true } })).toMatchObject({ _sum: { quantityOnHandBase: 5 } });
  });

  it("conditionally prevents negative batch stock", async () => {
    const f = await fixture();
    const created = await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 1 });
    const { decrementAllocatedBatch } = await import("../../services/inventory/batchMutations");
    await expect(decrementAllocatedBatch(harness.client as unknown as InventoryTransaction, {
      batchId: created.id,
      productId: f.product.id,
      warehouseId: f.warehouse.id,
      quantityBase: 2,
      expiryDate: null,
      receivedAt: created.receivedAt,
    })).rejects.toThrow(BatchConcurrencyConflictError);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: created.id } })).quantityOnHandBase).toBe(1);
  });

  it("commits posting, movements, allocations, batches, and compatibility cache atomically", async () => {
    const f = await fixture();
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 5 } });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2, expiry: "2026-08-01" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 3 });
    const s = await sale(f, 5);
    const result = await prepareSaleIssue(harness.client, {
      idempotencyKey: "sale-commit",
      performedById: f.user.id,
      saleOrderId: s.order.id,
      businessToday: today,
      items: [{ saleItemId: s.item.id, productId: f.product.id, warehouseId: f.warehouse.id }],
    });
    expect(result.replayed).toBe(false);
    expect(await harness.client.stockMovement.count({ where: { postingId: result.postingId } })).toBe(2);
    expect(await harness.client.saleAllocation.count({ where: { saleItemId: s.item.id } })).toBe(2);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
  });

  it("derives issue quantity from persisted order quantity and ignores lower or higher caller claims", async () => {
    for (const claimedQuantity of [1, 999]) {
      const f = await fixture();
      await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 4 } });
      await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 4 });
      const s = await sale(f, 4);
      const command = {
        idempotencyKey: `authority-${claimedQuantity}`,
        performedById: f.user.id,
        saleOrderId: s.order.id,
        businessToday: today,
        items: [{
          saleItemId: s.item.id,
          productId: f.product.id,
          warehouseId: f.warehouse.id,
          quantityBase: claimedQuantity,
        }],
      } as unknown as SaleIssueCommand;
      const result = await prepareSaleIssue(harness.client, command);
      expect(result.result.totalIssued).toBe(4);
      expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
    }
  });

  it("rejects activation when the persisted multiplier snapshot is missing", async () => {
    const f = await fixture();
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 2 } });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2 });
    const s = await sale(f, 2);
    await harness.client.saleItem.update({ where: { id: s.item.id }, data: { unitMultiplierSnapshot: null } });
    await expect(prepareSaleIssue(harness.client, {
      idempotencyKey: "missing-multiplier",
      performedById: f.user.id,
      saleOrderId: s.order.id,
      businessToday: today,
      items: [{ saleItemId: s.item.id, productId: f.product.id, warehouseId: f.warehouse.id }],
    })).rejects.toThrow("multiplier snapshot");
    expect(await harness.client.inventoryPosting.count()).toBe(0);
  });

  it("rolls back a forced transaction failure after a batch mutation", async () => {
    const f = await fixture();
    const created = await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 5 });
    await expect(executeInventoryPosting(harness.client, {
      kind: "ADJUSTMENT",
      idempotencyKey: "forced-rollback",
      performedById: f.user.id,
      source: {},
    }, async (tx) => {
      await tx.inventoryBatch.update({ where: { id: created.id }, data: { quantityOnHandBase: { decrement: 1 } } });
      throw new Error("forced rollback");
    }, async () => ({ totalIssued: 0, movementCount: 0 }))).rejects.toThrow("forced rollback");
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: created.id } })).quantityOnHandBase).toBe(5);
    expect(await harness.client.inventoryPosting.count()).toBe(0);
  });

  it("replays the same idempotency key and rejects reuse for another command", async () => {
    const f = await fixture();
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 2 } });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2 });
    const s = await sale(f, 2);
    const command = {
      idempotencyKey: "same-key",
      performedById: f.user.id,
      saleOrderId: s.order.id,
      businessToday: getBusinessDate(new Date("2026-07-21T12:00:00Z")),
      items: [{ saleItemId: s.item.id, productId: f.product.id, warehouseId: f.warehouse.id }],
    };
    const first = await prepareSaleIssue(harness.client, command);
    const second = await prepareSaleIssue(harness.client, command);
    expect(second).toMatchObject({ postingId: first.postingId, replayed: true });
    expect(second.result).toEqual(first.result);
    expect(second.result).toEqual({ totalIssued: 2, movementCount: 1 });
    expect(await harness.client.stockMovement.count()).toBe(1);
    await expect(executeInventoryPosting(harness.client, {
      kind: "ADJUSTMENT",
      idempotencyKey: "same-key",
      performedById: f.user.id,
      source: {},
    }, async () => ({ result: null, movements: [] }), async () => null)).rejects.toThrow(IdempotencyConflictError);
  });

  it("enforces one activation posting per sale order", async () => {
    const f = await fixture();
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 2 } });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2 });
    const s = await sale(f, 1);
    await prepareSaleIssue(harness.client, {
      idempotencyKey: "activation-one", performedById: f.user.id, saleOrderId: s.order.id, businessToday: today,
      items: [{ saleItemId: s.item.id, productId: f.product.id, warehouseId: f.warehouse.id }],
    });
    const secondItem = await harness.client.saleItem.create({ data: {
      saleId: s.order.id, productId: f.product.id, quantityOrdered: 1, unitId: f.unit.id, unitPrice: 1, totalPrice: 1, sourceWarehouseId: f.warehouse.id,
    } });
    await expect(prepareSaleIssue(harness.client, {
      idempotencyKey: "activation-two", performedById: f.user.id, saleOrderId: s.order.id, businessToday: today,
      items: [{ saleItemId: secondItem.id, productId: f.product.id, warehouseId: f.warehouse.id }],
    })).rejects.toBeTruthy();
    expect(await harness.client.inventoryPosting.count({ where: { saleOrderId: s.order.id } })).toBe(1);
  });

  it("prevents two concurrent sales from overselling", async () => {
    const f = await fixture();
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 10 } });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 10 });
    const first = await sale(f, 7);
    const second = await sale(f, 7);
    const results = await Promise.allSettled([
      prepareSaleIssue(harness.client, { idempotencyKey: "concurrent-a", performedById: f.user.id, saleOrderId: first.order.id, businessToday: today, items: [{ saleItemId: first.item.id, productId: f.product.id, warehouseId: f.warehouse.id }] }),
      prepareSaleIssue(harness.client, { idempotencyKey: "concurrent-b", performedById: f.user.id, saleOrderId: second.order.id, businessToday: today, items: [{ saleItemId: second.item.id, productId: f.product.id, warehouseId: f.warehouse.id }] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await harness.client.inventoryBatch.aggregate({ _sum: { quantityOnHandBase: true } }))._sum.quantityOnHandBase).toBe(3);
  });

  it("aborts when the compatibility cache is inconsistent", async () => {
    const f = await fixture();
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 5 });
    const s = await sale(f, 5);
    await expect(prepareSaleIssue(harness.client, {
      idempotencyKey: "bad-cache", performedById: f.user.id, saleOrderId: s.order.id, businessToday: today,
      items: [{ saleItemId: s.item.id, productId: f.product.id, warehouseId: f.warehouse.id }],
    })).rejects.toThrow("compatibility stock cache");
    expect((await harness.client.inventoryBatch.aggregate({ _sum: { quantityOnHandBase: true } }))._sum.quantityOnHandBase).toBe(5);
  });

  it("issues multiple sale items under one posting with unique movement sequences", async () => {
    const f = await fixture();
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: 4 } });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2, expiry: "2026-08-01" });
    await batch({ productId: f.product.id, warehouseId: f.warehouse.id, quantity: 2 });
    const first = await sale(f, 2);
    const secondItem = await harness.client.saleItem.create({ data: {
      saleId: first.order.id, productId: f.product.id, quantityOrdered: 2, unitId: f.unit.id, unitPrice: 1, totalPrice: 2, sourceWarehouseId: f.warehouse.id, unitMultiplierSnapshot: 1,
    } });
    const result = await prepareSaleIssue(harness.client, {
      idempotencyKey: "multi-item", performedById: f.user.id, saleOrderId: first.order.id, businessToday: today,
      items: [
        { saleItemId: first.item.id, productId: f.product.id, warehouseId: f.warehouse.id },
        { saleItemId: secondItem.id, productId: f.product.id, warehouseId: f.warehouse.id },
      ],
    });
    const movements = await harness.client.stockMovement.findMany({ where: { postingId: result.postingId }, orderBy: { sequence: "asc" } });
    expect(movements.map((movement) => movement.sequence)).toEqual([1, 2]);
    expect(new Set(movements.map((movement) => movement.sequence)).size).toBe(movements.length);
  });
});
