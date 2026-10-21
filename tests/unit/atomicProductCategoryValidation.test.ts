import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProductSchema } from "../../schemas/masterData";

const product = {
  name: "Chamdor", baseUnit: "bottle",
  units: [{ name: "Bottle", multiplier: 1, price: "3500.0000", sku: "CHAM-BTL" }],
};

describe("product category selection", () => {
  it("preserves categoryId input and defaults", () => {
    const categoryId = randomUUID();
    expect(createProductSchema.parse({ ...product, categoryId })).toEqual({ ...product, categoryId, reorderPoint: 0 });
  });

  it("trims new category names without changing their case or inner spaces", () => {
    expect(createProductSchema.parse({ ...product, newCategoryName: " \tNon  Alcoholic\n " }).newCategoryName)
      .toBe("Non  Alcoholic");
  });

  it.each([
    {}, { categoryId: randomUUID(), newCategoryName: "Drinks" },
    { newCategoryName: "   " }, { newCategoryName: "X" },
    { newCategoryName: "X".repeat(121) }, { newCategoryName: null },
    { categoryId: "invalid" }, { categoryId: randomUUID(), newCategoryName: null },
  ])("rejects an invalid category selection: %j", (category) => {
    expect(createProductSchema.safeParse({ ...product, ...category }).success).toBe(false);
  });

  it("keeps strict SKU, base-unit, unit-name, and price rules in the new mode", () => {
    const input = { ...product, newCategoryName: "Drinks" };
    for (const invalid of [
      { quantityInStock: 10 },
      { units: [] },
      { units: [{ ...product.units[0], multiplier: 0 }] },
      { units: [{ ...product.units[0], multiplier: -1 }] },
      { units: [{ ...product.units[0], multiplier: 12 }] },
      { units: [{ ...product.units[0], price: "-1" }] },
      { units: [{ ...product.units[0], price: "1.12345" }] },
      { units: [{ ...product.units[0], price: 3500 }] },
      { units: [{ ...product.units[0], sku: " " }] },
      { units: [product.units[0], { ...product.units[0], name: "Carton", sku: " cham-btl " }] },
      { units: [product.units[0], { ...product.units[0], name: " bottle ", sku: "CHAM-OTHER" }] },
    ]) expect(createProductSchema.safeParse({ ...input, ...invalid }).success).toBe(false);
  });
});
