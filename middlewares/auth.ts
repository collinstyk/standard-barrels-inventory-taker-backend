import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import prisma from "../prisma";
import { UserRole } from "../generated/prisma/enums";

interface JwtPayload {
  id: string;
  iat: number;
}

export const protect = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    let token: string | undefined;

    // 1. Check for the token in the incoming Request headers
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    // Guardrail: If no token is provided, deny access immediately
    if (!token) {
      return next(
        new AppError(
          "You are not logged in. Please log in to gain access.",
          401,
        ),
      );
    }

    // 2. Verify the cryptographic token signature
    const decoded = await new Promise<JwtPayload>((resolve, reject) => {
      jwt.verify(token!, process.env.JWT_SECRET!, (err, payload) => {
        if (err)
          return reject(
            new AppError("Invalid or expired token. Please log in again.", 401),
          );
        resolve(payload as JwtPayload);
      });
    }).catch((err) => {
      return next(err);
    });

    if (!decoded) return; // Halt execution if verification failed and error was passed to next()

    // 3. Verify the user attached to the token still physically exists in the database
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        // We explicitly leave out the password column here for security
      },
    });

    if (!currentUser) {
      return next(
        new AppError("The user belonging to this token no longer exists.", 401),
      );
    }

    // 4. Grant access! Save the verified user details to the request lifecycle object
    req.user = currentUser;
    next();
  },
);

/**
 * @desc    Gatekeeper middleware to restrict route access by user roles
 * @param   roles Allowed roles for this specific endpoint (e.g., Role.ADMIN, Role.MANAGER)
 */
export const restrictTo = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Safety Guard: Ensure protect middleware ran before this step
    if (!req.user) {
      return next(
        new AppError(
          "Authentication context missing. Please run protect middleware first.",
          500,
        ),
      );
    }

    // 2. Evaluate if the authenticated user's role is included in the permitted list
    if (!roles.includes(req.user.role as UserRole)) {
      return next(
        new AppError(
          "Access Denied: You do not have sufficient permissions to perform this action.",
          403,
        ),
      );
    }

    // 3. Authorized! Advance execution to the final controller target
    next();
  };
};
