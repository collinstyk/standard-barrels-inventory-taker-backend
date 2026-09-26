import { z } from "zod";
import { POSTGRES_INTEGER_MAX } from "../services/inventory";

const positiveInt = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const money = (places: number) => z.string().regex(new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`, "u"), `Money must be a nonnegative decimal string with at most ${places} places.`);

export const createPurchaseReturnSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1_000).optional(),
  refundAmount: money(2),
  items: z.array(z.object({
    originalPurchaseItemId: positiveInt,
    sourceBatchId: z.uuid(),
    sourceWarehouseId: positiveInt,
    quantityInOrderUnit: positiveInt,
    refundedUnitCost: money(4).optional(),
  }).strict()).min(1).superRefine((items, context) => {
    const batches = new Set<string>();
    items.forEach((item, index) => {
      if (batches.has(item.sourceBatchId)) context.addIssue({ code: "custom", path: [index, "sourceBatchId"], message: "A source batch may appear only once per supplier return." });
      batches.add(item.sourceBatchId);
    });
  }),
}).strict();

export const postPurchaseReturnSchema = z.object({}).strict();
export const cancelPurchaseReturnSchema = z.object({}).strict();
