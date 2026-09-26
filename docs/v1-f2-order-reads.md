# V1-F2 Purchase and Sale Reads

V1-F2 adds authenticated, inventory-neutral list and detail reads at `GET /api/v1/purchase`, `GET /api/v1/purchase/:id`, `GET /api/v1/sale`, and `GET /api/v1/sale/:id`. ADMIN, MANAGER, STAFF, and AUDITOR may use them. No mutation, deletion, reporting, export, or later V1 feature is included.

Lists accept `page` (default 1), `limit` (default 20, maximum 100), transaction/payment status, `dateFrom`, `dateTo`, and contact-name `search`. Purchases additionally accept `supplierId` and receiving status; sales accept `buyerId` and delivery status. A positive numeric search can also match order ID. Unknown parameters are rejected. Results are ordered by `createdAt DESC`, then `id DESC`.

Date-only values are interpreted in `BUSINESS_TIME_ZONE`, defaulting to `Africa/Lagos`. `dateFrom` starts at local business midnight. `dateTo` is inclusive through its complete business day and is implemented as an exclusive boundary at the following business midnight.

List responses contain commercial summaries and bounded counts only. Purchase details contain explicitly selected items, receipt summaries, supplier-return summaries, and ordered/received/remaining base quantities grouped by product. Sale details contain items, fulfilments, allocation summaries, issue/reversal state, customer-return summaries, and issued base quantities grouped by product and unit. Money values are strings. Unlike products are never combined.

The endpoints omit movements, complete batches, inspection evidence, credentials, password hashes, and unrelated users. They work with Inventory V2 enabled or disabled and perform no writes.
