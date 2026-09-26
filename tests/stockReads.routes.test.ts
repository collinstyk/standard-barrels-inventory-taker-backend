import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  product: { findMany: vi.fn(), fields: { reorderPoint: "reorderPoint" } },
  stockLevel: { findMany: vi.fn() },
  inventoryBatch: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("../prisma", () => ({ default: db, connectToDb: vi.fn(), disconnectFromDb: vi.fn() }));
import app from "../app";

const secret = "stock-read-route-secret";
const auth = (role: string) => `Bearer ${jwt.sign({ id: role }, secret)}`;
const user = (role: string) => ({ id: role, name: role, email: `${role}@test`, role, createdAt: new Date(), updatedAt: new Date() });

describe("V1-F4 stock read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = secret;
    process.env.NODE_ENV = "test";
    process.env.INVENTORY_V2_ENABLED = "true";
    db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: BigInt(0) }]);
    db.inventoryBatch.findMany.mockResolvedValue([]);
    db.inventoryBatch.count.mockResolvedValue(0);
  });

  it("requires authentication before stock reads", async () => {
    expect((await request(app).get("/api/v1/inventory/low-stock")).status).toBe(401);
    expect((await request(app).get("/api/v1/inventory/expiring-soon")).status).toBe(401);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "MANAGER", "STAFF", "AUDITOR"])("allows %s to read V2 alerts", async (role) => {
    db.user.findUnique.mockResolvedValue(user(role));
    expect((await request(app).get("/api/v1/inventory/low-stock").set("Authorization", auth(role))).status).toBe(200);
    expect((await request(app).get("/api/v1/inventory/expiring-soon?days=0").set("Authorization", auth(role))).status).toBe(200);
  });

  it("rejects unknown, unbounded, and malformed V2 query values before inventory queries", async () => {
    db.user.findUnique.mockResolvedValue(user("ADMIN"));
    for (const path of [
      "/api/v1/inventory/low-stock?unknown=x",
      "/api/v1/inventory/low-stock?limit=101",
      "/api/v1/inventory/expiring-soon?days=366",
      "/api/v1/inventory/expiring-soon?warehouseId=0",
    ]) expect((await request(app).get(path).set("Authorization", auth("ADMIN"))).status).toBe(400);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.inventoryBatch.findMany).not.toHaveBeenCalled();
  });

  it("preserves legacy StockLevel and compatibility-cache reads while V2 is false", async () => {
    process.env.INVENTORY_V2_ENABLED = "false";
    db.user.findUnique.mockResolvedValue(user("STAFF"));
    db.product.findMany.mockResolvedValue([]);
    db.stockLevel.findMany.mockResolvedValue([]);
    expect((await request(app).get("/api/v1/inventory/low-stock").set("Authorization", auth("STAFF"))).status).toBe(200);
    expect((await request(app).get("/api/v1/inventory/expiring-soon").set("Authorization", auth("STAFF"))).status).toBe(200);
    expect(db.product.findMany).toHaveBeenCalledOnce();
    expect(db.stockLevel.findMany).toHaveBeenCalledOnce();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.inventoryBatch.findMany).not.toHaveBeenCalled();
  });
});
