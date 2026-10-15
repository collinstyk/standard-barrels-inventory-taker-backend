import type { Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import AppError from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";
import { inventoryHttpError } from "../utils/inventoryHttpError";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";
import { saleDispatchSchema } from "../schemas/inventoryV2";
import { dispatchSale } from "../services/inventory/saleDispatch";

export const dispatchSaleOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isInventoryV2Enabled()) return next(new AppError("Sale dispatch requires Inventory V2.", 409));
  if (!req.user) return next(new AppError("Authentication required.", 401));
  const saleId = Number(req.params.id);
  if (!Number.isSafeInteger(saleId) || saleId < 1) return next(new AppError("Invalid sale ID.", 400));
  const parsed = saleDispatchSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(`Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`, 400));
  try {
    const result = await dispatchSale(prisma, saleId, parsed.data, req.user.id, req.idempotencyKey!);
    res.status(result.replayed ? 200 : 201).json({ status: "success", data: result });
  } catch (error) { next(inventoryHttpError(error)); }
});
