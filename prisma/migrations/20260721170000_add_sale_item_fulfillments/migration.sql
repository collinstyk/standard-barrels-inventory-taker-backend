CREATE TABLE "SaleItemFulfillment" (
    "id" SERIAL NOT NULL,
    "saleItemId" INTEGER NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "quantityInOrderUnit" INTEGER NOT NULL,
    "unitMultiplierSnapshot" INTEGER NOT NULL,
    "quantityBase" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaleItemFulfillment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SaleItemFulfillment_positive_quantity_check" CHECK ("quantityInOrderUnit" > 0),
    CONSTRAINT "SaleItemFulfillment_positive_multiplier_check" CHECK ("unitMultiplierSnapshot" > 0),
    CONSTRAINT "SaleItemFulfillment_positive_base_quantity_check" CHECK ("quantityBase" > 0),
    CONSTRAINT "SaleItemFulfillment_base_quantity_check" CHECK (
      "quantityBase"::BIGINT = "quantityInOrderUnit"::BIGINT * "unitMultiplierSnapshot"::BIGINT
    )
);

ALTER TABLE "SaleAllocation" ADD COLUMN "fulfillmentId" INTEGER;

CREATE UNIQUE INDEX "SaleItemFulfillment_saleItemId_warehouseId_key"
ON "SaleItemFulfillment"("saleItemId", "warehouseId");
CREATE INDEX "SaleItemFulfillment_saleItemId_idx" ON "SaleItemFulfillment"("saleItemId");
CREATE INDEX "SaleItemFulfillment_warehouseId_idx" ON "SaleItemFulfillment"("warehouseId");
CREATE INDEX "SaleAllocation_fulfillmentId_idx" ON "SaleAllocation"("fulfillmentId");

ALTER TABLE "SaleItemFulfillment"
ADD CONSTRAINT "SaleItemFulfillment_saleItemId_fkey"
FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleItemFulfillment"
ADD CONSTRAINT "SaleItemFulfillment_warehouseId_fkey"
FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleAllocation"
ADD CONSTRAINT "SaleAllocation_fulfillmentId_fkey"
FOREIGN KEY ("fulfillmentId") REFERENCES "SaleItemFulfillment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
