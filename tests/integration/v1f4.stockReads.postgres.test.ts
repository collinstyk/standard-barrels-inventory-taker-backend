import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as master from "../../services/masterData";
import { addBusinessDays, getAuthoritativeExpiringSoon, getAuthoritativeLowStock, getBusinessDate } from "../../services/inventory";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("V1-F4 authoritative stock reads on disposable PostgreSQL", () => {
  let h: IntegrationHarness;
  const oldFlag = process.env.INVENTORY_V2_ENABLED;

  beforeAll(async () => {
    process.env.INVENTORY_V2_ENABLED = "true";
    h = createIntegrationHarness();
    await clearDisposableDatabase(h);
  }, 60_000);
  afterEach(async () => clearDisposableDatabase(h));
  afterAll(async () => {
    if (oldFlag === undefined) delete process.env.INVENTORY_V2_ENABLED;
    else process.env.INVENTORY_V2_ENABLED = oldFlag;
    await h?.client.$disconnect();
  });

  async function fixtures() {
    const category = await master.createCategory(h.client, { name: `Category ${randomUUID()}` });
    const warehouse = await master.createWarehouse(h.client, { name: `Warehouse ${randomUUID()}` });
    const makeProduct = (name: string, reorderPoint: number) => master.createProduct(h.client, {
      name, baseUnit: "piece", categoryId: category.id, reorderPoint,
      units: [{ name: "Single", multiplier: 1, price: "1", sku: `${name}-${randomUUID()}` }],
    });
    return { warehouse, makeProduct };
  }

  it("aggregates eligible batches, includes zero-stock products, and filters before pagination", async () => {
    const { warehouse, makeProduct } = await fixtures();
    const zero = await makeProduct("Alpha Zero", 3);
    const low = await makeProduct("Beta Low", 5);
    const healthy = await makeProduct("Gamma Healthy", 2);
    const today = getBusinessDate();
    await h.client.inventoryBatch.createMany({ data: [
      { productId: low.id, warehouseId: warehouse.id, quantityOnHandBase: 4, disposition: "SELLABLE", receivedAt: new Date(), expiryDate: new Date(`${today}T00:00:00.000Z`) },
      { productId: low.id, warehouseId: warehouse.id, quantityOnHandBase: 50, disposition: "DAMAGED", receivedAt: new Date() },
      { productId: healthy.id, warehouseId: warehouse.id, quantityOnHandBase: 3, disposition: "SELLABLE", receivedAt: new Date() },
    ] });
    const first = await getAuthoritativeLowStock(h.client, { page: 1, limit: 1 });
    expect(first.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(first.data[0]).toMatchObject({ productId: zero.id, sellableQuantityBase: 0, severity: "CRITICAL_OUT_OF_STOCK" });
    const searched = await getAuthoritativeLowStock(h.client, { page: 1, limit: 20, search: "Beta" });
    expect(searched.data).toEqual([expect.objectContaining({ productId: low.id, sellableQuantityBase: 4, shortageQuantityBase: 1 })]);
  });

  it("uses inclusive business-date expiry bounds, filters, and stable ordering", async () => {
    const { warehouse, makeProduct } = await fixtures();
    const product = await makeProduct("Expiry Product", 0);
    const today = getBusinessDate();
    const cutoff = addBusinessDays(today, 2);
    const received = new Date("2026-01-01T10:00:00.000Z");
    await h.client.inventoryBatch.createMany({ data: [
      { id: randomUUID(), productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: 1, disposition: "SELLABLE", receivedAt: received, expiryDate: new Date(`${today}T00:00:00.000Z`) },
      { id: randomUUID(), productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: 2, disposition: "SELLABLE", receivedAt: received, expiryDate: new Date(`${cutoff}T00:00:00.000Z`) },
      { id: randomUUID(), productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: 3, disposition: "QUARANTINED", receivedAt: received, expiryDate: new Date(`${today}T00:00:00.000Z`) },
      { id: randomUUID(), productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: 4, disposition: "SELLABLE", receivedAt: received, expiryDate: new Date(`${addBusinessDays(today, 3)}T00:00:00.000Z`) },
    ] });
    const result = await getAuthoritativeExpiringSoon(h.client, { days: 2, page: 1, limit: 20, productId: product.id, warehouseId: warehouse.id });
    expect(result.data.map((row) => row.daysRemaining)).toEqual([0, 2]);
    expect(result.window).toEqual({ days: 2, throughDate: cutoff });
    expect(result.pagination.total).toBe(2);
  });

  it("returns authoritative catalog stock without mutating compatibility state", async () => {
    const { warehouse, makeProduct } = await fixtures();
    const product = await makeProduct("Catalog Product", 10);
    expect(product).toMatchObject({ sellableQuantityBase: 0 });
    expect(product).not.toHaveProperty("quantityInStock");
    await h.client.product.update({ where: { id: product.id }, data: { quantityInStock: 999 } });
    await h.client.inventoryBatch.create({ data: { productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: 7, disposition: "SELLABLE", receivedAt: new Date() } });
    const before = await h.client.product.findUniqueOrThrow({ where: { id: product.id } });
    const detail = await master.getProduct(h.client, product.id);
    const list = await master.listProducts(h.client, { page: 1, limit: 20 });
    const updated = await master.updateProduct(h.client, product.id, { reorderPoint: 8 });
    expect([detail, list.data[0], updated]).toEqual(expect.arrayContaining([
      expect.objectContaining({ sellableQuantityBase: 7 }),
      expect.objectContaining({ sellableQuantityBase: 7 }),
      expect.objectContaining({ sellableQuantityBase: 7 }),
    ]));
    expect(detail).not.toHaveProperty("quantityInStock");
    expect((await h.client.product.findUniqueOrThrow({ where: { id: product.id } })).quantityInStock).toBe(before.quantityInStock);
    expect(await h.client.inventoryPosting.count()).toBe(0);
    expect(await h.client.stockMovement.count()).toBe(0);
  });
});
