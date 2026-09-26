-- Persist the command identity used to distinguish safe posting replays.
ALTER TABLE "InventoryPosting"
ADD COLUMN "requestFingerprint" TEXT;
