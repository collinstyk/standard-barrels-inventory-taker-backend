import type { NextFunction, Request, Response } from "express";
import prisma from "../prisma";
import * as service from "../services/masterData";
import {
  createWarehouseSchema,
  integerIdSchema,
  paginationSchema,
  updateWarehouseSchema,
} from "../schemas/masterData";
import AppError from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";

const fail = (next: NextFunction, issues: string) =>
  next(new AppError(`Validation Failed: ${issues}`, 400));

const handle = (e: unknown, next: NextFunction) => {  
  console.log(e);
  next(
    e instanceof service.MasterDataError
      ? new AppError(e.message, e.statusCode)
      : new AppError("Master-data operation failed.", 500),
  );
}

export const createWarehouse = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const b = createWarehouseSchema.safeParse(req.body);
    if (!b.success)
      return fail(next, b.error.issues.map((i) => i.message).join(" | "));
    try {
      const data = await service.createWarehouse(prisma, b.data);
      res
        .status(201)
        .json({
          status: "success",
          data,
        });
    } catch (e) {
      handle(e, next);
    }
  },
);

export const listWarehouses = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const q = paginationSchema.safeParse(req.query);
    if (!q.success)
      return fail(next, q.error.issues.map((i) => i.message).join(" | "));
    res.json({
      status: "success",
      ...(await service.listWarehouses(prisma, q.data)),
    });
  },
);

export const getWarehouse = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = integerIdSchema.safeParse(req.params.id);
    
    if (!id.success) return fail(next, "Invalid warehouse ID.");
    try {
      res.json({
        status: "success",
        data: await service.getWarehouse(prisma, id.data),
      });
    } catch (e) {
      handle(e, next);
    }
  },
);
export const updateWarehouse = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = integerIdSchema.safeParse(req.params.id),
      b = updateWarehouseSchema.safeParse(req.body);
    if (!id.success) return fail(next, "Invalid warehouse ID.");
    if (!b.success)
      return fail(next, b.error.issues.map((i) => i.message).join(" | "));
    try {
      res.json({
        status: "success",
        data: await service.updateWarehouse(prisma, id.data, b.data),
      });
    } catch (e) {
      handle(e, next);
    }
  },
);
