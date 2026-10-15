CREATE TABLE "SaleDispatch" (
  "id" SERIAL PRIMARY KEY,
  "saleOrderId" INTEGER NOT NULL REFERENCES "SaleOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL,
  "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SaleDispatch_saleOrderId_dispatchedAt_idx" ON "SaleDispatch"("saleOrderId", "dispatchedAt");

CREATE TABLE "SaleDispatchLine" (
  "id" SERIAL PRIMARY KEY,
  "dispatchId" INTEGER NOT NULL REFERENCES "SaleDispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "fulfillmentId" INTEGER NOT NULL REFERENCES "SaleItemFulfillment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "quantityInOrderUnit" INTEGER NOT NULL,
  "quantityBase" INTEGER NOT NULL,
  CONSTRAINT "SaleDispatchLine_positive_check" CHECK ("quantityInOrderUnit" > 0 AND "quantityBase" > 0)
);
CREATE UNIQUE INDEX "SaleDispatchLine_dispatchId_fulfillmentId_key" ON "SaleDispatchLine"("dispatchId", "fulfillmentId");
CREATE INDEX "SaleDispatchLine_fulfillmentId_idx" ON "SaleDispatchLine"("fulfillmentId");

ALTER TABLE "InventoryPosting" ADD COLUMN "saleDispatchId" INTEGER;
CREATE UNIQUE INDEX "InventoryPosting_saleDispatchId_key" ON "InventoryPosting"("saleDispatchId");
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_saleDispatchId_fkey" FOREIGN KEY ("saleDispatchId") REFERENCES "SaleDispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InventoryPosting" DROP CONSTRAINT "InventoryPosting_singleSource_check";
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_singleSource_check" CHECK (
  num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") <= 1
);
ALTER TABLE "InventoryPosting" DROP CONSTRAINT "InventoryPosting_kindSource_check";
ALTER TABLE "InventoryPosting" ADD CONSTRAINT "InventoryPosting_kindSource_check" CHECK (
  CASE "kind"
    WHEN 'SALE_ISSUE' THEN num_nonnulls("saleOrderId", "saleDispatchId") = 1
      AND num_nonnulls("purchaseReceiptId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'PURCHASE_RECEIPT' THEN "purchaseReceiptId" IS NOT NULL AND num_nonnulls("saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'CUSTOMER_RETURN' THEN "saleReturnId" IS NOT NULL AND num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'SUPPLIER_RETURN' THEN "purchaseReturnId" IS NOT NULL AND num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'RETURN_INSPECTION_RECLASSIFICATION' THEN "returnInspectionId" IS NOT NULL AND num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "reversalOfId") = 0
    WHEN 'REVERSAL' THEN "reversalOfId" IS NOT NULL AND num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "returnInspectionId") = 0
    WHEN 'TRANSFER' THEN num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'ADJUSTMENT' THEN num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    WHEN 'MIGRATION_OPENING_BALANCE' THEN num_nonnulls("purchaseReceiptId", "saleOrderId", "saleDispatchId", "purchaseReturnId", "saleReturnId", "returnInspectionId", "reversalOfId") = 0
    ELSE FALSE
  END
);
