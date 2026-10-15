import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { allocateInventory } from "./allocation";
import { decrementAllocatedBatch } from "./batchMutations";
import { getBusinessDate } from "./businessDate";
import { IdempotencyConflictError, PostingInvariantError } from "./errors";
import { assertGlobalV2CommandKeyAvailable, commandFingerprint, lockIdempotencyKey } from "./idempotency";
import { executeInventoryPostingInTransaction } from "./posting";
import { withBoundedTransactionRetry } from "./retry";
import type { MovementInput } from "./types";
import { convertToBaseUnits, POSTGRES_INTEGER_MAX, validateIdempotencyKey } from "./validation";

export interface DispatchInput {
  lines: Array<{ fulfillmentId: number; quantityInOrderUnit: number }>;
}

export async function dispatchSale(client: PrismaClient, saleId: number, input: DispatchInput, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ command: "DISPATCH_SALE", saleId, userId, input });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const existing = await tx.saleDispatch.findUnique({ where: { idempotencyKey }, include: { lines: true, posting: true } });
    if (existing) {
      if (existing.saleOrderId !== saleId || existing.requestFingerprint !== requestFingerprint || !existing.posting)
        throw new IdempotencyConflictError();
      return { replayed: true, dispatch: existing, postingId: existing.posting.id };
    }
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleOrder" WHERE "id" = ${saleId} FOR UPDATE`);
    const sale = await tx.saleOrder.findUnique({ where: { id: saleId }, include: { items: { include: { fulfillments: true } }, inventoryPosting: true } });
    if (!sale) throw new PostingInvariantError("Sale order not found.");
    if (sale.transactionStatus === "DRAFT" || sale.transactionStatus === "CANCELLED" || sale.inventoryPosting)
      throw new PostingInvariantError("Only an active sale without a legacy issue posting can be dispatched.");
    const fulfillmentById = new Map(sale.items.flatMap((item) => item.fulfillments.map((fulfillment) => [fulfillment.id, { item, fulfillment }] as const)));
    const previous = await tx.saleDispatchLine.groupBy({ by: ["fulfillmentId"], where: { dispatch: { saleOrderId: saleId } }, _sum: { quantityInOrderUnit: true } });
    const deliveredByFulfillment = new Map(previous.map((line) => [line.fulfillmentId, line._sum.quantityInOrderUnit ?? 0]));
    for (const item of sale.items) {
      const recorded = item.fulfillments.reduce((sum, fulfillment) => sum + (deliveredByFulfillment.get(fulfillment.id) ?? 0), 0);
      if (item.quantityDelivered !== recorded)
        throw new PostingInvariantError("Saved delivery quantity does not match posted dispatches.");
    }
    const seen = new Set<number>();
    for (const line of input.lines) {
      if (seen.has(line.fulfillmentId)) throw new PostingInvariantError("Duplicate fulfillment in dispatch.");
      seen.add(line.fulfillmentId);
      const entry = fulfillmentById.get(line.fulfillmentId);
      if (!entry) throw new PostingInvariantError("Fulfillment does not belong to this sale.");
      if ((deliveredByFulfillment.get(line.fulfillmentId) ?? 0) + line.quantityInOrderUnit > entry.fulfillment.quantityInOrderUnit)
        throw new PostingInvariantError("Dispatch quantity exceeds the planned fulfillment.");
      deliveredByFulfillment.set(line.fulfillmentId, (deliveredByFulfillment.get(line.fulfillmentId) ?? 0) + line.quantityInOrderUnit);
    }
    const dispatch = await tx.saleDispatch.create({
      data: { saleOrderId: saleId, idempotencyKey, requestFingerprint,
        lines: { create: input.lines.map((line) => ({
          fulfillmentId: line.fulfillmentId,
          quantityInOrderUnit: line.quantityInOrderUnit,
          quantityBase: convertToBaseUnits(line.quantityInOrderUnit, fulfillmentById.get(line.fulfillmentId)!.fulfillment.unitMultiplierSnapshot),
        })) },
      }, include: { lines: true },
    });
    const posting = await executeInventoryPostingInTransaction(tx, {
      kind: "SALE_ISSUE", source: { saleDispatchId: dispatch.id }, idempotencyKey,
      requestFingerprint, performedById: userId,
    }, async () => {
      const movements: MovementInput[] = [];
      const issuedByProduct = new Map<string, number>();
      for (const line of dispatch.lines) {
        const { item, fulfillment } = fulfillmentById.get(line.fulfillmentId)!;
        if (fulfillment.quantityBase !== convertToBaseUnits(fulfillment.quantityInOrderUnit, fulfillment.unitMultiplierSnapshot))
          throw new PostingInvariantError("The saved fulfillment conversion is invalid.");
        const allocation = await allocateInventory({ tx, productId: item.productId, warehouseId: fulfillment.warehouseId,
          quantityBase: line.quantityBase, businessToday: getBusinessDate() });
        for (const batch of allocation.allocations) {
          await decrementAllocatedBatch(tx, batch);
          // One allocation row per sale item and batch; repeated dispatches add to it.
          await tx.saleAllocation.upsert({ where: { saleItemId_batchId: { saleItemId: item.id, batchId: batch.batchId } },
            create: { saleItemId: item.id, fulfillmentId: fulfillment.id, batchId: batch.batchId, quantityBase: batch.quantityBase },
            update: { quantityBase: { increment: batch.quantityBase } } });
          movements.push({ sequence: movements.length + 1, type: "SALE_ISSUE", productId: item.productId,
            batchId: batch.batchId, warehouseId: fulfillment.warehouseId, quantityChangeBase: -batch.quantityBase, performedById: userId });
        }
        if (allocation.allocations.reduce((sum, batch) => sum + batch.quantityBase, 0) !== line.quantityBase)
          throw new PostingInvariantError("Dispatch allocation does not balance.");
        issuedByProduct.set(item.productId, (issuedByProduct.get(item.productId) ?? 0) + line.quantityBase);
      }
      for (const [productId, amount] of issuedByProduct) {
        if (!Number.isSafeInteger(amount) || amount > POSTGRES_INTEGER_MAX) throw new PostingInvariantError("Dispatch exceeds supported quantity.");
        const changed = await tx.product.updateMany({ where: { id: productId, quantityInStock: { gte: amount } }, data: { quantityInStock: { decrement: amount } } });
        if (changed.count !== 1) throw new PostingInvariantError("The stock cache does not balance with inventory batches.");
      }
      return { result: { totalIssuedBase: dispatch.lines.reduce((sum, line) => sum + line.quantityBase, 0), movementCount: movements.length }, movements };
    }, async (_tx, postingId) => ({ totalIssuedBase: dispatch.lines.reduce((sum, line) => sum + line.quantityBase, 0), movementCount: await tx.stockMovement.count({ where: { postingId } }) }));
    const deliveredByItem = new Map<number, number>();
    for (const [fulfillmentId, delivered] of deliveredByFulfillment) {
      const entry = fulfillmentById.get(fulfillmentId)!;
      deliveredByItem.set(entry.item.id, (deliveredByItem.get(entry.item.id) ?? 0) + delivered);
    }
    for (const item of sale.items) {
      const delivered = deliveredByItem.get(item.id) ?? 0;
      if (delivered > item.quantityOrdered) throw new PostingInvariantError("Delivered quantity exceeds the sale order.");
      await tx.saleItem.update({ where: { id: item.id }, data: { quantityDelivered: delivered } });
    }
    const ordered = sale.items.reduce((sum, item) => sum + item.quantityOrdered, 0);
    const delivered = [...deliveredByItem.values()].reduce((sum, value) => sum + value, 0);
    const deliveryStatus = delivered === ordered ? "FULLY_DELIVERED" : "PARTLY_DELIVERED";
    await tx.saleOrder.update({ where: { id: saleId }, data: { deliveryStatus,
      transactionStatus: deliveryStatus === "FULLY_DELIVERED" && sale.paymentStatus === "FULLY_PAID" ? "COMPLETED" : "PENDING" } });
    return { replayed: false, dispatch, postingId: posting.postingId, result: posting.result };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 }));
}
