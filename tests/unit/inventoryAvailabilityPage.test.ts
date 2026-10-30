import { describe, expect, it, vi } from "vitest";
import { getInventoryAvailabilityPage } from "../../services/inventory/stockReads";

function database() {
  return {
    product: {
      findMany: vi.fn().mockResolvedValue([
        { id: "p1", name: "Palm oil", baseUnit: "litre", reorderPoint: 8,
          units: [{ id: 1, name: "Litre", multiplier: 1, sku: "PALM-L" }, { id: 2, name: "Gallon", multiplier: 4, sku: "PALM-G" }] },
        { id: "p2", name: "Water", baseUnit: "bottle", reorderPoint: 0,
          units: [{ id: 3, name: "Bottle", multiplier: 1, sku: "WATER-B" }] },
      ]),
      count: vi.fn().mockResolvedValue(2),
    },
    inventoryBatch: { groupBy: vi.fn().mockResolvedValue([
      { productId: "p1", warehouseId: 7, _sum: { quantityOnHandBase: 2 } },
    ]) },
    warehouse: { findMany: vi.fn().mockResolvedValue([{ id: 7, name: "Shop floor", location: null }]) },
  };
}

describe("paginated inventory availability", () => {
  it("searches before paging, converts quantities on the server and keeps zero-stock products", async () => {
    const db = database();
    const result = await getInventoryAvailabilityPage(db as never, { page: 1, limit: 20, search: "palm" });
    expect(db.product.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { name: { contains: "palm", mode: "insensitive" } }, skip: 0, take: 20,
    }));
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(result.data[0]).toMatchObject({ sellableQuantityBase: 2, stockLevel: "CRITICAL",
      units: [{ availableQuantityInUnit: 2 }, { availableQuantityInUnit: 0, baseUnitRemainder: 2 }],
      warehouses: [{ warehouseId: 7, stockLevel: "CRITICAL" }] });
    expect(result.data[1]).toMatchObject({ sellableQuantityBase: 0, stockLevel: "CRITICAL", warehouses: [] });
  });

  it("skips batch and warehouse queries on an empty product page", async () => {
    const db = database();
    db.product.findMany.mockResolvedValue([]);
    const result = await getInventoryAvailabilityPage(db as never, { page: 3, limit: 20 });
    expect(result.data).toEqual([]);
    expect(db.inventoryBatch.groupBy).not.toHaveBeenCalled();
    expect(db.warehouse.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [2, "CRITICAL"],
    [3, "LOW"],
    [8, "LOW"],
    [9, "NORMAL"],
  ] as const)("classifies %i base units as %s for reorder point 8", async (quantity, level) => {
    const db = database();
    db.inventoryBatch.groupBy.mockResolvedValue([{ productId: "p1", warehouseId: 7, _sum: { quantityOnHandBase: quantity } }]);
    const result = await getInventoryAvailabilityPage(db as never, { page: 1, limit: 20 });
    expect(result.data[0]?.stockLevel).toBe(level);
  });
});
