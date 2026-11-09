ALTER TABLE "Product"
  ADD COLUMN "defaultCostBase" DECIMAL(18,4),
  ADD COLUMN "lastReceivedCostBase" DECIMAL(18,4);

ALTER TABLE "InventoryBatch"
  ADD COLUMN "unitCostBase" DECIMAL(24,8);
