import { z } from "zod";
import { POSTGRES_INTEGER_MAX } from "../services/inventory";
import { dateOnlySchema } from "./inventoryV2";

const positiveInt = z.number().int().positive().max(POSTGRES_INTEGER_MAX);

export const createSaleReturnSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1_000).optional(),
  items: z.array(z.object({
    originalSaleItemId: positiveInt,
    quantityInOrderUnit: positiveInt,
    expiryDate: dateOnlySchema.nullable().optional(),
  }).strict()).min(1).superRefine((items, context) => {
    const ids = new Set<number>();
    items.forEach((item, index) => {
      if (ids.has(item.originalSaleItemId)) context.addIssue({ code: "custom", path: [index, "originalSaleItemId"], message: "Duplicate sale-item return line." });
      ids.add(item.originalSaleItemId);
    });
  }),
}).strict();

export const receiveSaleReturnSchema = z.object({
  receivedAt: z.iso.datetime(),
  items: z.array(z.object({
    saleReturnItemId: positiveInt,
    warehouseId: positiveInt,
    expiryDate: dateOnlySchema.nullable().optional(),
  }).strict()).min(1).superRefine((items, context) => {
    const ids = new Set<number>();
    items.forEach((item, index) => {
      if (ids.has(item.saleReturnItemId)) context.addIssue({ code: "custom", path: [index, "saleReturnItemId"], message: "Duplicate return-item receive line." });
      ids.add(item.saleReturnItemId);
    });
  }),
}).strict();

export const inspectSaleReturnSchema = z.object({
  saleReturnItemId: positiveInt,
  sourceBatchId: z.uuid(),
  warehouseId: positiveInt,
  quantityInOrderUnit: positiveInt,
  outcome: z.enum(["SELLABLE", "DAMAGED", "REJECTED"]),
  inspectedAt: z.iso.datetime(),
  notes: z.string().trim().max(2_000),
  checks: z.object({
    packagingIntact: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
    sealIntact: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
    correctProduct: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
    correctQuantity: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
    expiryChecked: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
    visibleDamage: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
    returnReasonConfirmed: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE"]),
  }).strict(),
}).strict().superRefine((inspection, context) => {
  const checks = inspection.checks;
  if (inspection.outcome === "SELLABLE") {
    const required = [checks.correctProduct, checks.correctQuantity, checks.visibleDamage, checks.returnReasonConfirmed];
    if (required.some((result) => result !== "PASSED") || Object.values(checks).some((result) => result === "FAILED")) {
      context.addIssue({ code: "custom", path: ["checks"], message: "Sellable evidence requires passed identity, quantity, damage, and return-reason checks with no failed check." });
    }
  }
  if (inspection.outcome === "DAMAGED") {
    if (checks.correctProduct !== "PASSED" || checks.correctQuantity !== "PASSED") context.addIssue({ code: "custom", path: ["checks"], message: "Damaged inventory requires passed product and quantity identification." });
    const damageCheckFailed = [checks.packagingIntact, checks.sealIntact, checks.visibleDamage].includes("FAILED");
    if (!damageCheckFailed && inspection.notes.length < 20) context.addIssue({ code: "custom", path: ["notes"], message: "Damaged inventory requires a failed damage-related check or a detailed explanation." });
  }
  if (inspection.outcome === "REJECTED") {
    if (inspection.notes.length < 10) context.addIssue({ code: "custom", path: ["notes"], message: "Rejected inventory requires a meaningful rejection explanation." });
    if (checks.correctProduct === "NOT_APPLICABLE" || checks.correctQuantity === "NOT_APPLICABLE") context.addIssue({ code: "custom", path: ["checks"], message: "Rejected inventory requires explicit product and quantity identification evidence." });
    if (!Object.values(checks).includes("FAILED")) context.addIssue({ code: "custom", path: ["checks"], message: "Rejected inventory requires at least one failed relevant inspection check." });
  }
});

export const cancelSaleReturnSchema = z.object({}).strict();
