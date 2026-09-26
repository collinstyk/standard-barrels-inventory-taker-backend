import { Request, Response, NextFunction } from "express";
import { ZodType, ZodError } from "zod";
import AppError from "../utils/appError";

/**
 * Higher-order middleware to validate incoming request data against a Zod schema
 */
export const validateBody = (schema: ZodType) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Parse and replace the request body with the strictly stripped/validated data
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Collect all structural validation errors into a single readable string
        const errorMessages = error.issues.map((err) => `${err.path.join(".")}: ${err.message}`).join(" | ");
        return next(new AppError(`Validation Failed: ${errorMessages}`, 400));
      }
      next(error);
    }
  };
};
