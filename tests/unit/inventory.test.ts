import { describe, expect, it, vi } from "vitest";
import {
  convertToBaseUnits,
  executeInventoryPosting,
  getBusinessDate,
  isExpiryEligible,
  InvalidInventoryQuantityError,
  InvalidPostingSourceError,
  InvalidTimeZoneError,
  isRetryableInventoryTransactionError,
  PostingInvariantError,
  QuantityOverflowError,
  reconstructSaleIssueResult,
  validateIdempotencyKey,
  validateMovements,
  validatePostingSource,
  withBoundedTransactionRetry,
} from "../../services/inventory";
import type { BusinessDate, InventoryTransaction } from "../../services/inventory";

describe("base-unit conversion", () => {
  it.each([
    [3, 12, 36],
    [7, 1, 7],
    [2_147_483_647, 1, 2_147_483_647],
  ])("converts %s by %s", (quantity, multiplier, expected) => {
    expect(convertToBaseUnits(quantity, multiplier)).toBe(expected);
  });

  it.each([0, -1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid quantity %s",
    (value) => expect(() => convertToBaseUnits(value, 1)).toThrow(InvalidInventoryQuantityError),
  );

  it("rejects invalid multipliers", () => {
    expect(() => convertToBaseUnits(1, 0)).toThrow(InvalidInventoryQuantityError);
    expect(() => convertToBaseUnits(1, "2")).toThrow(InvalidInventoryQuantityError);
  });

  it("rejects PostgreSQL integer overflow and unsafe multiplication", () => {
    expect(() => convertToBaseUnits(2_147_483_647, 2)).toThrow(QuantityOverflowError);
    expect(() => convertToBaseUnits(2_000_000_000, 2_000_000_000)).toThrow(QuantityOverflowError);
  });
});

describe("business-local expiry", () => {
  const today = "2026-07-21" as BusinessDate;

  it("treats the expiry date itself as valid", () => {
    expect(isExpiryEligible(new Date("2026-07-21T00:00:00.000Z"), today)).toBe(true);
    expect(isExpiryEligible(new Date("2026-07-20T00:00:00.000Z"), today)).toBe(false);
    expect(isExpiryEligible(new Date("2026-07-22T00:00:00.000Z"), today)).toBe(true);
    expect(isExpiryEligible(null, today)).toBe(true);
  });

  it("uses Lagos calendar boundaries instead of server-local midnight", () => {
    expect(getBusinessDate(new Date("2026-07-20T22:59:59.000Z"), "Africa/Lagos")).toBe("2026-07-20");
    expect(getBusinessDate(new Date("2026-07-20T23:00:00.000Z"), "Africa/Lagos")).toBe("2026-07-21");
  });

  it("defaults to Africa/Lagos and rejects invalid zones", () => {
    expect(getBusinessDate(new Date("2026-07-20T23:30:00.000Z"), "")).toBe("2026-07-21");
    expect(() => getBusinessDate(new Date(), "Mars/Olympus_Mons")).toThrow(InvalidTimeZoneError);
  });
});

describe("posting validation", () => {
  it("trims opaque idempotency keys and rejects malformed keys", () => {
    expect(validateIdempotencyKey("  order:42  ")).toBe("order:42");
    expect(() => validateIdempotencyKey(" ")).toThrow();
    expect(() => validateIdempotencyKey("x".repeat(201))).toThrow();
    expect(() => validateIdempotencyKey("bad\nkey")).toThrow();
  });

  it.each([
    ["SALE_ISSUE", { saleOrderId: 1 }],
    ["PURCHASE_RECEIPT", { purchaseReceiptId: 1 }],
    ["CUSTOMER_RETURN", { saleReturnId: 1 }],
    ["SUPPLIER_RETURN", { purchaseReturnId: 1 }],
    ["RETURN_INSPECTION_RECLASSIFICATION", { returnInspectionId: 1 }],
    ["REVERSAL", { reversalOfId: "posting-id" }],
    ["TRANSFER", {}],
    ["ADJUSTMENT", {}],
    ["MIGRATION_OPENING_BALANCE", {}],
  ] as const)("accepts the source for %s", (kind, source) => {
    expect(() => validatePostingSource(kind, source)).not.toThrow();
  });

  it("rejects missing and incompatible sources", () => {
    expect(() => validatePostingSource("SALE_ISSUE", {})).toThrow(InvalidPostingSourceError);
    expect(() => validatePostingSource("SALE_ISSUE", { saleOrderId: 1, saleReturnId: 2 })).toThrow(InvalidPostingSourceError);
    expect(() => validatePostingSource("TRANSFER", { saleOrderId: 1 })).toThrow(InvalidPostingSourceError);
  });

  it("validates nonempty, nonzero movements and unique sequences", () => {
    const movement = {
      sequence: 1,
      type: "SALE_ISSUE" as const,
      productId: "product",
      batchId: "batch",
      warehouseId: 1,
      quantityChangeBase: -2,
      performedById: "user",
    };
    expect(() => validateMovements([movement])).not.toThrow();
    expect(() => validateMovements([])).toThrow(PostingInvariantError);
    expect(() => validateMovements([movement, movement])).toThrow(PostingInvariantError);
    expect(() => validateMovements([{ ...movement, quantityChangeBase: 0 }])).toThrow();
  });
});

describe("sale-issue replay reconstruction", () => {
  it("replays through reconstruction without executing mutation work", async () => {
    const existing = {
      id: "posting-id",
      idempotencyKey: "sale-key",
      kind: "SALE_ISSUE",
      status: "POSTED",
      performedById: "user",
      postedAt: new Date(),
      notes: null,
      purchaseReceiptId: null,
      saleOrderId: 42,
      purchaseReturnId: null,
      saleReturnId: null,
      returnInspectionId: null,
      reversalOfId: null,
    };
    const tx = { inventoryPosting: { findUnique: vi.fn().mockResolvedValue(existing) } } as unknown as InventoryTransaction;
    const client = { $transaction: vi.fn((callback) => callback(tx)) };
    const work = vi.fn();
    const replay = vi.fn().mockResolvedValue({ totalIssued: 5, movementCount: 2 });

    await expect(executeInventoryPosting(client as never, {
      kind: "SALE_ISSUE",
      idempotencyKey: "sale-key",
      performedById: "user",
      source: { saleOrderId: 42 },
    }, work, replay)).resolves.toEqual({
      postingId: "posting-id",
      replayed: true,
      result: { totalIssued: 5, movementCount: 2 },
    });
    expect(work).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledWith(tx, "posting-id");
  });

  it("returns the persisted meaningful result without invoking mutations", async () => {
    const updateMany = vi.fn();
    const tx = {
      stockMovement: {
        findMany: vi.fn().mockResolvedValue([
          { type: "SALE_ISSUE", quantityChangeBase: -3 },
          { type: "SALE_ISSUE", quantityChangeBase: -2 },
        ]),
      },
      saleAllocation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantityBase: 5 } }) },
      inventoryBatch: { updateMany },
    } as unknown as InventoryTransaction;

    await expect(reconstructSaleIssueResult(tx, "posting", 42)).resolves.toEqual({
      totalIssued: 5,
      movementCount: 2,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects persisted movement/allocation imbalance", async () => {
    const tx = {
      stockMovement: { findMany: vi.fn().mockResolvedValue([{ type: "SALE_ISSUE", quantityChangeBase: -5 }]) },
      saleAllocation: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantityBase: 4 } }) },
    } as unknown as InventoryTransaction;
    await expect(reconstructSaleIssueResult(tx, "posting", 42)).rejects.toThrow(PostingInvariantError);
  });
});

describe("allocation input and transaction retries", () => {
  it("rejects invalid allocation before querying PostgreSQL", async () => {
    const queryRaw = vi.fn();
    const { allocateInventory } = await import("../../services/inventory/allocation");
    await expect(allocateInventory({
      tx: { $queryRaw: queryRaw } as unknown as InventoryTransaction,
      productId: "product",
      warehouseId: 1,
      quantityBase: 0,
      businessToday: "2026-07-21" as BusinessDate,
    })).rejects.toThrow(InvalidInventoryQuantityError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("classifies only explicit PostgreSQL/Prisma transaction conflicts", () => {
    expect(isRetryableInventoryTransactionError({ code: "40001" })).toBe(true);
    expect(isRetryableInventoryTransactionError({ code: "40P01" })).toBe(true);
    expect(isRetryableInventoryTransactionError({ code: "P2002" })).toBe(false);
    expect(isRetryableInventoryTransactionError(new Error("deadlock"))).toBe(false);
  });

  it("retries transient failures with a bound and does not retry validation errors", async () => {
    const transient = vi.fn()
      .mockRejectedValueOnce({ code: "40001" })
      .mockResolvedValue("ok");
    await expect(withBoundedTransactionRetry(transient, { delayMs: 0 })).resolves.toBe("ok");
    expect(transient).toHaveBeenCalledTimes(2);

    const validation = vi.fn().mockRejectedValue(new InvalidInventoryQuantityError("quantity"));
    await expect(withBoundedTransactionRetry(validation, { delayMs: 0 })).rejects.toThrow(InvalidInventoryQuantityError);
    expect(validation).toHaveBeenCalledTimes(1);
  });
});
