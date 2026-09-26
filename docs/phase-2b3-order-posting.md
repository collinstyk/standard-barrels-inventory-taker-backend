# Phase 2B-3 order and posting workflows

Inventory V2 is guarded by `INVENTORY_V2_ENABLED`. The flag is disabled when absent and enabled only by the explicit value `true` (case-insensitive, surrounding whitespace ignored). Do not enable it on an application database until legacy `StockLevel` and batch inventory have been reconciled.

When disabled, existing purchase, sale, return, transfer, and adjustment behavior remains active. When enabled, purchase creation and sale creation use the V2 services. Legacy purchase returns, sale returns, transfers, and physical adjustments return HTTP 503 so a command cannot mutate only the legacy inventory system.

## Public commands

- `POST /api/v1/purchase/create`: creates a purchase and snapshots multiplier and agreed cost; it never receives stock.
- `POST /api/v1/purchase/:id/receipts`: creates an inventory-neutral draft receipt.
- `POST /api/v1/purchase/:purchaseId/receipts/:receiptId/post`: posts a receipt atomically.
- `POST /api/v1/sale/create`: creates a draft sale without inventory effects, or creates and issues a non-draft sale atomically.
- `PATCH /api/v1/sale/:id`: edits a draft or activates it; posted inventory fields are immutable.
- `GET /api/v1/inventory/availability?productId=<uuid>&unitId=<id>&requestedQuantity=<optional>`: returns an informational InventoryBatch availability preview grouped by warehouse.

Each create command requires `Idempotency-Key` while V2 is enabled. Receipt posting and draft activation require their own keys. Replays reconstruct persisted identities and summaries without repeating inventory mutations.

Purchase posting locks the receipt and purchase items, checks cumulative posted quantities, creates one sellable batch and one positive movement per receipt item, updates compatibility caches, and marks the receipt posted in one serializable transaction. Sale issue creates the sale, snapshots the confirmed selling price, multiplier, and selected warehouse, then allocates FEFO/FIFO only within that warehouse and commits its posting, movements, allocations, batch decrements, and product cache changes in the same serializable transaction.

Purchase PATCH under V2 is commercial-only: it accepts status, amount paid, and extra cost. Purchase-item editing and all direct received-quantity changes are rejected. Posted purchase receipts are the only V2 goods-receipt authority. Split receipt lines are aggregated per purchase item before posting, so previously posted quantity plus the complete current receipt aggregate cannot exceed the ordered quantity.

Cancellation is distinct from inventory reversal. An untouched DRAFT or PENDING purchase and an unissued DRAFT sale may be cancelled directly. Once a purchase receipt or sale issue has posted inventory, cancellation is blocked until Phase 2B-4 provides an atomic reversal-and-cancellation workflow. CANCELLED orders are terminal; draft receipts retained for audit after purchase cancellation cannot be posted. No inventory history is deleted or offset by cancellation.

Sale activation replay is exact: concurrent or later requests using the activation posting's idempotency key reconstruct the same posting result without repeating mutations. A different activation key after inventory has posted returns a conflict and never returns a successful activation response with a null posting.

V2 sale items use an explicit `fulfillments` array. Each entry contains `warehouseId` and `quantityInOrderUnit`; the entries must be unique by warehouse and must total `quantityOrdered` before activation. FEFO/FIFO is applied independently within each selected warehouse. A shortage in one fulfilment fails the complete sale and is never covered from another warehouse automatically. `sourceWarehouseId` remains a compatibility field and is populated only for a single fulfilment.

Availability previews exclude expired and non-sellable batches, expose no cost data, and are ordered by warehouse name then ID. They are informational: sale creation and activation always recheck and lock the selected batches transactionally.

ADMIN and MANAGER may create purchases, post receipts, create sales, and activate drafts. STAFF may create purchases and sales and create/post receipts. AUDITOR is read-only for these operations.

This phase does not implement returns, inspection, transfers, adjustments, reversals, reconciliation, backfill, or legacy-table removal.
