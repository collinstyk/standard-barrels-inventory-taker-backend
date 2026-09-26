-- Phase 2B-1 inventory-domain foundation. This migration is additive and
-- intentionally does not backfill or post inventory for existing orders.

CREATE TYPE "BatchDisposition" AS ENUM ('SELLABLE', 'DAMAGED', 'QUARANTINED', 'EXPIRED');
CREATE TYPE "PostingKind" AS ENUM ('PURCHASE_RECEIPT', 'SALE_ISSUE', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'TRANSFER', 'ADJUSTMENT', 'REVERSAL', 'MIGRATION_OPENING_BALANCE', 'RETURN_INSPECTION_RECLASSIFICATION');
CREATE TYPE "PostingStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE_RECEIPT', 'SALE_ISSUE', 'CUSTOMER_RETURN_QUARANTINED', 'CUSTOMER_RETURN_SELLABLE', 'CUSTOMER_RETURN_DAMAGED', 'SUPPLIER_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'POSITIVE_ADJUSTMENT', 'NEGATIVE_ADJUSTMENT', 'EXPIRY_RECLASSIFICATION', 'RETURN_INSPECTION_RECLASSIFICATION', 'REVERSAL', 'MIGRATION_OPENING_BALANCE');
CREATE TYPE "ReceiptStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');
CREATE TYPE "ReturnStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED');
CREATE TYPE "ReturnCondition" AS ENUM ('QUARANTINED', 'SELLABLE', 'DAMAGED');
CREATE TYPE "InspectionCheckResult" AS ENUM ('PASSED', 'FAILED', 'NOT_APPLICABLE');

ALTER TABLE "SaleItem"
  ADD COLUMN "sourceWarehouseId" INTEGER,
  ADD COLUMN "unitMultiplierSnapshot" INTEGER,
  ADD COLUMN "confirmedUnitSalePrice" DECIMAL(18,4);

ALTER TABLE "PurchaseItem"
  ADD COLUMN "unitMultiplierSnapshot" INTEGER,
  ADD COLUMN "agreedUnitCost" DECIMAL(18,4);

CREATE TABLE "PurchaseReceipt" (
  "id" SERIAL NOT NULL,
  "purchaseOrderId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "ReceiptStatus" NOT NULL DEFAULT 'DRAFT',
  "receivedById" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedAt" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseReceiptItem" (
  "id" SERIAL NOT NULL,
  "receiptId" INTEGER NOT NULL,
  "purchaseItemId" INTEGER NOT NULL,
  "warehouseId" INTEGER NOT NULL,
  "quantityInOrderUnit" INTEGER NOT NULL,
  "unitMultiplier" INTEGER NOT NULL,
  "quantityBase" INTEGER NOT NULL,
  "actualUnitCost" DECIMAL(18,4) NOT NULL,
  "expiryDate" DATE,
  CONSTRAINT "PurchaseReceiptItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseReturn" (
  "id" SERIAL NOT NULL,
  "originalPurchaseId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "ReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "processedById" TEXT NOT NULL,
  "refundAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedAt" TIMESTAMP(3),
  CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleReturn" (
  "id" SERIAL NOT NULL,
  "originalSaleId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "ReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "processedById" TEXT NOT NULL,
  "refundAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedAt" TIMESTAMP(3),
  CONSTRAINT "SaleReturn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleReturnItem" (
  "id" SERIAL NOT NULL,
  "saleReturnId" INTEGER NOT NULL,
  "originalSaleItemId" INTEGER NOT NULL,
  "destinationWarehouseId" INTEGER NOT NULL,
  "quantityInOrderUnit" INTEGER NOT NULL,
  "unitMultiplier" INTEGER NOT NULL,
  "quantityBase" INTEGER NOT NULL,
  "expiryDate" DATE,
  "condition" "ReturnCondition" NOT NULL DEFAULT 'QUARANTINED',
  "refundedUnitPrice" DECIMAL(18,4),
  CONSTRAINT "SaleReturnItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReturnInspection" (
  "id" SERIAL NOT NULL,
  "saleReturnItemId" INTEGER NOT NULL,
  "inspectorId" TEXT NOT NULL,
  "inspectedAt" TIMESTAMP(3) NOT NULL,
  "packagingIntact" "InspectionCheckResult" NOT NULL,
  "sealIntact" "InspectionCheckResult" NOT NULL,
  "correctProduct" "InspectionCheckResult" NOT NULL,
  "correctQuantity" "InspectionCheckResult" NOT NULL,
  "expiryChecked" "InspectionCheckResult" NOT NULL,
  "visibleDamage" "InspectionCheckResult" NOT NULL,
  "returnReasonConfirmed" "InspectionCheckResult" NOT NULL,
  "finalCondition" "ReturnCondition" NOT NULL,
  "notes" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnInspection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryBatch" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "warehouseId" INTEGER NOT NULL,
  "expiryDate" DATE,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "quantityOnHandBase" INTEGER NOT NULL,
  "disposition" "BatchDisposition" NOT NULL DEFAULT 'SELLABLE',
  "purchaseReceiptItemId" INTEGER,
  "saleReturnItemId" INTEGER,
  "sourceBatchId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryPosting" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "kind" "PostingKind" NOT NULL,
  "status" "PostingStatus" NOT NULL DEFAULT 'POSTED',
  "performedById" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes" TEXT,
  "purchaseReceiptId" INTEGER,
  "saleOrderId" INTEGER,
  "purchaseReturnId" INTEGER,
  "saleReturnId" INTEGER,
  "returnInspectionId" INTEGER,
  "reversalOfId" TEXT,
  CONSTRAINT "InventoryPosting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockMovement" (
  "id" TEXT NOT NULL,
  "postingId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "StockMovementType" NOT NULL,
  "productId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "warehouseId" INTEGER NOT NULL,
  "sourceWarehouseId" INTEGER,
  "destinationWarehouseId" INTEGER,
  "quantityChangeBase" INTEGER NOT NULL,
  "performedById" TEXT NOT NULL,
  "adjustmentReason" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleAllocation" (
  "id" SERIAL NOT NULL,
  "saleItemId" INTEGER NOT NULL,
  "batchId" TEXT NOT NULL,
  "quantityBase" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseReturnItem" (
  "id" SERIAL NOT NULL,
  "purchaseReturnId" INTEGER NOT NULL,
  "originalPurchaseItemId" INTEGER NOT NULL,
  "sourceBatchId" TEXT NOT NULL,
  "sourceWarehouseId" INTEGER NOT NULL,
  "quantityInOrderUnit" INTEGER NOT NULL,
  "unitMultiplier" INTEGER NOT NULL,
  "quantityBase" INTEGER NOT NULL,
  "refundedUnitCost" DECIMAL(18,4),
  CONSTRAINT "PurchaseReturnItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseReceipt_idempotencyKey_key" ON "PurchaseReceipt"("idempotencyKey");
CREATE INDEX "PurchaseReceipt_purchaseOrderId_status_idx" ON "PurchaseReceipt"("purchaseOrderId", "status");
CREATE INDEX "PurchaseReceipt_receivedById_receivedAt_idx" ON "PurchaseReceipt"("receivedById", "receivedAt");
CREATE INDEX "PurchaseReceiptItem_receiptId_idx" ON "PurchaseReceiptItem"("receiptId");
CREATE INDEX "PurchaseReceiptItem_purchaseItemId_idx" ON "PurchaseReceiptItem"("purchaseItemId");
CREATE INDEX "PurchaseReceiptItem_warehouseId_expiryDate_idx" ON "PurchaseReceiptItem"("warehouseId", "expiryDate");
CREATE UNIQUE INDEX "PurchaseReturn_idempotencyKey_key" ON "PurchaseReturn"("idempotencyKey");
CREATE INDEX "PurchaseReturn_originalPurchaseId_status_idx" ON "PurchaseReturn"("originalPurchaseId", "status");
CREATE INDEX "PurchaseReturn_processedById_createdAt_idx" ON "PurchaseReturn"("processedById", "createdAt");
CREATE UNIQUE INDEX "SaleReturn_idempotencyKey_key" ON "SaleReturn"("idempotencyKey");
CREATE INDEX "SaleReturn_originalSaleId_status_idx" ON "SaleReturn"("originalSaleId", "status");
CREATE INDEX "SaleReturn_processedById_createdAt_idx" ON "SaleReturn"("processedById", "createdAt");
CREATE INDEX "SaleReturnItem_saleReturnId_idx" ON "SaleReturnItem"("saleReturnId");
CREATE INDEX "SaleReturnItem_originalSaleItemId_idx" ON "SaleReturnItem"("originalSaleItemId");
CREATE INDEX "SaleReturnItem_destinationWarehouseId_condition_idx" ON "SaleReturnItem"("destinationWarehouseId", "condition");
CREATE UNIQUE INDEX "ReturnInspection_saleReturnItemId_key" ON "ReturnInspection"("saleReturnItemId");
CREATE INDEX "ReturnInspection_inspectorId_inspectedAt_idx" ON "ReturnInspection"("inspectorId", "inspectedAt");
CREATE INDEX "InventoryBatch_productId_warehouseId_disposition_idx" ON "InventoryBatch"("productId", "warehouseId", "disposition");
CREATE INDEX "InventoryBatch_productId_warehouseId_disposition_expiryDate_receivedAt_idx" ON "InventoryBatch"("productId", "warehouseId", "disposition", "expiryDate", "receivedAt");
CREATE INDEX "InventoryBatch_productId_warehouseId_disposition_receivedAt_idx" ON "InventoryBatch"("productId", "warehouseId", "disposition", "receivedAt");
CREATE INDEX "InventoryBatch_expiryDate_idx" ON "InventoryBatch"("expiryDate");
CREATE INDEX "InventoryBatch_sourceBatchId_idx" ON "InventoryBatch"("sourceBatchId");
CREATE INDEX "InventoryBatch_purchaseReceiptItemId_idx" ON "InventoryBatch"("purchaseReceiptItemId");
CREATE INDEX "InventoryBatch_saleReturnItemId_idx" ON "InventoryBatch"("saleReturnItemId");
CREATE INDEX "InventoryBatch_fefo_available_idx" ON "InventoryBatch"("productId", "warehouseId", "expiryDate", "receivedAt", "id") WHERE "disposition" = 'SELLABLE' AND "quantityOnHandBase" > 0 AND "expiryDate" IS NOT NULL;
CREATE INDEX "InventoryBatch_fifo_available_idx" ON "InventoryBatch"("productId", "warehouseId", "receivedAt", "id") WHERE "disposition" = 'SELLABLE' AND "quantityOnHandBase" > 0 AND "expiryDate" IS NULL;
CREATE UNIQUE INDEX "InventoryPosting_idempotencyKey_key" ON "InventoryPosting"("idempotencyKey");
CREATE UNIQUE INDEX "InventoryPosting_purchaseReceiptId_key" ON "InventoryPosting"("purchaseReceiptId");
CREATE UNIQUE INDEX "InventoryPosting_saleOrderId_key" ON "InventoryPosting"("saleOrderId");
CREATE UNIQUE INDEX "InventoryPosting_purchaseReturnId_key" ON "InventoryPosting"("purchaseReturnId");
CREATE UNIQUE INDEX "InventoryPosting_saleReturnId_key" ON "InventoryPosting"("saleReturnId");
CREATE UNIQUE INDEX "InventoryPosting_returnInspectionId_key" ON "InventoryPosting"("returnInspectionId");
CREATE UNIQUE INDEX "InventoryPosting_reversalOfId_key" ON "InventoryPosting"("reversalOfId");
CREATE INDEX "InventoryPosting_performedById_postedAt_idx" ON "InventoryPosting"("performedById", "postedAt");
CREATE INDEX "InventoryPosting_kind_postedAt_idx" ON "InventoryPosting"("kind", "postedAt");
CREATE UNIQUE INDEX "StockMovement_postingId_sequence_key" ON "StockMovement"("postingId", "sequence");
CREATE INDEX "StockMovement_batchId_createdAt_idx" ON "StockMovement"("batchId", "createdAt");
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");
CREATE INDEX "StockMovement_warehouseId_createdAt_idx" ON "StockMovement"("warehouseId", "createdAt");
CREATE INDEX "StockMovement_sourceWarehouseId_createdAt_idx" ON "StockMovement"("sourceWarehouseId", "createdAt");
CREATE INDEX "StockMovement_destinationWarehouseId_createdAt_idx" ON "StockMovement"("destinationWarehouseId", "createdAt");
CREATE INDEX "StockMovement_performedById_createdAt_idx" ON "StockMovement"("performedById", "createdAt");
CREATE UNIQUE INDEX "SaleAllocation_saleItemId_batchId_key" ON "SaleAllocation"("saleItemId", "batchId");
CREATE INDEX "SaleAllocation_saleItemId_idx" ON "SaleAllocation"("saleItemId");
CREATE INDEX "SaleAllocation_batchId_idx" ON "SaleAllocation"("batchId");
CREATE INDEX "PurchaseReturnItem_purchaseReturnId_idx" ON "PurchaseReturnItem"("purchaseReturnId");
CREATE INDEX "PurchaseReturnItem_originalPurchaseItemId_idx" ON "PurchaseReturnItem"("originalPurchaseItemId");
CREATE INDEX "PurchaseReturnItem_sourceBatchId_idx" ON "PurchaseReturnItem"("sourceBatchId");
CREATE INDEX "PurchaseReturnItem_sourceWarehouseId_idx" ON "PurchaseReturnItem"("sourceWarehouseId");
CREATE INDEX "SaleItem_sourceWarehouseId_idx" ON "SaleItem"("sourceWarehouseId");

ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_unitMultiplierSnapshot_check" CHECK ("unitMultiplierSnapshot" IS NULL OR "unitMultiplierSnapshot" > 0);
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_confirmedUnitSalePrice_check" CHECK ("confirmedUnitSalePrice" IS NULL OR "confirmedUnitSalePrice" >= 0);
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_unitMultiplierSnapshot_check" CHECK ("unitMultiplierSnapshot" IS NULL OR "unitMultiplierSnapshot" > 0);
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_agreedUnitCost_check" CHECK ("agreedUnitCost" IS NULL OR "agreedUnitCost" >= 0);
ALTER TABLE "PurchaseReceiptItem" ADD CONSTRAINT "PurchaseReceiptItem_quantities_check" CHECK ("quantityInOrderUnit" > 0 AND "unitMultiplier" > 0 AND "quantityBase" > 0);
ALTER TABLE "PurchaseReceiptItem" ADD CONSTRAINT "PurchaseReceiptItem_actualUnitCost_check" CHECK ("actualUnitCost" >= 0);
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_refundAmount_check" CHECK ("refundAmount" >= 0);
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_refundAmount_check" CHECK ("refundAmount" >= 0);
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_quantities_check" CHECK ("quantityInOrderUnit" > 0 AND "unitMultiplier" > 0 AND "quantityBase" > 0);
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_refundedUnitPrice_check" CHECK ("refundedUnitPrice" IS NULL OR "refundedUnitPrice" >= 0);
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_finalCondition_check" CHECK ("finalCondition" IN ('SELLABLE', 'DAMAGED'));
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_quantityOnHandBase_check" CHECK ("quantityOnHandBase" >= 0);
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_reversalOfId_check" CHECK ("reversalOfId" IS NULL OR "reversalOfId" <> "id");
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_singleSource_check" CHECK (
  num_nonnulls(
    "purchaseReceiptId",
    "saleOrderId",
    "purchaseReturnId",
    "saleReturnId",
    "returnInspectionId",
    "reversalOfId"
  ) <= 1
);
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_kindSource_check" CHECK (
  CASE "kind"
    WHEN 'SALE_ISSUE' THEN
      "saleOrderId" IS NOT NULL
      AND "purchaseReceiptId" IS NULL
      AND "purchaseReturnId" IS NULL
      AND "saleReturnId" IS NULL
      AND "returnInspectionId" IS NULL
      AND "reversalOfId" IS NULL
    WHEN 'PURCHASE_RECEIPT' THEN
      "purchaseReceiptId" IS NOT NULL
      AND "saleOrderId" IS NULL
      AND "purchaseReturnId" IS NULL
      AND "saleReturnId" IS NULL
      AND "returnInspectionId" IS NULL
      AND "reversalOfId" IS NULL
    WHEN 'CUSTOMER_RETURN' THEN
      "saleReturnId" IS NOT NULL
      AND "purchaseReceiptId" IS NULL
      AND "saleOrderId" IS NULL
      AND "purchaseReturnId" IS NULL
      AND "returnInspectionId" IS NULL
      AND "reversalOfId" IS NULL
    WHEN 'SUPPLIER_RETURN' THEN
      "purchaseReturnId" IS NOT NULL
      AND "purchaseReceiptId" IS NULL
      AND "saleOrderId" IS NULL
      AND "saleReturnId" IS NULL
      AND "returnInspectionId" IS NULL
      AND "reversalOfId" IS NULL
    WHEN 'RETURN_INSPECTION_RECLASSIFICATION' THEN
      "returnInspectionId" IS NOT NULL
      AND "purchaseReceiptId" IS NULL
      AND "saleOrderId" IS NULL
      AND "purchaseReturnId" IS NULL
      AND "saleReturnId" IS NULL
      AND "reversalOfId" IS NULL
    WHEN 'REVERSAL' THEN
      "reversalOfId" IS NOT NULL
      AND "purchaseReceiptId" IS NULL
      AND "saleOrderId" IS NULL
      AND "purchaseReturnId" IS NULL
      AND "saleReturnId" IS NULL
      AND "returnInspectionId" IS NULL
    WHEN 'TRANSFER' THEN
      num_nonnulls("purchaseReceiptId", "saleOrderId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'ADJUSTMENT' THEN
      num_nonnulls("purchaseReceiptId", "saleOrderId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'MIGRATION_OPENING_BALANCE' THEN
      num_nonnulls("purchaseReceiptId", "saleOrderId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    ELSE FALSE
  END
);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_quantityChangeBase_check" CHECK ("quantityChangeBase" <> 0);
ALTER TABLE "SaleAllocation" ADD CONSTRAINT "SaleAllocation_quantityBase_check" CHECK ("quantityBase" > 0);
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_quantities_check" CHECK ("quantityInOrderUnit" > 0 AND "unitMultiplier" > 0 AND "quantityBase" > 0);
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_refundedUnitCost_check" CHECK ("refundedUnitCost" IS NULL OR "refundedUnitCost" >= 0);

ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceiptItem" ADD CONSTRAINT "PurchaseReceiptItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PurchaseReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceiptItem" ADD CONSTRAINT "PurchaseReceiptItem_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "PurchaseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceiptItem" ADD CONSTRAINT "PurchaseReceiptItem_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_originalPurchaseId_fkey" FOREIGN KEY ("originalPurchaseId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_originalSaleId_fkey" FOREIGN KEY ("originalSaleId") REFERENCES "SaleOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "SaleReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_originalSaleItemId_fkey" FOREIGN KEY ("originalSaleItemId") REFERENCES "SaleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_saleReturnItemId_fkey" FOREIGN KEY ("saleReturnItemId") REFERENCES "SaleReturnItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_inspectorId_fkey" FOREIGN KEY ("inspectorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_purchaseReceiptItemId_fkey" FOREIGN KEY ("purchaseReceiptItemId") REFERENCES "PurchaseReceiptItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_saleReturnItemId_fkey" FOREIGN KEY ("saleReturnItemId") REFERENCES "SaleReturnItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_purchaseReceiptId_fkey" FOREIGN KEY ("purchaseReceiptId") REFERENCES "PurchaseReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_saleOrderId_fkey" FOREIGN KEY ("saleOrderId") REFERENCES "SaleOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "PurchaseReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "SaleReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_returnInspectionId_fkey" FOREIGN KEY ("returnInspectionId") REFERENCES "ReturnInspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "InventoryPosting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "InventoryPosting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleAllocation" ADD CONSTRAINT "SaleAllocation_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleAllocation" ADD CONSTRAINT "SaleAllocation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "PurchaseReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_originalPurchaseItemId_fkey" FOREIGN KEY ("originalPurchaseItemId") REFERENCES "PurchaseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
