import { Request } from "express";
import { User } from "../generated/prisma/client";

declare global {
    namespace Express {
    interface Request {
      user?: Omit<User, "password">;
      idempotencyKey?: string;
    }
    }
}
