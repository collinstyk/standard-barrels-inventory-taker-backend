import { z } from "zod";

export const passwordSchema = z
      .string({ message: "Password is required" })
      .min(6, "Password must be at least 6 characters long")
      .refine(
        (password: string) => !/\s/u.test(password),
        "Password must not contain spaces",
      )
      .refine(
        (password: string) => /[a-z]/u.test(password),
        "Password must contain at least one lowercase letter",
      )
      .refine(
        (password) => /[A-Z]/u.test(password),
        "Password must contain at least one uppercase letter",
      )
      .refine(
        (password) => /\d/u.test(password),
        "Password must contain at least one nmuber",
      )
      .refine(
        (password) => /[^A-Za-z0-9]/u.test(password),
        "Password must contain at least one special character",
      )

export const signupSchema = z
  .object({
    // Modern Zod uses 'message' to catch both missing properties and empty types
    name: z
      .string({ message: "Name is strictly required" })
      .min(2, "Name must be at least 2 characters"),

    // Chain .email() off the string, passing the custom message
    email: z
      .string({ message: "Email is strictly required" })
      .trim()
      .toLowerCase()
      .email("Invalid email format representation"),

    password: passwordSchema
  })
  .strict();

export const loginSchema = z
  .object({
    email: z
      .string({ message: "Email is required" })
      .trim()
      .toLowerCase()
      .email("Invalid email layout"),
    password: z
      .string({ message: "Password is required" })
      .min(1, "Password is required"),
  })
  .strict();
