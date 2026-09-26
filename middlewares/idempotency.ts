import type { NextFunction, Request, Response } from "express";
import AppError from "../utils/appError";
import { validateIdempotencyKey } from "../services/inventory";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";

export function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  try {
    const value = req.get("Idempotency-Key");
    req.idempotencyKey = validateIdempotencyKey(value);
    next();
  } catch {
    next(new AppError("A valid Idempotency-Key header is required.", 400));
  }
}

export function requireIdempotencyKeyWhenV2(req: Request, res: Response, next: NextFunction): void {
  if (!isInventoryV2Enabled()) return next();
  requireIdempotencyKey(req, res, next);
}
