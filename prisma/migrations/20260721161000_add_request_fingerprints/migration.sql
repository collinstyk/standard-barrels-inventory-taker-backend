ALTER TABLE "SaleOrder" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "PurchaseReceipt" ADD COLUMN "requestFingerprint" TEXT NOT NULL;
