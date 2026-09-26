ALTER TABLE "SaleReturn" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "receiveFingerprint" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "notes" TEXT;
ALTER TABLE "SaleReturnItem" ALTER COLUMN "destinationWarehouseId" DROP NOT NULL;

DROP INDEX IF EXISTS "ReturnInspection_saleReturnItemId_key";
ALTER TABLE "ReturnInspection" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "ReturnInspection" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "ReturnInspection" ADD COLUMN "sourceBatchId" TEXT;
ALTER TABLE "ReturnInspection" ADD COLUMN "destinationBatchId" TEXT;
ALTER TABLE "ReturnInspection" ADD COLUMN "finalWarehouseId" INTEGER;
ALTER TABLE "ReturnInspection" ADD COLUMN "quantityBase" INTEGER;

CREATE UNIQUE INDEX "ReturnInspection_idempotencyKey_key" ON "ReturnInspection"("idempotencyKey");
CREATE UNIQUE INDEX "ReturnInspection_destinationBatchId_key" ON "ReturnInspection"("destinationBatchId");
CREATE INDEX "ReturnInspection_saleReturnItemId_inspectedAt_idx" ON "ReturnInspection"("saleReturnItemId", "inspectedAt");
CREATE INDEX "ReturnInspection_sourceBatchId_inspectedAt_idx" ON "ReturnInspection"("sourceBatchId", "inspectedAt");

ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_destinationBatchId_fkey" FOREIGN KEY ("destinationBatchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_finalWarehouseId_fkey" FOREIGN KEY ("finalWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_quantityBase_check" CHECK ("quantityBase" IS NULL OR "quantityBase" > 0);
ALTER TABLE "ReturnInspection" DROP CONSTRAINT "ReturnInspection_finalCondition_check";
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_finalCondition_check" CHECK ("finalCondition" IN ('SELLABLE', 'DAMAGED', 'REJECTED'));
