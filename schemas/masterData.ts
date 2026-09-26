import { z } from "zod";
import { POSTGRES_INTEGER_MAX } from "../services/inventory/validation";

const uuid = z.uuid();
const positiveInt = z.coerce
  .number()
  .int()
  .positive()
  .max(POSTGRES_INTEGER_MAX);
const nonnegativeInt = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);
const name = z.string().trim().min(2).max(120);
const money = z
  .string()
  .trim()
  .regex(
    /^\d+(?:\.\d{1,4})?$/,
    "Must be a nonnegative decimal string with at most four decimal places.",
  );
const sku = z.string().trim().min(1).max(100);
const nonEmptyPatch = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine(
      (value) => Object.keys(value).length > 0,
      "At least one field is required.",
    );

export const uuidIdSchema = uuid;
export const integerIdSchema = positiveInt;
export const paginationSchema = z
  .object({
    page: positiveInt.default(1),
    limit: positiveInt.max(100).default(20),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const createCategorySchema = z.object({ name }).strict();
export const updateCategorySchema = nonEmptyPatch({ name: name.optional() });

export const unitInputSchema = z
  .object({
    name,
    multiplier: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
    price: money,
    sku,
  })
  .strict();

export const createProductSchema = z
  .object({
    name,
    baseUnit: z.string().trim().min(1).max(50),
    categoryId: uuid,
    reorderPoint: nonnegativeInt.default(0),
    units: z.array(unitInputSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.units.some((unit) => unit.multiplier === 1))
      context.addIssue({
        code: "custom",
        path: ["units"],
        message: "At least one unit must have multiplier 1.",
      });
    const skus = new Set<string>();
    const names = new Set<string>();
    value.units.forEach((unit, index) => {
      const normalizedSku = unit.sku.toUpperCase();
      const normalizedName = unit.name.toLocaleLowerCase();
      if (skus.has(normalizedSku))
        context.addIssue({
          code: "custom",
          path: ["units", index, "sku"],
          message: "Duplicate SKU.",
        });
      if (names.has(normalizedName))
        context.addIssue({
          code: "custom",
          path: ["units", index, "name"],
          message: "Duplicate unit name.",
        });
      skus.add(normalizedSku);
      names.add(normalizedName);
    });
  });

export const updateProductSchema = nonEmptyPatch({
  name: name.optional(),
  categoryId: uuid.optional(),
  reorderPoint: nonnegativeInt.optional(),
});

export const createUnitSchema = unitInputSchema;

export const updateUnitSchema = nonEmptyPatch({
  name: name.optional(),
  price: money.optional(),
  sku: sku.optional(),
});

export const productListQuerySchema = paginationSchema
  .extend({ categoryId: uuid.optional() })
  .strict();

export const createWarehouseSchema = z
  .object({
    name,
    location: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();
  
export const updateWarehouseSchema = nonEmptyPatch({
  name: name.optional(),
  location: z.string().trim().min(1).max(500).nullable().optional(),
});

export const createContactSchema = z
  .object({ name, isSupplier: z.boolean().optional().default(false), isBuyer: z.boolean().optional().default(false) })
  .strict()
  .refine((value) => value.isSupplier || value.isBuyer, {
    message: "At least one contact role must be true.",
  });

export const updateContactSchema = nonEmptyPatch({
  name: name.optional(),
  isSupplier: z.boolean().optional(),
  isBuyer: z.boolean().optional(),
});
export const contactListQuerySchema = paginationSchema
  .extend({ type: z.enum(["SUPPLIER", "BUYER", "BOTH"]).optional() })
  .strict();
