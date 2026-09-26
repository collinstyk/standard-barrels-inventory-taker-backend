/*
  Warnings:

  - A unique constraint covering the columns `[productId,warehouseId,expiryDate]` on the table `StockLevel` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "StockLevel_productId_warehouseId_key";

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_productId_warehouseId_expiryDate_key" ON "StockLevel"("productId", "warehouseId", "expiryDate");
