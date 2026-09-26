# V1 release checklist

## Scope and completed features

V1 provides authenticated multi-warehouse inventory operations with:

- Category, product, product-unit, warehouse, and contact master data.
- Purchase orders, explicit partial goods receipts, and supplier returns.
- Draft and posted sales, FEFO/FIFO allocation, multi-warehouse fulfilment, and safe cancellation of issued undelivered pending sales.
- Customer returns, quarantine receipt, inspection, and disposition reclassification.
- InventoryBatch, InventoryPosting, StockMovement, and allocation records.
- Inventory availability, low-stock, expiring-soon, and physical-count adjustment workflows.
- Purchase and sale list/detail reads.
- Secure startup validation, default-off STAFF signup, and one-time administrator bootstrap.

## Production surface and security

`app.ts` mounts these route groups:

- `/api/v1/auth`
- `/api/v1/catalog`
- `/api/v1/warehouses`
- `/api/v1/contacts`
- `/api/v1/purchase`
- `/api/v1/sale`
- `/api/v1/inventory`

Reports and analytics are not mounted. Unknown routes use the safe 404 flow. Login and signup accept credentials only through POST bodies. Password hashes are excluded from authentication responses and protected request identity queries. The administrator bootstrap is a CLI command, not an HTTP endpoint, and neither bootstrap nor seed runs during application startup.

ADMIN and MANAGER perform privileged operational mutations. STAFF has the explicitly supported receiving, sales, and customer-return responsibilities. AUDITOR is read-only for V2 transactional workflows. STAFF and AUDITOR cannot post physical-count adjustments. When Inventory V2 is enabled, legacy StockLevel-only return, transfer, and adjustment mutation routes are blocked.

## Inventory and database authority

`InventoryBatch` is authoritative for V2 stock quantities and disposition. `Product.quantityInStock` remains a temporary compatibility cache. Inventory changes are represented through immutable postings and movements and use transaction-scoped allocation/posting workflows.

The repository contains **21 migrations**. A fresh disposable PostgreSQL database deployed all 21 in order, `prisma migrate status` reported the schema up to date, and no V1-F6 migration was added. Existing migration files were not edited during V1-F6.

## Required operation

Production requires:

- `DATABASE_URL` containing a valid PostgreSQL target.
- A secure `JWT_SECRET` of at least 32 characters.
- `INVENTORY_V2_ENABLED=true`.
- Applied Prisma migrations before startup.

`JWT_EXPIRES_IN`, `PORT`, and `BUSINESS_TIME_ZONE` have validated defaults. `PUBLIC_SIGNUP_ENABLED` defaults to false. If deliberately enabled, public signup still creates only STAFF.

To create the initial administrator, privately set `ADMIN_BOOTSTRAP_ENABLED=true`, `ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_EMAIL`, and `ADMIN_BOOTSTRAP_PASSWORD`, then run `pnpm run bootstrap:admin`. After success, remove the password and disable the flag. Bootstrap refuses if an administrator already exists. `prisma/seed.ts` is intentionally disabled and must not be used for setup.

Build with `pnpm run build` and start the compiled service with `pnpm run start`.

## Final verification

Commands and results from the guarded disposable release rehearsal:

- `prisma format`: passed; schema hash unchanged.
- `prisma validate`: passed.
- `prisma generate`: Prisma Client 7.7.0 generated successfully.
- `pnpm run typecheck`: passed.
- `pnpm run test:unit`: **107/107 passed** across 13 files.
- Route/application tests: **83/83 passed** across 6 files.
- `pnpm run test:integration`: **103/103 passed** across 10 files; none skipped.
- Complete enabled suite: **293/293 passed** across 29 files.
- `pnpm run build`: passed.
- Fresh migration deployment: 21/21 applied; no pending migrations.
- Administrator bootstrap: first invocation created exactly one ADMIN; second invocation refused without mutation.
- Compiled production startup: connected and listened with production-safe flags.
- Administrator login: HTTP 200.
- Protected catalog read: HTTP 200.
- Disabled public signup: HTTP 403.
- Unknown route: HTTP 404.
- SIGTERM shutdown: listener closed and no process remained.
- `git diff --check`: passed, with existing Windows line-ending warnings only.
- Unsafe raw-SQL API scan: zero matches.
- Destructive seed scan: zero matches.
- Embedded-secret scan: no high-confidence production credential.

Integration verification used only the guarded disposable database. The seed was not run.

## Known non-blocking backlog

- Expiring-soon summaries omit warehouse location.
- Expiry values may serialize as timestamps rather than date-only strings.
- Out-of-stock severity currently uses `CRITICAL_OUT_OF_STOCK`.
- Some source files use compact formatting.
- Some summary queries may be optimized later.
- Unmounted reports and analytics source remains outside V1.

## Explicitly deferred

- General warehouse transfer workflow.
- Full inventory-posting reversal API.
- Delivered/completed sale cancellation.
- Automated expiry reclassification.
- Historical reconciliation and backfill.
- Reports, analytics, and exports.
- CI/CD and deployment infrastructure.
- Frontend implementation.
- Advanced user administration.
- Password reset and multi-factor authentication.

## Release status

**V1 READY** — the clean migration, startup, authentication, inventory safety, test, and production-build gates passed with no release blocker remaining.
