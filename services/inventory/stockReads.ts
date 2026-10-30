import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { getBusinessDate } from "./businessDate";
import type { BusinessDate } from "./types";
import { POSTGRES_INTEGER_MAX } from "./validation";
import { PostingInvariantError } from "./errors";

type PageQuery = { page: number; limit: number };
type LowStockQuery = PageQuery & { search?: string };
type ExpiringQuery = PageQuery & { days: number; productId?: string; warehouseId?: number };

type LowStockRow = {
  productId: string;
  productName: string;
  baseUnit: string;
  reorderPoint: number;
  sellableQuantityBase: number;
};

type CountRow = { total: bigint | number };

export type AvailabilityPageQuery = PageQuery & { search?: string };

function stockLevel(quantityBase: number, reorderPoint: number) {
  if (quantityBase === 0 || (reorderPoint > 0 && quantityBase <= Math.floor(reorderPoint / 4))) return "CRITICAL" as const;
  if (quantityBase <= reorderPoint) return "LOW" as const;
  return "NORMAL" as const;
}

// Page products first, then aggregate only eligible batches for those products.
// A product with no sellable stock remains in the result with zero total and no warehouses.
export async function getInventoryAvailabilityPage(db: PrismaClient, query: AvailabilityPageQuery) {
  const businessDate = getBusinessDate();
  const where: Prisma.ProductWhereInput = query.search
    ? { name: { contains: query.search, mode: "insensitive" } }
    : {};
  const [products, total] = await Promise.all([
    db.product.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true, name: true, baseUnit: true, reorderPoint: true,
        units: { orderBy: [{ multiplier: "asc" }, { id: "asc" }], select: { id: true, name: true, multiplier: true, sku: true } },
      },
    }),
    db.product.count({ where }),
  ]);
  const productIds = products.map((product) => product.id);
  const batchTotals = productIds.length ? await db.inventoryBatch.groupBy({
    by: ["productId", "warehouseId"],
    where: {
      productId: { in: productIds },
      disposition: "SELLABLE",
      quantityOnHandBase: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gte: new Date(`${businessDate}T00:00:00.000Z`) } }],
    },
    _sum: { quantityOnHandBase: true },
  }) : [];
  const warehouseIds = [...new Set(batchTotals.map((row) => row.warehouseId))];
  const warehouses = warehouseIds.length ? await db.warehouse.findMany({
    where: { id: { in: warehouseIds } },
    select: { id: true, name: true, location: true },
  }) : [];
  const warehouseById = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]));
  const batchesByProduct = new Map<string, typeof batchTotals>();
  for (const row of batchTotals) {
    const grouped = batchesByProduct.get(row.productId) ?? [];
    grouped.push(row);
    batchesByProduct.set(row.productId, grouped);
  }
  return {
    businessDate,
    evaluatedAt: new Date().toISOString(),
    informationalOnly: true,
    data: products.map((product) => {
      const rows = batchesByProduct.get(product.id) ?? [];
      const sellableQuantityBase = rows.reduce((sum, row) => sum + (row._sum.quantityOnHandBase ?? 0), 0);
      if (!Number.isSafeInteger(sellableQuantityBase) || sellableQuantityBase > POSTGRES_INTEGER_MAX)
        throw new PostingInvariantError("Product availability exceeds the database range.");
      return {
        productId: product.id,
        productName: product.name,
        baseUnit: product.baseUnit,
        reorderPoint: product.reorderPoint,
        units: product.units.map((unit) => ({ unitId: unit.id, name: unit.name, multiplier: unit.multiplier, sku: unit.sku,
          availableQuantityInUnit: Math.floor(sellableQuantityBase / unit.multiplier), baseUnitRemainder: sellableQuantityBase % unit.multiplier })),
        sellableQuantityBase,
        stockLevel: stockLevel(sellableQuantityBase, product.reorderPoint),
        warehouses: rows.map((row) => {
          const warehouse = warehouseById.get(row.warehouseId)!;
          const quantityBase = row._sum.quantityOnHandBase ?? 0;
          if (!Number.isSafeInteger(quantityBase) || quantityBase > POSTGRES_INTEGER_MAX)
            throw new PostingInvariantError("Warehouse availability exceeds the database range.");
          return {
            warehouseId: warehouse.id,
            warehouseName: warehouse.name,
            warehouseLocation: warehouse.location,
            sellableQuantityBase: quantityBase,
            stockLevel: stockLevel(quantityBase, product.reorderPoint),
            unitQuantities: product.units.map((unit) => ({ unitId: unit.id,
              availableQuantityInUnit: Math.floor(quantityBase / unit.multiplier), baseUnitRemainder: quantityBase % unit.multiplier })),
          };
        }).sort((left, right) => left.warehouseName.localeCompare(right.warehouseName) || left.warehouseId - right.warehouseId),
      };
    }),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}

export function addBusinessDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10) as BusinessDate;
}

export function calendarDaysBetween(from: BusinessDate, to: Date): number {
  let cursor = from;
  const target = to.toISOString().slice(0, 10);
  let days = 0;
  while (cursor < target) {
    cursor = addBusinessDays(cursor, 1);
    days += 1;
  }
  return days;
}

export async function getSellableQuantitiesByProduct(
  db: PrismaClient,
  productIds: string[],
  businessDate = getBusinessDate(),
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.inventoryBatch.groupBy({
    by: ["productId"],
    where: {
      productId: { in: productIds },
      disposition: "SELLABLE",
      quantityOnHandBase: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gte: new Date(`${businessDate}T00:00:00.000Z`) } }],
    },
    _sum: { quantityOnHandBase: true },
  });
  return new Map(rows.map((row) => [row.productId, row._sum.quantityOnHandBase ?? 0]));
}

function lowStockCte(businessDate: BusinessDate, search?: string): Prisma.Sql {
  const searchFilter = search
    ? Prisma.sql`WHERE p."name" ILIKE ${`%${search}%`}`
    : Prisma.empty;
  return Prisma.sql`
    WITH low_stock AS (
      SELECT p."id" AS "productId", p."name" AS "productName", p."baseUnit",
        p."reorderPoint", COALESCE(SUM(b."quantityOnHandBase"), 0)::integer AS "sellableQuantityBase"
      FROM "Product" p
      LEFT JOIN "InventoryBatch" b ON b."productId" = p."id"
        AND b."disposition" = 'SELLABLE'
        AND b."quantityOnHandBase" > 0
        AND (b."expiryDate" IS NULL OR b."expiryDate" >= ${businessDate}::date)
      ${searchFilter}
      GROUP BY p."id", p."name", p."baseUnit", p."reorderPoint"
      HAVING COALESCE(SUM(b."quantityOnHandBase"), 0) <= p."reorderPoint"
    )`;
}

export async function getAuthoritativeLowStock(db: PrismaClient, query: LowStockQuery) {
  const businessDate = getBusinessDate();
  const cte = lowStockCte(businessDate, query.search);
  const [rows, count] = await Promise.all([
    db.$queryRaw<LowStockRow[]>(Prisma.sql`${cte}
      SELECT * FROM low_stock
      ORDER BY "sellableQuantityBase" ASC, "productName" ASC, "productId" ASC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`),
    db.$queryRaw<CountRow[]>(Prisma.sql`${cte} SELECT COUNT(*) AS total FROM low_stock`),
  ]);
  const total = Number(count[0]?.total ?? 0);
  return {
    data: rows.map((row) => ({
      ...row,
      shortageQuantityBase: Math.max(0, row.reorderPoint - row.sellableQuantityBase),
      severity: row.sellableQuantityBase === 0 ? "CRITICAL_OUT_OF_STOCK" : "LOW_STOCK",
    })),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}

export async function getAuthoritativeExpiringSoon(db: PrismaClient, query: ExpiringQuery) {
  const businessDate = getBusinessDate();
  const cutoffDate = addBusinessDays(businessDate, query.days);
  const where: Prisma.InventoryBatchWhereInput = {
    disposition: "SELLABLE",
    quantityOnHandBase: { gt: 0 },
    expiryDate: {
      gte: new Date(`${businessDate}T00:00:00.000Z`),
      lte: new Date(`${cutoffDate}T00:00:00.000Z`),
    },
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.inventoryBatch.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        quantityOnHandBase: true,
        expiryDate: true,
        receivedAt: true,
        product: { select: { id: true, name: true, baseUnit: true } },
        warehouse: { select: { id: true, name: true } },
      },
    }),
    db.inventoryBatch.count({ where }),
  ]);
  return {
    businessDate,
    window: { days: query.days, throughDate: cutoffDate },
    evaluatedAt: new Date(),
    data: rows.map((row) => ({
      batchId: row.id,
      product: row.product,
      warehouse: row.warehouse,
      quantityOnHandBase: row.quantityOnHandBase,
      expiryDate: row.expiryDate,
      receivedAt: row.receivedAt,
      daysRemaining: calendarDaysBetween(businessDate, row.expiryDate!),
    })),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}
