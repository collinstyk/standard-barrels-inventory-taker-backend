# V1-F1 Master-Data APIs

V1-F1 supplies the minimum supported category, product, product-unit, warehouse, and supplier/buyer contact management required by Inventory V2. It adds create, bounded list, detail, and update operations only; deletion, bulk import, variants beyond `ProductUnit`, image handling, advanced search, and all later V1 tasks remain deferred.

## Endpoints and roles

Categories use `/api/v1/catalog/categories`; products use `/api/v1/catalog/products`; units use `/api/v1/catalog/products/:productId/units`; warehouses use `/api/v1/warehouses`; contacts use `/api/v1/contacts`. Each collection supports `POST` and `GET`; each record supports `GET` and `PATCH`. Units are nested under their product. ADMIN and MANAGER may read and write. STAFF and AUDITOR are read-only. Every endpoint requires authentication.

## Contracts

Category bodies contain only `name`. Product creation requires `name`, `baseUnit`, `categoryId`, nonnegative `reorderPoint`, and at least one strict unit object containing `name`, positive `multiplier`, decimal-string `price`, and `sku`. At least one initial unit must have multiplier 1. The server always initializes `quantityInStock` to zero and creates no inventory records. Product PATCH permits only name, category, and reorder point.

`ProductUnit.price` is purchase/cost price, stored as Decimal with up to four fractional digits. SKU input is trimmed and normalized to uppercase. Multiplier and parent product are immutable; create another unit to represent another multiplier. Unit PATCH permits only name, price, and SKU.

Warehouse bodies contain name and optional location. Contact bodies contain name plus supplier/buyer flags, with at least one role remaining true.

## Reads and uniqueness

Lists default to page 1 and limit 20, cap limit at 100, and use stable name/ID ordering. Category, warehouse, and contact lists support case-insensitive name search. Warehouse search also covers location. Products additionally support category filtering and name-or-SKU search. Contacts support `SUPPLIER`, `BUYER`, and `BOTH` filters. Responses contain bounded summaries, never unbounded inventory or order history. `quantityInStock` remains the transitional sellable-stock cache; availability remains the Inventory V2 engine's responsibility.

PostgreSQL expression indexes enforce case-insensitive category names, unit names within a product, and warehouse names under concurrency. Prisma cannot represent these expression indexes in its schema, so the forward migration documents them directly. Normalized uppercase SKU values use the existing globally unique SKU constraint. Uniqueness conflicts return HTTP 409.

No DELETE endpoints exist. Opening stock must enter through purchase receipts or a later controlled adjustment workflow.
