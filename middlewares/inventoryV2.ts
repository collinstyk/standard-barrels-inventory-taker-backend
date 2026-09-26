import type { NextFunction, Request, Response } from "express";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";
import AppError from "../utils/appError";

export function blockLegacyMutationWhenV2(_req: Request, _res: Response, next: NextFunction): void {
  if (isInventoryV2Enabled()) {
    next(new AppError("This legacy inventory workflow is temporarily unavailable while Inventory V2 is enabled.", 503));
    return;
  }
  next();
}
