-- Indexes for observed list, relation, and inventory read patterns.
-- Keep the existing partial FEFO/FIFO indexes; Prisma does not represent them here.

CREATE INDEX "UserInvitation_createdById_idx" ON "UserInvitation"("createdById");

CREATE INDEX "Contact_name_id_idx" ON "Contact"("name", "id");

CREATE INDEX "Category_name_id_idx" ON "Category"("name", "id");

CREATE INDEX "Product_name_id_idx" ON "Product"("name", "id");
CREATE INDEX "Product_categoryId_name_id_idx" ON "Product"("categoryId", "name", "id");

CREATE INDEX "ProductUnit_productId_name_id_idx" ON "ProductUnit"("productId", "name", "id");

CREATE INDEX "StockLevel_warehouseId_idx" ON "StockLevel"("warehouseId");
CREATE INDEX "StockLevel_expiryDate_idx" ON "StockLevel"("expiryDate");

CREATE INDEX "SaleOrder_createdAt_id_idx" ON "SaleOrder"("createdAt", "id");
CREATE INDEX "SaleOrder_transactionStatus_createdAt_id_idx" ON "SaleOrder"("transactionStatus", "createdAt", "id");
CREATE INDEX "SaleOrder_paymentStatus_createdAt_id_idx" ON "SaleOrder"("paymentStatus", "createdAt", "id");
CREATE INDEX "SaleOrder_deliveryStatus_createdAt_id_idx" ON "SaleOrder"("deliveryStatus", "createdAt", "id");
CREATE INDEX "SaleOrder_buyerId_createdAt_id_idx" ON "SaleOrder"("buyerId", "createdAt", "id");

CREATE INDEX "PurchaseOrder_createdAt_id_idx" ON "PurchaseOrder"("createdAt", "id");
CREATE INDEX "PurchaseOrder_transactionStatus_createdAt_id_idx" ON "PurchaseOrder"("transactionStatus", "createdAt", "id");
CREATE INDEX "PurchaseOrder_paymentStatus_createdAt_id_idx" ON "PurchaseOrder"("paymentStatus", "createdAt", "id");
CREATE INDEX "PurchaseOrder_receivingStatus_createdAt_id_idx" ON "PurchaseOrder"("receivingStatus", "createdAt", "id");
CREATE INDEX "PurchaseOrder_supplierId_createdAt_id_idx" ON "PurchaseOrder"("supplierId", "createdAt", "id");

CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");

CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");
CREATE INDEX "PurchaseItem_productId_idx" ON "PurchaseItem"("productId");

CREATE INDEX "StockLog_productId_createdAt_idx" ON "StockLog"("productId", "createdAt");
CREATE INDEX "StockLog_warehouseId_createdAt_idx" ON "StockLog"("warehouseId", "createdAt");
CREATE INDEX "StockLog_saleOrderId_idx" ON "StockLog"("saleOrderId");
CREATE INDEX "StockLog_purchaseOrderId_idx" ON "StockLog"("purchaseOrderId");

CREATE INDEX "InventoryBatch_warehouseId_productId_idx" ON "InventoryBatch"("warehouseId", "productId");

CREATE INDEX "SaleDispatchLine_saleItemId_idx" ON "SaleDispatchLine"("saleItemId");

CREATE INDEX "ReturnInspection_finalWarehouseId_idx" ON "ReturnInspection"("finalWarehouseId");
