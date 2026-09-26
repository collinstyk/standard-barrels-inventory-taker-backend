import type { PrismaClient } from "../../generated/prisma/client";
import { allocateInventory } from "./allocation";
import { decrementAllocatedBatch } from "./batchMutations";
import { PostingInvariantError } from "./errors";
import { executeInventoryPosting, executeInventoryPostingInTransaction } from "./posting";
import type { InventoryTransaction, MovementInput, SaleIssueCommand, SaleIssueResult } from "./types";
import { convertToBaseUnits, POSTGRES_INTEGER_MAX } from "./validation";

export async function reconstructSaleIssueResult(
  tx: InventoryTransaction,
  postingId: string,
  saleOrderId: number,
): Promise<SaleIssueResult> {
  const movements = await tx.stockMovement.findMany({
    where: { postingId },
    select: { type: true, quantityChangeBase: true },
  });
  if (movements.length === 0 || movements.some((movement) => movement.type !== "SALE_ISSUE" || movement.quantityChangeBase >= 0)) {
    throw new PostingInvariantError("Persisted sale-issue movements are invalid.");
  }
  const totalIssued = -movements.reduce((sum, movement) => sum + movement.quantityChangeBase, 0);
  const allocations = await tx.saleAllocation.aggregate({
    where: { saleItem: { saleId: saleOrderId } },
    _sum: { quantityBase: true },
  });
  if (allocations._sum.quantityBase !== totalIssued) {
    throw new PostingInvariantError("Persisted sale allocations do not balance with the posting movements.");
  }
  return { totalIssued, movementCount: movements.length };
}

function validateSaleIssueCommand(command: SaleIssueCommand): void {
  if (!Number.isSafeInteger(command.saleOrderId) || command.saleOrderId <= 0) {
    throw new PostingInvariantError("A valid sale order ID is required.");
  }
  if (!Array.isArray(command.items) || command.items.length === 0) {
    throw new PostingInvariantError("A sale issue requires at least one sale item.");
  }
  const saleItemIds = new Set<number>();
  for (const item of command.items) {
    if (!Number.isSafeInteger(item.saleItemId) || item.saleItemId <= 0 || saleItemIds.has(item.saleItemId)) {
      throw new PostingInvariantError("Sale item IDs must be unique positive integers.");
    }
    if (item.warehouseId !== undefined && (!Number.isSafeInteger(item.warehouseId) || item.warehouseId <= 0)) {
      throw new PostingInvariantError("Selected warehouse IDs must be positive integers.");
    }
    if (typeof item.productId !== "string" || item.productId.length === 0) {
      throw new PostingInvariantError("Every sale item requires a product ID.");
    }
    saleItemIds.add(item.saleItemId);
  }
}

async function performSaleIssue(
  tx: InventoryTransaction,
  command: SaleIssueCommand,
) {
  const movements: MovementInput[] = [];
  const issuedByProduct = new Map<string, number>();
  let sequence = 1;
  const persistedItems = await tx.saleItem.findMany({
    where: { id: { in: command.items.map((item) => item.saleItemId) }, saleId: command.saleOrderId },
    select: {
      id: true,
      productId: true,
      sourceWarehouseId: true,
      quantityOrdered: true,
      unitMultiplierSnapshot: true,
      fulfillments: { select: { id: true, warehouseId: true, quantityInOrderUnit: true, unitMultiplierSnapshot: true, quantityBase: true } },
    },
  });
  const persistedById = new Map(persistedItems.map((item) => [item.id, item]));
  const resolvedFulfillments: Array<{ saleItemId: number; fulfillmentId?: number; productId: string; warehouseId: number; quantityBase: number }> = [];
  for (const item of command.items) {
    const persisted = persistedById.get(item.saleItemId);
    if (!persisted || persisted.productId !== item.productId) {
      throw new PostingInvariantError("Sale-item product must match the persisted sale order.");
    }
    if (persisted.unitMultiplierSnapshot === null) {
      throw new PostingInvariantError("Sale-item unit multiplier snapshot is required before activation.");
    }
    if (persisted.fulfillments.length > 0) {
      const orderUnitTotal = persisted.fulfillments.reduce((sum, fulfillment) => sum + fulfillment.quantityInOrderUnit, 0);
      if (!Number.isSafeInteger(orderUnitTotal) || orderUnitTotal !== persisted.quantityOrdered) {
        throw new PostingInvariantError("Sale-item fulfilment quantities must equal quantity ordered.");
      }
      for (const fulfillment of persisted.fulfillments) {
        if (fulfillment.unitMultiplierSnapshot !== persisted.unitMultiplierSnapshot
          || fulfillment.quantityBase !== convertToBaseUnits(fulfillment.quantityInOrderUnit, fulfillment.unitMultiplierSnapshot)) {
          throw new PostingInvariantError("Persisted sale-item fulfilment quantities are invalid.");
        }
        resolvedFulfillments.push({ saleItemId: persisted.id, fulfillmentId: fulfillment.id, productId: persisted.productId, warehouseId: fulfillment.warehouseId, quantityBase: fulfillment.quantityBase });
      }
    } else {
      if (item.warehouseId === undefined || persisted.sourceWarehouseId !== item.warehouseId) {
        throw new PostingInvariantError("Sale item requires persisted warehouse fulfilments.");
      }
      resolvedFulfillments.push({ saleItemId: persisted.id, productId: persisted.productId, warehouseId: item.warehouseId, quantityBase: convertToBaseUnits(persisted.quantityOrdered, persisted.unitMultiplierSnapshot) });
    }
  }
  for (const item of resolvedFulfillments) {
    const allocation = await allocateInventory({
      tx,
      productId: item.productId,
      warehouseId: item.warehouseId,
      quantityBase: item.quantityBase,
      businessToday: command.businessToday,
    });
    for (const batch of allocation.allocations) {
      await decrementAllocatedBatch(tx, batch);
      await tx.saleAllocation.create({
        data: { saleItemId: item.saleItemId, fulfillmentId: item.fulfillmentId, batchId: batch.batchId, quantityBase: batch.quantityBase },
      });
      movements.push({
        sequence: sequence++,
        type: "SALE_ISSUE",
        productId: item.productId,
        batchId: batch.batchId,
        warehouseId: item.warehouseId,
        quantityChangeBase: -batch.quantityBase,
        performedById: command.performedById,
      });
    }
    const movementTotal = allocation.allocations.reduce((sum, entry) => sum + entry.quantityBase, 0);
    if (movementTotal !== item.quantityBase) throw new PostingInvariantError("Sale allocation is not balanced.");
    const productTotal = (issuedByProduct.get(item.productId) ?? 0) + item.quantityBase;
    if (!Number.isSafeInteger(productTotal) || productTotal > POSTGRES_INTEGER_MAX) {
      throw new PostingInvariantError("The total issued quantity for a product exceeds the database range.");
    }
    issuedByProduct.set(item.productId, productTotal);
  }
  for (const [productId, quantityBase] of issuedByProduct) {
    const updated = await tx.product.updateMany({
      where: { id: productId, quantityInStock: { gte: quantityBase } },
      data: { quantityInStock: { decrement: quantityBase } },
    });
    if (updated.count !== 1) throw new PostingInvariantError("The compatibility stock cache is inconsistent with batch inventory.");
  }
  const totalIssued = resolvedFulfillments.reduce((sum, item) => sum + item.quantityBase, 0);
  if (-movements.reduce((sum, movement) => sum + movement.quantityChangeBase, 0) !== totalIssued) {
    throw new PostingInvariantError("Sale-issue movements do not balance.");
  }
  return { result: { totalIssued, movementCount: movements.length }, movements };
}

function postingCommand(command: SaleIssueCommand) {
  return {
    kind: "SALE_ISSUE" as const,
    idempotencyKey: command.idempotencyKey,
    performedById: command.performedById,
    source: { saleOrderId: command.saleOrderId },
    notes: command.notes,
  };
}

export async function issueSaleInTransaction(tx: InventoryTransaction, command: SaleIssueCommand) {
  validateSaleIssueCommand(command);
  return executeInventoryPostingInTransaction(
    tx,
    postingCommand(command),
    (transaction) => performSaleIssue(transaction, command),
    (transaction, postingId) => reconstructSaleIssueResult(transaction, postingId, command.saleOrderId),
  );
}

export async function prepareSaleIssue(client: PrismaClient, command: SaleIssueCommand) {
  validateSaleIssueCommand(command);
  return executeInventoryPosting(
    client,
    postingCommand(command),
    (transaction) => performSaleIssue(transaction, command),
    (transaction, postingId) => reconstructSaleIssueResult(transaction, postingId, command.saleOrderId),
  );
}
