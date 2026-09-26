import type { NextFunction, Request, Response } from "express";
import prisma from "../prisma";
import * as service from "../services/masterData";
import {
  contactListQuerySchema,
  createContactSchema,
  updateContactSchema,
  uuidIdSchema,
} from "../schemas/masterData";
import AppError from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";


const fail = (next: NextFunction, msg: string) =>
  next(new AppError(`Validation Failed: ${msg}`, 400));

const handle = (e: unknown, next: NextFunction) =>
  next(
    e instanceof service.MasterDataError
      ? new AppError(e.message, e.statusCode)
      : new AppError("Master-data operation failed.", 500),
  );

export const createContact = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log(req.body);
    
    const b = createContactSchema.safeParse(req.body);
    if (!b.success)
      return fail(next, b.error.issues.map((i) => i.message).join(" | "));

    const data = await service.createContact(prisma, b.data)

    res
      .status(201)
      .json({
        status: "success",
        data,
      });
  },
);

export const listContacts = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const q = contactListQuerySchema.safeParse(req.query);
    if (!q.success)
      return fail(next, q.error.issues.map((i) => i.message).join(" | "));
    res.json({
      status: "success",
      ...(await service.listContacts(prisma, q.data)),
    });
  },
);

export const getContact = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = uuidIdSchema.safeParse(req.params.id);
    if (!id.success) return fail(next, "Invalid contact ID.");
    try {
      res.json({
        status: "success",
        data: await service.getContact(prisma, id.data),
      });
    } catch (e) {
      handle(e, next);
    }
  },
);

export const updateContact = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = uuidIdSchema.safeParse(req.params.id),
      b = updateContactSchema.safeParse(req.body);
    if (!id.success) return fail(next, "Invalid contact ID.");
    if (!b.success)
      return fail(next, b.error.issues.map((i) => i.message).join(" | "));
    try {
      res.json({
        status: "success",
        data: await service.updateContact(prisma, id.data, b.data),
      });
    } catch (e) {
      handle(e, next);
    }
  },
);
