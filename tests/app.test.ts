import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../prisma", () => ({
  default: prismaMock,
  connectToDb: vi.fn(),
  disconnectFromDb: vi.fn(),
}));

import app from "../app";

const jwtSecret = "phase-one-test-secret";
const adminUser = {
  id: "test-admin-id",
  name: "Test Admin",
  email: "admin@example.com",
  role: "ADMIN",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const authenticatedRequest = () =>
  `Bearer ${jwt.sign({ id: adminUser.id }, jwtSecret)}`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = jwtSecret;
  process.env.NODE_ENV = "test";
  delete process.env.PUBLIC_SIGNUP_ENABLED;
});

describe("application startup and fallback", () => {
  it("imports and initializes the Express application", () => {
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe("function");
  });

  it("routes unknown requests through the 404 error flow", async () => {
    const response = await request(app).get("/api/v1/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      status: "fail",
      message: "Can't find /api/v1/does-not-exist on this service!",
    });
  });
});

describe("authentication routes", () => {
  it("makes login available through POST", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "correct-shape" });

    expect(response.status).toBe(401);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: "staff@example.com" },
    });
  });

  it("normalizes login email without changing the password text", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await request(app).post("/api/v1/auth/login").send({ email: "  STAFF@Example.COM ", password: "  unchanged password  " });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { email: "staff@example.com" } });
  });

  it("disables public signup by default without querying Prisma", async () => {
    const response = await request(app).post("/api/v1/auth/signup").send({
      name: "Public User", email: "staff@example.com", password: "secure-password",
    });
    expect(response.status).toBe(403);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("does not execute login through GET", async () => {
    const response = await request(app).get("/api/v1/auth/login");

    expect(response.status).toBe(404);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "MANAGER", "AUDITOR"])(
    "rejects public signup attempts containing the %s role",
    async (role) => {
      const response = await request(app)
        .post("/api/v1/auth/signup")
        .send({
          name: "Public User",
          email: `${role.toLowerCase()}@example.com`,
          password: "secure-password",
          role,
        });

      expect(response.status).toBe(400);
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    },
  );

  it("always creates a valid public signup as STAFF", async () => {
    process.env.PUBLIC_SIGNUP_ENABLED = "true";
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: "new-staff-id",
      name: "Public User",
      email: "staff@example.com",
      role: "STAFF",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await request(app)
      .post("/api/v1/auth/signup")
      .send({
        name: "Public User",
        email: "  STAFF@Example.COM ",
        password: "secure-password",
      });

    expect(response.status).toBe(201);
    expect(response.body.data.user).toMatchObject({ role: "STAFF" });
    expect(response.body.data.user).not.toHaveProperty("password");
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { email: "staff@example.com" } });
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "STAFF" }),
        select: expect.not.objectContaining({ password: true }),
      }),
    );
  });

  it.each([
    ["signup", { name: "A", email: "not-an-email", password: "short" }],
    ["login", { email: "not-an-email", password: "" }],
  ])("rejects invalid %s input before Prisma", async (path, body) => {
    const response = await request(app)
      .post(`/api/v1/auth/${path}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });
});

describe("purchase and sale ID route contracts", () => {
  const transactionClient = {
    purchaseOrder: { findUnique: vi.fn() },
    saleOrder: { findUnique: vi.fn() },
  };

  beforeEach(() => {
    transactionClient.purchaseOrder.findUnique.mockReset().mockResolvedValue(null);
    transactionClient.saleOrder.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue(adminUser);
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback(transactionClient),
    );
  });

  it.each([
    ["purchase update", "patch", "/api/v1/purchase/17", "purchaseOrder", { items: [] }],
    ["purchase return", "post", "/api/v1/purchase/18/return", "purchaseOrder", { items: [{ stockKeepingUnit: "SKU", quantityReturned: 1, warehouseId: 1 }] }],
    ["sale update", "patch", "/api/v1/sale/19", "saleOrder", { items: [] }],
    ["sale return", "post", "/api/v1/sale/20/return", "saleOrder", { items: [{ stockKeepingUnit: "SKU", quantityReturned: 1, warehouseId: 1 }] }],
  ] as const)(
    "provides req.params.id to the %s controller",
    async (_name, method, path, model, body) => {
      const response = await request(app)
        [method](path)
        .set("Authorization", authenticatedRequest())
        .send(body);

      const expectedId = Number(path.match(/\/(\d+)(?:\/return)?$/)?.[1]);
      expect(response.status).toBe(404);
      expect(transactionClient[model].findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: expectedId } }),
      );
    },
  );

  it("accepts the maximum signed 32-bit PostgreSQL Int ID", async () => {
    const maximumId = 2_147_483_647;

    const response = await request(app)
      .patch(`/api/v1/purchase/${maximumId}`)
      .set("Authorization", authenticatedRequest())
      .send({ items: [] });

    expect(response.status).toBe(404);
    expect(transactionClient.purchaseOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: maximumId } }),
    );
  });

  it.each([
    ["patch", "/api/v1/purchase"],
    ["post", "/api/v1/purchase/return"],
    ["patch", "/api/v1/purchase/0"],
    ["patch", "/api/v1/purchase/-1"],
    ["patch", "/api/v1/purchase/1.5"],
    ["post", "/api/v1/purchase/not-a-number/return"],
    ["patch", "/api/v1/sale/0"],
    ["post", "/api/v1/sale/return"],
    ["post", "/api/v1/sale/-2/return"],
    ["patch", "/api/v1/purchase/2147483648"],
    ["patch", `/api/v1/purchase/${Number.MAX_SAFE_INTEGER + 1}`],
    ["patch", `/api/v1/purchase/${"9".repeat(1_000)}`],
    ["patch", `/api/v1/purchase/${`1${"0".repeat(309)}`}`],
  ] as const)("rejects invalid ID on %s %s", async (method, path) => {
    const response = await request(app)[method](path);

    expect(response.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["patch", "/api/v1/purchase/1"],
    ["post", "/api/v1/purchase/1/return"],
    ["patch", "/api/v1/sale/1"],
    ["post", "/api/v1/sale/1/return"],
  ] as const)("keeps valid %s %s routes protected", async (method, path) => {
    const response = await request(app)[method](path).send({ items: [] });

    expect(response.status).toBe(401);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
