# Atomic product and category creation

`POST /api/v1/catalog/products` accepts an existing `categoryId` **or** a
`newCategoryName`. ADMIN and MANAGER may call it with their Bearer JWT. STAFF
and AUDITOR receive 403; missing or invalid authentication receives 401.
There is no new route and no Idempotency-Key requirement on this endpoint.

## Request

Existing-category requests keep their current meaning:

```json
{
  "name": "Chamdor",
  "baseUnit": "bottle",
  "categoryId": "d1ab616e-674e-47fb-86ed-a42f7c9e20d5",
  "reorderPoint": 0,
  "units": [
    { "name": "Bottle", "multiplier": 1, "price": "3500.0000", "sku": "CHAM-BTL" }
  ]
}
```

To find or create a category during product creation, replace `categoryId`
with `newCategoryName`:

```json
{
  "name": "Chamdor",
  "baseUnit": "bottle",
  "newCategoryName": "  Non-Alcoholics  ",
  "reorderPoint": 0,
  "units": [
    { "name": "Bottle", "multiplier": 1, "price": "3500.0000", "sku": " cham-btl " },
    { "name": "Carton", "multiplier": 12, "price": "40000.1234", "sku": "CHAM-CTN" }
  ]
}
```

Provide exactly one category field. Both, neither, null, an invalid UUID, or
an empty/whitespace-only name return 400. `newCategoryName` uses the existing
category-name schema: trim surrounding JavaScript whitespace, then require
2–120 characters. `name`, `baseUnit`, `reorderPoint`, `units` and their validation
are unchanged: reorder point defaults to 0, 1–100 initial units, positive integer
multipliers with at least one multiplier 1, decimal-string prices with at most
four decimal places, and unique trimmed unit names/SKUs within the request.
SKUs are stored trimmed and uppercased and remain globally unique. Unknown
request fields, including client-supplied inventory quantities, are rejected.

## Category matching, retries and concurrency

The category identity is PostgreSQL `LOWER(BTRIM(name))`, using the existing
`Category_name_ci_key` expression index and the database's case rules. This
matches the separate category endpoint's database uniqueness rule. The trimmed
new name is stored with its submitted spelling; if a match already exists, its
ID and display name are reused without renaming it. For example, `Whiskey`,
`whiskey` and `  Whiskey  ` select one category. Inner whitespace is not collapsed:
`Red Wine` and `Red  Wine` remain different. `%` and `_` are literal characters,
not search wildcards. This does not add accent or Unicode normalization rules.

A parameterized SQL upsert resolves the expression-index conflict inside the
same Prisma transaction as product creation and nested ProductUnit creation.
Concurrent requests with different products can reuse the same category; no
unique-constraint exception is caught inside an aborted transaction. Any product
or unit insertion failure rolls back a newly inserted category and all product
and unit inserts. A reused category remains present.

This is category deduplication, not idempotent product creation. Retrying the
same product body after a successful commit normally conflicts on its SKU and
returns the existing 409; it does not create another category or replay a 201.
The separate `POST /api/v1/catalog/categories` still rejects duplicate names.
Existing product-name behavior is unchanged.

## Response

Success remains **201 Created** with `{ "status": "success", "data": product }`.
There is no additional wrapper. Example with Inventory V2 enabled:

```json
{
  "status": "success",
  "data": {
    "id": "46fb0285-753d-4406-92a7-865a9b7fae29",
    "name": "Chamdor",
    "baseUnit": "bottle",
    "reorderPoint": 0,
    "category": {
      "id": "d1ab616e-674e-47fb-86ed-a42f7c9e20d5",
      "name": "Non-Alcoholics"
    },
    "units": [
      { "id": 1, "name": "Bottle", "multiplier": 1, "price": "3500", "sku": "CHAM-BTL" },
      { "id": 2, "name": "Carton", "multiplier": 12, "price": "40000.1234", "sku": "CHAM-CTN" }
    ],
    "sellableQuantityBase": 0
  }
}
```

With Inventory V2 disabled, the established response uses `quantityInStock: 0`
instead of `sellableQuantityBase`. Prices are Prisma Decimal strings; trailing
zeroes may be omitted. Units remain ordered by ID. The frontend can select
`data.id`, `data.category.id`, and `data.units[n].id` immediately. No `categoryId`
field or category-created flag is added to the response.

The existing error envelope remains unchanged. Statuses are 400 for validation,
404 for a well-formed but missing categoryId, and 409 for SKU/unit uniqueness
conflicts. Both category modes retain the existing `SKU or product unit name
already exists.` message for those conflicts.

## Database impact and tests

No schema change, migration, dependency, or backfill is included. The existing
`20260722090000_add_master_data_case_insensitive_uniqueness` migration must already
be applied. All historical migrations, including the separate dispatch-history
issue, remain untouched. Applying this Git patch performs no database action.

Run typecheck and focused tests after generating the Prisma client:

```sh
pnpm exec prisma generate
pnpm typecheck
pnpm exec vitest run tests/unit/masterDataValidation.test.ts tests/unit/atomicProductCategoryValidation.test.ts tests/masterData.routes.test.ts tests/atomicProductCategory.routes.test.ts --no-file-parallelism --maxWorkers=1
```

The database tests use the existing guarded integration harness. They run migrations
and truncate data **only in the disposable TEST_DATABASE_URL target**, whose name
must contain `test` and which must be different from DATABASE_URL. Never supply
the live application URL as TEST_DATABASE_URL. After setting up that separate
database (the repository includes `docker-compose.test.yml`), run:

```sh
pnpm exec vitest run tests/integration/atomicProductCategory.postgres.test.ts --no-file-parallelism --maxWorkers=1
```

Coverage includes the old categoryId flow, new category creation, normalized-name
reuse, literal wildcard names, concurrent category reuse, rollback after a later
unit's SKU fails, repeat-request conflicts, missing categories, response stock
shaping, strict validation, and authorization denial before service execution.
