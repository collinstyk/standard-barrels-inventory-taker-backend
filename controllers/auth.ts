import jwt, { SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import 'dotenv/config'
import { NextFunction, Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync';
import AppError from '../utils/appError';
import prisma from '../prisma';
import { isPublicSignupEnabled } from '../config/environment';
import { createPublicStaff } from '../services/auth';

const signToken = (id: string): string => {
    const jwtSecret = process.env.JWT_SECRET;
    const expiresIn = (process.env.JWT_EXPIRES_IN || "1d") as SignOptions["expiresIn"];

    if (!jwtSecret) throw new Error("JWT_SECRET credential missing!");
    
    return jwt.sign({ id }, jwtSecret, {
        expiresIn,
    });
}

/**
 * @desc    Register a new internal warehouse staff user
 * @route   POST /api/v1/auth/signup
 */
export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isPublicSignupEnabled()) {
    return next(new AppError("Public signup is disabled.", 403));
  }
  const { name, email, password } = req.body;

  const newUser = await createPublicStaff(prisma, { name, email, password });

  // 4. Issue token so they are instantly logged in upon successful signup
  const token = signToken(newUser.id);

  res.status(201).json({
    status: "success",
    token,
    data: { user: newUser },
  });
});

/**
 * @desc    Authenticate existing user credentials
 * @route   POST /api/v1/auth/login
 */
export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { email, password } = req.body;

  // 1. Check if email and password fields exist in the request body
  if (!email || !password) {
    return next(new AppError("Please provide both an email and password.", 400));
  }

  // 2. Pull the user records explicitly including the hashed password string
  const user = await prisma.user.findUnique({ where: { email } });

  // 3. Verify the user exists and evaluate the text password against the hashed string
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return next(new AppError("Incorrect email or password.", 401));
  }

  // 4. Credentials are correct, sign and distribute token
  const token = signToken(user.id);

  res.status(200).json({
    status: "success",
    token,
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    },
  });
});
