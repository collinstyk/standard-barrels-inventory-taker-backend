import { z } from "zod";
import { POSTGRES_INTEGER_MAX } from "../services/inventory/validation";

const positive = z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Must be a valid ISO calendar date.");
const common = {
  page: positive.default(1), limit: positive.max(100).default(20),
  transactionStatus: z.enum(["DRAFT", "PENDING", "COMPLETED", "CANCELLED"]).optional(),
  paymentStatus: z.enum(["NOT_PAID", "PARTLY_PAID", "FULLY_PAID"]).optional(),
  dateFrom: dateOnly.optional(), dateTo: dateOnly.optional(),
  search: z.string().trim().min(1).max(120).optional(),
};
const validRange = (value: { dateFrom?: string; dateTo?: string }) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo;
export const purchaseListQuerySchema = z.object({ ...common, supplierId: z.uuid().optional(), receivingStatus: z.enum(["NOT_RECEIVED", "PARTLY_RECEIVED", "FULLY_RECEIVED"]).optional() }).strict().refine(validRange, { path: ["dateTo"], message: "dateTo must be on or after dateFrom." });
export const saleListQuerySchema = z.object({ ...common, buyerId: z.uuid().optional(), deliveryStatus: z.enum(["NOT_DELIVERED", "PARTLY_DELIVERED", "FULLY_DELIVERED"]).optional() }).strict().refine(validRange, { path: ["dateTo"], message: "dateTo must be on or after dateFrom." });
export const orderIdSchema = positive;
