-- DropForeignKey
ALTER TABLE "ReturnInspection" DROP CONSTRAINT "ReturnInspection_destinationBatchId_fkey";

-- DropForeignKey
ALTER TABLE "ReturnInspection" DROP CONSTRAINT "ReturnInspection_finalWarehouseId_fkey";

-- DropForeignKey
ALTER TABLE "ReturnInspection" DROP CONSTRAINT "ReturnInspection_sourceBatchId_fkey";

-- DropForeignKey
ALTER TABLE "SaleAllocation" DROP CONSTRAINT "SaleAllocation_fulfillmentId_fkey";

-- DropForeignKey
ALTER TABLE "SaleReturnItem" DROP CONSTRAINT "SaleReturnItem_destinationWarehouseId_fkey";

-- AlterTable
ALTER TABLE "SaleDispatchLine" ADD COLUMN     "saleItemId" INTEGER;

-- AddForeignKey
ALTER TABLE "SaleDispatchLine" ADD CONSTRAINT "SaleDispatchLine_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAllocation" ADD CONSTRAINT "SaleAllocation_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "SaleItemFulfillment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_destinationBatchId_fkey" FOREIGN KEY ("destinationBatchId") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnInspection" ADD CONSTRAINT "ReturnInspection_finalWarehouseId_fkey" FOREIGN KEY ("finalWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "InventoryBatch_productId_warehouseId_disposition_expiryDate_rec" RENAME TO "InventoryBatch_productId_warehouseId_disposition_expiryDate_idx";
