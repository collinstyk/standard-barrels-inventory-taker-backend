-- Phase 2B-3: additive request identity for atomic/idempotent order creation.
ALTER TABLE "SaleOrder" ADD COLUMN "requestIdempotencyKey" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "requestIdempotencyKey" TEXT;

CREATE UNIQUE INDEX "SaleOrder_requestIdempotencyKey_key" ON "SaleOrder"("requestIdempotencyKey");
CREATE UNIQUE INDEX "PurchaseOrder_requestIdempotencyKey_key" ON "PurchaseOrder"("requestIdempotencyKey");
