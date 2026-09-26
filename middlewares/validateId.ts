import { NextFunction, Request, Response } from "express";
import AppError from "../utils/appError";

const positiveIntegerPattern = /^[1-9]\d*$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const validateIdParam = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { id } = req.params;
  const numericId = typeof id === "string" ? Number(id) : Number.NaN;

  if (
    typeof id !== "string"
    || !positiveIntegerPattern.test(id)
    || !Number.isFinite(numericId)
    || !Number.isSafeInteger(numericId)
    || numericId <= 0
    || numericId > POSTGRES_INTEGER_MAX
  ) {
    return next(
      new AppError(
        `Route parameter 'id' must be a positive 32-bit integer no greater than ${POSTGRES_INTEGER_MAX}.`,
        400,
      ),
    );
  }

  next();
};
