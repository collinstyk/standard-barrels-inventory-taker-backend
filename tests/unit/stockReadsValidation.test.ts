import { afterEach, describe, expect, it } from "vitest";
import { expiringSoonQuerySchema, lowStockQuerySchema } from "../../schemas/inventoryV2";
import { addBusinessDays, calendarDaysBetween, getBusinessDate, isInventoryV2Enabled } from "../../services/inventory";

describe("V1-F4 stock read validation", () => {
  afterEach(() => delete process.env.INVENTORY_V2_ENABLED);

  it("accepts bounded defaults and rejects unknown or unsafe low-stock queries", () => {
    expect(lowStockQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(lowStockQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(lowStockQuerySchema.safeParse({ unexpected: "yes" }).success).toBe(false);
    expect(lowStockQuerySchema.safeParse({ search: "   " }).success).toBe(false);
  });

  it("accepts zero-day expiry windows and rejects invalid filters", () => {
    expect(expiringSoonQuerySchema.parse({ days: "0" })).toMatchObject({ days: 0, page: 1, limit: 20 });
    expect(expiringSoonQuerySchema.safeParse({ days: "366" }).success).toBe(false);
    expect(expiringSoonQuerySchema.safeParse({ warehouseId: "0" }).success).toBe(false);
    expect(expiringSoonQuerySchema.safeParse({ productId: "not-a-uuid" }).success).toBe(false);
  });

  it("uses calendar dates and explicit feature-flag parsing", () => {
    expect(getBusinessDate(new Date("2026-07-22T23:30:00.000Z"), "Africa/Lagos")).toBe("2026-07-23");
    const start = getBusinessDate(new Date("2026-03-28T12:00:00.000Z"), "Europe/London");
    const end = addBusinessDays(start, 2);
    expect(calendarDaysBetween(start, new Date(`${end}T00:00:00.000Z`))).toBe(2);
    expect(isInventoryV2Enabled("yes")).toBe(false);
    expect(isInventoryV2Enabled(" true ")).toBe(true);
  });
});
