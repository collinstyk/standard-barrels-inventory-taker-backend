import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { cancelIssuedSaleSchema } from "../schemas/saleCancellationV2";
import { isInventoryV2Enabled, POSTGRES_INTEGER_MAX } from "../services/inventory";
import { cancelIssuedPendingSale } from "../services/inventory/saleCancellation";
import AppError from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";
import { inventoryHttpError } from "../utils/inventoryHttpError";

const idSchema = z.coerce.number().int().positive().max(POSTGRES_INTEGER_MAX);

export const cancelIssuedSale = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isInventoryV2Enabled()) return next(new AppError("Issued-sale cancellation requires Inventory V2.", 503));
  const id = idSchema.safeParse(req.params.id);
  const body = cancelIssuedSaleSchema.safeParse(req.body);
  if (!id.success) return next(new AppError("Sale ID must be a positive 32-bit integer.", 400));
  if (!body.success) return next(new AppError(`Validation Failed: ${body.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`, 400));
  try {
    const result = await cancelIssuedPendingSale(prisma, id.data, body.data, req.user!.id, req.idempotencyKey!);
    res.status(200).json({ status: "success", data: result });
  } catch (error) {
    next(inventoryHttpError(error));
  }
});
