import { Prisma } from "../../generated/prisma/client";
import { RetryExhaustedError } from "./errors";

export const DEFAULT_TRANSACTION_ATTEMPTS = 3;
const TRANSIENT_POSTGRES_CODES = new Set(["40001", "40P01"]);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isRetryableInventoryTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; meta?: Record<string, unknown> };
  const databaseCode = stringValue(candidate.meta?.database_error_code) ?? stringValue(candidate.meta?.code);
  const message = stringValue(candidate.message) ?? "";
  return TRANSIENT_POSTGRES_CODES.has(stringValue(candidate.code) ?? "")
    || TRANSIENT_POSTGRES_CODES.has(databaseCode ?? "")
    || [...TRANSIENT_POSTGRES_CODES].some((code) => message.includes(`Code: \`${code}\``) || message.includes(`code ${code}`));
}

export async function withBoundedTransactionRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_TRANSACTION_ATTEMPTS;
  const delayMs = Math.min(Math.max(options.delayMs ?? 10, 0), 50);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableInventoryTransactionError(error)) throw error;
      if (attempt < maxAttempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw new RetryExhaustedError(maxAttempts, lastError);
}
