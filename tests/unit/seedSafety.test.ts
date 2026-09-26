import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("V1-F5 disabled seed", () => {
  it("contains no database connection, destructive SQL, or record creation", () => {
    const source = readFileSync(resolve(process.cwd(), "prisma/seed.ts"), "utf8");
    expect(source).not.toMatch(/deleteMany|\bDELETE\b|\bTRUNCATE\b|\breset\b|\.create\s*\(|PrismaClient|from ["']\.\.\/prisma["']/iu);
  });

  it("can be imported without contacting Prisma", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const module = await import("../../prisma/seed");
    expect(module.explainDisabledSeed()).toContain("bootstrap:admin");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
