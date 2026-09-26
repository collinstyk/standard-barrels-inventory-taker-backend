import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import { inventoryHttpError } from "../utils/inventoryHttpError";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";
import { cancelPurchaseReturn, createPurchaseReturn, getPurchaseReturn, listPurchaseReturns, postPurchaseReturn } from "../services/inventory/purchaseReturn";
import { cancelPurchaseReturnSchema, createPurchaseReturnSchema, postPurchaseReturnSchema } from "../schemas/purchaseReturnV2";
import { POSTGRES_INTEGER_MAX } from "../services/inventory/validation";

const id = z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX);
const pathSchema = z.object({ purchaseId: id, returnId: id.optional() });
const validationMessage = (error: z.ZodError) => `Validation Failed: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`;

function requireV2(next: NextFunction): boolean {
  if (isInventoryV2Enabled()) return true;
  next(new AppError("Supplier-return V2 workflow requires Inventory V2.", 503));
  return false;
}

export const createSupplierReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = pathSchema.safeParse(req.params); const body = createPurchaseReturnSchema.safeParse(req.body);
  if (!path.success) return next(new AppError("Purchase ID must be a positive 32-bit integer.", 400));
  if (!body.success) return next(new AppError(validationMessage(body.error), 400));
  try { const result = await createPurchaseReturn(prisma, path.data.purchaseId, body.data, req.user!.id, req.idempotencyKey!); res.status(result.replayed ? 200 : 201).json({ status: "success", data: result }); } catch (error) { next(inventoryHttpError(error)); }
});

export const postSupplierReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = pathSchema.safeParse(req.params); const body = postPurchaseReturnSchema.safeParse(req.body);
  if (!path.success || path.data.returnId === undefined || !body.success) return next(new AppError(!body.success ? validationMessage(body.error) : "Purchase and return IDs must be positive 32-bit integers.", 400));
  try { res.status(200).json({ status: "success", data: await postPurchaseReturn(prisma, path.data.purchaseId, path.data.returnId, req.user!.id, req.idempotencyKey!) }); } catch (error) { next(inventoryHttpError(error)); }
});

export const cancelSupplierReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = pathSchema.safeParse(req.params); const body = cancelPurchaseReturnSchema.safeParse(req.body);
  if (!path.success || path.data.returnId === undefined || !body.success) return next(new AppError("Invalid supplier-return cancellation request.", 400));
  try { res.status(200).json({ status: "success", data: await cancelPurchaseReturn(prisma, path.data.purchaseId, path.data.returnId) }); } catch (error) { next(inventoryHttpError(error)); }
});

export const listSupplierReturns = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = pathSchema.safeParse(req.params); if (!path.success) return next(new AppError("Purchase ID must be a positive 32-bit integer.", 400));
  const financial = req.user!.role === "ADMIN" || req.user!.role === "MANAGER";
  const returns = await listPurchaseReturns(prisma, path.data.purchaseId, financial);
  res.status(200).json({ status: "success", results: returns.length, data: { returns } });
});

export const getSupplierReturn = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!requireV2(next)) return;
  const path = pathSchema.safeParse(req.params); if (!path.success || path.data.returnId === undefined) return next(new AppError("Purchase and return IDs must be positive 32-bit integers.", 400));
  const financial = req.user!.role === "ADMIN" || req.user!.role === "MANAGER";
  try { res.status(200).json({ status: "success", data: await getPurchaseReturn(prisma, path.data.purchaseId, path.data.returnId, financial) }); } catch (error) { next(inventoryHttpError(error)); }
});
