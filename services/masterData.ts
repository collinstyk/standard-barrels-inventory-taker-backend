import { Prisma, type PrismaClient } from "../generated/prisma/client";
import {
  getSellableQuantitiesByProduct,
  isInventoryV2Enabled,
} from "./inventory";

export class MasterDataError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 404 | 409,
  ) {
    super(message);
  }
}

const conflict = (message: string) => new MasterDataError(message, 409);
const missing = (name: string) =>
  new MasterDataError(`${name} not found.`, 404);
const normalizeSku = (sku: string) => sku.trim().toUpperCase();
const uniqueError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";
async function controlled<T>(
  work: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (uniqueError(error)) throw conflict(message);
    throw error;
  }
}

export type Page = { page: number; limit: number; search?: string };
const pageResult = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
) => ({
  data,
  pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
});

export const createCategory = (db: PrismaClient, input: { name: string }) =>
  controlled(
    () => db.category.create({ data: input, select: { id: true, name: true } }),
    "Category name already exists.",
  );
export async function listCategories(db: PrismaClient, query: Page) {
  const where = query.search
    ? { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } }
    : {};
  const [data, total] = await Promise.all([
    db.category.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, _count: { select: { product: true } } },
    }),
    db.category.count({ where }),
  ]);
  return pageResult(
    data.map(({ _count, ...item }) => ({
      ...item,
      productCount: _count.product,
    })),
    total,
    query.page,
    query.limit,
  );
}
export async function getCategory(db: PrismaClient, id: string) {
  const value = await db.category.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { product: true } } },
  });
  if (!value) throw missing("Category");
  const { _count, ...category } = value;
  return { ...category, productCount: _count.product };
}
export async function updateCategory(
  db: PrismaClient,
  id: string,
  input: { name?: string },
) {
  if (!(await db.category.findUnique({ where: { id }, select: { id: true } })))
    throw missing("Category");
  return controlled(
    () =>
      db.category.update({
        where: { id },
        data: input,
        select: { id: true, name: true },
      }),
    "Category name already exists.",
  );
}

type UnitInput = {
  name: string;
  multiplier: number;
  price: string;
  sku: string;
};
type ProductInput = {
  name: string;
  baseUnit: string;
  categoryId: string;
  reorderPoint: number;
  units: UnitInput[];
};
const productSelect = {
  id: true,
  name: true,
  baseUnit: true,
  reorderPoint: true,
  quantityInStock: true,
  category: { select: { id: true, name: true } },
  units: {
    select: { id: true, name: true, multiplier: true, price: true, sku: true },
    orderBy: { id: "asc" as const },
  },
};

type SelectedProduct = Prisma.ProductGetPayload<{
  select: typeof productSelect;
}>;
type ProductStockResponse = Omit<SelectedProduct, "quantityInStock"> & {
  quantityInStock?: number;
  sellableQuantityBase?: number;
};
async function shapeProductStock(
  db: PrismaClient,
  products: SelectedProduct[],
): Promise<ProductStockResponse[]> {
  if (!isInventoryV2Enabled()) return products as ProductStockResponse[];
  const quantities = await getSellableQuantitiesByProduct(
    db,
    products.map((product) => product.id),
  );
  return products.map(
    ({ quantityInStock: _compatibilityCache, ...product }) => ({
      ...product,
      sellableQuantityBase: quantities.get(product.id) ?? 0,
    }),
  );
}

export async function createProduct(db: PrismaClient, input: ProductInput) {
  const product = await controlled(
    () =>
      db.$transaction(async (tx) => {
        if (
          !(await tx.category.findUnique({
            where: { id: input.categoryId },
            select: { id: true },
          }))
        )
          throw missing("Category");
        return tx.product.create({
          data: {
            name: input.name,
            baseUnit: input.baseUnit,
            categoryId: input.categoryId,
            reorderPoint: input.reorderPoint,
            quantityInStock: 0,
            units: {
              create: input.units.map((unit) => ({
                ...unit,
                sku: normalizeSku(unit.sku),
                price: new Prisma.Decimal(unit.price),
              })),
            },
          },
          select: productSelect,
        });
      }),
    "SKU or product unit name already exists.",
  );
  return (await shapeProductStock(db, [product]))[0]!;
}

export async function listProducts(
  db: PrismaClient,
  query: Page & { categoryId?: string },
) {
  const where: Prisma.ProductWhereInput = {
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            {
              units: {
                some: { sku: { contains: query.search, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };
  const [products, total] = await Promise.all([
    db.product.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: productSelect,
    }),
    db.product.count({ where }),
  ]);
  return pageResult(
    await shapeProductStock(db, products),
    total,
    query.page,
    query.limit,
  );
}

export async function getProduct(db: PrismaClient, id: string) {
  const product = await db.product.findUnique({
    where: { id },
    select: productSelect,
  });
  if (!product) throw missing("Product");
  return (await shapeProductStock(db, [product]))[0]!;
}

export async function updateProduct(
  db: PrismaClient,
  id: string,
  input: { name?: string; categoryId?: string; reorderPoint?: number },
) {
  if (!(await db.product.findUnique({ where: { id }, select: { id: true } })))
    throw missing("Product");
  if (
    input.categoryId &&
    !(await db.category.findUnique({
      where: { id: input.categoryId },
      select: { id: true },
    }))
  )
    throw missing("Category");
  const product = await db.product.update({
    where: { id },
    data: input,
    select: productSelect,
  });
  return (await shapeProductStock(db, [product]))[0]!;
}

// CREATE UNIT
const unitSelect = {
  id: true,
  productId: true,
  name: true,
  multiplier: true,
  price: true,
  sku: true,
};
export async function createUnit(
  db: PrismaClient,
  productId: string,
  input: UnitInput,
) {
  if (
    !(await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    }))
  )
    throw missing("Product");
  return controlled(
    () =>
      db.productUnit.create({
        data: {
          ...input,
          productId,
          sku: normalizeSku(input.sku),
          price: new Prisma.Decimal(input.price),
        },
        select: unitSelect,
      }),
    "SKU or product unit name already exists.",
  );
}

export async function listUnits(db: PrismaClient, productId: string) {
  if (
    !(await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    }))
  )
    throw missing("Product");
  return db.productUnit.findMany({
    where: { productId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: unitSelect,
  });
}
export async function getUnit(
  db: PrismaClient,
  productId: string,
  unitId: number,
) {
  const unit = await db.productUnit.findFirst({
    where: { id: unitId, productId },
    select: unitSelect,
  });
  if (!unit) throw missing("Product unit");
  return unit;
}
export async function updateUnit(
  db: PrismaClient,
  productId: string,
  unitId: number,
  input: { name?: string; price?: string; sku?: string },
) {
  if (
    !(await db.productUnit.findFirst({
      where: { id: unitId, productId },
      select: { id: true },
    }))
  )
    throw missing("Product unit");
  return controlled(
    () =>
      db.productUnit.update({
        where: { id: unitId },
        data: {
          ...input,
          ...(input.sku ? { sku: normalizeSku(input.sku) } : {}),
          ...(input.price ? { price: new Prisma.Decimal(input.price) } : {}),
        },
        select: unitSelect,
      }),
    "SKU or product unit name already exists.",
  );
}

export async function createWarehouse(
  db: PrismaClient,
  input: { name: string; location?: string | null },
) {
  return controlled(
    () =>
      db.warehouse.create({
        data: input,
        select: { id: true, name: true, location: true },
      }),
    "Warehouse name already exists.",
  );
}
export async function listWarehouses(db: PrismaClient, query: Page) {
  const where = query.search
    ? {
        OR: [
          {
            name: {
              contains: query.search,
              mode: Prisma.QueryMode.insensitive,
            },
          },
          {
            location: {
              contains: query.search,
              mode: Prisma.QueryMode.insensitive,
            },
          },
        ],
      }
    : {};
  const [data, total] = await Promise.all([
    db.warehouse.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        location: true,
        _count: { select: { inventoryBatches: true } },
      },
    }),
    db.warehouse.count({ where }),
  ]);
  return pageResult(
    data.map(({ _count, ...item }) => ({
      ...item,
      batchCount: _count.inventoryBatches,
    })),
    total,
    query.page,
    query.limit,
  );
}

export async function getWarehouse(db: PrismaClient, id: number) {
  
  const value = await db.warehouse.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      location: true,
      _count: { select: { inventoryBatches: true } },
    },
  });

  console.log("ALL GOOD!");
  if (!value) throw missing("Warehouse");
  const { _count, ...warehouse } = value;
  return { ...warehouse, batchCount: _count.inventoryBatches };
}

export async function updateWarehouse(
  db: PrismaClient,
  id: number,
  input: { name?: string; location?: string | null },
) {
  if (!(await db.warehouse.findUnique({ where: { id }, select: { id: true } })))
    throw missing("Warehouse");
  return controlled(
    () =>
      db.warehouse.update({
        where: { id },
        data: input,
        select: { id: true, name: true, location: true },
      }),
    "Warehouse name already exists.",
  );
}

type ContactInput = { name: string; isSupplier: boolean; isBuyer: boolean };

const contactSelect = {
  id: true,
  name: true,
  isSupplier: true,
  isBuyer: true,
  _count: { select: { sales: true, purchases: true } },
};

const shapeContact = ({
  _count,
  ...value
}: Awaited<ReturnType<PrismaClient["contact"]["findFirstOrThrow"]>> & {
  _count?: { sales: number; purchases: number };
}) => ({
  ...value,
  purchaseOrderCount: _count?.sales ?? 0,
  saleOrderCount: _count?.purchases ?? 0,
});

export async function createContact(db: PrismaClient, input: ContactInput) {
  const value = await db.contact.create({ data: input, select: contactSelect });
  return shapeContact(value as never);
}

export async function listContacts(
  db: PrismaClient,
  query: Page & { type?: "SUPPLIER" | "BUYER" | "BOTH" },
) {
  const role =
    query.type === "SUPPLIER"
      ? { isSupplier: true }
      : query.type === "BUYER"
        ? { isBuyer: true }
        : query.type === "BOTH"
          ? { isSupplier: true, isBuyer: true }
          : {};
  const where = {
    ...role,
    ...(query.search
      ? { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.contact.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: contactSelect,
    }),
    db.contact.count({ where }),
  ]);
  return pageResult(
    rows.map((row) => shapeContact(row as never)),
    total,
    query.page,
    query.limit,
  );
}
export async function getContact(db: PrismaClient, id: string) {
  const value = await db.contact.findUnique({
    where: { id },
    select: contactSelect,
  });
  if (!value) throw missing("Contact");
  return shapeContact(value as never);
}
export async function updateContact(
  db: PrismaClient,
  id: string,
  input: Partial<ContactInput>,
) {
  const existing = await db.contact.findUnique({ where: { id } });
  if (!existing) throw missing("Contact");
  if (
    !(input.isSupplier ?? existing.isSupplier) &&
    !(input.isBuyer ?? existing.isBuyer)
  )
    throw conflict("A contact must remain a supplier, buyer, or both.");
  const value = await db.contact.update({
    where: { id },
    data: input,
    select: contactSelect,
  });
  return shapeContact(value as never);
}
