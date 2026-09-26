import type { StockMovementType } from "../../generated/prisma/enums";
import { BatchConcurrencyConflictError } from "./errors";
import type { BatchAllocation, InventoryTransaction, MovementInput } from "./types";
import { requirePositiveBaseQuantity } from "./validation";

export async function decrementAllocatedBatch(
  tx: InventoryTransaction,
  allocation: BatchAllocation,
): Promise<void> {
  const quantity = requirePositiveBaseQuantity(allocation.quantityBase, "allocated quantity");
  const result = await tx.inventoryBatch.updateMany({
    where: { id: allocation.batchId, quantityOnHandBase: { gte: quantity } },
    data: { quantityOnHandBase: { decrement: quantity } },
  });
  if (result.count !== 1) throw new BatchConcurrencyConflictError(allocation.batchId);
}

export async function incrementExplicitBatch(
  tx: InventoryTransaction,
  batchId: string,
  quantityBase: number,
): Promise<void> {
  const quantity = requirePositiveBaseQuantity(quantityBase, "positive batch quantity");
  const result = await tx.inventoryBatch.updateMany({
    where: { id: batchId },
    data: { quantityOnHandBase: { increment: quantity } },
  });
  if (result.count !== 1) throw new BatchConcurrencyConflictError(batchId);
}

export function createPositiveMovementInput(input: {
  sequence: number;
  type: StockMovementType;
  productId: string;
  batchId: string;
  warehouseId: number;
  quantityBase: number;
  performedById: string;
  notes?: string;
}): MovementInput {
  const { quantityBase, ...movement } = input;
  return { ...movement, quantityChangeBase: requirePositiveBaseQuantity(quantityBase) };
}
