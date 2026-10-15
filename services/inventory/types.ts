import type { PostingKind, StockMovementType } from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";

export type InventoryTransaction = Prisma.TransactionClient;
export type BusinessDate = string & { readonly __businessDate: unique symbol };

export interface AllocationRequest {
  tx: InventoryTransaction;
  productId: string;
  warehouseId: number;
  quantityBase: number;
  businessToday: BusinessDate;
}

export interface BatchAllocation {
  batchId: string;
  productId: string;
  warehouseId: number;
  quantityBase: number;
  expiryDate: Date | null;
  receivedAt: Date;
}

export interface AllocationResult {
  allocations: BatchAllocation[];
  totalAllocatedQuantity: number;
  remainingUnfulfilledQuantity: number;
}

export interface PostingSource {
  purchaseReceiptId?: number;
  saleOrderId?: number;
  saleDispatchId?: number;
  purchaseReturnId?: number;
  saleReturnId?: number;
  returnInspectionId?: number;
  reversalOfId?: string;
}

export interface MovementInput {
  sequence: number;
  type: StockMovementType;
  productId: string;
  batchId: string;
  warehouseId: number;
  sourceWarehouseId?: number;
  destinationWarehouseId?: number;
  quantityChangeBase: number;
  performedById: string;
  adjustmentReason?: string;
  notes?: string;
}

export interface PostingCommand {
  kind: PostingKind;
  idempotencyKey: string;
  performedById: string;
  source: PostingSource;
  notes?: string;
  requestFingerprint?: string;
}

export interface PostingWorkResult<T> {
  result: T;
  movements: MovementInput[];
}

export interface PostingExecutionResult<T> {
  postingId: string;
  replayed: boolean;
  result: T;
}

export interface SaleIssueItemInput {
  saleItemId: number;
  productId: string;
  warehouseId?: number;
}

export interface SaleIssueCommand {
  idempotencyKey: string;
  requestFingerprint?: string;
  performedById: string;
  saleOrderId: number;
  businessToday: BusinessDate;
  items: SaleIssueItemInput[];
  notes?: string;
}

export interface SaleIssueResult {
  totalIssued: number;
  movementCount: number;
}
