# Paginated inventory availability

`GET /api/v1/inventory/availability-list?page=1&limit=20&search=palm`

Requires JWT and any of `ADMIN`, `MANAGER`, `STAFF`, or `AUDITOR`. Inventory V2 must be enabled. `page` and `limit` are positive integers; `limit` is at most 100. `search` is an optional, trimmed, case-insensitive product-name substring of 1–120 characters. Unknown query keys return 400.

The response is `{ status: "success", businessDate, evaluatedAt, informationalOnly: true, data, pagination }`. Products are ordered by name then ID. Each data row has `productId`, `productName`, `baseUnit`, `reorderPoint`, `units`, `sellableQuantityBase`, `stockLevel`, and `warehouses`. Units have ID, name, SKU, multiplier, server-calculated `availableQuantityInUnit`, and `baseUnitRemainder`. Warehouses list only locations with eligible sellable stock and have their own base quantity, stock level and per-unit quantities. Products with no eligible stock remain listed with zero total and an empty warehouse list.

Eligible stock uses the same disposition, positive-quantity and business-date expiry rules as the existing single-product availability preview. The total is across all warehouses. `stockLevel` is `CRITICAL` when the quantity is zero or at most one quarter of a positive reorder point; `LOW` when it is at most the reorder point; otherwise `NORMAL`. A zero reorder point makes only zero stock critical. The threshold is applied independently to the total and each warehouse quantity.

This read is informational only. Dispatch must still recheck authoritative stock. The endpoint does not cache responses or reserve stock. No migration is required.
