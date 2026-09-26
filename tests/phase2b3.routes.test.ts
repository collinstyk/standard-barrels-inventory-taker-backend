import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  saleReturn: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  returnInspection: { findUnique: vi.fn() },
  inventoryPosting: { findUnique: vi.fn() },
  purchaseReturn: { findUnique: vi.fn(), findMany: vi.fn() },
  saleItem: { findMany: vi.fn() },
  saleOrder: { findUnique: vi.fn() },
  purchaseOrder: { findUnique: vi.fn() },
  purchaseReceipt: { findFirst: vi.fn(), findUnique: vi.fn() },
  saleAllocation: { count: vi.fn(), aggregate: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("../prisma", () => ({ default: prismaMock, connectToDb: vi.fn(), disconnectFromDb: vi.fn() }));

import app from "../app";

const secret = "phase2b3-route-test-secret";
const token = (id: string) => `Bearer ${jwt.sign({ id }, secret)}`;

describe("Phase 2B-3 route policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = secret;
    process.env.NODE_ENV = "test";
    process.env.INVENTORY_V2_ENABLED = "true";
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
    prismaMock.saleReturn.findMany.mockResolvedValue([]);
    prismaMock.purchaseReturn.findMany.mockResolvedValue([]);
  });

  it.each([
    ["/api/v1/purchase/create", {}],
    ["/api/v1/sale/create", {}],
  ])("forbids AUDITOR order creation at %s", async (path, body) => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "auditor", name: "Audit", email: "audit@test.local", role: "AUDITOR", createdAt: new Date(), updatedAt: new Date() });
    const response = await request(app).post(path).set("Authorization", token("auditor")).set("Idempotency-Key", "auditor-command").send(body);
    expect(response.status).toBe(403);
  });

  it.each(["/api/v1/inventory/adjust", "/api/v1/inventory/transfer"])("blocks legacy-only mutation at %s when V2 is enabled", async (path) => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    const response = await request(app).post(path).set("Authorization", token("admin")).send({});
    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/i);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("requires a client idempotency key on V2 create commands", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    const response = await request(app).post("/api/v1/sale/create").set("Authorization", token("admin")).send({});
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/i);
  });

  it("restricts issued-sale cancellation to ADMIN and MANAGER", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "staff", name: "Staff", email: "staff@test.local", role: "STAFF", createdAt: new Date(), updatedAt: new Date() });
    const response = await request(app).post("/api/v1/sale/1/cancel-issued").set("Authorization", token("staff")).set("Idempotency-Key", "staff-cancel-issued").send({ reason: "Customer cancelled", custodyConfirmation: "GOODS_REMAIN_IN_BUSINESS_CUSTODY" });
    expect(response.status).toBe(403);
  });

  it("requires an idempotency key and strict custody confirmation for issued-sale cancellation", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    const missingKey = await request(app).post("/api/v1/sale/1/cancel-issued").set("Authorization", token("admin")).send({ reason: "Customer cancelled", custodyConfirmation: "GOODS_REMAIN_IN_BUSINESS_CUSTODY" });
    expect(missingKey.status).toBe(400);
    const invalidBody = await request(app).post("/api/v1/sale/1/cancel-issued").set("Authorization", token("admin")).set("Idempotency-Key", "invalid-custody").send({ reason: "Customer cancelled", custodyConfirmation: "YES", unexpected: true });
    expect(invalidBody.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns a controlled response for batch availability while V2 is disabled", async () => {
    process.env.INVENTORY_V2_ENABLED = "false";
    prismaMock.user.findUnique.mockResolvedValue({ id: "auditor", name: "Audit", email: "audit@test.local", role: "AUDITOR", createdAt: new Date(), updatedAt: new Date() });
    const response = await request(app).get(`/api/v1/inventory/availability?productId=${crypto.randomUUID()}&unitId=1`).set("Authorization", token("auditor"));
    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/unavailable/i);
  });

  it("rejects inventory-authoritative purchase fields before the V2 update workflow", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    const response = await request(app).patch("/api/v1/purchase/1").set("Authorization", token("admin")).send({ quantityReceived: 5, items: [] });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/unrecognized|validation/i);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("retains the legacy purchase update delegate while V2 is disabled", async () => {
    process.env.INVENTORY_V2_ENABLED = "false";
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    prismaMock.$transaction.mockRejectedValue(new Error("legacy delegate reached"));
    await request(app).patch("/api/v1/purchase/1").set("Authorization", token("admin")).send({ transactionStatus: "DRAFT", amountPaid: 0, extraCost: 0, items: [] });
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
  });

  it("enforces customer-return mutation roles while allowing auditor reads", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "auditor", name: "Audit", email: "audit@test.local", role: "AUDITOR", createdAt: new Date(), updatedAt: new Date() });
    expect((await request(app).post("/api/v1/sale/1/returns").set("Authorization", token("auditor")).set("Idempotency-Key", "auditor-return").send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/sale/1/returns").set("Authorization", token("auditor"))).status).toBe(200);
    prismaMock.user.findUnique.mockResolvedValue({ id: "staff", name: "Staff", email: "staff@test.local", role: "STAFF", createdAt: new Date(), updatedAt: new Date() });
    expect((await request(app).post("/api/v1/sale/1/returns/1/inspections").set("Authorization", token("staff")).set("Idempotency-Key", "staff-inspection").send({})).status).toBe(403);
    expect((await request(app).post("/api/v1/sale/1/returns").set("Idempotency-Key", "anonymous-return").send({})).status).toBe(401);
  });

  it("returns HTTP 409 for issued-sale and received-purchase cancellation", async () => {
    const admin = { id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() };
    prismaMock.user.findUnique.mockResolvedValue(admin);
    prismaMock.saleOrder.findUnique.mockResolvedValue({ id: 1, transactionStatus: "PENDING", inventoryPosting: { id: "posting", idempotencyKey: "sale-key" }, items: [] });
    prismaMock.purchaseOrder.findUnique.mockResolvedValue({ id: 1, transactionStatus: "PENDING" });
    prismaMock.purchaseReceipt.findFirst.mockResolvedValue({ id: 1 });
    const sale = await request(app).patch("/api/v1/sale/1").set("Authorization", token("admin")).send({ transactionStatus: "CANCELLED" });
    const purchase = await request(app).patch("/api/v1/purchase/1").set("Authorization", token("admin")).send({ transactionStatus: "CANCELLED" });
    expect(sale.status).toBe(409);
    expect(purchase.status).toBe(409);
  });

  it("returns HTTP 409 when cancelling a received customer return", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    prismaMock.saleReturn.findUnique.mockResolvedValue({ id: 1, originalSaleId: 1, status: "RECEIVED", posting: { id: "return-posting" } });
    const response = await request(app).post("/api/v1/sale/1/returns/1/cancel").set("Authorization", token("admin")).send({});
    expect(response.status).toBe(409);
  });

  it("returns HTTP 400 for an inspection checklist incompatible with SELLABLE", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    const checks = { packagingIntact: "PASSED", sealIntact: "PASSED", correctProduct: "FAILED", correctQuantity: "PASSED", expiryChecked: "PASSED", visibleDamage: "PASSED", returnReasonConfirmed: "PASSED" };
    const response = await request(app).post("/api/v1/sale/1/returns/1/inspections").set("Authorization", token("admin")).set("Idempotency-Key", "invalid-inspection").send({ saleReturnItemId: 1, sourceBatchId: crypto.randomUUID(), warehouseId: 1, quantityInOrderUnit: 1, outcome: "SELLABLE", inspectedAt: "2026-07-21T12:00:00.000Z", notes: "Invalid identity evidence", checks });
    expect(response.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns HTTP 409 when a customer-return idempotency key is reused with a different payload", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() });
    let stored: Record<string, unknown> | null = null;
    prismaMock.saleReturn.findUnique.mockImplementation(async (args: { where: { idempotencyKey?: string } }) => args.where.idempotencyKey ? stored : null);
    prismaMock.returnInspection.findUnique.mockResolvedValue(null);
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(null);
    prismaMock.purchaseOrder.findUnique.mockImplementation(async (args: { where: { requestIdempotencyKey?: string } }) => args.where.requestIdempotencyKey ? null : null);
    prismaMock.purchaseReceipt.findUnique.mockResolvedValue(null);
    prismaMock.purchaseReturn.findUnique.mockResolvedValue(null);
    prismaMock.saleOrder.findUnique.mockImplementation(async (args: { where: { requestIdempotencyKey?: string; id?: number } }) => args.where.requestIdempotencyKey ? null : { id: 1, transactionStatus: "PENDING", inventoryPosting: { id: "issued-posting" } });
    prismaMock.saleItem.findMany.mockResolvedValue([{ id: 1, saleId: 1, productId: crypto.randomUUID(), unitMultiplierSnapshot: 1 }]);
    prismaMock.saleAllocation.aggregate.mockResolvedValue({ _sum: { quantityBase: 5 } });
    prismaMock.saleReturn.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      stored = { id: 1, ...args.data, items: [{ id: 1, originalSaleItemId: 1, quantityInOrderUnit: 2, unitMultiplier: 1, quantityBase: 2 }] };
      return stored;
    });
    const first = await request(app).post("/api/v1/sale/1/returns").set("Authorization", token("admin")).set("Idempotency-Key", "return-payload-conflict").send({ reason: "Customer return", items: [{ originalSaleItemId: 1, quantityInOrderUnit: 2 }] });
    const conflict = await request(app).post("/api/v1/sale/1/returns").set("Authorization", token("admin")).set("Idempotency-Key", "return-payload-conflict").send({ reason: "Customer return", items: [{ originalSaleItemId: 1, quantityInOrderUnit: 3 }] });
    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(prismaMock.saleReturn.create).toHaveBeenCalledOnce();
  });

  it("enforces supplier-return roles while allowing STAFF and AUDITOR reads", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "staff", name: "Staff", email: "staff@test.local", role: "STAFF", createdAt: new Date(), updatedAt: new Date() });
    expect((await request(app).post("/api/v1/purchase/1/returns").set("Authorization", token("staff")).set("Idempotency-Key", "staff-supplier-return").send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/purchase/1/returns").set("Authorization", token("staff"))).status).toBe(200);
    prismaMock.user.findUnique.mockResolvedValue({ id: "auditor", name: "Auditor", email: "auditor@test.local", role: "AUDITOR", createdAt: new Date(), updatedAt: new Date() });
    expect((await request(app).post("/api/v1/purchase/1/returns/1/post").set("Authorization", token("auditor")).set("Idempotency-Key", "auditor-supplier-post").send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/purchase/1/returns").set("Authorization", token("auditor"))).status).toBe(200);
  });

  it("returns controlled supplier-return validation, feature, and state responses", async () => {
    const admin = { id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", createdAt: new Date(), updatedAt: new Date() };
    prismaMock.user.findUnique.mockResolvedValue(admin);
    const unknown = await request(app).post("/api/v1/purchase/1/returns").set("Authorization", token("admin")).set("Idempotency-Key", "unknown-field-return").send({ reason: "Supplier return", refundAmount: "0", items: [], force: true });
    expect(unknown.status).toBe(400);
    prismaMock.purchaseReturn.findUnique.mockResolvedValue({ id: 1, originalPurchaseId: 1, status: "POSTED", posting: { id: "supplier-posting" } });
    const conflict = await request(app).post("/api/v1/purchase/1/returns/1/cancel").set("Authorization", token("admin")).send({});
    expect(conflict.status).toBe(409);
    process.env.INVENTORY_V2_ENABLED = "false";
    const disabled = await request(app).post("/api/v1/purchase/1/returns").set("Authorization", token("admin")).set("Idempotency-Key", "disabled-supplier-return").send({});
    expect(disabled.status).toBe(503);
  });

  it("protects supplier-return routes and blocks only the legacy mutation while V2 is enabled", async () => {
    expect((await request(app).post("/api/v1/purchase/1/returns").set("Idempotency-Key", "anonymous-supplier-return").send({})).status).toBe(401);
    prismaMock.user.findUnique.mockResolvedValue({ id: "manager", name: "Manager", email: "manager@test.local", role: "MANAGER", createdAt: new Date(), updatedAt: new Date() });
    const allowedThroughRole = await request(app).post("/api/v1/purchase/1/returns").set("Authorization", token("manager")).set("Idempotency-Key", "manager-supplier-return").send({});
    expect(allowedThroughRole.status).toBe(400);
    const legacy = await request(app).post("/api/v1/purchase/1/return").set("Authorization", token("manager")).send({});
    expect(legacy.status).toBe(503);
    expect(legacy.body.message).toMatch(/temporarily unavailable/i);
  });
});
