import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createProduct, MasterDataError } from "../../services/masterData";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const input = (sku: string = randomUUID()) => ({
  name: "Chamdor", baseUnit: "bottle", reorderPoint: 0,
  units: [{ name: "Bottle", multiplier: 1, price: "3500.0000", sku }],
});

describe.skipIf(!enabled)("atomic product/category creation on disposable PostgreSQL", () => {
  let h: IntegrationHarness;
  const oldFlag = process.env.INVENTORY_V2_ENABLED;
  beforeAll(async () => {
    process.env.INVENTORY_V2_ENABLED = "false";
    h = createIntegrationHarness();
    await clearDisposableDatabase(h);
  }, 60_000);
  afterEach(async () => { process.env.INVENTORY_V2_ENABLED = "false"; await clearDisposableDatabase(h); });
  afterAll(async () => {
    if (oldFlag === undefined) delete process.env.INVENTORY_V2_ENABLED;
    else process.env.INVENTORY_V2_ENABLED = oldFlag;
    await h?.client.$disconnect();
  });

  it("preserves categoryId creation, initial units, decimal prices and stock shape", async () => {
    const category = await h.client.category.create({ data: { name: "Existing" } });
    const product = await createProduct(h.client, { ...input(" cham-btl "), categoryId: category.id });
    expect(product).toMatchObject({ name: "Chamdor", category, quantityInStock: 0, units: [{ name: "Bottle", multiplier: 1, sku: "CHAM-BTL" }] });
    expect(product.units[0]!.price.toString()).toBe("3500");
    expect(await h.client.category.count()).toBe(1);
  });

  it("creates a trimmed category and all initial units in the same operation", async () => {
    const base = input("BTL");
    const product = await createProduct(h.client, { ...base, newCategoryName: "  Non-Alcoholics  ", units: [...base.units, { name: "Carton", multiplier: 12, price: "40000.1234", sku: " ctn " }] });
    expect(product.category.name).toBe("Non-Alcoholics");
    expect(product.id).toBeTruthy();
    expect(product.units.map(unit => unit.sku)).toEqual(["BTL", "CTN"]);
    expect(product.units[1]!.price.toString()).toBe("40000.1234");
    expect(await h.client.category.count()).toBe(1);
    expect(await h.client.product.count()).toBe(1);
    expect(await h.client.productUnit.count()).toBe(2);
  });

  it("reuses a normalized name, preserves its spelling, and treats wildcard characters literally", async () => {
    const category = await h.client.category.create({ data: { name: "  Drinks 100%_Premium  " } });
    const product = await createProduct(h.client, { ...input(), newCategoryName: " drinks 100%_premium " });
    expect(product.category).toEqual(category);
    expect(await h.client.category.count()).toBe(1);
    const different = await createProduct(h.client, { ...input(), newCategoryName: "Drinks 100AApremium" });
    expect(different.category.id).not.toBe(category.id);
  });

  it("reuses one category across simultaneous requests with different products", async () => {
    const products = await Promise.all([
      createProduct(h.client, { ...input("ONE"), newCategoryName: "Beverages" }),
      createProduct(h.client, { ...input("TWO"), newCategoryName: " beverages " }),
    ]);
    expect(products[0]!.category.id).toBe(products[1]!.category.id);
    expect(await h.client.category.count()).toBe(1);
    expect(await h.client.product.count()).toBe(2);
  });

  it("rolls back a new category, product and units when a later initial SKU conflicts", async () => {
    const existing = await h.client.category.create({ data: { name: "Existing" } });
    await createProduct(h.client, { ...input("TAKEN"), categoryId: existing.id });
    await expect(createProduct(h.client, { ...input("FRESH"), newCategoryName: "Must roll back", units: [
      { name: "Bottle", multiplier: 1, price: "1", sku: "FRESH" },
      { name: "Carton", multiplier: 12, price: "12", sku: " taken " },
    ] })).rejects.toMatchObject({ statusCode: 409 });
    expect(await h.client.category.findFirst({ where: { name: "Must roll back" } })).toBeNull();
    expect(await h.client.category.count()).toBe(1);
    expect(await h.client.product.count()).toBe(1);
    expect(await h.client.productUnit.count()).toBe(1);
    expect(await h.client.productUnit.findUnique({ where: { sku: "FRESH" } })).toBeNull();
  });

  it("does not create extra categories on an exact retry that conflicts on SKU", async () => {
    const body = { ...input("RETRY"), newCategoryName: "Drinks" };
    const first = await createProduct(h.client, body);
    await expect(createProduct(h.client, { ...body, newCategoryName: " drinks " })).rejects.toMatchObject({ statusCode: 409 });
    expect(await h.client.category.count()).toBe(1);
    expect(await h.client.product.count()).toBe(1);
    expect(await h.client.category.findUnique({ where: { id: first.category.id } })).toEqual(first.category);
  });

  it("keeps missing categoryId as 404 and rejects ambiguous service calls", async () => {
    await expect(createProduct(h.client, { ...input(), categoryId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(createProduct(h.client, input())).rejects.toBeInstanceOf(MasterDataError);
    await expect(createProduct(h.client, { ...input(), categoryId: randomUUID(), newCategoryName: "Both" })).rejects.toMatchObject({ statusCode: 400 });
    expect(await h.client.category.count()).toBe(0);
    expect(await h.client.product.count()).toBe(0);
  });

  it("preserves Inventory V2's authoritative zero-stock response", async () => {
    process.env.INVENTORY_V2_ENABLED = "true";
    const product = await createProduct(h.client, { ...input(), newCategoryName: "V2 category" });
    expect(product.sellableQuantityBase).toBe(0);
    expect(product).not.toHaveProperty("quantityInStock");
    expect(await h.client.inventoryBatch.count()).toBe(0);
    expect(await h.client.inventoryPosting.count()).toBe(0);
    expect(await h.client.stockMovement.count()).toBe(0);
  });
});
