import { describe, expect, it } from "vitest";
import { openingStockSchema } from "../../schemas/inventoryV2";

const line = () => ({
  productId: crypto.randomUUID(),
  unitId: 1,
  warehouseId: 1,
  quantityInUnit: 3,
  expiryDate: "2099-12-31",
});

describe("opening stock validation", () => {
  it("accepts multiple products and distinct expiry batches", () => {
    const first = line();
    expect(openingStockSchema.safeParse({
      notes: "Initial shop count",
      lines: [first, { ...first, expiryDate: null }, line()],
    }).success).toBe(true);
  });

  it("rejects duplicates, invalid quantities, dates, and unknown fields", () => {
    const first = line();
    for (const body of [
      { lines: [] },
      { lines: [first, first] },
      { lines: [{ ...first, quantityInUnit: 0 }] },
      { lines: [{ ...first, quantityInUnit: "3" }] },
      { lines: [{ ...first, expiryDate: "2099-02-30" }] },
      { lines: [{ ...first, extra: true }] },
      { lines: [first], extra: true },
    ]) expect(openingStockSchema.safeParse(body).success).toBe(false);
  });
});
