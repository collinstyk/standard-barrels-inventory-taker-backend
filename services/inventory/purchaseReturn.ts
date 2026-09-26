import { Decimal } from "@prisma/client/runtime/client";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { BatchConcurrencyConflictError, IdempotencyConflictError, PostingInvariantError } from "./errors";
import { assertGlobalV2CommandKeyAvailable, commandFingerprint, lockIdempotencyKey } from "./idempotency";
import { executeInventoryPostingInTransaction } from "./posting";
import { withBoundedTransactionRetry } from "./retry";
import type { InventoryTransaction, MovementInput } from "./types";
import { convertToBaseUnits, POSTGRES_INTEGER_MAX, validateIdempotencyKey } from "./validation";

type CreateInput = {
  reason: string;
  notes?: string;
  refundAmount: string;
  items: Array<{ originalPurchaseItemId: number; sourceBatchId: string; sourceWarehouseId: number; quantityInOrderUnit: number; refundedUnitCost?: string }>;
};

const postedReturnStatuses = ["POSTED"] as const;

type QuantitySummaryLine = { productId: string; unitId: number; quantityInOrderUnit: number; unitMultiplier: number; quantityBase: number };

function groupQuantities(lines: readonly QuantitySummaryLine[]) {
  const products = new Map<string, Map<number, { unitId: number; quantityInOrderUnit: number; multiplierSnapshot: number; baseQuantity: number }>>();
  for (const line of lines) {
    let units = products.get(line.productId);
    if (!units) { units = new Map(); products.set(line.productId, units); }
    const current = units.get(line.unitId);
    if (current && current.multiplierSnapshot !== line.unitMultiplier) throw new PostingInvariantError("One product/unit group contains inconsistent multiplier snapshots.");
    const quantityInOrderUnit = (current?.quantityInOrderUnit ?? 0) + line.quantityInOrderUnit;
    const baseQuantity = (current?.baseQuantity ?? 0) + line.quantityBase;
    if (!Number.isSafeInteger(quantityInOrderUnit) || !Number.isSafeInteger(baseQuantity) || quantityInOrderUnit > POSTGRES_INTEGER_MAX || baseQuantity > POSTGRES_INTEGER_MAX) throw new PostingInvariantError("Supplier-return grouped quantity exceeds the database range.");
    units.set(line.unitId, { unitId: line.unitId, quantityInOrderUnit, multiplierSnapshot: line.unitMultiplier, baseQuantity });
  }
  return {
    lineCount: lines.length,
    products: [...products.entries()].map(([productId, units]) => {
      const totalBaseQuantity = [...units.values()].reduce((sum, unit) => sum + unit.baseQuantity, 0);
      if (!Number.isSafeInteger(totalBaseQuantity) || totalBaseQuantity > POSTGRES_INTEGER_MAX) throw new PostingInvariantError("Supplier-return product base quantity exceeds the database range.");
      return { productId, totalBaseQuantity, unitGroups: [...units.values()] };
    }),
  };
}

function financialSummary(refundAmount: Decimal, items: readonly { refundedUnitCost: Decimal | null; quantityInOrderUnit: number }[]) {
  const lineRefundComplete = items.every((item) => item.refundedUnitCost !== null);
  const calculated = lineRefundComplete ? items.reduce((sum, item) => sum.plus(item.refundedUnitCost!.times(item.quantityInOrderUnit)), new Decimal(0)) : null;
  return { declaredRefundAmount: refundAmount.toString(), calculatedLineRefundAmount: calculated?.toString() ?? null, refundDifference: calculated ? refundAmount.minus(calculated).toString() : null, lineRefundComplete };
}

function commandReturnShape<T extends { refundAmount: Decimal; items: Array<{ refundedUnitCost: Decimal | null; quantityInOrderUnit: number }> }>(purchaseReturn: T) {
  const { refundAmount, ...safeReturn } = purchaseReturn;
  return { ...safeReturn, items: purchaseReturn.items.map((item) => ({ ...item, refundedUnitCost: item.refundedUnitCost?.toString() ?? null })), financialSummary: financialSummary(refundAmount, purchaseReturn.items) };
}

function assertDirectReceiptProvenance(batch: {
  productId: string;
  warehouseId: number;
  purchaseReceiptItem: null | { purchaseItemId: number; receipt: { purchaseOrderId: number; status: string } };
}, line: { productId: string; purchaseItemId: number; purchaseId: number; warehouseId: number }): void {
  if (batch.warehouseId !== line.warehouseId) throw new PostingInvariantError("Selected source batch does not belong to the specified warehouse.");
  if (batch.productId !== line.productId) throw new PostingInvariantError("Selected source batch does not contain the purchase-item product.");
  if (!batch.purchaseReceiptItem
    || batch.purchaseReceiptItem.purchaseItemId !== line.purchaseItemId
    || batch.purchaseReceiptItem.receipt.purchaseOrderId !== line.purchaseId
    || batch.purchaseReceiptItem.receipt.status !== "POSTED") {
    throw new PostingInvariantError("Selected source batch does not have direct posted-receipt provenance for this purchase item.");
  }
}

async function authoritativeReceivedBase(tx: InventoryTransaction, purchaseItemId: number): Promise<number> {
  const result = await tx.purchaseReceiptItem.aggregate({ where: { purchaseItemId, receipt: { status: "POSTED" } }, _sum: { quantityBase: true } });
  return result._sum.quantityBase ?? 0;
}

export async function createPurchaseReturn(client: PrismaClient, purchaseId: number, input: CreateInput, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ command: "CREATE_SUPPLIER_RETURN", purchaseId, userId, input });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const existing = await tx.purchaseReturn.findUnique({ where: { idempotencyKey }, include: { items: { include: { originalPurchaseItem: { select: { productId: true, unitId: true } } } } } });
    if (existing) {
      if (existing.originalPurchaseId !== purchaseId || existing.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();
      return { replayed: true, purchaseReturn: commandReturnShape(existing), quantitySummary: groupQuantities(existing.items.map((item) => ({ productId: item.originalPurchaseItem.productId, unitId: item.originalPurchaseItem.unitId, quantityInOrderUnit: item.quantityInOrderUnit, unitMultiplier: item.unitMultiplier, quantityBase: item.quantityBase }))) };
    }
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseId} FOR UPDATE`);
    const purchase = await tx.purchaseOrder.findUnique({ where: { id: purchaseId } });
    if (!purchase) throw new PostingInvariantError("Purchase order not found.");
    if (purchase.transactionStatus === "CANCELLED") throw new PostingInvariantError("A cancelled purchase order cannot accept a supplier return.");
    const batchIds = input.items.map((item) => item.sourceBatchId);
    if (new Set(batchIds).size !== batchIds.length) throw new PostingInvariantError("A source batch may appear only once per supplier return.");
    const itemIds = [...new Set(input.items.map((item) => item.originalPurchaseItemId))];
    const [purchaseItems, batches] = await Promise.all([
      tx.purchaseItem.findMany({ where: { purchaseId, id: { in: itemIds } } }),
      tx.inventoryBatch.findMany({ where: { id: { in: batchIds } }, include: { purchaseReceiptItem: { include: { receipt: true } } } }),
    ]);
    if (purchaseItems.length !== itemIds.length) throw new PostingInvariantError("Purchase return item not found on the original purchase.");
    if (batches.length !== batchIds.length) throw new PostingInvariantError("Supplier-return source batch not found.");
    const itemById = new Map(purchaseItems.map((item) => [item.id, item]));
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    const resolved = [];
    const currentByItem = new Map<number, number>();
    for (const line of input.items) {
      const item = itemById.get(line.originalPurchaseItemId)!;
      const batch = batchById.get(line.sourceBatchId)!;
      if (item.unitMultiplierSnapshot === null) throw new PostingInvariantError("Purchase-item multiplier snapshot is missing.");
      const quantityBase = convertToBaseUnits(line.quantityInOrderUnit, item.unitMultiplierSnapshot);
      assertDirectReceiptProvenance(batch, { productId: item.productId, purchaseItemId: item.id, purchaseId, warehouseId: line.sourceWarehouseId });
      if (batch.quantityOnHandBase <= 0 || quantityBase > batch.quantityOnHandBase) throw new PostingInvariantError("Selected source batch has insufficient on-hand quantity.");
      const aggregate = (currentByItem.get(item.id) ?? 0) + quantityBase;
      if (!Number.isSafeInteger(aggregate) || aggregate > POSTGRES_INTEGER_MAX) throw new PostingInvariantError("Aggregate draft supplier-return quantity exceeds the database range.");
      currentByItem.set(item.id, aggregate);
      resolved.push({ line, item, quantityBase });
    }
    for (const [purchaseItemId, quantityBase] of currentByItem) {
      if (quantityBase > await authoritativeReceivedBase(tx, purchaseItemId)) throw new PostingInvariantError("Aggregate draft supplier-return quantity exceeds authoritative posted receipt quantity.");
    }
    const purchaseReturn = await tx.purchaseReturn.create({
      data: {
        originalPurchaseId: purchaseId,
        idempotencyKey,
        requestFingerprint,
        processedById: userId,
        refundAmount: new Decimal(input.refundAmount),
        reason: input.reason,
        notes: input.notes,
        items: { create: resolved.map(({ line, item, quantityBase }) => ({
          originalPurchaseItemId: item.id,
          sourceBatchId: line.sourceBatchId,
          sourceWarehouseId: line.sourceWarehouseId,
          quantityInOrderUnit: line.quantityInOrderUnit,
          unitMultiplier: item.unitMultiplierSnapshot!,
          quantityBase,
          refundedUnitCost: line.refundedUnitCost === undefined ? null : new Decimal(line.refundedUnitCost),
        })) },
      },
      include: { items: { include: { originalPurchaseItem: { select: { productId: true, unitId: true } } } } },
    });
    return { replayed: false, purchaseReturn: commandReturnShape(purchaseReturn), quantitySummary: groupQuantities(resolved.map(({ item, line, quantityBase }) => ({ productId: item.productId, unitId: item.unitId, quantityInOrderUnit: line.quantityInOrderUnit, unitMultiplier: item.unitMultiplierSnapshot!, quantityBase }))) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

async function reconstructPostedReturn(tx: InventoryTransaction, postingId: string, returnId: number) {
  const purchaseReturn = await tx.purchaseReturn.findUniqueOrThrow({ where: { id: returnId }, include: { items: { include: { originalPurchaseItem: { select: { productId: true, unitId: true } } } } } });
  const movements = await tx.stockMovement.findMany({ where: { postingId }, orderBy: { sequence: "asc" } });
  return { returnId, status: purchaseReturn.status, quantitySummary: groupQuantities(purchaseReturn.items.map((item) => ({ productId: item.originalPurchaseItem.productId, unitId: item.originalPurchaseItem.unitId, quantityInOrderUnit: item.quantityInOrderUnit, unitMultiplier: item.unitMultiplier, quantityBase: item.quantityBase }))), financialSummary: financialSummary(purchaseReturn.refundAmount, purchaseReturn.items), movementCount: movements.length };
}

export async function postPurchaseReturn(client: PrismaClient, purchaseId: number, returnId: number, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const postFingerprint = commandFingerprint({ command: "POST_SUPPLIER_RETURN", purchaseId, returnId, userId });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const postingForKey = await tx.inventoryPosting.findUnique({ where: { idempotencyKey } });
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey, { postingId: postingForKey?.id });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseReturn" WHERE "id" = ${returnId} FOR UPDATE`);
    let purchaseReturn = await tx.purchaseReturn.findUnique({ where: { id: returnId }, include: { items: true, posting: true } });
    if (!purchaseReturn || purchaseReturn.originalPurchaseId !== purchaseId) throw new PostingInvariantError("Supplier return not found.");
    if (purchaseReturn.posting) {
      if (purchaseReturn.posting.idempotencyKey !== idempotencyKey || purchaseReturn.postFingerprint !== postFingerprint) throw new IdempotencyConflictError();
      return { postingId: purchaseReturn.posting.id, replayed: true, result: await reconstructPostedReturn(tx, purchaseReturn.posting.id, returnId) };
    }
    if (purchaseReturn.status === "CANCELLED") throw new PostingInvariantError("A cancelled supplier return cannot be posted.");
    if (purchaseReturn.status !== "DRAFT") throw new PostingInvariantError("Only a draft supplier return may be posted.");
    const itemIds = [...new Set(purchaseReturn.items.map((item) => item.originalPurchaseItemId))].sort((a, b) => a - b);
    const batchIds = [...new Set(purchaseReturn.items.map((item) => item.sourceBatchId))].sort();
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseItem" WHERE "id" IN (${Prisma.join(itemIds)}) ORDER BY "id" FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryBatch" WHERE "id" IN (${Prisma.join(batchIds)}) ORDER BY "id" FOR UPDATE`);
    const lockedReturn = await tx.purchaseReturn.findUniqueOrThrow({ where: { id: returnId }, include: { items: { include: { originalPurchaseItem: true, sourceBatch: { include: { purchaseReceiptItem: { include: { receipt: true } } } } } }, posting: true } });
    return executeInventoryPostingInTransaction(tx, { kind: "SUPPLIER_RETURN", idempotencyKey, performedById: userId, source: { purchaseReturnId: returnId }, notes: lockedReturn.reason ?? undefined }, async () => {
      const currentByItem = new Map<number, number>();
      for (const line of lockedReturn.items) currentByItem.set(line.originalPurchaseItemId, (currentByItem.get(line.originalPurchaseItemId) ?? 0) + line.quantityBase);
      for (const [purchaseItemId, current] of currentByItem) {
        if (!Number.isSafeInteger(current) || current > POSTGRES_INTEGER_MAX) throw new PostingInvariantError("Supplier-return quantity exceeds the database range.");
        const [received, prior] = await Promise.all([
          authoritativeReceivedBase(tx, purchaseItemId),
          tx.purchaseReturnItem.aggregate({ where: { originalPurchaseItemId: purchaseItemId, purchaseReturnId: { not: returnId }, purchaseReturn: { status: { in: [...postedReturnStatuses] } } }, _sum: { quantityBase: true } }),
        ]);
        if ((prior._sum.quantityBase ?? 0) + current > received) throw new PostingInvariantError("Cumulative supplier-return quantity exceeds authoritative posted receipt quantity.");
      }
      const movements: MovementInput[] = [];
      const sellableByProduct = new Map<string, number>();
      let sequence = 1;
      for (const line of lockedReturn.items) {
        const batch = line.sourceBatch;
        assertDirectReceiptProvenance(batch, { productId: line.originalPurchaseItem.productId, purchaseItemId: line.originalPurchaseItemId, purchaseId, warehouseId: line.sourceWarehouseId });
        const decremented = await tx.inventoryBatch.updateMany({ where: { id: batch.id, warehouseId: line.sourceWarehouseId, productId: line.originalPurchaseItem.productId, quantityOnHandBase: { gte: line.quantityBase } }, data: { quantityOnHandBase: { decrement: line.quantityBase } } });
        if (decremented.count !== 1) throw new BatchConcurrencyConflictError(batch.id);
        if (batch.disposition === "SELLABLE") sellableByProduct.set(batch.productId, (sellableByProduct.get(batch.productId) ?? 0) + line.quantityBase);
        movements.push({ sequence: sequence++, type: "SUPPLIER_RETURN", productId: batch.productId, batchId: batch.id, warehouseId: batch.warehouseId, sourceWarehouseId: batch.warehouseId, quantityChangeBase: -line.quantityBase, performedById: userId, notes: lockedReturn.notes ?? lockedReturn.reason ?? undefined });
      }
      for (const [productId, quantity] of sellableByProduct) {
        const cache = await tx.product.updateMany({ where: { id: productId, quantityInStock: { gte: quantity } }, data: { quantityInStock: { decrement: quantity } } });
        if (cache.count !== 1) throw new PostingInvariantError("Sellable compatibility cache is inconsistent with the selected batches.");
      }
      await tx.purchaseReturn.update({ where: { id: returnId }, data: { status: "POSTED", postedAt: new Date(), postFingerprint } });
      return { result: { returnId, status: "POSTED" as const, quantitySummary: groupQuantities(lockedReturn.items.map((item) => ({ productId: item.originalPurchaseItem.productId, unitId: item.originalPurchaseItem.unitId, quantityInOrderUnit: item.quantityInOrderUnit, unitMultiplier: item.unitMultiplier, quantityBase: item.quantityBase }))), financialSummary: financialSummary(lockedReturn.refundAmount, lockedReturn.items), movementCount: movements.length }, movements };
    }, (transaction, postingId) => reconstructPostedReturn(transaction, postingId, returnId));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function cancelPurchaseReturn(client: PrismaClient, purchaseId: number, returnId: number) {
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseReturn" WHERE "id" = ${returnId} FOR UPDATE`);
    const purchaseReturn = await tx.purchaseReturn.findUnique({ where: { id: returnId }, include: { posting: true } });
    if (!purchaseReturn || purchaseReturn.originalPurchaseId !== purchaseId) throw new PostingInvariantError("Supplier return not found.");
    if (purchaseReturn.status === "CANCELLED") return purchaseReturn;
    if (purchaseReturn.status !== "DRAFT" || purchaseReturn.posting) throw new PostingInvariantError("A posted supplier return requires an explicit reversal before cancellation.");
    return tx.purchaseReturn.update({ where: { id: returnId }, data: { status: "CANCELLED" } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

const readInclude = { originalPurchase: { select: { id: true, supplier: { select: { id: true, name: true } } } }, processedBy: { select: { id: true, name: true, role: true } }, items: { include: { originalPurchaseItem: { select: { id: true, productId: true, unitId: true, product: { select: { id: true, name: true, baseUnit: true } } } }, sourceWarehouse: { select: { id: true, name: true, location: true } }, sourceBatch: { select: { id: true, disposition: true, expiryDate: true, warehouseId: true, productId: true } } } }, posting: { select: { id: true, kind: true, postedAt: true, movements: { select: { id: true, sequence: true, batchId: true, warehouseId: true, quantityChangeBase: true } } } } } satisfies Prisma.PurchaseReturnInclude;
type ReadReturn = Prisma.PurchaseReturnGetPayload<{ include: typeof readInclude }>;

function shapeRead(result: ReadReturn, includeFinancial: boolean) {
  const items = result.items.map((item) => {
    const { refundedUnitCost, ...safe } = item;
    return { ...safe, ...(includeFinancial ? { refundedUnitCost: refundedUnitCost?.toString() ?? null } : {}) };
  });
  const { refundAmount, ...safeReturn } = result;
  const quantitySummary = groupQuantities(result.items.map((item) => ({ productId: item.originalPurchaseItem.productId, unitId: item.originalPurchaseItem.unitId, quantityInOrderUnit: item.quantityInOrderUnit, unitMultiplier: item.unitMultiplier, quantityBase: item.quantityBase })));
  return { ...safeReturn, ...(includeFinancial ? { financialSummary: financialSummary(refundAmount, result.items) } : {}), items, quantitySummary };
}

export async function listPurchaseReturns(client: PrismaClient, purchaseId: number, includeFinancial: boolean) {
  const results = await client.purchaseReturn.findMany({ where: { originalPurchaseId: purchaseId }, include: readInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return results.map((result) => shapeRead(result, includeFinancial));
}

export async function getPurchaseReturn(client: PrismaClient, purchaseId: number, returnId: number, includeFinancial: boolean) {
  const result = await client.purchaseReturn.findFirst({ where: { id: returnId, originalPurchaseId: purchaseId }, include: readInclude });
  if (!result) throw new PostingInvariantError("Supplier return not found.");
  return shapeRead(result, includeFinancial);
}
