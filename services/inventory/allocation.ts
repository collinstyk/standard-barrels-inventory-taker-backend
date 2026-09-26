import { Prisma } from "../../generated/prisma/client";
import { InsufficientStockError, InvalidInventoryQuantityError, PostingInvariantError } from "./errors";
import type { AllocationRequest, AllocationResult } from "./types";
import { POSTGRES_INTEGER_MAX, requirePositiveBaseQuantity } from "./validation";

interface LockedBatchRow {
  id: string;
  productId: string;
  warehouseId: number;
  expiryDate: Date | null;
  receivedAt: Date;
  quantityOnHandBase: number;
}

function validateLockedBatch(row: LockedBatchRow): void {
  if (
    typeof row.id !== "string"
    || typeof row.productId !== "string"
    || !Number.isSafeInteger(row.warehouseId)
    || !Number.isSafeInteger(row.quantityOnHandBase)
    || row.quantityOnHandBase <= 0
    || !(row.receivedAt instanceof Date)
    || (row.expiryDate !== null && !(row.expiryDate instanceof Date))
  ) {
    throw new PostingInvariantError("The database returned an invalid inventory batch row.");
  }
}

export async function allocateInventory(request: AllocationRequest): Promise<AllocationResult> {
  if (typeof request.productId !== "string" || request.productId.length === 0) {
    throw new PostingInvariantError("A product ID is required for allocation.");
  }
  if (!Number.isSafeInteger(request.warehouseId) || request.warehouseId <= 0) {
    throw new InvalidInventoryQuantityError("warehouseId");
  }
  const requested = requirePositiveBaseQuantity(request.quantityBase, "quantityBase");

  // Prisma does not expose SELECT FOR UPDATE. The tagged template parameterizes
  // every value while PostgreSQL remains authoritative for ordering and locks.
  const rows = await request.tx.$queryRaw<LockedBatchRow[]>(Prisma.sql`
    SELECT
      "id",
      "productId",
      "warehouseId",
      "expiryDate",
      "receivedAt",
      "quantityOnHandBase"
    FROM "InventoryBatch"
    WHERE "productId" = ${request.productId}
      AND "warehouseId" = ${request.warehouseId}
      AND "disposition" = 'SELLABLE'::"BatchDisposition"
      AND "quantityOnHandBase" > 0
      AND ("expiryDate" IS NULL OR "expiryDate" >= CAST(${request.businessToday} AS DATE))
    ORDER BY
      ("expiryDate" IS NULL) ASC,
      "expiryDate" ASC NULLS LAST,
      "receivedAt" ASC,
      "id" ASC
    FOR UPDATE
  `);

  let remaining = requested;
  const allocations = [];
  let available = 0;
  for (const row of rows) {
    validateLockedBatch(row);
    available = Math.min(POSTGRES_INTEGER_MAX, available + row.quantityOnHandBase);
    if (remaining === 0) continue;
    const quantityBase = Math.min(remaining, row.quantityOnHandBase);
    allocations.push({
      batchId: row.id,
      productId: row.productId,
      warehouseId: row.warehouseId,
      quantityBase,
      expiryDate: row.expiryDate,
      receivedAt: row.receivedAt,
    });
    remaining -= quantityBase;
  }

  if (remaining > 0) throw new InsufficientStockError(requested, available);
  return { allocations, totalAllocatedQuantity: requested, remainingUnfulfilledQuantity: 0 };
}
