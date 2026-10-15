import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { InventoryTransaction } from "./types";
import { IdempotencyConflictError } from "./errors";

export function commandFingerprint(command: unknown): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

export async function lockIdempotencyKey(tx: InventoryTransaction, key: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT hashtext(${key})::int AS "lockKey" FROM pg_advisory_xact_lock(hashtext(${key}))`);
}

export interface AllowedV2CommandIdentity {
  purchaseOrderId?: number;
  purchaseReceiptId?: number;
  saleOrderId?: number;
  saleReturnId?: number;
  returnInspectionId?: number;
  purchaseReturnId?: number;
  postingId?: string;
}

export async function assertGlobalV2CommandKeyAvailable(tx: InventoryTransaction, key: string, allowed: AllowedV2CommandIdentity = {}): Promise<void> {
  const [purchaseOrder, receipt, saleOrder, saleReturn, inspection, purchaseReturn, posting, saleDispatch] = await Promise.all([
    tx.purchaseOrder.findUnique({ where: { requestIdempotencyKey: key }, select: { id: true } }),
    tx.purchaseReceipt.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
    tx.saleOrder.findUnique({ where: { requestIdempotencyKey: key }, select: { id: true } }),
    tx.saleReturn.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
    tx.returnInspection.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
    tx.purchaseReturn.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
    tx.inventoryPosting.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
    tx.saleDispatch.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
  ]);
  const conflict = (record: { id: number } | null, id?: number) => record !== null && record.id !== id;
  if (conflict(purchaseOrder, allowed.purchaseOrderId)
    || conflict(receipt, allowed.purchaseReceiptId)
    || conflict(saleOrder, allowed.saleOrderId)
    || conflict(saleReturn, allowed.saleReturnId)
    || conflict(inspection, allowed.returnInspectionId)
    || conflict(purchaseReturn, allowed.purchaseReturnId)
    || (posting !== null && posting.id !== allowed.postingId)
    || saleDispatch !== null) throw new IdempotencyConflictError();
}
