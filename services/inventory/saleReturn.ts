import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { InspectionCheckResult } from "../../generated/prisma/enums";
import { BatchConcurrencyConflictError, IdempotencyConflictError, InvalidInspectionEvidenceError, PostingInvariantError } from "./errors";
import { executeInventoryPostingInTransaction } from "./posting";
import { withBoundedTransactionRetry } from "./retry";
import type { InventoryTransaction, MovementInput } from "./types";
import { convertToBaseUnits, validateIdempotencyKey } from "./validation";
import { getBusinessDate } from "./businessDate";
import { assertGlobalV2CommandKeyAvailable, commandFingerprint, lockIdempotencyKey } from "./idempotency";

type CreateInput = { reason: string; notes?: string; items: Array<{ originalSaleItemId: number; quantityInOrderUnit: number; expiryDate?: string | null }> };
type ReceiveInput = { receivedAt: string; items: Array<{ saleReturnItemId: number; warehouseId: number; expiryDate?: string | null }> };
type InspectionChecks = Record<"packagingIntact" | "sealIntact" | "correctProduct" | "correctQuantity" | "expiryChecked" | "visibleDamage" | "returnReasonConfirmed", InspectionCheckResult>;
type InspectInput = { saleReturnItemId: number; sourceBatchId: string; warehouseId: number; quantityInOrderUnit: number; outcome: "SELLABLE" | "DAMAGED" | "REJECTED"; inspectedAt: string; notes: string; checks: InspectionChecks };

const receivedStatuses = ["RECEIVED", "PARTLY_INSPECTED", "INSPECTED", "POSTED"] as const;

function validateInspectionEvidence(input: InspectInput, hasExpiry: boolean): void {
  const checks = input.checks;
  if (input.outcome === "SELLABLE") {
    if ([checks.correctProduct, checks.correctQuantity, checks.visibleDamage, checks.returnReasonConfirmed].some((result) => result !== "PASSED") || Object.values(checks).some((result) => result === "FAILED")) throw new InvalidInspectionEvidenceError("Sellable inventory requires passed identity, quantity, damage, and return-reason checks with no failed check.");
    if (hasExpiry && checks.expiryChecked !== "PASSED") throw new InvalidInspectionEvidenceError("Sellable inventory with an expiry date requires expiryChecked to be PASSED.");
  }
  if (input.outcome === "DAMAGED") {
    if (checks.correctProduct !== "PASSED" || checks.correctQuantity !== "PASSED") throw new InvalidInspectionEvidenceError("Damaged inventory requires passed product and quantity identification.");
    const failedDamageCheck = [checks.packagingIntact, checks.sealIntact, checks.visibleDamage].includes("FAILED");
    if (!failedDamageCheck && input.notes.trim().length < 20) throw new InvalidInspectionEvidenceError("Damaged inventory requires a failed damage-related check or a detailed explanation.");
  }
  if (input.outcome === "REJECTED") {
    if (input.notes.trim().length < 10) throw new InvalidInspectionEvidenceError("Rejected inventory requires a meaningful rejection explanation.");
    if (checks.correctProduct === "NOT_APPLICABLE" || checks.correctQuantity === "NOT_APPLICABLE") throw new InvalidInspectionEvidenceError("Rejected inventory requires explicit product and quantity identification evidence.");
    if (!Object.values(checks).includes("FAILED")) throw new InvalidInspectionEvidenceError("Rejected inventory requires at least one failed relevant inspection check.");
  }
}

export async function createSaleReturn(client: PrismaClient, saleId: number, input: CreateInput, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ command: "CREATE_CUSTOMER_RETURN", saleId, userId, input });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const existing = await tx.saleReturn.findUnique({ where: { idempotencyKey }, include: { items: true } });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();
      return { replayed: true, saleReturn: existing };
    }
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleOrder" WHERE "id" = ${saleId} FOR UPDATE`);
    const sale = await tx.saleOrder.findUnique({ where: { id: saleId }, include: { inventoryPosting: true } });
    if (!sale || sale.transactionStatus === "CANCELLED" || (!sale.inventoryPosting && !(await tx.saleDispatch.findFirst({ where: { saleOrderId: saleId }, select: { id: true } })))) throw new PostingInvariantError("Customer returns require an issued sale order.");
    const requestedItemIds = input.items.map((item) => item.originalSaleItemId);
    if (new Set(requestedItemIds).size !== requestedItemIds.length) throw new PostingInvariantError("Duplicate sale-item return lines are not allowed.");
    const items = await tx.saleItem.findMany({ where: { saleId, id: { in: requestedItemIds } } });
    if (items.length !== input.items.length) throw new PostingInvariantError("Sale return item not found on the original sale.");
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const line of input.items) {
      const item = byId.get(line.originalSaleItemId)!;
      if (item.unitMultiplierSnapshot === null) throw new PostingInvariantError("Original sale-item multiplier snapshot is missing.");
      const requestedBase = convertToBaseUnits(line.quantityInOrderUnit, item.unitMultiplierSnapshot);
      const issued = await tx.saleAllocation.aggregate({ where: { saleItemId: item.id }, _sum: { quantityBase: true } });
      if ((issued._sum.quantityBase ?? 0) === 0) throw new PostingInvariantError("Customer returns require an issued allocation for every sale item.");
      if (requestedBase > (issued._sum.quantityBase ?? 0)) throw new PostingInvariantError("Draft customer-return quantity exceeds the quantity originally issued.");
    }
    const saleReturn = await tx.saleReturn.create({
      data: {
        originalSaleId: saleId, idempotencyKey, requestFingerprint, processedById: userId, reason: input.reason, notes: input.notes,
        items: { create: input.items.map((line) => {
          const item = byId.get(line.originalSaleItemId)!;
          if (item.unitMultiplierSnapshot === null) throw new PostingInvariantError("Original sale-item multiplier snapshot is missing.");
          return { originalSaleItemId: item.id, quantityInOrderUnit: line.quantityInOrderUnit, unitMultiplier: item.unitMultiplierSnapshot, quantityBase: convertToBaseUnits(line.quantityInOrderUnit, item.unitMultiplierSnapshot), expiryDate: line.expiryDate ? new Date(`${line.expiryDate}T00:00:00.000Z`) : null, condition: "QUARANTINED" as const };
        }) },
      }, include: { items: true },
    });
    return { replayed: false, saleReturn };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

async function reconstructReceive(tx: InventoryTransaction, postingId: string, returnId: number) {
  const saleReturn = await tx.saleReturn.findUniqueOrThrow({ where: { id: returnId }, include: { items: { include: { inventoryBatches: true } } } });
  return { returnId, status: saleReturn.status, batchIds: saleReturn.items.flatMap((item) => item.inventoryBatches.map((batch) => batch.id)), movementCount: await tx.stockMovement.count({ where: { postingId } }) };
}

export async function receiveSaleReturn(client: PrismaClient, saleId: number, returnId: number, input: ReceiveInput, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const receiveFingerprint = commandFingerprint({ command: "RECEIVE_CUSTOMER_RETURN", saleId, returnId, userId, input });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleOrder" WHERE "id" = ${saleId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleReturn" WHERE "id" = ${returnId} FOR UPDATE`);
    const saleReturn = await tx.saleReturn.findUnique({ where: { id: returnId }, include: { items: true, posting: true } });
    if (!saleReturn || saleReturn.originalSaleId !== saleId) throw new PostingInvariantError("Customer return not found.");
    if (saleReturn.posting) {
      if (saleReturn.posting.idempotencyKey !== idempotencyKey || saleReturn.receiveFingerprint !== receiveFingerprint) throw new IdempotencyConflictError();
      return { postingId: saleReturn.posting.id, replayed: true, result: await reconstructReceive(tx, saleReturn.posting.id, returnId) };
    }
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
    if (saleReturn.status === "CANCELLED") throw new PostingInvariantError("A cancelled customer return cannot be received.");
    if (saleReturn.status !== "DRAFT") throw new PostingInvariantError("Only a draft customer return can be received.");
    const requestedIds = new Set(input.items.map((item) => item.saleReturnItemId));
    if (requestedIds.size !== saleReturn.items.length || saleReturn.items.some((item) => !requestedIds.has(item.id))) throw new PostingInvariantError("Every return item must have exactly one receiving warehouse.");
    const warehouseIds = [...new Set(input.items.map((item) => item.warehouseId))];
    if (await tx.warehouse.count({ where: { id: { in: warehouseIds } } }) !== warehouseIds.length) throw new PostingInvariantError("Return warehouse not found.");
    const saleItemIds = saleReturn.items.map((item) => item.originalSaleItemId).sort((a, b) => a - b);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleItem" WHERE "id" IN (${Prisma.join(saleItemIds)}) ORDER BY "id" FOR UPDATE`);
    for (const item of saleReturn.items) {
      const issued = await tx.saleAllocation.aggregate({ where: { saleItemId: item.originalSaleItemId }, _sum: { quantityBase: true } });
      const priorItems = await tx.saleReturnItem.findMany({ where: { originalSaleItemId: item.originalSaleItemId, saleReturnId: { not: returnId }, saleReturn: { status: { in: [...receivedStatuses] } } }, select: { quantityBase: true } });
      const prior = priorItems.reduce((sum, priorItem) => sum + priorItem.quantityBase, 0);
      if (prior + item.quantityBase > (issued._sum.quantityBase ?? 0)) throw new PostingInvariantError("Cumulative customer return quantity exceeds the quantity originally issued.");
    }
    return executeInventoryPostingInTransaction(tx, { kind: "CUSTOMER_RETURN", idempotencyKey, performedById: userId, source: { saleReturnId: returnId }, notes: saleReturn.reason ?? undefined }, async () => {
      const movements: MovementInput[] = [];
      const batchIds: string[] = [];
      const byItem = new Map(input.items.map((item) => [item.saleReturnItemId, item]));
      let sequence = 1;
      for (const item of saleReturn.items) {
        const receive = byItem.get(item.id)!;
        const expiryDate = receive.expiryDate === undefined ? item.expiryDate : receive.expiryDate ? new Date(`${receive.expiryDate}T00:00:00.000Z`) : null;
        await tx.saleReturnItem.update({ where: { id: item.id }, data: { destinationWarehouseId: receive.warehouseId, expiryDate } });
        const batch = await tx.inventoryBatch.create({ data: { id: randomUUID(), productId: (await tx.saleItem.findUniqueOrThrow({ where: { id: item.originalSaleItemId } })).productId, warehouseId: receive.warehouseId, expiryDate, receivedAt: new Date(input.receivedAt), quantityOnHandBase: item.quantityBase, disposition: "QUARANTINED", saleReturnItemId: item.id } });
        batchIds.push(batch.id);
        movements.push({ sequence: sequence++, type: "CUSTOMER_RETURN_QUARANTINED", productId: batch.productId, batchId: batch.id, warehouseId: batch.warehouseId, destinationWarehouseId: batch.warehouseId, quantityChangeBase: item.quantityBase, performedById: userId });
      }
      await tx.saleReturn.update({ where: { id: returnId }, data: { status: "RECEIVED", postedAt: new Date(), receiveFingerprint } });
      return { result: { returnId, status: "RECEIVED" as const, batchIds, movementCount: movements.length }, movements };
    }, (transaction, postingId) => reconstructReceive(transaction, postingId, returnId));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

async function reconstructInspection(tx: InventoryTransaction, postingId: string, inspectionId: number) {
  const inspection = await tx.returnInspection.findUniqueOrThrow({ where: { id: inspectionId }, include: { destinationBatch: true } });
  return { inspectionId, outcome: inspection.finalCondition, quantityBase: inspection.quantityBase!, destinationBatchId: inspection.destinationBatchId, movementCount: await tx.stockMovement.count({ where: { postingId } }) };
}

export async function inspectSaleReturn(client: PrismaClient, saleId: number, returnId: number, input: InspectInput, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ command: "INSPECT_CUSTOMER_RETURN", saleId, returnId, userId, input });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const existing = await tx.returnInspection.findUnique({ where: { idempotencyKey }, include: { posting: true } });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint || !existing.posting) throw new IdempotencyConflictError();
      return { postingId: existing.posting.id, replayed: true, result: await reconstructInspection(tx, existing.posting.id, existing.id) };
    }
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleReturn" WHERE "id" = ${returnId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleReturnItem" WHERE "id" = ${input.saleReturnItemId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryBatch" WHERE "id" = ${input.sourceBatchId} FOR UPDATE`);
    const saleReturn = await tx.saleReturn.findUnique({ where: { id: returnId } });
    if (!saleReturn || saleReturn.originalSaleId !== saleId || !["RECEIVED", "PARTLY_INSPECTED"].includes(saleReturn.status)) throw new PostingInvariantError("Customer return is not available for inspection.");
    const item = await tx.saleReturnItem.findUnique({ where: { id: input.saleReturnItemId }, include: { originalSaleItem: true } });
    if (!item || item.saleReturnId !== returnId) throw new PostingInvariantError("Customer return item not found.");
    const batch = await tx.inventoryBatch.findUnique({ where: { id: input.sourceBatchId } });
    if (!batch || batch.saleReturnItemId !== item.id || batch.disposition !== "QUARANTINED") throw new PostingInvariantError("Inspection source must be the return item's quarantined batch.");
    if (!await tx.warehouse.findUnique({ where: { id: input.warehouseId } })) throw new PostingInvariantError("Final inspection warehouse not found.");
    const quantityBase = convertToBaseUnits(input.quantityInOrderUnit, item.unitMultiplier);
    if (batch.quantityOnHandBase < quantityBase) throw new PostingInvariantError("Inspection quantity exceeds the remaining quarantined quantity.");
    validateInspectionEvidence(input, batch.expiryDate !== null);
    if (input.outcome === "SELLABLE" && batch.expiryDate && batch.expiryDate < new Date(`${getBusinessDate()}T00:00:00.000Z`)) throw new PostingInvariantError("Expired returned inventory cannot become sellable.");
    const inspection = await tx.returnInspection.create({ data: { idempotencyKey, requestFingerprint, saleReturnItemId: item.id, sourceBatchId: batch.id, finalWarehouseId: input.warehouseId, quantityBase, inspectorId: userId, inspectedAt: new Date(input.inspectedAt), ...input.checks, finalCondition: input.outcome, notes: input.notes } });
    return executeInventoryPostingInTransaction(tx, { kind: "RETURN_INSPECTION_RECLASSIFICATION", idempotencyKey, performedById: userId, source: { returnInspectionId: inspection.id }, notes: input.notes }, async () => {
      const decremented = await tx.inventoryBatch.updateMany({ where: { id: batch.id, disposition: "QUARANTINED", quantityOnHandBase: { gte: quantityBase } }, data: { quantityOnHandBase: { decrement: quantityBase } } });
      if (decremented.count !== 1) throw new BatchConcurrencyConflictError(batch.id);
      const movements: MovementInput[] = [{ sequence: 1, type: "RETURN_INSPECTION_RECLASSIFICATION", productId: batch.productId, batchId: batch.id, warehouseId: batch.warehouseId, quantityChangeBase: -quantityBase, performedById: userId, notes: input.notes }];
      let destinationBatchId: string | null = null;
      if (input.outcome !== "REJECTED") {
        const derived = await tx.inventoryBatch.create({ data: { id: randomUUID(), productId: batch.productId, warehouseId: input.warehouseId, expiryDate: batch.expiryDate, receivedAt: new Date(input.inspectedAt), quantityOnHandBase: quantityBase, disposition: input.outcome, saleReturnItemId: item.id, sourceBatchId: batch.id } });
        destinationBatchId = derived.id;
        movements.push({ sequence: 2, type: input.outcome === "SELLABLE" ? "CUSTOMER_RETURN_SELLABLE" : "CUSTOMER_RETURN_DAMAGED", productId: batch.productId, batchId: derived.id, warehouseId: derived.warehouseId, quantityChangeBase: quantityBase, performedById: userId, notes: input.notes });
        if (input.outcome === "SELLABLE") await tx.product.update({ where: { id: batch.productId }, data: { quantityInStock: { increment: quantityBase } } });
      } else {
        movements[0] = { ...movements[0]!, type: "CUSTOMER_RETURN_REJECTED" };
      }
      await tx.returnInspection.update({ where: { id: inspection.id }, data: { destinationBatchId } });
      const remaining = await tx.inventoryBatch.aggregate({ where: { saleReturnItem: { saleReturnId: returnId }, disposition: "QUARANTINED" }, _sum: { quantityOnHandBase: true } });
      await tx.saleReturn.update({ where: { id: returnId }, data: { status: (remaining._sum.quantityOnHandBase ?? 0) === 0 ? "INSPECTED" : "PARTLY_INSPECTED" } });
      return { result: { inspectionId: inspection.id, outcome: input.outcome, quantityBase, destinationBatchId, movementCount: movements.length }, movements };
    }, (transaction, postingId) => reconstructInspection(transaction, postingId, inspection.id));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function cancelSaleReturn(client: PrismaClient, saleId: number, returnId: number) {
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleReturn" WHERE "id" = ${returnId} FOR UPDATE`);
    const saleReturn = await tx.saleReturn.findUnique({ where: { id: returnId }, include: { posting: true } });
    if (!saleReturn || saleReturn.originalSaleId !== saleId) throw new PostingInvariantError("Customer return not found.");
    if (saleReturn.status === "CANCELLED") return saleReturn;
    if (saleReturn.status !== "DRAFT" || saleReturn.posting) throw new PostingInvariantError("Received customer-return inventory must be reversed before cancellation.");
    return tx.saleReturn.update({ where: { id: returnId }, data: { status: "CANCELLED" } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

const returnInclude = { items: { include: { originalSaleItem: { select: { id: true, productId: true, quantityOrdered: true, unitMultiplierSnapshot: true } }, destinationWarehouse: true, inventoryBatches: { include: { derivedBatches: true } }, inspections: { include: { inspector: { select: { id: true, name: true, role: true } }, sourceBatch: true, destinationBatch: true, finalWarehouse: true, posting: { select: { id: true, kind: true, postedAt: true, movements: { select: { id: true, sequence: true, type: true, quantityChangeBase: true } } } } } } } }, posting: { select: { id: true, kind: true, postedAt: true } }, processedBy: { select: { id: true, name: true, role: true } } } satisfies Prisma.SaleReturnInclude;

type ReturnReadModel = Prisma.SaleReturnGetPayload<{ include: typeof returnInclude }>;

function withQuantitySummary(saleReturn: ReturnReadModel) {
  const items = saleReturn.items.map((item) => {
    const inspectedQuantityBase = item.inspections.reduce((sum, inspection) => sum + (inspection.quantityBase ?? 0), 0);
    const receivedQuantityBase = saleReturn.posting ? item.quantityBase : 0;
    const outcomeSummary = item.inspections.reduce((summary, inspection) => {
      const quantity = inspection.quantityBase ?? 0;
      if (inspection.finalCondition === "SELLABLE") summary.sellableQuantityBase += quantity;
      if (inspection.finalCondition === "DAMAGED") summary.damagedQuantityBase += quantity;
      if (inspection.finalCondition === "REJECTED") summary.rejectedQuantityBase += quantity;
      return summary;
    }, { sellableQuantityBase: 0, damagedQuantityBase: 0, rejectedQuantityBase: 0 });
    const remainingQuarantineQuantityBase = item.inventoryBatches
      .filter((batch) => batch.disposition === "QUARANTINED")
      .reduce((sum, batch) => sum + batch.quantityOnHandBase, 0);
    const { condition: intakeCondition, ...safeItem } = item;
    return {
      ...safeItem,
      intakeCondition,
      outcomeSummary: { ...outcomeSummary, remainingQuarantineQuantityBase },
      quantitySummary: {
        requestedQuantityInOrderUnit: item.quantityInOrderUnit,
        requestedQuantityBase: item.quantityBase,
        receivedQuantityBase,
        inspectedQuantityBase,
        remainingQuantityBase: remainingQuarantineQuantityBase,
      },
    };
  });
  return {
    ...saleReturn,
    items,
    quantitySummary: items.reduce((summary, item) => ({
      requestedQuantityBase: summary.requestedQuantityBase + item.quantitySummary.requestedQuantityBase,
      receivedQuantityBase: summary.receivedQuantityBase + item.quantitySummary.receivedQuantityBase,
      inspectedQuantityBase: summary.inspectedQuantityBase + item.quantitySummary.inspectedQuantityBase,
      remainingQuantityBase: summary.remainingQuantityBase + item.quantitySummary.remainingQuantityBase,
    }), { requestedQuantityBase: 0, receivedQuantityBase: 0, inspectedQuantityBase: 0, remainingQuantityBase: 0 }),
    outcomeSummary: items.reduce((summary, item) => ({
      sellableQuantityBase: summary.sellableQuantityBase + item.outcomeSummary.sellableQuantityBase,
      damagedQuantityBase: summary.damagedQuantityBase + item.outcomeSummary.damagedQuantityBase,
      rejectedQuantityBase: summary.rejectedQuantityBase + item.outcomeSummary.rejectedQuantityBase,
      remainingQuarantineQuantityBase: summary.remainingQuarantineQuantityBase + item.outcomeSummary.remainingQuarantineQuantityBase,
    }), { sellableQuantityBase: 0, damagedQuantityBase: 0, rejectedQuantityBase: 0, remainingQuarantineQuantityBase: 0 }),
  };
}

export async function listSaleReturns(client: PrismaClient, saleId: number) {
  const results = await client.saleReturn.findMany({ where: { originalSaleId: saleId }, include: returnInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return results.map(withQuantitySummary);
}
export async function getSaleReturn(client: PrismaClient, saleId: number, returnId: number) {
  const result = await client.saleReturn.findFirst({ where: { id: returnId, originalSaleId: saleId }, include: returnInclude });
  if (!result) throw new PostingInvariantError("Customer return not found.");
  return withQuantitySummary(result);
}
