import { z } from "zod";
import { POSTGRES_INTEGER_MAX } from "../services/inventory";

const positiveInt = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeMoney = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(?:\.\d{1,4})?$/u, "Money must be a nonnegative decimal with at most four places."),
]);
const transactionStatus = z.enum(["DRAFT", "PENDING", "COMPLETED", "CANCELLED"]);
const fulfillmentSchema = z.object({
  warehouseId: positiveInt,
  quantityInOrderUnit: positiveInt,
}).strict();

function validateFulfillments(
  item: { quantityOrdered: number; fulfillments: Array<{ warehouseId: number; quantityInOrderUnit: number }> },
  addIssue: (path: PropertyKey[], message: string) => void,
  requireComplete: boolean,
): void {
  const warehouses = new Set<number>();
  let total = 0;
  item.fulfillments.forEach((fulfillment, index) => {
    if (warehouses.has(fulfillment.warehouseId)) addIssue(["fulfillments", index, "warehouseId"], "Duplicate fulfilment warehouse.");
    warehouses.add(fulfillment.warehouseId);
    total += fulfillment.quantityInOrderUnit;
  });
  if (!Number.isSafeInteger(total) || total > POSTGRES_INTEGER_MAX) addIssue(["fulfillments"], "Fulfilment quantity total exceeds the database range.");
  if (requireComplete && item.fulfillments.length === 0) addIssue(["fulfillments"], "At least one fulfilment is required.");
  if (requireComplete && total !== item.quantityOrdered) addIssue(["fulfillments"], "Fulfilment quantities must equal quantityOrdered.");
}

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}, "Invalid calendar date.");

export const v2PurchaseCreateSchema = z.object({
  supplierId: z.uuid().nullable().optional(),
  transactionStatus,
  amountPaid: nonnegativeMoney,
  extraCost: nonnegativeMoney.optional().default(0),
  items: z.array(z.object({
    productId: z.uuid(),
    unitId: positiveInt,
    quantityOrdered: positiveInt,
    agreedUnitCost: nonnegativeMoney.optional(),
  }).strict()).min(1),
}).strict().refine((purchase) => purchase.transactionStatus !== "CANCELLED", { path: ["transactionStatus"], message: "A purchase cannot be created as CANCELLED." });

export const v2PurchaseUpdateSchema = z.object({
  transactionStatus: transactionStatus.optional(),
  amountPaid: nonnegativeMoney.optional(),
  extraCost: nonnegativeMoney.optional(),
}).strict().refine((purchase) => Object.keys(purchase).length > 0, { message: "At least one supported commercial field is required." });

export const receiptCreateSchema = z.object({
  receivedAt: z.iso.datetime(),
  notes: z.string().trim().max(1_000).optional(),
  items: z.array(z.object({
    purchaseItemId: positiveInt,
    warehouseId: positiveInt,
    quantityInOrderUnit: positiveInt,
    actualUnitCost: nonnegativeMoney,
    expiryDate: dateOnlySchema.nullable().optional(),
  }).strict()).min(1).superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const key = `${item.purchaseItemId}:${item.warehouseId}:${item.expiryDate ?? "none"}`;
      if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "Duplicate receipt item/warehouse/expiry line." });
      seen.add(key);
    });
  }),
}).strict();

export const v2SaleCreateSchema = z.object({
  buyerId: z.uuid().nullable().optional(),
  transactionStatus,
  amountPaid: nonnegativeMoney,
  extraCost: nonnegativeMoney.optional().default(0),
  items: z.array(z.object({
    productId: z.uuid(),
    unitId: positiveInt,
    quantityOrdered: positiveInt,
    quantityDelivered: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX).optional().default(0),
    fulfillments: z.array(fulfillmentSchema).default([]),
    confirmedUnitSalePrice: nonnegativeMoney,
  }).strict().refine((item) => item.quantityDelivered <= item.quantityOrdered, { message: "quantityDelivered cannot exceed quantityOrdered." })).min(1),
}).strict().superRefine((sale, context) => {
  if (sale.transactionStatus === "CANCELLED") context.addIssue({ code: "custom", path: ["transactionStatus"], message: "A sale cannot be created as CANCELLED." });
  sale.items.forEach((item, index) => {
  validateFulfillments(item, (path, message) => context.addIssue({ code: "custom", path: ["items", index, ...path], message }), sale.transactionStatus !== "DRAFT");
  });
});

export const v2SaleUpdateSchema = z.object({
  transactionStatus: transactionStatus.optional(),
  amountPaid: nonnegativeMoney.optional(),
  extraCost: nonnegativeMoney.optional(),
  items: z.array(z.object({
    id: positiveInt,
    productId: z.uuid(),
    unitId: positiveInt,
    quantityOrdered: positiveInt,
    quantityDelivered: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
    fulfillments: z.array(fulfillmentSchema).default([]),
    confirmedUnitSalePrice: nonnegativeMoney,
  }).strict().refine((item) => item.quantityDelivered <= item.quantityOrdered, { message: "quantityDelivered cannot exceed quantityOrdered." })).min(1).optional(),
}).strict().superRefine((sale, context) => sale.items?.forEach((item, index) => {
  validateFulfillments(item, (path, message) => context.addIssue({ code: "custom", path: ["items", index, ...path], message }), sale.transactionStatus !== undefined && sale.transactionStatus !== "DRAFT");
}));

export const receiptPathSchema = z.object({
  purchaseId: positiveInt,
  receiptId: positiveInt,
}).strict();

export const availabilityQuerySchema = z.object({
  productId: z.uuid(),
  unitId: z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX),
  requestedQuantity: z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX).optional(),
}).strict();

const queryPage = z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX);

export const lowStockQuerySchema = z.object({
  page: queryPage.default(1),
  limit: queryPage.max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();

export const expiringSoonQuerySchema = z.object({
  days: z.coerce.number().int().min(0).max(365).default(90),
  page: queryPage.default(1),
  limit: queryPage.max(100).default(20),
  productId: z.uuid().optional(),
  warehouseId: z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX).optional(),
}).strict();

export const physicalCountAdjustmentSchema = z.object({
  batchId: z.uuid(),
  countedQuantityBase: z.number().int().min(0).max(2_147_483_647),
  reason: z.enum(["PHYSICAL_COUNT", "LOSS", "FOUND_STOCK", "DATA_CORRECTION"]),
  notes: z.string().trim().min(1).max(1_000).optional(),
}).strict();
