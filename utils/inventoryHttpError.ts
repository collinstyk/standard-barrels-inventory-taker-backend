import { InventoryDomainError } from "../services/inventory";
import AppError from "./appError";

export function inventoryHttpError(error: unknown): AppError {
  if (!(error instanceof InventoryDomainError)) return new AppError("Inventory operation failed.", 500);
  if (error.code === "INSUFFICIENT_STOCK" || error.code === "IDEMPOTENCY_CONFLICT" || error.code === "POSTING_INVARIANT_FAILURE") {
    const notFound = /not found/u.test(error.message.toLowerCase());
    return new AppError(error.message, notFound ? 404 : 409);
  }
  if (error.code === "BATCH_CONCURRENCY_CONFLICT" || error.code === "RETRY_EXHAUSTED") return new AppError(error.message, 503);
  return new AppError(error.message, 400);
}
