import { Prisma } from "../../generated/prisma/client";
import { BatchConcurrencyConflictError, IdempotencyConflictError, PostingInvariantError } from "./errors";
import { executeInventoryPostingInTransaction } from "./posting";
import type { InventoryTransaction, MovementInput } from "./types";
import { POSTGRES_INTEGER_MAX } from "./validation";

export interface SaleIssueReversalResult {
  originalPosting: { id: string; status: "REVERSED" };
  reversalPosting: { id: string; kind: "REVERSAL"; status: "POSTED"; postedAt: Date; actor: { id: string; name: string; role: string }; reason: string };
  movementCount: number;
  groupedQuantities: Array<{ productId: string; quantityBase: number }>;
  affectedBatches: Array<{ batchId: string; productId: string; warehouseId: number; quantityBase: number }>;
}

async function reconstruct(tx: InventoryTransaction, postingId: string, sourcePostingId: string): Promise<SaleIssueReversalResult> {
  const posting = await tx.inventoryPosting.findUniqueOrThrow({ where: { id: postingId }, include: { performedBy: { select: { id: true, name: true, role: true } }, movements: { orderBy: { sequence: "asc" } } } });
  const movements = posting.movements;
  const grouped = new Map<string, number>();
  for (const movement of movements) grouped.set(movement.productId, (grouped.get(movement.productId) ?? 0) + movement.quantityChangeBase);
  return {
    originalPosting: { id: sourcePostingId, status: "REVERSED" },
    reversalPosting: { id: posting.id, kind: "REVERSAL", status: "POSTED", postedAt: posting.postedAt, actor: posting.performedBy, reason: posting.notes ?? "" },
    movementCount: movements.length,
    groupedQuantities: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([productId, quantityBase]) => ({ productId, quantityBase })),
    affectedBatches: movements.map((movement) => ({ batchId: movement.batchId, productId: movement.productId, warehouseId: movement.warehouseId, quantityBase: movement.quantityChangeBase })),
  };
}

export async function reverseSaleIssueInTransaction(tx: InventoryTransaction, input: {
  sourcePostingId: string;
  saleOrderId: number;
  idempotencyKey: string;
  requestFingerprint: string;
  performedById: string;
  reason: string;
}) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryPosting" WHERE "id" = ${input.sourcePostingId} FOR UPDATE`);
  const source = await tx.inventoryPosting.findUnique({ where: { id: input.sourcePostingId }, include: { movements: { orderBy: { sequence: "asc" } }, reversedBy: true } });
  if (!source || source.kind !== "SALE_ISSUE" || source.saleOrderId !== input.saleOrderId) throw new PostingInvariantError("The sale-issue posting was not found.");
  if (source.reversedBy) {
    if (source.reversedBy.idempotencyKey !== input.idempotencyKey || source.reversedBy.requestFingerprint !== input.requestFingerprint) throw new IdempotencyConflictError();
    return { postingId: source.reversedBy.id, replayed: true, result: await reconstruct(tx, source.reversedBy.id, source.id) };
  }
  if (source.status !== "POSTED") throw new PostingInvariantError("Only an active posted sale issue can be reversed.");
  if (source.movements.length === 0 || source.movements.some((movement) => movement.type !== "SALE_ISSUE" || movement.quantityChangeBase >= 0)) throw new PostingInvariantError("The sale issue has invalid movement history.");

  const allocations = await tx.saleAllocation.findMany({ where: { saleItem: { saleId: input.saleOrderId } }, select: { batchId: true, quantityBase: true, saleItem: { select: { productId: true } } } });
  const issuedByBatch = new Map<string, { productId: string; quantity: number }>();
  for (const movement of source.movements) {
    const current = issuedByBatch.get(movement.batchId);
    if (current && current.productId !== movement.productId) throw new PostingInvariantError("The sale issue movement products are inconsistent.");
    issuedByBatch.set(movement.batchId, { productId: movement.productId, quantity: (current?.quantity ?? 0) - movement.quantityChangeBase });
  }
  const allocatedByBatch = new Map<string, { productId: string; quantity: number }>();
  for (const allocation of allocations) {
    const current = allocatedByBatch.get(allocation.batchId);
    allocatedByBatch.set(allocation.batchId, { productId: allocation.saleItem.productId, quantity: (current?.quantity ?? 0) + allocation.quantityBase });
  }
  if (issuedByBatch.size !== allocatedByBatch.size || [...issuedByBatch].some(([batchId, issued]) => {
    const allocated = allocatedByBatch.get(batchId);
    return !allocated || allocated.productId !== issued.productId || allocated.quantity !== issued.quantity;
  })) throw new PostingInvariantError("The persisted sale allocations do not match the sale issue movements.");

  const batchIds = [...issuedByBatch.keys()].sort();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryBatch" WHERE "id" IN (${Prisma.join(batchIds)}) ORDER BY "id" FOR UPDATE`);
  const batches = await tx.inventoryBatch.findMany({ where: { id: { in: batchIds } } });
  const byBatch = new Map(batches.map((batch) => [batch.id, batch]));
  for (const movement of source.movements) {
    const batch = byBatch.get(movement.batchId);
    const quantity = -movement.quantityChangeBase;
    if (!batch || batch.productId !== movement.productId || batch.warehouseId !== movement.warehouseId || batch.disposition !== "SELLABLE") throw new PostingInvariantError("A source batch is not safely restorable.");
    if (batch.quantityOnHandBase > POSTGRES_INTEGER_MAX - quantity) throw new PostingInvariantError("Batch restoration exceeds the supported database range.");
  }

  const productTotals = new Map<string, number>();
  for (const issued of issuedByBatch.values()) productTotals.set(issued.productId, (productTotals.get(issued.productId) ?? 0) + issued.quantity);
  for (const [productId, quantity] of productTotals) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { quantityInStock: true } });
    if (!product) throw new PostingInvariantError("A sale-issue product was not found.");
    if (product.quantityInStock > POSTGRES_INTEGER_MAX - quantity) throw new PostingInvariantError("Cache restoration exceeds the supported database range.");
  }

  return executeInventoryPostingInTransaction(tx, {
    kind: "REVERSAL", idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint,
    performedById: input.performedById, source: { reversalOfId: source.id }, notes: input.reason,
  }, async (_transaction, postingId) => {
    const movements: MovementInput[] = [];
    for (const [index, original] of source.movements.entries()) {
      const quantity = -original.quantityChangeBase;
      const updated = await tx.inventoryBatch.updateMany({ where: { id: original.batchId, disposition: "SELLABLE", quantityOnHandBase: { lte: POSTGRES_INTEGER_MAX - quantity } }, data: { quantityOnHandBase: { increment: quantity } } });
      if (updated.count !== 1) throw new BatchConcurrencyConflictError(original.batchId);
      movements.push({ sequence: index + 1, type: "REVERSAL", productId: original.productId, batchId: original.batchId, warehouseId: original.warehouseId, destinationWarehouseId: original.warehouseId, quantityChangeBase: quantity, performedById: input.performedById, adjustmentReason: input.reason, notes: `Reverses movement ${original.id}.` });
    }
    for (const [productId, quantity] of productTotals) {
      const updated = await tx.product.updateMany({ where: { id: productId, quantityInStock: { lte: POSTGRES_INTEGER_MAX - quantity } }, data: { quantityInStock: { increment: quantity } } });
      if (updated.count !== 1) throw new PostingInvariantError("Cache restoration exceeds the supported database range.");
    }
    await tx.inventoryPosting.update({ where: { id: source.id }, data: { status: "REVERSED" } });
    return { result: {
      originalPosting: { id: source.id, status: "REVERSED" as const },
      reversalPosting: { id: postingId, kind: "REVERSAL" as const, status: "POSTED" as const, postedAt: (await tx.inventoryPosting.findUniqueOrThrow({ where: { id: postingId }, select: { postedAt: true } })).postedAt, actor: await tx.user.findUniqueOrThrow({ where: { id: input.performedById }, select: { id: true, name: true, role: true } }), reason: input.reason },
      movementCount: movements.length,
      groupedQuantities: [...productTotals].sort(([a], [b]) => a.localeCompare(b)).map(([productId, quantityBase]) => ({ productId, quantityBase })),
      affectedBatches: movements.map((movement) => ({ batchId: movement.batchId, productId: movement.productId, warehouseId: movement.warehouseId, quantityBase: movement.quantityChangeBase })),
    }, movements };
  }, (transaction, postingId) => reconstruct(transaction, postingId, source.id));
}
