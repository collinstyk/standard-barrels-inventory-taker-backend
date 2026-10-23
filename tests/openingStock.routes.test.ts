import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, $transaction: vi.fn() }));
vi.mock("../prisma", () => ({ default: db, connectToDb: vi.fn(), disconnectFromDb: vi.fn() }));
import app from "../app";

const secret = "opening-stock-route-secret";
const token = (role: string) => `Bearer ${jwt.sign({ id: role }, secret)}`;
const user = (role: string) => ({ id: role, name: role, email: `${role}@test`, role });
const body = () => ({ lines: [{
  productId: crypto.randomUUID(), unitId: 1, warehouseId: 1, quantityInUnit: 3,
}] });

describe("opening stock route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = secret;
    process.env.NODE_ENV = "test";
    process.env.INVENTORY_V2_ENABLED = "true";
  });

  it("requires authentication and an idempotency key", async () => {
    expect((await request(app).post("/api/v1/inventory/opening-stock").set("Idempotency-Key", "opening-auth").send(body())).status).toBe(401);
    db.user.findUnique.mockResolvedValue(user("ADMIN"));
    expect((await request(app).post("/api/v1/inventory/opening-stock").set("Authorization", token("ADMIN")).send(body())).status).toBe(400);
  });

  it.each(["STAFF", "AUDITOR"])("denies %s", async (role) => {
    db.user.findUnique.mockResolvedValue(user(role));
    expect((await request(app).post("/api/v1/inventory/opening-stock").set("Authorization", token(role)).set("Idempotency-Key", `opening-${role}`).send(body())).status).toBe(403);
  });

  it.each(["ADMIN", "MANAGER"])("allows %s through authorization and enforces strict validation", async (role) => {
    db.user.findUnique.mockResolvedValue(user(role));
    expect((await request(app).post("/api/v1/inventory/opening-stock").set("Authorization", token(role)).set("Idempotency-Key", `opening-${role}`).send({ lines: [{ ...body().lines[0], quantityInUnit: "3" }] })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects when Inventory V2 is disabled", async () => {
    db.user.findUnique.mockResolvedValue(user("ADMIN"));
    process.env.INVENTORY_V2_ENABLED = "false";
    expect((await request(app).post("/api/v1/inventory/opening-stock").set("Authorization", token("ADMIN")).set("Idempotency-Key", "opening-disabled").send(body())).status).toBe(503);
  });
});
