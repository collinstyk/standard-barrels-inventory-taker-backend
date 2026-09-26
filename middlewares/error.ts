import { Request, Response, NextFunction } from "express";
import { Prisma } from "../generated/prisma/client";
import AppError from "../utils/appError";

/**
 * Handles known Prisma Engine Errors (P-Codes) and transforms them into clean AppErrors
 */
const handlePrismaError = (err: Prisma.PrismaClientKnownRequestError): AppError => {
  switch (err.code) {
    case "P2002": {
      // Unique constraint violation (e.g., trying to register an email or SKU that already exists)
      const targetFields = (err.meta?.target as string[])?.join(", ") || "field";
      return new AppError(`Duplicate field value error: A record with this '${targetFields}' already exists.`, 400);
    }
    case "P2003": {
      // Foreign key constraint violation (e.g., providing a warehouseId or contactId that doesn't exist)
      return new AppError(`Relational Integrity Error: The provided reference identifier does not exist in the system database.`, 400);
    }
    case "P2025": {
      // Record to update or delete not found
      return new AppError(err.meta?.cause as string || "The requested record could not be found in the system.", 404);
    }
    default:
      return new AppError("An internal database operation failed.", 500);
  }
};

/**
 * Handles invalid database inputs, like malformed UUID formats or bad data types
 */
const handlePrismaValidationError = (err: Prisma.PrismaClientValidationError): AppError => {
  return new AppError("Invalid data format or missing required model properties provided to the database engine.", 400);
};

/**
 * Global Express Error Interceptor Engine
 */
export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  let operationalError = { ...err, message: err.message };

  // 1. Intercept Prisma Database Engine Known Errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    operationalError = handlePrismaError(err);
  }

  // 2. Intercept Prisma Typings/Validation Mismatches
  if (err instanceof Prisma.PrismaClientValidationError) {
    operationalError = handlePrismaValidationError(err);
  }

  // 3. Intercept Broken JWT Signatures
  if (err.name === "JsonWebTokenError") {
    operationalError = new AppError("Invalid security token signature. Access Denied. Please log in again.", 401);
  }

  // 4. Intercept Expired JWT Tokens
  if (err.name === "TokenExpiredError") {
    operationalError = new AppError("Your authentication token has expired. Please log in again to renew your session.", 401);
  }

  // Production vs Development visibility switch
  if (process.env.NODE_ENV === "development") {
    res.status(operationalError.statusCode || err.statusCode).json({
      status: operationalError.status || err.status,
      error: err,
      message: operationalError.message || err.message,
      stack: err.stack,
    });
  } else {
    // Production Mode: Shield internal structure logs from clients
    res.status(operationalError.statusCode || err.statusCode).json({
      status: operationalError.status || err.status,
      message: operationalError.message || "Something went wrong internally inside our servers.",
    });
  }
};
