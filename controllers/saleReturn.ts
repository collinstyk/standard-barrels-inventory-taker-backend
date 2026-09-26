import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import { isInventoryV2Enabled } from "../services/inventory";
import { cancelSaleReturn, createSaleReturn, getSaleReturn, inspectSaleReturn, listSaleReturns, receiveSaleReturn } from "../services/inventory/saleReturn";
import { cancelSaleReturnSchema, createSaleReturnSchema, inspectSaleReturnSchema, receiveSaleReturnSchema } from "../schemas/saleReturnV2";
import { inventoryHttpError } from "../utils/inventoryHttpError";
import { POSTGRES_INTEGER_MAX } from "../services/inventory/validation";

const id = z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX);
const parseIds = (req: Request) => z.object({ saleId: id, returnId: id.optional() }).safeParse(req.params);
const validationMessage = (error: z.ZodError) => `Validation Failed: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`;

function requireV2(next: NextFunction): boolean {
  if (isInventoryV2Enabled()) return true;
  next(new AppError("Customer-return V2 workflow requires Inventory V2.", 503));
  return false;
}

export const createCustomerReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = parseIds(req); const body = createSaleReturnSchema.safeParse(req.body);
  if (!path.success) return next(new AppError("Sale ID must be a positive 32-bit integer.", 400));
  if (!body.success) return next(new AppError(validationMessage(body.error), 400));
  try { const result = await createSaleReturn(prisma, path.data.saleId, body.data, req.user!.id, req.idempotencyKey!); res.status(result.replayed ? 200 : 201).json({ status: "success", data: result }); } catch (error) { next(inventoryHttpError(error)); }
});

export const receiveCustomerReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = parseIds(req); const body = receiveSaleReturnSchema.safeParse(req.body);
  if (!path.success || path.data.returnId === undefined || !body.success) return next(new AppError(!body.success ? validationMessage(body.error) : "Sale and return IDs must be positive 32-bit integers.", 400));
  try { const result = await receiveSaleReturn(prisma, path.data.saleId, path.data.returnId, body.data, req.user!.id, req.idempotencyKey!); res.status(200).json({ status: "success", data: result }); } catch (error) { next(inventoryHttpError(error)); }
});

export const inspectCustomerReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = parseIds(req); const body = inspectSaleReturnSchema.safeParse(req.body);
  if (!path.success || path.data.returnId === undefined || !body.success) return next(new AppError(!body.success ? validationMessage(body.error) : "Sale and return IDs must be positive 32-bit integers.", 400));
  try { const result = await inspectSaleReturn(prisma, path.data.saleId, path.data.returnId, body.data, req.user!.id, req.idempotencyKey!); res.status(200).json({ status: "success", data: result }); } catch (error) { next(inventoryHttpError(error)); }
});

export const cancelCustomerReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = parseIds(req); const body = cancelSaleReturnSchema.safeParse(req.body);
  if (!path.success || path.data.returnId === undefined || !body.success) return next(new AppError("Invalid customer-return cancellation request.", 400));
  try { res.status(200).json({ status: "success", data: await cancelSaleReturn(prisma, path.data.saleId, path.data.returnId) }); } catch (error) { next(inventoryHttpError(error)); }
});

export const listCustomerReturns = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = parseIds(req); if (!path.success) return next(new AppError("Sale ID must be a positive 32-bit integer.", 400));
  const returns = await listSaleReturns(prisma, path.data.saleId); res.status(200).json({ status: "success", results: returns.length, data: { returns } });
});

export const getCustomerReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = parseIds(req); if (!path.success || path.data.returnId === undefined) return next(new AppError("Sale and return IDs must be positive 32-bit integers.", 400));
  try { res.status(200).json({ status: "success", data: await getSaleReturn(prisma, path.data.saleId, path.data.returnId) }); } catch (error) { next(inventoryHttpError(error)); }
});
