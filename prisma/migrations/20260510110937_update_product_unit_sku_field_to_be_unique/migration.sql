/*
  Warnings:

  - A unique constraint covering the columns `[sku]` on the table `ProductUnit` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ProductUnit_sku_key" ON "ProductUnit"("sku");
