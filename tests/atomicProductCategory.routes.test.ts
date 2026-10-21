import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
const service = vi.hoisted(() => ({ createProduct: vi.fn() }));
vi.mock("../prisma", () => ({ default: db }));
vi.mock("../services/masterData", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/masterData")>(),
  createProduct: service.createProduct,
}));
import app from "../app";

const secret = "atomic-product-category-route-test-secret";
const input = {
  name: "Chamdor", baseUnit: "bottle", newCategoryName: "  Drinks  ",
  units: [{ name: "Bottle", multiplier: 1, price: "3500", sku: "CHAM-BTL" }],
};
const token = (role: string) => `Bearer ${jwt.sign({ id: role }, secret)}`;

describe("atomic product/category route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = secret;
  });

  it.each(["ADMIN", "MANAGER"])("allows %s and returns the existing product envelope", async (role) => {
    db.user.findUnique.mockResolvedValue({ id: role, role });
    const product = { id: randomUUID(), name: "Chamdor", category: { id: randomUUID(), name: "Drinks" }, units: [{ id: 1, ...input.units[0] }] };
    service.createProduct.mockResolvedValue(product);
    const response = await request(app).post("/api/v1/catalog/products").set("Authorization", token(role)).send(input);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ status: "success", data: product });
    expect(service.createProduct).toHaveBeenCalledWith(db, { ...input, newCategoryName: "Drinks", reorderPoint: 0 });
  });

  it.each(["STAFF", "AUDITOR"])("denies %s before product or category creation", async (role) => {
    db.user.findUnique.mockResolvedValue({ id: role, role });
    for (const body of [input, { ...input, newCategoryName: undefined, categoryId: randomUUID() }]) {
      const response = await request(app).post("/api/v1/catalog/products").set("Authorization", token(role)).send(body);
      expect(response.status).toBe(403);
    }
    expect(service.createProduct).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    expect((await request(app).post("/api/v1/catalog/products").send(input)).status).toBe(401);
    expect(service.createProduct).not.toHaveBeenCalled();
  });

  it("rejects both or neither category fields before the service runs", async () => {
    db.user.findUnique.mockResolvedValue({ id: "ADMIN", role: "ADMIN" });
    for (const body of [{ ...input, categoryId: randomUUID() }, { ...input, newCategoryName: undefined }]) {
      const response = await request(app).post("/api/v1/catalog/products").set("Authorization", token("ADMIN")).send(body);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain("Provide exactly one");
    }
    expect(service.createProduct).not.toHaveBeenCalled();
  });
});
