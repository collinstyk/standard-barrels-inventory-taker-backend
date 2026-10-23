import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { getBusinessDate } from "./businessDate";
import { IdempotencyConflictError, PostingInvariantError } from "./errors";
import { assertGlobalV2CommandKeyAvailable, commandFingerprint, lockIdempotencyKey } from "./idempotency";
import { withBoundedTransactionRetry } from "./retry";
import { convertToBaseUnits, POSTGRES_INTEGER_MAX, validateIdempotencyKey } from "./validation";

export type OpeningStockInput = {
  notes?: string;
  lines: Array<{
    productId: string;
    unitId: number;
    warehouseId: number;
    quantityInUnit: number;
    expiryDate?: string | null;
  }>;
};

type OpeningLine = {
  product: { id: string; name: string; baseUnit: string };
  unit: { id: number; name: string; multiplier: number };
  warehouse: { id: number; name: string };
  quantityInUnit: number;
  quantityBase: number;
  expiryDate: string | null;
  resultingProductSellableCache: number;
  batchId: string;
};

type OpeningAudit = {
  command: "OPENING_STOCK";
  notes: string | null;
  lines: OpeningLine[];
};

function parseAudit(value: string | null): OpeningAudit {
  try {
    const audit = JSON.parse(value ?? "") as OpeningAudit;
    if (audit.command !== "OPENING_STOCK" || !Array.isArray(audit.lines) || !audit.lines.length)
      throw new Error();
    return audit;
  } catch {
    throw new PostingInvariantError("Persisted opening stock audit data is invalid.");
  }
}

async function resultFromPosting(tx: Prisma.TransactionClient, postingId: string, replayed: boolean) {
  const posting = await tx.inventoryPosting.findUnique({
    where: { id: postingId },
    select: {
      id: true,
      kind: true,
      status: true,
      postedAt: true,
      notes: true,
      performedBy: { select: { id: true, name: true, role: true } },
      movements: {
        orderBy: { sequence: "asc" },
        select: { id: true, type: true, batchId: true, productId: true, warehouseId: true, quantityChangeBase: true },
      },
    },
  });
  if (!posting || posting.kind !== "OPENING_STOCK")
    throw new PostingInvariantError("Opening stock posting was not found.");
  const audit = parseAudit(posting.notes);
  if (posting.movements.length !== audit.lines.length)
    throw new PostingInvariantError("Persisted opening stock movements are invalid.");
  const lines = audit.lines.map((line, index) => {
    const movement = posting.movements[index];
    if (!movement || movement.type !== "OPENING_STOCK" || movement.batchId !== line.batchId
      || movement.productId !== line.product.id || movement.warehouseId !== line.warehouse.id
      || movement.quantityChangeBase !== line.quantityBase)
      throw new PostingInvariantError("Persisted opening stock movement does not match its audit data.");
    return { ...line, movementId: movement.id };
  });
  return {
    postingId: posting.id,
    postingStatus: posting.status,
    postedAt: posting.postedAt,
    actor: posting.performedBy,
    replayed,
    notes: audit.notes,
    lines,
  };
}

export async function recordOpeningStock(
  client: PrismaClient,
  input: OpeningStockInput,
  actorId: string,
  requestKey: string,
) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const normalized = {
    notes: input.notes?.trim() ?? null,
    lines: input.lines.map((line) => ({ ...line, expiryDate: line.expiryDate ?? null })),
  };
  const fingerprint = commandFingerprint({ command: "OPENING_STOCK", actorId, ...normalized });
  const recordedAt = new Date();
  const businessDate = getBusinessDate(recordedAt);

  return withBoundedTransactionRetry(() => client.$transaction(async (tx) => {
    await lockIdempotencyKey(tx, idempotencyKey);
    const existing = await tx.inventoryPosting.findUnique({
      where: { idempotencyKey },
      select: { id: true, kind: true, requestFingerprint: true },
    });
    if (existing) {
      if (existing.kind !== "OPENING_STOCK" || existing.requestFingerprint !== fingerprint)
        throw new IdempotencyConflictError();
      return resultFromPosting(tx, existing.id, true);
    }
    await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);

    // Product locks serialize opening counts and cache updates across warehouses.
    const productIds = [...new Set(normalized.lines.map((line) => line.productId))].sort();
    for (const productId of productIds)
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`);
    const unitIds = [...new Set(normalized.lines.map((line) => line.unitId))].sort((a, b) => a - b);
    for (const unitId of unitIds)
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductUnit" WHERE "id" = ${unitId} FOR SHARE`);

    const products = new Map<string, { id: string; name: string; baseUnit: string; quantityInStock: number }>();
    const totalByProduct = new Map<string, number>();
    for (const productId of productIds) {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, baseUnit: true, quantityInStock: true },
      });
      if (!product) throw new PostingInvariantError("Product not found.");
      const balance = await tx.inventoryBatch.aggregate({
        where: { productId, disposition: "SELLABLE" },
        _sum: { quantityOnHandBase: true },
      });
      if ((balance._sum.quantityOnHandBase ?? 0) !== product.quantityInStock)
        throw new PostingInvariantError("Product stock does not reconcile with its existing sellable batches.");
      products.set(productId, product);
      totalByProduct.set(productId, 0);
    }

    const units = new Map<number, { id: number; name: string; productId: string; multiplier: number }>();
    const warehouses = new Map<number, { id: number; name: string }>();
    const quantityByLine: number[] = [];
    const pairs = new Set<string>();
    for (const line of normalized.lines) {
      let unit = units.get(line.unitId);
      if (!unit) {
        const found = await tx.productUnit.findUnique({
          where: { id: line.unitId },
          select: { id: true, name: true, productId: true, multiplier: true },
        });
        if (!found) throw new PostingInvariantError("Product unit not found.");
        unit = found;
        units.set(unit.id, unit);
      }
      if (unit.productId !== line.productId)
        throw new PostingInvariantError("Product unit does not belong to the selected product.");
      if (!warehouses.has(line.warehouseId)) {
        const warehouse = await tx.warehouse.findUnique({
          where: { id: line.warehouseId }, select: { id: true, name: true },
        });
        if (!warehouse) throw new PostingInvariantError("Warehouse not found.");
        warehouses.set(warehouse.id, warehouse);
      }
      if (line.expiryDate !== null && line.expiryDate < businessDate)
        throw new PostingInvariantError("Expired goods cannot be entered as sellable opening stock.");
      const quantityBase = convertToBaseUnits(line.quantityInUnit, unit.multiplier);
      quantityByLine.push(quantityBase);
      const subtotal = (totalByProduct.get(line.productId) ?? 0) + quantityBase;
      if (!Number.isSafeInteger(subtotal) || subtotal > POSTGRES_INTEGER_MAX)
        throw new PostingInvariantError("Opening stock quantity exceeds the supported database range.");
      totalByProduct.set(line.productId, subtotal);
      pairs.add(`${line.productId}:${line.warehouseId}`);
    }

    for (const pair of pairs) {
      const separator = pair.lastIndexOf(":");
      const productId = pair.slice(0, separator);
      const warehouseId = Number(pair.slice(separator + 1));
      const [batch, legacy] = await Promise.all([
        tx.inventoryBatch.findFirst({ where: { productId, warehouseId }, select: { id: true } }),
        tx.stockLevel.findFirst({ where: { productId, warehouseId }, select: { id: true } }),
      ]);
      if (batch || legacy)
        throw new PostingInvariantError("Opening stock already exists for a selected product and warehouse.");
    }
    for (const productId of productIds) {
      const product = products.get(productId)!;
      const resulting = product.quantityInStock + totalByProduct.get(productId)!;
      if (!Number.isSafeInteger(resulting) || resulting > POSTGRES_INTEGER_MAX)
        throw new PostingInvariantError("Product stock would exceed the supported database range.");
      const changed = await tx.product.updateMany({
        where: { id: productId, quantityInStock: product.quantityInStock },
        data: { quantityInStock: resulting },
      });
      if (changed.count !== 1)
        throw new PostingInvariantError("Product stock changed concurrently.");
    }

    const lines: OpeningLine[] = [];
    for (const [index, line] of normalized.lines.entries()) {
      const product = products.get(line.productId)!;
      const unit = units.get(line.unitId)!;
      const warehouse = warehouses.get(line.warehouseId)!;
      const batch = await tx.inventoryBatch.create({
        data: {
          productId: product.id,
          warehouseId: warehouse.id,
          quantityOnHandBase: quantityByLine[index]!,
          disposition: "SELLABLE",
          expiryDate: line.expiryDate ? new Date(`${line.expiryDate}T00:00:00.000Z`) : null,
          receivedAt: recordedAt,
        },
        select: { id: true },
      });
      lines.push({
        product: { id: product.id, name: product.name, baseUnit: product.baseUnit },
        unit: { id: unit.id, name: unit.name, multiplier: unit.multiplier },
        warehouse,
        quantityInUnit: line.quantityInUnit,
        quantityBase: quantityByLine[index]!,
        expiryDate: line.expiryDate,
        resultingProductSellableCache: product.quantityInStock + totalByProduct.get(product.id)!,
        batchId: batch.id,
      });
    }
    const posting = await tx.inventoryPosting.create({
      data: {
        idempotencyKey,
        requestFingerprint: fingerprint,
        kind: "OPENING_STOCK",
        performedById: actorId,
        notes: JSON.stringify({ command: "OPENING_STOCK", notes: normalized.notes, lines } satisfies OpeningAudit),
      },
      select: { id: true },
    });
    for (const [index, line] of lines.entries()) {
      await tx.stockMovement.create({
        data: {
          postingId: posting.id,
          sequence: index + 1,
          type: "OPENING_STOCK",
          productId: line.product.id,
          batchId: line.batchId,
          warehouseId: line.warehouse.id,
          quantityChangeBase: line.quantityBase,
          performedById: actorId,
          adjustmentReason: "OPENING_STOCK",
          notes: normalized.notes ?? undefined,
        },
      });
    }
    return resultFromPosting(tx, posting.id, false);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
