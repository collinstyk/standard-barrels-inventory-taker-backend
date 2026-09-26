import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { IdempotencyConflictError, PostingInvariantError } from "./errors";
import { assertGlobalV2CommandKeyAvailable, commandFingerprint, lockIdempotencyKey } from "./idempotency";
import { reverseSaleIssueInTransaction } from "./reversal";
import { withBoundedTransactionRetry } from "./retry";
import { validateIdempotencyKey } from "./validation";

export interface CancelIssuedSaleInput {
  reason: string;
  custodyConfirmation: "GOODS_REMAIN_IN_BUSINESS_CUSTODY";
}

export async function cancelIssuedPendingSale(client: PrismaClient, saleId: number, input: CancelIssuedSaleInput, userId: string, requestKey: string) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ command: "CANCEL_ISSUED_PENDING_SALE", saleId, userId, input });
  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const keyedPosting = await tx.inventoryPosting.findUnique({ where: { idempotencyKey }, select: { id: true, kind: true, reversalOfId: true, requestFingerprint: true } });
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey, { postingId: keyedPosting?.id });
    if (keyedPosting && (keyedPosting.kind !== "REVERSAL" || keyedPosting.requestFingerprint !== requestFingerprint)) throw new IdempotencyConflictError();

    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SaleOrder" WHERE "id" = ${saleId} FOR UPDATE`);
    const sale = await tx.saleOrder.findUnique({ where: { id: saleId }, include: { items: true, inventoryPosting: { include: { reversedBy: true } } } });
    if (!sale) throw new PostingInvariantError("Sale order not found.");
    const issue = sale.inventoryPosting;
    if (sale.transactionStatus === "CANCELLED") {
      if (!issue?.reversedBy || issue.reversedBy.id !== keyedPosting?.id || issue.reversedBy.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();
      const reversal = await reverseSaleIssueInTransaction(tx, { sourcePostingId: issue.id, saleOrderId: sale.id, idempotencyKey, requestFingerprint, performedById: userId, reason: input.reason });
      return { replayed: true, sale: { id: sale.id, transactionStatus: sale.transactionStatus }, reversal: reversal.result };
    }
    if (sale.transactionStatus !== "PENDING") throw new PostingInvariantError("Only a pending issued sale can be cancelled by this workflow.");
    if (sale.items.some((item) => item.quantityDelivered !== 0)) throw new PostingInvariantError("A delivered or partly delivered sale cannot be cancelled by this workflow.");
    if (!issue || issue.kind !== "SALE_ISSUE" || issue.status !== "POSTED") throw new PostingInvariantError("The sale does not have an active posted sale issue.");
    const activeReturn = await tx.saleReturn.findFirst({ where: { originalSaleId: sale.id, status: { not: "CANCELLED" } }, select: { id: true } });
    if (activeReturn) throw new PostingInvariantError("Cancel the active customer return before cancelling this sale.");
    if (keyedPosting && keyedPosting.reversalOfId !== issue.id) throw new IdempotencyConflictError();

    const reversal = await reverseSaleIssueInTransaction(tx, { sourcePostingId: issue.id, saleOrderId: sale.id, idempotencyKey, requestFingerprint, performedById: userId, reason: input.reason });
    const cancelled = await tx.saleOrder.update({ where: { id: sale.id }, data: { transactionStatus: "CANCELLED" }, select: { id: true, transactionStatus: true } });
    return { replayed: reversal.replayed, sale: cancelled, reversal: reversal.result };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
