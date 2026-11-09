import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../generated/prisma/client";
import { createProductSchema, updateProductSchema } from "../../schemas/masterData";
import { openingStockSchema } from "../../schemas/inventoryV2";
import { listProducts, listUnits } from "../../services/masterData";

describe("catalog cost defaults", () => {
  it("accepts unknown cost and explicit zero, but rejects malformed amounts", () => {
    const base = { name: "Palm oil", baseUnit: "litre", categoryId: crypto.randomUUID(), reorderPoint: 0,
      units: [{ name: "Litre", multiplier: 1, price: "750", sku: "PALM-L" }] };
    expect(createProductSchema.safeParse(base).success).toBe(true);
    expect(createProductSchema.safeParse({ ...base, defaultCostBase: "0" }).success).toBe(true);
    expect(createProductSchema.safeParse({ ...base, defaultCostBase: "12.12345" }).success).toBe(false);
    expect(updateProductSchema.safeParse({ defaultCostBase: null }).success).toBe(true);
  });

  it("derives each unit cost from the base cost without changing selling prices", async () => {
    process.env.INVENTORY_V2_ENABLED = "false";
    const product = { id: "p1", name: "Palm oil", baseUnit: "litre", reorderPoint: 0,
      quantityInStock: 0, category: { id: "c1", name: "Oils" },
      defaultCostBase: new Prisma.Decimal("500"), lastReceivedCostBase: new Prisma.Decimal("475"),
      units: [
        { id: 1, name: "Litre", multiplier: 1, price: new Prisma.Decimal("750"), sku: "PALM-L" },
        { id: 2, name: "Carton", multiplier: 24, price: new Prisma.Decimal("16500"), sku: "PALM-C" },
      ] };
    const db = { product: { findMany: vi.fn().mockResolvedValue([product]), count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue({ id: "p1" }) },
      productUnit: { findMany: vi.fn().mockResolvedValue(product.units.map((unit) => ({ ...unit,
        product: { defaultCostBase: product.defaultCostBase, lastReceivedCostBase: product.lastReceivedCostBase } }))) } };
    const listed = await listProducts(db as never, { page: 1, limit: 20 });
    expect(listed.data[0]?.units).toMatchObject([
      { defaultCostInUnit: "500.0000", lastReceivedCostInUnit: "475.0000" },
      { defaultCostInUnit: "12000.0000", lastReceivedCostInUnit: "11400.0000" },
    ]);
    expect(listed.data[0]?.units[1]?.price.toString()).toBe("16500");
    const units = await listUnits(db as never, "p1");
    expect(units[1]?.defaultCostInUnit).toBe("12000.0000");
  });

  it("accepts an optional opening-stock cost without treating unknown as zero", () => {
    const line = { productId: crypto.randomUUID(), unitId: 1, warehouseId: 1, quantityInUnit: 2 };
    expect(openingStockSchema.safeParse({ lines: [line] }).success).toBe(true);
    expect(openingStockSchema.safeParse({ lines: [{ ...line, unitCostInUnit: "0" }] }).success).toBe(true);
    expect(openingStockSchema.safeParse({ lines: [{ ...line, unitCostInUnit: "1.23456" }] }).success).toBe(false);
  });
});
