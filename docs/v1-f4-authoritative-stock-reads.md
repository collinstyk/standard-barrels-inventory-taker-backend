# V1-F4 authoritative stock reads

Inventory V2 read behavior is enabled only when `INVENTORY_V2_ENABLED=true`.

In that mode, sellable stock is derived from `InventoryBatch` rows whose disposition is `SELLABLE`, whose base-unit balance is positive, and whose expiry is either absent or on/after the current business date. The business date uses `BUSINESS_TIME_ZONE`, defaulting to `Africa/Lagos`. A batch expiring on the business date remains eligible.

The low-stock and expiring-soon endpoints never read `StockLevel` in V2 mode. Catalog product responses expose `sellableQuantityBase`, derived from the same eligible-batch definition, and omit the temporary `quantityInStock` compatibility cache.

When Inventory V2 is disabled, the existing legacy alert and catalog response behavior is preserved. These endpoints are read-only: they do not update caches, dispositions, batches, postings, or movements.
