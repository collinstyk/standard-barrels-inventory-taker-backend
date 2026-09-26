import { describe, expect, it } from "vitest";
import { contactListQuerySchema, createContactSchema, createProductSchema, paginationSchema, updateProductSchema, updateUnitSchema } from "../../schemas/masterData";

describe("V1-F1 master-data validation", () => {
  const unit = { name: "Single", multiplier: 1, price: "3500.0000", sku: "SKU-1" };
  const product = { name: "Product", baseUnit: "piece", categoryId: crypto.randomUUID(), reorderPoint: 0, units: [unit] };
  it("accepts the product contract and rejects inventory authority", () => { expect(createProductSchema.safeParse(product).success).toBe(true); expect(createProductSchema.safeParse({ ...product, quantityInStock: 10 }).success).toBe(false); });
  it("requires multiplier one and unique normalized unit names and SKUs", () => { expect(createProductSchema.safeParse({ ...product, units: [{ ...unit, multiplier: 2 }] }).success).toBe(false); expect(createProductSchema.safeParse({ ...product, units: [unit, { ...unit, name: "single", sku: "sku-1" }] }).success).toBe(false); });
  it("rejects base-unit, stock, and multiplier patches", () => { expect(updateProductSchema.safeParse({ baseUnit: "kg" }).success).toBe(false); expect(updateProductSchema.safeParse({ quantityInStock: 5 }).success).toBe(false); expect(updateUnitSchema.safeParse({ multiplier: 2 }).success).toBe(false); expect(updateUnitSchema.safeParse({}).success).toBe(false); });
  it("validates contact roles and bounded pagination", () => { expect(createContactSchema.safeParse({ name: "Nobody", isSupplier: false, isBuyer: false }).success).toBe(false); expect(createContactSchema.safeParse({ name: "Both", isSupplier: true, isBuyer: true }).success).toBe(true); expect(paginationSchema.safeParse({ limit: "101" }).success).toBe(false); expect(contactListQuerySchema.safeParse({ type: "OTHER" }).success).toBe(false); });
  it("accepts only decimal strings with at most four places", () => { expect(createProductSchema.safeParse({ ...product, units: [{ ...unit, price: "12.12345" }] }).success).toBe(false); expect(createProductSchema.safeParse({ ...product, units: [{ ...unit, price: Infinity }] }).success).toBe(false); });
});
