import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createV2SaleOrder } from "../../services/inventory/orderWorkflows";
import { cancelIssuedPendingSale } from "../../services/inventory/saleCancellation";
import { cancelSaleReturn, createSaleReturn } from "../../services/inventory/saleReturn";
import { POSTGRES_INTEGER_MAX } from "../../services/inventory/validation";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";

const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);
const input = { reason: "Customer cancelled while goods remain in the warehouse", custodyConfirmation: "GOODS_REMAIN_IN_BUSINESS_CUSTODY" } as const;

describe.skipIf(!hasTestDatabase)("Phase 2B-4C-1 sale-issue cancellation on disposable PostgreSQL", () => {
  let harness: IntegrationHarness;
  beforeAll(async () => { harness = createIntegrationHarness(); await clearDisposableDatabase(harness); }, 60_000);
  afterEach(async () => clearDisposableDatabase(harness));
  afterAll(async () => harness?.client.$disconnect());

  async function fixture(quantity = 6) {
    const suffix = randomUUID();
    const user = await harness.client.user.create({ data: { name: "Cancellation Admin", email: `${suffix}@cancel.test`, password: "local-test-only", role: "ADMIN" } });
    const category = await harness.client.category.create({ data: { name: `Cancel ${suffix}` } });
    const product = await harness.client.product.create({ data: { name: `Cancel product ${suffix}`, baseUnit: "piece", categoryId: category.id, quantityInStock: quantity } });
    const unit = await harness.client.productUnit.create({ data: { name: "piece", multiplier: 1, price: "2", sku: `CAN-${suffix}`, productId: product.id } });
    const warehouse = await harness.client.warehouse.create({ data: { name: `Cancel warehouse ${suffix}` } });
    const batch = await harness.client.inventoryBatch.create({ data: { productId: product.id, warehouseId: warehouse.id, quantityOnHandBase: quantity, receivedAt: new Date("2026-01-01T00:00:00Z"), disposition: "SELLABLE" } });
    const created = await createV2SaleOrder(harness.client, { transactionStatus: "PENDING", amountPaid: "0", extraCost: "0", items: [{ productId: product.id, unitId: unit.id, quantityOrdered: quantity, quantityDelivered: 0, confirmedUnitSalePrice: "10", fulfillments: [{ warehouseId: warehouse.id, quantityInOrderUnit: quantity }] }] }, user.id, `issued-${suffix}`);
    return { user, product, unit, warehouse, batch, sale: created.sale, issuePostingId: created.posting!.postingId };
  }

  it("atomically cancels an eligible pending sale and restores its exact batch and cache", async () => {
    const f = await fixture();
    const result = await cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-issued-success");
    expect(result.sale.transactionStatus).toBe("CANCELLED");
    expect(result.reversal).toMatchObject({ originalPosting: { id: f.issuePostingId, status: "REVERSED" }, reversalPosting: { kind: "REVERSAL", status: "POSTED", reason: input.reason }, groupedQuantities: [{ productId: f.product.id, quantityBase: 6 }], movementCount: 1 });
    expect(result.reversal).not.toHaveProperty("totalRestored");
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).quantityOnHandBase).toBe(6);
    expect((await harness.client.product.findUniqueOrThrow({ where: { id: f.product.id } })).quantityInStock).toBe(6);
    expect((await harness.client.inventoryPosting.findUniqueOrThrow({ where: { id: f.issuePostingId } })).status).toBe("REVERSED");
    const reversal = await harness.client.inventoryPosting.findUniqueOrThrow({ where: { idempotencyKey: "cancel-issued-success" }, include: { movements: true } });
    expect(reversal).toMatchObject({ kind: "REVERSAL", status: "POSTED", reversalOfId: f.issuePostingId });
    expect(reversal.movements[0]).toMatchObject({ type: "REVERSAL", batchId: f.batch.id, productId: f.product.id, warehouseId: f.warehouse.id, quantityChangeBase: 6 });
    expect(await harness.client.saleAllocation.count({ where: { saleItem: { saleId: f.sale.id } } })).toBe(1);
  });

  it("replays the same command without duplicate restoration and rejects changed payloads or cross-command keys", async () => {
    const f = await fixture(3);
    const first = await cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-replay");
    const replay = await cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-replay");
    expect(replay.replayed).toBe(true);
    expect(replay.reversal.reversalPosting.id).toBe(first.reversal.reversalPosting.id);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).quantityOnHandBase).toBe(3);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "REVERSAL" } })).toBe(1);
    await expect(cancelIssuedPendingSale(harness.client, f.sale.id, { ...input, reason: "Different reason" }, f.user.id, "cancel-replay")).rejects.toThrow(/idempotency/i);
    const other = await fixture(1);
    await expect(cancelIssuedPendingSale(harness.client, other.sale.id, input, other.user.id, `issued-${other.user.email!.split("@")[0]}`)).rejects.toThrow(/idempotency/i);
  });

  it("allows only one winner under concurrent duplicate cancellation", async () => {
    const f = await fixture(4);
    const results = await Promise.all([cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-concurrent"), cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-concurrent")]);
    expect(results[0].reversal.reversalPosting.id).toBe(results[1].reversal.reversalPosting.id);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "REVERSAL" } })).toBe(1);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).quantityOnHandBase).toBe(4);
  });

  it("allows only one winner for concurrent different-key cancellation", async () => {
    const f = await fixture(4);
    const outcomes = await Promise.allSettled([cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-key-a"), cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-key-b")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "REVERSAL" } })).toBe(1);
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).quantityOnHandBase).toBe(4);
  });

  it("rejects missing and inconsistent issue histories", async () => {
    const f = await fixture(2);
    const draft = await createV2SaleOrder(harness.client, { transactionStatus: "DRAFT", amountPaid: "0", extraCost: "0", items: [{ productId: f.product.id, unitId: f.unit.id, quantityOrdered: 1, quantityDelivered: 0, confirmedUnitSalePrice: "1", fulfillments: [{ warehouseId: f.warehouse.id, quantityInOrderUnit: 1 }] }] }, f.user.id, "draft-without-issue");
    await expect(cancelIssuedPendingSale(harness.client, draft.sale.id, input, f.user.id, "cancel-draft")).rejects.toThrow(/pending/i);
    await harness.client.stockMovement.deleteMany({ where: { postingId: f.issuePostingId } });
    await expect(cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-missing-history")).rejects.toThrow(/movement history/i);
    expect((await harness.client.saleOrder.findUniqueOrThrow({ where: { id: f.sale.id } })).transactionStatus).toBe("PENDING");
  });

  it("rejects delivered, completed, and already-reversed sales", async () => {
    const delivered = await fixture(2);
    await harness.client.saleItem.updateMany({ where: { saleId: delivered.sale.id }, data: { quantityDelivered: 1 } });
    await expect(cancelIssuedPendingSale(harness.client, delivered.sale.id, input, delivered.user.id, "cancel-delivered")).rejects.toThrow(/delivered/i);
    const completed = await fixture(2);
    await harness.client.saleOrder.update({ where: { id: completed.sale.id }, data: { transactionStatus: "COMPLETED" } });
    await expect(cancelIssuedPendingSale(harness.client, completed.sale.id, input, completed.user.id, "cancel-completed")).rejects.toThrow(/pending/i);
    const reversed = await fixture(2);
    await cancelIssuedPendingSale(harness.client, reversed.sale.id, input, reversed.user.id, "cancel-first");
    await expect(cancelIssuedPendingSale(harness.client, reversed.sale.id, input, reversed.user.id, "cancel-second")).rejects.toThrow(/idempotency/i);
  });

  it("blocks cancellation while a customer return is active and permits it after draft-return cancellation", async () => {
    const f = await fixture(2);
    const draft = await createSaleReturn(harness.client, f.sale.id, { reason: "Return created before cancellation", items: [{ originalSaleItemId: f.sale.items[0]!.id, quantityInOrderUnit: 1 }] }, f.user.id, "draft-before-cancel");
    await expect(cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-with-return")).rejects.toThrow(/customer return/i);
    await cancelSaleReturn(harness.client, f.sale.id, draft.saleReturn.id);
    expect((await cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-after-return")).sale.transactionStatus).toBe("CANCELLED");
  });

  it("serializes cancellation against customer-return creation without a mixed outcome", async () => {
    const f = await fixture(2);
    const outcomes = await Promise.allSettled([
      cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-return-race"),
      createSaleReturn(harness.client, f.sale.id, { reason: "Concurrent customer return", items: [{ originalSaleItemId: f.sale.items[0]!.id, quantityInOrderUnit: 1 }] }, f.user.id, "return-cancel-race"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const sale = await harness.client.saleOrder.findUniqueOrThrow({ where: { id: f.sale.id }, include: { inventoryPosting: { include: { reversedBy: true } }, saleReturns: true } });
    if (sale.transactionStatus === "CANCELLED") {
      expect(sale.inventoryPosting?.status).toBe("REVERSED");
      expect(sale.inventoryPosting?.reversedBy).not.toBeNull();
      expect(sale.saleReturns).toHaveLength(0);
    } else {
      expect(sale.transactionStatus).toBe("PENDING");
      expect(sale.inventoryPosting?.status).toBe("POSTED");
      expect(sale.saleReturns).toHaveLength(1);
    }
  });

  it("rolls back every reversal change when cache restoration cannot be represented", async () => {
    const f = await fixture(2);
    await harness.client.product.update({ where: { id: f.product.id }, data: { quantityInStock: POSTGRES_INTEGER_MAX } });
    await expect(cancelIssuedPendingSale(harness.client, f.sale.id, input, f.user.id, "cancel-overflow")).rejects.toThrow(/range/i);
    expect((await harness.client.saleOrder.findUniqueOrThrow({ where: { id: f.sale.id } })).transactionStatus).toBe("PENDING");
    expect((await harness.client.inventoryPosting.findUniqueOrThrow({ where: { id: f.issuePostingId } })).status).toBe("POSTED");
    expect((await harness.client.inventoryBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).quantityOnHandBase).toBe(0);
    expect(await harness.client.inventoryPosting.count({ where: { kind: "REVERSAL" } })).toBe(0);
  });
});
