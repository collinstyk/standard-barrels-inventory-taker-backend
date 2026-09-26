export type InventoryErrorCode =
  | "INVALID_INVENTORY_QUANTITY"
  | "QUANTITY_OVERFLOW"
  | "INVALID_TIME_ZONE"
  | "INSUFFICIENT_STOCK"
  | "BATCH_CONCURRENCY_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_POSTING_SOURCE"
  | "INVALID_INSPECTION_EVIDENCE"
  | "POSTING_INVARIANT_FAILURE"
  | "RETRY_EXHAUSTED";

export class InventoryDomainError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    message: string,
    public readonly metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "InventoryDomainError";
  }
}

export class InvalidInventoryQuantityError extends InventoryDomainError {
  constructor(field: string) {
    super("INVALID_INVENTORY_QUANTITY", `${field} must be a positive safe integer.`, { field });
  }
}

export class QuantityOverflowError extends InventoryDomainError {
  constructor() {
    super("QUANTITY_OVERFLOW", "The inventory quantity exceeds the supported database range.");
  }
}

export class InvalidTimeZoneError extends InventoryDomainError {
  constructor(timeZone: string) {
    super("INVALID_TIME_ZONE", "BUSINESS_TIME_ZONE must be a valid IANA time zone.", { timeZone });
  }
}

export class InsufficientStockError extends InventoryDomainError {
  constructor(requested: number, available: number) {
    super("INSUFFICIENT_STOCK", "Insufficient eligible inventory in the selected warehouse.", {
      requested,
      available,
    });
  }
}

export class BatchConcurrencyConflictError extends InventoryDomainError {
  constructor(batchId: string) {
    super("BATCH_CONCURRENCY_CONFLICT", "Inventory changed concurrently; retry the command.", { batchId });
  }
}

export class IdempotencyConflictError extends InventoryDomainError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "The idempotency key is already associated with another command.");
  }
}

export class InvalidPostingSourceError extends InventoryDomainError {
  constructor(kind: string) {
    super("INVALID_POSTING_SOURCE", "The posting source does not match the posting kind.", { kind });
  }
}

export class PostingInvariantError extends InventoryDomainError {
  constructor(message = "The inventory posting does not satisfy movement invariants.") {
    super("POSTING_INVARIANT_FAILURE", message);
  }
}

export class InvalidInspectionEvidenceError extends InventoryDomainError {
  constructor(message: string) {
    super("INVALID_INSPECTION_EVIDENCE", message);
  }
}

export class RetryExhaustedError extends InventoryDomainError {
  public readonly originalError: unknown;

  constructor(attempts: number, originalError?: unknown) {
    super("RETRY_EXHAUSTED", "The inventory transaction could not complete after bounded retries.", { attempts });
    this.originalError = originalError;
  }
}
