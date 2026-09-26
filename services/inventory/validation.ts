import type { PostingKind } from "../../generated/prisma/enums";
import {
  IdempotencyConflictError,
  InvalidInventoryQuantityError,
  InvalidPostingSourceError,
  PostingInvariantError,
  QuantityOverflowError,
} from "./errors";
import type { MovementInput, PostingSource } from "./types";

export const POSTGRES_INTEGER_MAX = 2_147_483_647;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export function requirePositiveBaseQuantity(value: unknown, field = "quantity"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidInventoryQuantityError(field);
  }
  if (value > POSTGRES_INTEGER_MAX) throw new QuantityOverflowError();
  return value;
}

export function convertToBaseUnits(quantity: unknown, multiplier: unknown): number {
  const safeQuantity = requirePositiveBaseQuantity(quantity, "quantity");
  const safeMultiplier = requirePositiveBaseQuantity(multiplier, "multiplier");
  const product = safeQuantity * safeMultiplier;
  if (!Number.isSafeInteger(product) || product > POSTGRES_INTEGER_MAX) {
    throw new QuantityOverflowError();
  }
  return product;
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new IdempotencyConflictError();
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new IdempotencyConflictError();
  }
  return trimmed;
}

const sourceKeyByKind: Partial<Record<PostingKind, keyof PostingSource>> = {
  SALE_ISSUE: "saleOrderId",
  PURCHASE_RECEIPT: "purchaseReceiptId",
  CUSTOMER_RETURN: "saleReturnId",
  SUPPLIER_RETURN: "purchaseReturnId",
  RETURN_INSPECTION_RECLASSIFICATION: "returnInspectionId",
  REVERSAL: "reversalOfId",
};

export function validatePostingSource(kind: PostingKind, source: PostingSource): void {
  const populated = Object.entries(source).filter(([, value]) => value !== undefined && value !== null);
  const requiredKey = sourceKeyByKind[kind];
  if (requiredKey) {
    if (populated.length !== 1 || populated[0]?.[0] !== requiredKey) throw new InvalidPostingSourceError(kind);
    const value = source[requiredKey];
    const validValue = requiredKey === "reversalOfId"
      ? typeof value === "string" && value.length > 0
      : typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= POSTGRES_INTEGER_MAX;
    if (!validValue) throw new InvalidPostingSourceError(kind);
    return;
  }
  if (populated.length !== 0) throw new InvalidPostingSourceError(kind);
}

export function postingSourceMatches(
  kind: PostingKind,
  source: PostingSource,
  existing: PostingSource & { kind: PostingKind },
): boolean {
  if (existing.kind !== kind) return false;
  return (["purchaseReceiptId", "saleOrderId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId"] as const)
    .every((key) => (source[key] ?? null) === (existing[key] ?? null));
}

export function validateMovements(movements: readonly MovementInput[]): void {
  if (movements.length === 0) throw new PostingInvariantError("A stock-changing posting requires movements.");
  const sequences = new Set<number>();
  for (const movement of movements) {
    requirePositiveBaseQuantity(Math.abs(movement.quantityChangeBase), "movement quantity");
    if (!Number.isSafeInteger(movement.sequence) || movement.sequence < 1 || sequences.has(movement.sequence)) {
      throw new PostingInvariantError("Movement sequences must be unique positive integers.");
    }
    sequences.add(movement.sequence);
  }
}
