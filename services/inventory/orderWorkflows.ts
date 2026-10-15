import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { IdempotencyConflictError, PostingInvariantError } from "./errors";
import { executeInventoryPostingInTransaction } from "./posting";
import type { InventoryTransaction, MovementInput } from "./types";
import {
  convertToBaseUnits,
  POSTGRES_INTEGER_MAX,
  validateIdempotencyKey,
} from "./validation";
import { withBoundedTransactionRetry } from "./retry";
import {
  assertGlobalV2CommandKeyAvailable,
  commandFingerprint,
  lockIdempotencyKey,
} from "./idempotency";

type MoneyInput = string | number;

export interface V2PurchaseInput {
  supplierId?: string | null;
  transactionStatus: "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED";
  amountPaid: MoneyInput;
  extraCost: MoneyInput;
  items: Array<{
    productId: string;
    unitId: number;
    quantityOrdered: number;
    agreedUnitCost?: MoneyInput;
  }>;
}

export interface V2PurchaseUpdateInput {
  transactionStatus?: V2PurchaseInput["transactionStatus"];
  amountPaid?: MoneyInput;
  extraCost?: MoneyInput;
}

export interface ReceiptCreateInput {
  receivedAt: string;
  notes?: string;
  items: Array<{
    purchaseItemId: number;
    warehouseId: number;
    quantityInOrderUnit: number;
    actualUnitCost: MoneyInput;
    expiryDate?: string | null;
  }>;
}

export interface V2SaleInput {
  buyerId?: string | null;
  transactionStatus: "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED";
  amountPaid: MoneyInput;
  extraCost: MoneyInput;
  items: Array<{
    productId: string;
    unitId: number;
    quantityOrdered: number;
    quantityDelivered: number;
    fulfillments: Array<{ warehouseId: number; quantityInOrderUnit: number }>;
    confirmedUnitSalePrice: MoneyInput;
  }>;
}

function paymentStatus(amountPaid: Decimal, total: Decimal) {
  if (amountPaid.isZero()) return "NOT_PAID" as const;
  return amountPaid.greaterThanOrEqualTo(total)
    ? ("FULLY_PAID" as const)
    : ("PARTLY_PAID" as const);
}

function deliveryStatus(
  items: Array<
    Pick<V2SaleInput["items"][number], "quantityOrdered" | "quantityDelivered">
  >,
) {
  const ordered = items.reduce((sum, item) => sum + item.quantityOrdered, 0);
  const delivered = items.reduce(
    (sum, item) => sum + item.quantityDelivered,
    0,
  );
  if (delivered === 0) return "NOT_DELIVERED" as const;
  return delivered >= ordered
    ? ("FULLY_DELIVERED" as const)
    : ("PARTLY_DELIVERED" as const);
}

function activeSaleTransactionStatus(
  payment: ReturnType<typeof paymentStatus>,
  delivery: ReturnType<typeof deliveryStatus>,
) {
  return payment === "FULLY_PAID" && delivery === "FULLY_DELIVERED"
    ? ("COMPLETED" as const)
    : ("PENDING" as const);
}

function assertSaleCompletionRequest(
  requested: V2SaleInput["transactionStatus"] | undefined,
  calculated: "PENDING" | "COMPLETED",
) {
  if (requested === "COMPLETED" && calculated !== "COMPLETED")
    throw new PostingInvariantError(
      "A sale cannot be completed until payment and delivery are both complete.",
    );
}

export async function createV2PurchaseOrder(
  client: PrismaClient,
  input: V2PurchaseInput,
  userId: string,
  requestKey: string,
) {
  if (input.transactionStatus === "CANCELLED")
    throw new PostingInvariantError(
      "A purchase order cannot be created as cancelled.",
    );
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ userId, input });
  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await lockIdempotencyKey(tx, idempotencyKey);
        const existing = await tx.purchaseOrder.findUnique({
          where: { requestIdempotencyKey: idempotencyKey },
          include: { items: true },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new IdempotencyConflictError();
          return { replayed: true, purchase: existing };
        }
        await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
        if (
          input.supplierId &&
          !(await tx.contact.findUnique({ where: { id: input.supplierId } }))
        ) {
          throw new PostingInvariantError("Supplier not found.");
        }
        const units = await tx.productUnit.findMany({
          where: { id: { in: input.items.map((item) => item.unitId) } },
        });
        const byId = new Map(units.map((unit) => [unit.id, unit]));
        let total = new Decimal(0);
        const resolved = input.items.map((item) => {
          const unit = byId.get(item.unitId);
          if (!unit || unit.productId !== item.productId)
            throw new PostingInvariantError(
              "Purchase unit does not belong to the selected product.",
            );
          const cost = new Decimal(item.agreedUnitCost ?? unit.price);
          const lineTotal = cost.times(item.quantityOrdered);
          total = total.plus(lineTotal);
          return { item, unit, cost, lineTotal };
        });
        const extra = new Decimal(input.extraCost);
        const paid = new Decimal(input.amountPaid);
        const purchase = await tx.purchaseOrder.create({
          data: {
            requestIdempotencyKey: idempotencyKey,
            requestFingerprint,
            supplierId: input.supplierId,
            receiverId: userId,
            transactionStatus: input.transactionStatus,
            paymentStatus: paymentStatus(paid, total.plus(extra)),
            receivingStatus: "NOT_RECEIVED",
            amountPaid: paid,
            extraCost: extra,
            totalPurchaseCost: total,
            items: {
              create: resolved.map(({ item, unit, cost, lineTotal }) => ({
                productId: item.productId,
                quantityOrdered: item.quantityOrdered,
                quantityReceived: 0,
                unitId: item.unitId,
                unitPrice: cost,
                totalPrice: lineTotal,
                unitMultiplierSnapshot: unit.multiplier,
                agreedUnitCost: cost,
              })),
            },
          },
          include: { items: true },
        });
        return { replayed: false, purchase };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function updateV2PurchaseOrder(
  client: PrismaClient,
  purchaseId: number,
  input: V2PurchaseUpdateInput,
) {
  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseId} FOR UPDATE`,
        );
        const purchase = await tx.purchaseOrder.findUnique({
          where: { id: purchaseId },
        });
        if (!purchase)
          throw new PostingInvariantError("Purchase order not found.");
        const target = input.transactionStatus ?? purchase.transactionStatus;
        if (
          purchase.transactionStatus === "CANCELLED" &&
          (target !== "CANCELLED" ||
            input.amountPaid !== undefined ||
            input.extraCost !== undefined)
        )
          throw new PostingInvariantError(
            "A cancelled purchase order is terminal and cannot be reactivated or edited.",
          );
        if (
          target === "CANCELLED" &&
          purchase.transactionStatus !== "CANCELLED"
        ) {
          if (
            purchase.transactionStatus !== "DRAFT" &&
            purchase.transactionStatus !== "PENDING"
          )
            throw new PostingInvariantError(
              "Only an unreceived draft or pending purchase order may be cancelled.",
            );
          const postedReceipt = await tx.purchaseReceipt.findFirst({
            where: {
              purchaseOrderId: purchaseId,
              OR: [{ status: "POSTED" }, { posting: { isNot: null } }],
            },
            select: { id: true },
          });
          if (postedReceipt)
            throw new PostingInvariantError(
              "Received inventory must be reversed or returned before the purchase order can be cancelled.",
            );
        }
        const amountPaid =
          input.amountPaid === undefined
            ? purchase.amountPaid
            : new Decimal(input.amountPaid);
        const extraCost =
          input.extraCost === undefined
            ? purchase.extraCost
            : new Decimal(input.extraCost);
        return tx.purchaseOrder.update({
          where: { id: purchaseId },
          data: {
            transactionStatus: target,
            amountPaid,
            extraCost,
            paymentStatus: paymentStatus(
              amountPaid,
              purchase.totalPurchaseCost.plus(extraCost),
            ),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function createDraftReceipt(
  client: PrismaClient,
  purchaseId: number,
  input: ReceiptCreateInput,
  userId: string,
  requestKey: string,
) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ purchaseId, userId, input });
  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await lockIdempotencyKey(tx, idempotencyKey);
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseId} FOR UPDATE`,
        );
        const existing = await tx.purchaseReceipt.findUnique({
          where: { idempotencyKey },
          include: { items: true },
        });
        if (existing) {
          if (
            existing.purchaseOrderId !== purchaseId ||
            existing.requestFingerprint !== requestFingerprint
          )
            throw new IdempotencyConflictError();
          return { replayed: true, receipt: existing };
        }
        await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
        const purchase = await tx.purchaseOrder.findUnique({
          where: { id: purchaseId },
          include: { items: true },
        });
        if (!purchase)
          throw new PostingInvariantError("Purchase order not found.");
        if (purchase.transactionStatus === "CANCELLED")
          throw new PostingInvariantError(
            "A receipt cannot be created for a cancelled purchase order.",
          );
        const itemById = new Map(purchase.items.map((item) => [item.id, item]));
        const warehouseCount = await tx.warehouse.count({
          where: { id: { in: input.items.map((item) => item.warehouseId) } },
        });
        if (
          warehouseCount !==
          new Set(input.items.map((item) => item.warehouseId)).size
        )
          throw new PostingInvariantError("Warehouse not found.");
        const receipt = await tx.purchaseReceipt.create({
          data: {
            purchaseOrderId: purchaseId,
            idempotencyKey,
            requestFingerprint,
            status: "DRAFT",
            receivedById: userId,
            receivedAt: new Date(input.receivedAt),
            notes: input.notes,
            items: {
              create: input.items.map((line) => {
                const item = itemById.get(line.purchaseItemId);
                if (!item || item.unitMultiplierSnapshot === null)
                  throw new PostingInvariantError(
                    "Purchase item multiplier snapshot is missing.",
                  );
                return {
                  purchaseItemId: item.id,
                  warehouseId: line.warehouseId,
                  quantityInOrderUnit: line.quantityInOrderUnit,
                  unitMultiplier: item.unitMultiplierSnapshot,
                  quantityBase: convertToBaseUnits(
                    line.quantityInOrderUnit,
                    item.unitMultiplierSnapshot,
                  ),
                  actualUnitCost: new Decimal(line.actualUnitCost),
                  expiryDate: line.expiryDate
                    ? new Date(`${line.expiryDate}T00:00:00.000Z`)
                    : null,
                };
              }),
            },
          },
          include: { items: true },
        });
        return { replayed: false, receipt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function reconstructReceipt(
  tx: InventoryTransaction,
  postingId: string,
  receiptId: number,
) {
  await tx.purchaseReceipt.findUniqueOrThrow({ where: { id: receiptId } });
  const movements = await tx.stockMovement.findMany({ where: { postingId } });
  return {
    receiptId,
    totalReceivedBase: movements.reduce(
      (sum, movement) => sum + movement.quantityChangeBase,
      0,
    ),
    movementCount: movements.length,
  };
}

export async function postPurchaseReceipt(
  client: PrismaClient,
  purchaseId: number,
  receiptId: number,
  userId: string,
  requestKey: string,
) {
  const idempotencyKey = validateIdempotencyKey(requestKey);
  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await lockIdempotencyKey(tx, idempotencyKey);
        const existingPostingForKey = await tx.inventoryPosting.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        });
        await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey, {
          postingId: existingPostingForKey?.id,
        });
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseId} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "PurchaseReceipt" WHERE "id" = ${receiptId} FOR UPDATE`,
        );
        const receipt = await tx.purchaseReceipt.findUnique({
          where: { id: receiptId },
          include: { items: { include: { purchaseItem: true } } },
        });
        if (!receipt || receipt.purchaseOrderId !== purchaseId)
          throw new PostingInvariantError("Purchase receipt not found.");
        const purchase = await tx.purchaseOrder.findUnique({
          where: { id: purchaseId },
        });
        if (!purchase)
          throw new PostingInvariantError("Purchase order not found.");
        if (purchase.transactionStatus === "CANCELLED")
          throw new PostingInvariantError(
            "A receipt cannot be posted after its purchase order is cancelled.",
          );
        return executeInventoryPostingInTransaction(
          tx,
          {
            kind: "PURCHASE_RECEIPT",
            idempotencyKey,
            performedById: userId,
            source: { purchaseReceiptId: receiptId },
            notes: receipt.notes ?? undefined,
          },
          async () => {
            if (receipt.status !== "DRAFT")
              throw new PostingInvariantError(
                "Only a draft receipt may be posted.",
              );
            const itemIds = receipt.items.map((item) => item.purchaseItemId);
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "PurchaseItem" WHERE "id" IN (${Prisma.join(itemIds)}) ORDER BY "id" FOR UPDATE`,
            );
            const previous = await tx.purchaseReceiptItem.groupBy({
              by: ["purchaseItemId"],
              where: {
                purchaseItemId: { in: itemIds },
                receipt: { status: "POSTED", id: { not: receiptId } },
              },
              _sum: { quantityInOrderUnit: true },
            });
            const previousByItem = new Map(
              previous.map((row) => [
                row.purchaseItemId,
                row._sum.quantityInOrderUnit ?? 0,
              ]),
            );
            const currentByItem = new Map<number, number>();
            for (const line of receipt.items) {
              const aggregate =
                (currentByItem.get(line.purchaseItemId) ?? 0) +
                line.quantityInOrderUnit;
              if (
                !Number.isSafeInteger(aggregate) ||
                aggregate > POSTGRES_INTEGER_MAX
              )
                throw new PostingInvariantError(
                  "Current receipt quantity exceeds the database range.",
                );
              currentByItem.set(line.purchaseItemId, aggregate);
            }
            for (const [purchaseItemId, currentQuantity] of currentByItem) {
              const purchaseItem = receipt.items.find(
                (line) => line.purchaseItemId === purchaseItemId,
              )!.purchaseItem;
              if (
                (previousByItem.get(purchaseItemId) ?? 0) + currentQuantity >
                purchaseItem.quantityOrdered
              ) {
                throw new PostingInvariantError(
                  "Cumulative receipt quantity exceeds the purchase order.",
                );
              }
            }
            const movements: MovementInput[] = [];
            const productTotals = new Map<string, number>();
            let sequence = 1;
            for (const line of receipt.items) {
              const batch = await tx.inventoryBatch.create({
                data: {
                  id: randomUUID(),
                  productId: line.purchaseItem.productId,
                  warehouseId: line.warehouseId,
                  expiryDate: line.expiryDate,
                  receivedAt: receipt.receivedAt,
                  quantityOnHandBase: line.quantityBase,
                  disposition: "SELLABLE",
                  purchaseReceiptItemId: line.id,
                },
              });
              movements.push({
                sequence: sequence++,
                type: "PURCHASE_RECEIPT",
                productId: batch.productId,
                batchId: batch.id,
                warehouseId: batch.warehouseId,
                quantityChangeBase: line.quantityBase,
                performedById: userId,
              });
              productTotals.set(
                batch.productId,
                (productTotals.get(batch.productId) ?? 0) + line.quantityBase,
              );
            }
            for (const [purchaseItemId, quantityInOrderUnit] of currentByItem)
              await tx.purchaseItem.update({
                where: { id: purchaseItemId },
                data: { quantityReceived: { increment: quantityInOrderUnit } },
              });
            for (const [productId, quantity] of productTotals) {
              await tx.product.update({
                where: { id: productId },
                data: { quantityInStock: { increment: quantity } },
              });
            }
            await tx.purchaseReceipt.update({
              where: { id: receiptId },
              data: { status: "POSTED", postedAt: new Date() },
            });
            const orderItems = await tx.purchaseItem.findMany({
              where: { purchaseId },
            });
            const totalOrdered = orderItems.reduce(
              (sum, item) => sum + item.quantityOrdered,
              0,
            );
            const totalReceived = orderItems.reduce(
              (sum, item) => sum + item.quantityReceived,
              0,
            );
            const receivingStatus =
              totalReceived === 0
                ? "NOT_RECEIVED"
                : totalReceived >= totalOrdered
                  ? "FULLY_RECEIVED"
                  : "PARTLY_RECEIVED";
            await tx.purchaseOrder.update({
              where: { id: purchaseId },
              data: { receivingStatus },
            });
            return {
              result: {
                receiptId,
                totalReceivedBase: movements.reduce(
                  (sum, movement) => sum + movement.quantityChangeBase,
                  0,
                ),
                movementCount: movements.length,
              },
              movements,
            };
          },
          (transaction, postingId) =>
            reconstructReceipt(transaction, postingId, receiptId),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function createV2SaleOrder(
  client: PrismaClient,
  input: V2SaleInput,
  userId: string,
  requestKey: string,
) {
  if (input.transactionStatus === "CANCELLED")
    throw new PostingInvariantError(
      "A sale order cannot be created as cancelled.",
    );
  const idempotencyKey = validateIdempotencyKey(requestKey);
  const requestFingerprint = commandFingerprint({ userId, input });
  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await lockIdempotencyKey(tx, idempotencyKey);
        const existing = await tx.saleOrder.findUnique({
          where: { requestIdempotencyKey: idempotencyKey },
          include: {
            items: { include: { fulfillments: true } },
            inventoryPosting: true,
          },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new IdempotencyConflictError();
          return {
            replayed: true,
            sale: existing,
            posting: existing.inventoryPosting
              ? await reconstructSaleIssueSummary(
                  tx,
                  existing.inventoryPosting.id,
                  existing.id,
                )
              : null,
          };
        }
        await assertGlobalV2CommandKeyAvailable(tx, idempotencyKey);
        if (
          input.buyerId &&
          !(await tx.contact.findUnique({ where: { id: input.buyerId } }))
        )
          throw new PostingInvariantError("Buyer not found.");
        const units = await tx.productUnit.findMany({
          where: { id: { in: input.items.map((item) => item.unitId) } },
        });
        const warehouseIds = input.items.flatMap((item) =>
          item.fulfillments.map((fulfillment) => fulfillment.warehouseId),
        );
        const warehouses = await tx.warehouse.count({
          where: { id: { in: warehouseIds } },
        });
        if (warehouses !== new Set(warehouseIds).size)
          throw new PostingInvariantError("Fulfilment warehouse not found.");
        const byId = new Map(units.map((unit) => [unit.id, unit]));
        let total = new Decimal(0);
        const resolved = input.items.map((item) => {
          const unit = byId.get(item.unitId);
          if (!unit || unit.productId !== item.productId)
            throw new PostingInvariantError(
              "Sale unit does not belong to the selected product.",
            );
          const salePrice = new Decimal(item.confirmedUnitSalePrice);
          const lineTotal = salePrice.times(item.quantityOrdered);
          total = total.plus(lineTotal);
          const fulfillmentTotal = item.fulfillments.reduce(
            (sum, fulfillment) => sum + fulfillment.quantityInOrderUnit,
            0,
          );
          if (
            input.transactionStatus !== "DRAFT" &&
            fulfillmentTotal !== item.quantityOrdered
          )
            throw new PostingInvariantError(
              "Sale-item fulfilment quantities must equal quantity ordered.",
            );
          const fulfillments = item.fulfillments.map((fulfillment) => ({
            warehouseId: fulfillment.warehouseId,
            quantityInOrderUnit: fulfillment.quantityInOrderUnit,
            unitMultiplierSnapshot: unit.multiplier,
            quantityBase: convertToBaseUnits(
              fulfillment.quantityInOrderUnit,
              unit.multiplier,
            ),
          }));
          return { item, unit, salePrice, lineTotal, fulfillments };
        });
        const extra = new Decimal(input.extraCost);
        const paid = new Decimal(input.amountPaid);
        const nextPaymentStatus = paymentStatus(paid, total.plus(extra));
        if (input.items.some((item) => item.quantityDelivered !== 0))
          throw new PostingInvariantError("Delivery quantities are recorded by dispatch, not sale creation.");
        const nextDeliveryStatus = deliveryStatus(input.items);
        const activeStatus = activeSaleTransactionStatus(
          nextPaymentStatus,
          nextDeliveryStatus,
        );
        assertSaleCompletionRequest(input.transactionStatus, activeStatus);
        const sale = await tx.saleOrder.create({
          data: {
            requestIdempotencyKey: idempotencyKey,
            requestFingerprint,
            buyerId: input.buyerId,
            sellerId: userId,
            transactionStatus:
              input.transactionStatus === "DRAFT" ? "DRAFT" : activeStatus,
            paymentStatus: nextPaymentStatus,
            deliveryStatus: nextDeliveryStatus,
            amountPaid: paid,
            extraCost: extra,
            totalSaleAmount: total,
            items: {
              create: resolved.map(
                ({ item, unit, salePrice, lineTotal, fulfillments }) => ({
                  productId: item.productId,
                  quantityOrdered: item.quantityOrdered,
                  quantityDelivered: item.quantityDelivered,
                  unitId: item.unitId,
                  unitPrice: salePrice,
                  totalPrice: lineTotal,
                  sourceWarehouseId:
                    fulfillments.length === 1
                      ? fulfillments[0]!.warehouseId
                      : null,
                  unitMultiplierSnapshot: unit.multiplier,
                  confirmedUnitSalePrice: salePrice,
                  fulfillments: { create: fulfillments },
                }),
              ),
            },
          },
          include: { items: { include: { fulfillments: true } } },
        });
        return { replayed: false, sale, posting: null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function reconstructSaleIssueSummary(
  tx: InventoryTransaction,
  postingId: string,
  saleOrderId: number,
) {
  const movements = await tx.stockMovement.findMany({ where: { postingId } });
  return {
    postingId,
    replayed: true,
    result: {
      totalIssued: -movements.reduce(
        (sum, movement) => sum + movement.quantityChangeBase,
        0,
      ),
      movementCount: movements.length,
    },
    saleOrderId,
  };
}

export async function updateV2SaleOrder(
  client: PrismaClient,
  saleId: number,
  input: Omit<Partial<V2SaleInput>, "items"> & {
    items?: Array<V2SaleInput["items"][number] & { id: number }>;
  },
  userId: string,
  requestKey?: string,
) {
  const activationFingerprint = commandFingerprint({
    command: "ACTIVATE_SALE",
    saleId,
    userId,
    input,
  });

  return withBoundedTransactionRetry(() =>
    client.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "SaleOrder" WHERE "id" = ${saleId} FOR UPDATE`,
        );

        const sale = await tx.saleOrder.findUnique({
          where: { id: saleId },
          include: {
            items: { include: { fulfillments: true } },
            inventoryPosting: true,
          },
        });

        if (!sale) throw new PostingInvariantError("Sale order not found.");

        const target = input.transactionStatus ?? sale.transactionStatus;

        if (sale.transactionStatus === "CANCELLED") {
          if (
            target !== "CANCELLED" ||
            input.items ||
            input.amountPaid !== undefined ||
            input.extraCost !== undefined ||
            requestKey
          ) {
            throw new PostingInvariantError(
              "A cancelled sale order is terminal and cannot be reactivated or edited.",
            );
          }
          return { sale, posting: null };
        }

        if (target === "CANCELLED") {
          if (
            sale.inventoryPosting ||
            (await tx.saleDispatch.count({ where: { saleOrderId: saleId } })) > 0 ||
            (await tx.saleAllocation.count({
              where: { saleItem: { saleId } },
            })) > 0
          ) {
            throw new PostingInvariantError(
              "Issued inventory must be reversed before the sale order can be cancelled.",
            );
          }
          if (input.items)
            throw new PostingInvariantError(
              "Sale items cannot be edited while cancelling the order.",
            );
          const cancelled = await tx.saleOrder.update({
            where: { id: saleId },
            data: { transactionStatus: "CANCELLED" },
            include: { items: { include: { fulfillments: true } } },
          });
          return { sale: cancelled, posting: null };
        }

        if (sale.inventoryPosting || (await tx.saleDispatch.count({ where: { saleOrderId: saleId } })) > 0) {
          if (target === "DRAFT")
            throw new PostingInvariantError(
              "A posted sale cannot return to draft.",
            );

          if (requestKey && sale.inventoryPosting) {
            if (
              validateIdempotencyKey(requestKey) !==
                sale.inventoryPosting.idempotencyKey ||
              sale.inventoryPosting.requestFingerprint !== activationFingerprint
            )
              throw new IdempotencyConflictError();

            const { inventoryPosting: _inventoryPosting, ...replayedSale } =
              sale;

            return {
              sale: replayedSale,
              posting: await reconstructSaleIssueSummary(
                tx,
                sale.inventoryPosting.id,
                sale.id,
              ),
            };
          }

          if (input.items)
            throw new PostingInvariantError("Dispatched sale items are immutable.");

          const amountPaid =
            input.amountPaid === undefined
              ? sale.amountPaid
              : new Decimal(input.amountPaid);
          const extraCost =
            input.extraCost === undefined
              ? sale.extraCost
              : new Decimal(input.extraCost);
          const nextPaymentStatus = paymentStatus(
            amountPaid,
            sale.totalSaleAmount.plus(extraCost),
          );
          const activeStatus = activeSaleTransactionStatus(
            nextPaymentStatus,
            sale.deliveryStatus,
          );
          assertSaleCompletionRequest(input.transactionStatus, activeStatus);

          return {
            sale: await tx.saleOrder.update({
              where: { id: saleId },
              data: {
                transactionStatus: activeStatus,
                amountPaid,
                extraCost,
                paymentStatus: nextPaymentStatus,
              },
            }),
            posting: null,
          };
        }

        if (input.items) {
          if (sale.transactionStatus !== "DRAFT")
            throw new PostingInvariantError("Sale items can only be edited while the sale is a draft.");
          const existingIds = new Set(sale.items.map((item) => item.id));
          if (
            input.items.length !== sale.items.length ||
            input.items.some((item) => !existingIds.has(item.id))
          )
            throw new PostingInvariantError(
              "Draft edits must preserve the existing sale-item set.",
            );
          const warehouseIds = input.items.flatMap((item) =>
            item.fulfillments.map((fulfillment) => fulfillment.warehouseId),
          );
          const warehouseCount = await tx.warehouse.count({
            where: { id: { in: warehouseIds } },
          });
          if (warehouseCount !== new Set(warehouseIds).size)
            throw new PostingInvariantError("Fulfilment warehouse not found.");
          for (const item of input.items) {
            if (item.quantityDelivered !== 0)
              throw new PostingInvariantError("Delivery quantities are recorded by dispatch, not sale edits.");
            const unit = await tx.productUnit.findUnique({
              where: { id: item.unitId },
            });
            if (!unit || unit.productId !== item.productId)
              throw new PostingInvariantError(
                "Sale unit does not belong to the selected product.",
              );
            const price = new Decimal(item.confirmedUnitSalePrice);
            const fulfillmentTotal = item.fulfillments.reduce(
              (sum, fulfillment) => sum + fulfillment.quantityInOrderUnit,
              0,
            );
            if (target !== "DRAFT" && fulfillmentTotal !== item.quantityOrdered)
              throw new PostingInvariantError(
                "Sale-item fulfilment quantities must equal quantity ordered.",
              );
            const fulfillments = item.fulfillments.map((fulfillment) => ({
              warehouseId: fulfillment.warehouseId,
              quantityInOrderUnit: fulfillment.quantityInOrderUnit,
              unitMultiplierSnapshot: unit.multiplier,
              quantityBase: convertToBaseUnits(
                fulfillment.quantityInOrderUnit,
                unit.multiplier,
              ),
            }));
            await tx.saleItem.update({
              where: { id: item.id },
              data: {
                productId: item.productId,
                unitId: item.unitId,
                quantityOrdered: item.quantityOrdered,
                quantityDelivered: item.quantityDelivered,
                sourceWarehouseId:
                  fulfillments.length === 1
                    ? fulfillments[0]!.warehouseId
                    : null,
                unitMultiplierSnapshot: unit.multiplier,
                confirmedUnitSalePrice: price,
                unitPrice: price,
                totalPrice: price.times(item.quantityOrdered),
                fulfillments: { deleteMany: {}, create: fulfillments },
              },
            });
          }
        }
        const currentItems = await tx.saleItem.findMany({ where: { saleId } });
        const totalSaleAmount = currentItems.reduce(
          (sum, item) => sum.plus(item.totalPrice),
          new Decimal(0),
        );
        const amountPaid =
          input.amountPaid === undefined
            ? sale.amountPaid
            : new Decimal(input.amountPaid);
        const extraCost =
          input.extraCost === undefined
            ? sale.extraCost
            : new Decimal(input.extraCost);
        const nextPaymentStatus = paymentStatus(
          amountPaid,
          totalSaleAmount.plus(extraCost),
        );
        const nextDeliveryStatus = deliveryStatus(currentItems);
        const activeStatus = activeSaleTransactionStatus(
          nextPaymentStatus,
          nextDeliveryStatus,
        );
        assertSaleCompletionRequest(input.transactionStatus, activeStatus);
        let posting = null;
        if (target !== "DRAFT") {
          // Activation confirms the order; stock moves only at dispatch.
        }

        const updated = await tx.saleOrder.update({
          where: { id: saleId },
          data: {
            transactionStatus: target === "DRAFT" ? "DRAFT" : activeStatus,
            amountPaid,
            extraCost,
            totalSaleAmount,
            paymentStatus: nextPaymentStatus,
            deliveryStatus: nextDeliveryStatus,
          },
          include: { items: { include: { fulfillments: true } } },
        });
        return { sale: updated, posting };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 },
    ),
  );
}
