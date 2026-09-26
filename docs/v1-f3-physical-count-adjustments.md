# V1-F3 Physical-Count Adjustment

`POST /api/v1/inventory/adjustments` records one physical count against one existing Inventory V2 batch. It requires Inventory V2, authentication, ADMIN or MANAGER, and an `Idempotency-Key`. The strict body contains `batchId`, integer `countedQuantityBase` from zero through 2,147,483,647, reason (`PHYSICAL_COUNT`, `LOSS`, `FOUND_STOCK`, or `DATA_CORRECTION`), and optional non-empty notes up to 1,000 characters.

The server locks the selected batch, derives the signed delta from its current balance, and creates one ADJUSTMENT posting and one signed adjustment movement in a serializable bounded-retry transaction. It never creates or substitutes a batch and never changes disposition, expiry, provenance, warehouse, or linkage fields. A no-change count returns conflict without writes.

SELLABLE counts change the temporary product sellable cache by the same delta after underflow, overflow, and consistency checks. DAMAGED, QUARANTINED, and EXPIRED counts leave that cache unchanged. No StockLevel or StockLog dual-write occurs. The legacy `/adjust` endpoint and all transfer/read behavior remain unchanged.

The fingerprint covers actor, batch, count, reason, and normalized notes. Same-command replay reconstructs the persisted result without applying inventory again; changed or cross-command key reuse conflicts. Transfers, bulk counts, batch creation/reclassification, opening balances, expiry processing, reconciliation, reversal, and later V1 work remain deferred.
