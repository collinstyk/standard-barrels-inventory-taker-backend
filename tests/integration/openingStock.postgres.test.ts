import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client";
import { recordOpeningStock } from "../../services/inventory/openingStock";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("opening stock on disposable PostgreSQL", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = createIntegrationHarness();
    await clearDisposableDatabase(harness);
  }, 60_000);
  afterEach(async () => clearDisposableDatabase(harness));
  afterAll(async () => harness?.client.$disconnect());

  async function fixture(multiplier = 1) {
    const suffix = randomUUID();
    const actor = await harness.client.user.create({ data: {
      name: "Opening Admin", email: `${suffix}@opening.test`, password: "local", role: "ADMIN",
    } });
    const category = await harness.client.category.create({ data: { name: `Opening ${suffix}` } });
    const product = await harness.client.product.create({ data: {
      name: `Product ${suffix}`, baseUnit: "piece", categoryId: category.id, quantityInStock: 0,
    } });
    const unit = await harness.client.productUnit.create({ data: {
      name: "Carton", multiplier, price: "1", sku: `OPEN-${suffix}`, productId: product.id,
    } });
    const warehouse = await harness.client.warehouse.create({ data: { name: `Warehouse ${suffix}` } });
    return { actor, product, unit, warehouse };
  }

  it("atomically records multiple products and expiry batches with server-owned unit conversion", async () => {
    const first = await fixture(12);
    const second = await fixture(1);
    const result = await recordOpeningStock(harness.client, {
      notes: "  Initial count  ",
      lines: [
        { productId: first.product.id, unitId: first.unit.id, warehouseId: first.warehouse.id, quantityInUnit: 2, expiryDate: "2099-01-01" },
        { productId: first.product.id, unitId: first.unit.id, warehouseId: first.warehouse.id, quantityInUnit: 1, expiryDate: null },
        { productId: second.product.id, unitId: second.unit.id, warehouseId: second.warehouse.id, quantityInUnit: 5 },
      ],
    }, first.actor.id, "opening-multiple");
    expect(result).toMatchObject({ replayed: false, postingStatus: "POSTED", notes: "Initial count" });
    expect(result.lines.map((line) => line.quantityBase)).toEqual([24, 12, 5]);
    expect(result.lines.map((line) => line.resultingProductSellableCache)).toEqual([36, 36, 5]);
    expect(await harness.client.inventoryBatch.count()).toBe(3);
    expect(await harness.client.stockMovement.count({ where: { type: "OPENING_STOCK" } })).toBe(3);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: first.product.id } })).quantityInStock).toBe(36);
    expect(await harness.client.purchaseOrder.count()).toBe(0);
    expect(await harness.client.purchaseReceipt.count()).toBe(0);
    expect(await harness.client.stockLevel.count()).toBe(0);
  });

  it("replays exactly once and rejects changed payloads or another command's key", async () => {
    const f = await fixture(6);
    const input = { lines: [{ productId: f.product.id, unitId: f.unit.id, warehouseId: f.warehouse.id, quantityInUnit: 2 }] };
    const first = await recordOpeningStock(harness.client, input, f.actor.id, "opening-replay");
    const replay = await recordOpeningStock(harness.client, input, f.actor.id, "opening-replay");
    expect(replay).toMatchObject({ postingId: first.postingId, replayed: true });
    expect(replay.lines[0]?.batchId).toBe(first.lines[0]?.batchId);
    await expect(recordOpeningStock(harness.client, { lines: [{ ...input.lines[0]!, quantityInUnit: 3 }] }, f.actor.id, "opening-replay")).rejects.toThrow(/idempotency/i);
    await harness.client.inventoryPosting.create({ data: {
      idempotencyKey: "different-command", kind: "MIGRATION_OPENING_BALANCE", performedById: f.actor.id,
    } });
    await expect(recordOpeningStock(harness.client, input, f.actor.id, "different-command")).rejects.toThrow(/idempotency/i);
    expect(await harness.client.inventoryBatch.count()).toBe(1);
    expect(await harness.client.stockMovement.count()).toBe(1);
  });

  it("refuses duplicate openings, expired goods, mismatched units, and unreconciled cache", async () => {
    const f = await fixture();
    const input = { lines: [{ productId: f.product.id, unitId: f.unit.id, warehouseId: f.warehouse.id, quantityInUnit: 2 }] };
    await recordOpeningStock(harness.client, input, f.actor.id, "opening-first");
    await expect(recordOpeningStock(harness.client, input, f.actor.id, "opening-duplicate")).rejects.toThrow(/already exists/i);
    const expired = await fixture();
    await expect(recordOpeningStock(harness.client, { lines: [{ productId: expired.product.id, unitId: expired.unit.id, warehouseId: expired.warehouse.id, quantityInUnit: 1, expiryDate: "2000-01-01" }] }, expired.actor.id, "opening-expired")).rejects.toThrow(/expired/i);
    await expect(recordOpeningStock(harness.client, { lines: [{ productId: expired.product.id, unitId: f.unit.id, warehouseId: expired.warehouse.id, quantityInUnit: 1 }] }, expired.actor.id, "opening-wrong-unit")).rejects.toThrow(/does not belong/i);
    await harness.client.product.update({ where: { id: expired.product.id }, data: { quantityInStock: 1 } });
    await expect(recordOpeningStock(harness.client, { lines: [{ productId: expired.product.id, unitId: expired.unit.id, warehouseId: expired.warehouse.id, quantityInUnit: 1 }] }, expired.actor.id, "opening-bad-cache")).rejects.toThrow(/reconcile/i);
    expect(await harness.client.inventoryBatch.count()).toBe(1);
  });

  it("rolls back batches, cache, and posting if a movement cannot be written", async () => {
    const f = await fixture();
    await harness.client.$executeRaw(Prisma.sql`CREATE FUNCTION fail_opening_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."type" = 'OPENING_STOCK' THEN RAISE EXCEPTION 'forced opening movement failure'; END IF; RETURN NEW; END $$`);
    await harness.client.$executeRaw(Prisma.sql`CREATE TRIGGER "fail_opening_movement_trigger" BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION fail_opening_movement()`);
    try {
      await expect(recordOpeningStock(harness.client, { lines: [{ productId: f.product.id, unitId: f.unit.id, warehouseId: f.warehouse.id, quantityInUnit: 4 }] }, f.actor.id, "opening-failed")).rejects.toThrow();
      expect(await harness.client.inventoryBatch.count()).toBe(0);
      expect(await harness.client.inventoryPosting.count()).toBe(0);
      expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(0);
    } finally {
      await harness.client.$executeRaw(Prisma.sql`DROP TRIGGER "fail_opening_movement_trigger" ON "StockMovement"`);
      await harness.client.$executeRaw(Prisma.sql`DROP FUNCTION fail_opening_movement()`);
    }
  });
});
