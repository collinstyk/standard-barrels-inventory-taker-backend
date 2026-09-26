import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import prisma from "../prisma";
import * as service from "../services/masterData";
import {
  createCategorySchema,
  createProductSchema,
  createUnitSchema,
  integerIdSchema,
  paginationSchema,
  productListQuerySchema,
  updateCategorySchema,
  updateProductSchema,
  updateUnitSchema,
  uuidIdSchema,
} from "../schemas/masterData";
import AppError from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";

const parse = <T>(
  schema: ZodType<T>,
  value: unknown,
  next: NextFunction,
): T | undefined => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  next(
    new AppError(
      `Validation Failed: ${result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join(" | ")}`,
      400,
    ),
  );
};
const handle = (error: unknown, next: NextFunction) =>
  next(
    error instanceof service.MasterDataError
      ? new AppError(error.message, error.statusCode)
      : new AppError("Master-data operation failed.", 500),
  );

export const createCategory = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const body = parse(createCategorySchema, req.body, next);
    if (!body) return;
    try {
      res.status(201).json({
        status: "success",
        data: await service.createCategory(prisma, body),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);

export const listCategories = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const query = parse(paginationSchema, req.query, next);
    if (!query) return;
    res.json({
      status: "success",
      ...(await service.listCategories(prisma, query)),
    });
  },
);
export const getCategory = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = parse(uuidIdSchema, req.params.id, next);
    if (!id) return;
    try {
      res.json({
        status: "success",
        data: await service.getCategory(prisma, id),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);
export const updateCategory = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = parse(uuidIdSchema, req.params.id, next);
    const body = parse(updateCategorySchema, req.body, next);
    if (!id || !body) return;
    try {
      res.json({
        status: "success",
        data: await service.updateCategory(prisma, id, body),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);

export const createProduct = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const body = parse(createProductSchema, req.body, next);
    if (!body) return;
    try {
      const data = await service.createProduct(prisma, body);
      res.status(201).json({
        status: "success",
        data,
      });
    } catch (error) {
      handle(error, next);
    }
  },
);

export const listProducts = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const query = parse(productListQuerySchema, req.query, next);
    if (!query) return;
    res.json({
      status: "success",
      ...(await service.listProducts(prisma, query)),
    });
  },
);
export const getProduct = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = parse(uuidIdSchema, req.params.id, next);
    if (!id) return;
    try {
      res.json({
        status: "success",
        data: await service.getProduct(prisma, id),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);
export const updateProduct = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = parse(uuidIdSchema, req.params.id, next);
    const body = parse(updateProductSchema, req.body, next);
    if (!id || !body) return;
    try {
      res.json({
        status: "success",
        data: await service.updateProduct(prisma, id, body),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);

// UNITS
const productId = (req: Request, next: NextFunction) =>
  parse(uuidIdSchema, req.params.productId, next);
const unitId = (req: Request, next: NextFunction) =>
  parse(integerIdSchema, req.params.unitId, next);
// CREATE UNITS
export const createUnit = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const pid = productId(req, next);
    const body = parse(createUnitSchema, req.body, next);
    if (!pid || !body) return;
    try {
      res.status(201).json({
        status: "success",
        data: await service.createUnit(prisma, pid, body),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);
export const listUnits = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const pid = productId(req, next);
    if (!pid) return;
    try {
      res.json({
        status: "success",
        data: await service.listUnits(prisma, pid),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);
export const getUnit = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const pid = productId(req, next);
    const uid = unitId(req, next);
    if (!pid || !uid) return;
    try {
      res.json({
        status: "success",
        data: await service.getUnit(prisma, pid, uid),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);
export const updateUnit = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const pid = productId(req, next);
    const uid = unitId(req, next);
    const body = parse(updateUnitSchema, req.body, next);
    if (!pid || !uid || !body) return;
    try {
      res.json({
        status: "success",
        data: await service.updateUnit(prisma, pid, uid, body),
      });
    } catch (error) {
      handle(error, next);
    }
  },
);
