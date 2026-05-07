import { NextFunction, Request, Response } from "express";

export const catchAsync = <T extends Request>(fn: (req: T,res: Response, next: NextFunction) => Promise<any>) => (req: T,res: Response, next: NextFunction) => fn(req,res,next).catch(next);