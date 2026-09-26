import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { IdempotencyConflictError, PostingInvariantError } from "./errors";
import {
  assertGlobalV2CommandKeyAvailable,
  commandFingerprint,
  lockIdempotencyKey,
} from "./idempotency";
import { withBoundedTransactionRetry } from "./retry";
import { validateIdempotencyKey } from "./validation";

export type AdjustmentReason =
  | "PHYSICAL_COUNT"
  | "LOSS"
  | "FOUND_STOCK"
  | "DATA_CORRECTION";
  
export type PhysicalCountInput = {
  batchId: string;
  countedQuantityBase: number;
  reason: AdjustmentReason;
  notes?: string;
};

type Snapshot = {
  batchId: string;
  product: { id: string; name: string; baseUnit: string };
  warehouse: { id: number; name: string };
  batchDisposition: "SELLABLE" | "DAMAGED" | "QUARANTINED" | "EXPIRED";
  expiryDate: string | null;
  previousQuantityBase: number;
  countedQuantityBase: number;
  adjustmentQuantityBase: number;
  reason: AdjustmentReason;
  notes: string | null;
  resultingProductSellableCache: number | null;
};

const MAX = 2_147_483_647;

function audit(snapshot: Snapshot) {
  return JSON.stringify({ command: "PHYSICAL_COUNT_ADJUSTMENT", snapshot });
}

function parseAudit(value: string | null): Snapshot {
  try {
    const parsed = JSON.parse(value ?? "") as {
      command?: string;
      snapshot?: Snapshot;
    };
    if (parsed.command !== "PHYSICAL_COUNT_ADJUSTMENT" || !parsed.snapshot)
      throw new Error();
    return parsed.snapshot;
  } catch {
    throw new PostingInvariantError(
      "Persisted adjustment audit data is invalid.",
    );
  }
}

async function resultFromPosting(
  tx: Prisma.TransactionClient,
  postingId: string,
  replayed: boolean,
) {
  const posting = await tx.inventoryPosting.findUnique({
    where: { id: postingId },
    select: {
      id: true,
      status: true,
      postedAt: true,
      notes: true,
      performedBy: { select: { id: true, name: true, role: true } },
      movements: {
        orderBy: { sequence: "asc" },
        take: 1,
        select: { id: true, type: true },
      },
    },
  });
  if (!posting || posting.movements.length !== 1)
    throw new PostingInvariantError(
      "Persisted adjustment movement is invalid.",
    );
  const snapshot = parseAudit(posting.notes);
  return {
    postingId: posting.id,
    postingStatus: posting.status,
    replayed,
    ...snapshot,
    movementId: posting.movements[0]!.id,
    movementType: posting.movements[0]!.type,
    actor: posting.performedBy,
    postedAt: posting.postedAt,
  };
}

export async function adjustInventoryBatch(
  client: PrismaClient,
  input: PhysicalCountInput,
  actorId: string,
  requestKey: string,
) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const normalized = {
    ...input,
    reason: input.reason,
    notes: input.notes?.trim(),
  };
  const fingerprint = commandFingerprint({
    command: "PHYSICAL_COUNT_ADJUSTMENT",
    actorId,
    ...normalized,
  });
  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await lockIdempotencyKey(tx, idempotencyKey);
        const existing = await tx.inventoryPosting.findUnique({
          where: { idempotencyKey },
          select: { id: true, kind: true, requestFingerprint: true },
        });
        if (existing) {
          if (
            existing.kind !== "ADJUSTMENT" ||
            existing.requestFingerprint !== fingerprint
          )
            throw new IdempotencyConflictError();
          return resultFromPosting(tx, existing.id, true);
        }
        await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "InventoryBatch" WHERE "id" = ${input.batchId} FOR UPDATE`,
        );
        const batch = await tx.inventoryBatch.findUnique({
          where: { id: input.batchId },
          select: {
            id: true,
            quantityOnHandBase: true,
            disposition: true,
            expiryDate: true,
            product: {
              select: {
                id: true,
                name: true,
                baseUnit: true,
                quantityInStock: true,
              },
            },
            warehouse: { select: { id: true, name: true } },
          },
        });
        if (!batch)
          throw new PostingInvariantError("Inventory batch not found.");
        const previous = batch.quantityOnHandBase,
          delta = input.countedQuantityBase - previous;
        if (delta === 0)
          throw new PostingInvariantError(
            "Physical count matches the current batch quantity; no adjustment was created.",
          );
        if (!Number.isSafeInteger(delta) || delta < -MAX || delta > MAX)
          throw new PostingInvariantError(
            "Adjustment quantity exceeds the supported database range.",
          );
        let resultingCache: number | null = null;
        if (batch.disposition === "SELLABLE") {
          if (batch.product.quantityInStock < previous)
            throw new PostingInvariantError(
              "Product sellable cache is inconsistent with the selected batch.",
            );
          resultingCache = batch.product.quantityInStock + delta;
          if (
            !Number.isSafeInteger(resultingCache) ||
            resultingCache < 0 ||
            resultingCache > MAX
          )
            throw new PostingInvariantError(
              "Product sellable cache adjustment would underflow or overflow.",
            );
        }
        const snapshot: Snapshot = {
          batchId: batch.id,
          product: {
            id: batch.product.id,
            name: batch.product.name,
            baseUnit: batch.product.baseUnit,
          },
          warehouse: batch.warehouse,
          batchDisposition: batch.disposition,
          expiryDate: batch.expiryDate?.toISOString().slice(0, 10) ?? null,
          previousQuantityBase: previous,
          countedQuantityBase: input.countedQuantityBase,
          adjustmentQuantityBase: delta,
          reason: input.reason,
          notes: normalized.notes ?? null,
          resultingProductSellableCache: resultingCache,
        };
        const posting = await tx.inventoryPosting.create({
          data: {
            idempotencyKey,
            requestFingerprint: fingerprint,
            kind: "ADJUSTMENT",
            performedById: actorId,
            notes: audit(snapshot),
          },
        });
        const changed = await tx.inventoryBatch.updateMany({
          where: { id: batch.id, quantityOnHandBase: previous },
          data: { quantityOnHandBase: input.countedQuantityBase },
        });
        if (changed.count !== 1)
          throw new PostingInvariantError(
            "Inventory batch changed concurrently.",
          );
        if (resultingCache !== null) {
          const cache = await tx.product.updateMany({
            where: {
              id: batch.product.id,
              quantityInStock: batch.product.quantityInStock,
            },
            data: { quantityInStock: resultingCache },
          });
          if (cache.count !== 1)
            throw new PostingInvariantError(
              "Product sellable cache changed concurrently.",
            );
        }
        const movement = await tx.stockMovement.create({
          data: {
            postingId: posting.id,
            sequence: 1,
            type: delta > 0 ? "POSITIVE_ADJUSTMENT" : "NEGATIVE_ADJUSTMENT",
            productId: batch.product.id,
            batchId: batch.id,
            warehouseId: batch.warehouse.id,
            quantityChangeBase: delta,
            performedById: actorId,
            adjustmentReason: input.reason,
            notes: normalized.notes,
          },
        });
        return {
          postingId: posting.id,
          postingStatus: posting.status,
          replayed: false,
          ...snapshot,
          movementId: movement.id,
          movementType: movement.type,
          actor: await tx.user.findUniqueOrThrow({
            where: { id: actorId },
            select: { id: true, name: true, role: true },
          }),
          postedAt: posting.postedAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
