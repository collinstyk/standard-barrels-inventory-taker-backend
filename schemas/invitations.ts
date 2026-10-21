import { z } from "zod";
import { passwordSchema } from "./auth";

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["MANAGER", "STAFF", "AUDITOR"]),
}).strict();

export const acceptInvitationSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/u),
  name: z.string().trim().min(2).max(120),
  password: passwordSchema,
}).strict();

export const inspectInvitationSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
