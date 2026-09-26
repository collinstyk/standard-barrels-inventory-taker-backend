# Phase 2B-2 inventory infrastructure

Status: internal services and tests only. These services are not connected to production routes or existing controllers.

## Runtime configuration

`BUSINESS_TIME_ZONE` controls the calendar date used for expiry eligibility and defaults to `Africa/Lagos`. It must be a valid IANA time-zone name. A batch remains eligible throughout its expiry date in that business zone and becomes expired on the following business-local date.

## Transaction architecture

Inventory commands use serializable Prisma interactive transactions. Candidate batches are selected with a parameterized tagged-template `SELECT ... FOR UPDATE` because Prisma does not expose row locks directly. PostgreSQL applies the authoritative FEFO/FIFO order while holding locks: valid expiring batches by expiry date, receipt time, and ID, followed by non-expiring batches by receipt time and ID.

Batch decrements are conditional on the remaining balance and must affect exactly one row. The posting, movements, allocations, batch changes, and temporary `Product.quantityInStock` cache update occur in the same transaction. A failure therefore rolls back the whole command. The retry wrapper recognizes PostgreSQL `40001` (serialization failure), `40P01` (deadlock), and Prisma `P2034` transaction-conflict errors. It makes at most three attempts with short bounded delays and does not retry domain validation, insufficient-stock, idempotency, or unknown failures.

Idempotency keys are opaque after surrounding whitespace is trimmed, may contain at most 200 characters, and may not contain control characters. A replay with the same kind and source reconstructs its command result from persisted posting data instead of rerunning mutations. Sale-issue replay verifies persisted movements against sale allocations and returns the original `totalIssued` and `movementCount` shape. Reusing the key for another kind or source is a conflict. Database uniqueness remains authoritative during concurrent requests.

Sale-issue callers supply identity only: sale item, product, and selected warehouse. The service loads `quantityOrdered`, `unitMultiplierSnapshot`, and `sourceWarehouseId` from each persisted sale item, verifies every item belongs to the supplied sale order, and derives base quantity through the checked conversion utility. Missing multiplier snapshots are rejected; Phase 2B-3 must populate them before activation.

## Disposable PostgreSQL integration tests

Integration tests require `TEST_DATABASE_URL` to identify a completely separate PostgreSQL database. Protocol, case-normalized host, normalized port, and database name are compared without credentials; a different schema in the application database is rejected. `test` must appear in the test database name itself, and `prod`/`production` markers are forbidden. If `DATABASE_URL` exists but is malformed, validation fails closed. Logs identify only host, database, and optional schema; credentials are never printed.

After validation, the harness runs `prisma migrate deploy` with the validated test URL supplied only to that child process. It never invokes `prisma/seed.ts`. Test cleanup truncates only inside the validated separate test database and does not rely on a schema query parameter as its safety boundary. It never resets or deletes the normal application database.

Commands:

```powershell
pnpm.cmd run test:unit
$env:TEST_DATABASE_URL='postgresql://test_user:test_password@localhost:5432/standard_barrels_test'
pnpm.cmd run test:integration
pnpm.cmd run test:all
```

When `TEST_DATABASE_URL` is absent, the integration suite is reported as skipped. Row-locking, real migrations, rollback, uniqueness, serializable concurrency, and compatibility-cache integration behavior are then not verified in that run.

Phase 2B-2 does not change current API behavior. Purchase receipts, controller activation, returns, transfers, adjustments, inspection endpoints, reversals, backfill, reconciliation, and production rollout remain later work.
