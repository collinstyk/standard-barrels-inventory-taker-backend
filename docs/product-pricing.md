# Product pricing and purchase cost

`ProductUnit.price` is the independently editable default **selling price** for that unit. `Product.defaultCostBase` is the optional default purchase cost for one base unit. Product reads also return `defaultCostInUnit` and `lastReceivedCostInUnit` on each unit, multiplied server-side by its saved multiplier. Null means unknown, not zero.

`POST /api/v1/catalog/products` accepts optional `defaultCostBase` as a nonnegative decimal string (up to four decimal places) or null. `PATCH /api/v1/catalog/products/:id` accepts the same field, including null to clear it. Existing role checks remain `ADMIN`/`MANAGER` for writes and all four roles for reads.

V2 purchase creation accepts `agreedUnitCost` per line as before. If omitted, it uses `defaultCostBase × unit.multiplier`. If no default exists, the request fails instead of using the selling price. Existing purchase lines keep their recorded agreed costs. Draft receipt lines keep `actualUnitCost`; posting a receipt updates `lastReceivedCostBase` to that receipt's quantity-weighted actual cost per base unit. Posting does not change `defaultCostBase` or any selling price. Historical receipt and sale values remain unchanged.

The migration adds two nullable decimal columns to Product and one nullable batch-cost column to InventoryBatch. Existing products and batches start with unknown costs. Do not backfill them from selling prices.

Opening stock lines may include optional `unitCostInUnit`, the cost of one selected ProductUnit. The backend converts it to a per-base-unit cost and stores it on the created batch. Posted purchase receipts likewise snapshot actual cost per base unit on each batch. Customer-return-derived batches inherit their source batch cost. Null batch cost means unknown, not zero. Existing batches remain unknown; no historical cost is inferred from selling prices. This patch records provenance but does not introduce a profit/COGS report.
