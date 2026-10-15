import { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { InventoryPosting } from "../../generated/prisma/client";
import { IdempotencyConflictError, PostingInvariantError } from "./errors";
import type {
  InventoryTransaction,
  PostingCommand,
  PostingExecutionResult,
  PostingSource,
  PostingWorkResult,
} from "./types";
import { withBoundedTransactionRetry } from "./retry";
import {
  postingSourceMatches,
  validateIdempotencyKey,
  validateMovements,
  validatePostingSource,
} from "./validation";

type ExistingPosting = InventoryPosting;

function assertIdempotentMatch(
  command: PostingCommand,
  posting: ExistingPosting,
): void {
  const existingSource: PostingSource & { kind: ExistingPosting["kind"] } = {
    kind: posting.kind,
    purchaseReceiptId: posting.purchaseReceiptId ?? undefined,
    saleOrderId: posting.saleOrderId ?? undefined,
    saleDispatchId: posting.saleDispatchId ?? undefined,
    purchaseReturnId: posting.purchaseReturnId ?? undefined,
    saleReturnId: posting.saleReturnId ?? undefined,
    returnInspectionId: posting.returnInspectionId ?? undefined,
    reversalOfId: posting.reversalOfId ?? undefined,
  };
  if (!postingSourceMatches(command.kind, command.source, existingSource)) {
    throw new IdempotencyConflictError();
  }
  if (
    command.requestFingerprint !== undefined &&
    posting.requestFingerprint !== command.requestFingerprint
  ) {
    throw new IdempotencyConflictError();
  }
}

function isIdempotencyUniqueError(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  )
    return false;
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.includes("idempotencyKey")
    : typeof target === "string" && target.includes("idempotencyKey");
}

export async function executeInventoryPosting<T>(
  client: PrismaClient,
  command: PostingCommand,
  work: (
    tx: InventoryTransaction,
    postingId: string,
  ) => Promise<PostingWorkResult<T>>,
  replay: (tx: InventoryTransaction, postingId: string) => Promise<T>,
): Promise<PostingExecutionResult<T>> {
  const idempotencyKey = validateIdempotencyKey(command.idempotencyKey);
  validatePostingSource(command.kind, command.source);

  try {
    return await withBoundedTransactionRetry(() =>
      client.$transaction(
        (tx) =>
          executeInventoryPostingInTransaction(
            tx,
            { ...command, idempotencyKey },
            work,
            replay,
          ),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (!isIdempotencyUniqueError(error)) throw error;
    const existing = await client.inventoryPosting.findUnique({
      where: { idempotencyKey },
    });
    if (!existing) throw error;
    assertIdempotentMatch(command, existing);
    const result = await client.$transaction((tx) => replay(tx, existing.id), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    return { postingId: existing.id, replayed: true, result };
  }
}

export async function executeInventoryPostingInTransaction<T>(
  tx: InventoryTransaction,
  command: PostingCommand,
  work: (
    tx: InventoryTransaction,
    postingId: string,
  ) => Promise<PostingWorkResult<T>>,
  replay: (tx: InventoryTransaction, postingId: string) => Promise<T>,
): Promise<PostingExecutionResult<T>> {
  const idempotencyKey = validateIdempotencyKey(command.idempotencyKey);
  validatePostingSource(command.kind, command.source);
  const existing = await tx.inventoryPosting.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    assertIdempotentMatch(command, existing);
    return {
      postingId: existing.id,
      replayed: true,
      result: await replay(tx, existing.id),
    };
  }

  if (command.source.purchaseReceiptId !== undefined) {
    const existingReceiptPosting = await tx.inventoryPosting.findUnique({
      where: {
        purchaseReceiptId: command.source.purchaseReceiptId,
      },
      select: { id: true },
    });

    if (existingReceiptPosting) {
      throw new PostingInvariantError(
        "This purchase receipt has already been posted.",
      );
    }
  }

  const posting = await tx.inventoryPosting.create({
    data: {
      idempotencyKey,
      kind: command.kind,
      performedById: command.performedById,
      notes: command.notes,
      requestFingerprint: command.requestFingerprint,
      ...command.source,
    },
  });
  const completed = await work(tx, posting.id);
  validateMovements(completed.movements);
  for (const movement of completed.movements) {
    await tx.stockMovement.create({
      data: { postingId: posting.id, ...movement },
    });
  }
  return { postingId: posting.id, replayed: false, result: completed.result };
}
