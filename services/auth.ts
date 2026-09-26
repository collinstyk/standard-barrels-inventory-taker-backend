import bcrypt from "bcryptjs";
import type { PrismaClient } from "../generated/prisma/client";
import { UserRole } from "../generated/prisma/enums";
import AppError from "../utils/appError";

export async function createPublicStaff(
  db: PrismaClient,
  input: { name: string; email: string; password: string },
) {
  const email = input.email.trim().toLowerCase();
  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) throw new AppError("Email is already registered in the system.", 400);
  const hashedPassword = await bcrypt.hash(input.password, 12);
  return db.user.create({
    data: { name: input.name, email, password: hashedPassword, role: UserRole.STAFF },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
}
