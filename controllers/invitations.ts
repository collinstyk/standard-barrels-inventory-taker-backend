import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { Prisma } from "../generated/prisma/client";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import { signToken } from "./auth";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

function validToken(token: string | undefined): string {
  if (!token || !/^[a-f0-9]{64}$/u.test(token)) throw new AppError("Invalid invitation.", 400);
  return digest(token);
}

export const createInvitation = catchAsync(async (req, res) => {
  const { email, role } = req.body as { email: string; role: "MANAGER" | "STAFF" | "AUDITOR" };
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new AppError("This email already has an account.", 409);
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const invitation = await prisma.userInvitation.create({
    data: { email, role, tokenHash: digest(token), expiresAt, createdById: req.user!.id },
    select: { id: true, email: true, role: true, expiresAt: true },
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ status: "success", data: { invitation, token } });
});

export const inspectInvitation = catchAsync(async (req, res) => {
  const tokenHash = validToken(req.body.token);
  const invitation = await prisma.userInvitation.findUnique({
    where: { tokenHash }, select: { email: true, role: true, expiresAt: true, usedAt: true },
  });
  if (!invitation || invitation.usedAt || invitation.expiresAt <= new Date())
    throw new AppError("Invitation is invalid or expired.", 410);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "success", data: { email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt } });
});

export const acceptInvitation = catchAsync(async (req, res) => {
  const tokenHash = validToken(req.body.token);
  const { name, password } = req.body as { name: string; password: string };
  const hashedPassword = await bcrypt.hash(password, 12);
  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const invitation = await tx.userInvitation.findUnique({ where: { tokenHash } });
      if (!invitation || invitation.usedAt || invitation.expiresAt <= new Date())
        throw new AppError("Invitation is invalid or expired.", 410);
      const claimed = await tx.userInvitation.updateMany({
        where: { id: invitation.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new AppError("Invitation has already been used.", 409);
      return tx.user.create({
        data: { email: invitation.email, role: invitation.role, name, password: hashedPassword },
        select: { id: true, name: true, email: true, role: true },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new AppError("This email already has an account.", 409);
    console.error(error);
    throw error;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ status: "success", token: signToken(user.id), data: { user } });
});
