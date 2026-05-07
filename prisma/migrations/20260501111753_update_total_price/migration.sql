/*
  Warnings:

  - Added the required column `amountPaid` to the `PurchaseOrder` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalPurchaseCost` to the `PurchaseOrder` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountPaid` to the `SaleOrder` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalSaleAmount` to the `SaleOrder` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "amountPaid" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "extraCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalPurchaseCost" DECIMAL(10,2) NOT NULL;

-- AlterTable
ALTER TABLE "SaleOrder" ADD COLUMN     "amountPaid" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "totalSaleAmount" DECIMAL(10,2) NOT NULL;
