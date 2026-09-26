# Standard Barrels Inventory Tracker Backend: Project Overview

Report date: 2026-07-21  
Repository reviewed: `standard-barrels-inventory-taker-backend`  
Review basis: current working tree, including uncommitted files. Generated code and `node_modules` were excluded except for a targeted generated-client drift check.

## 1. Project Identity

- **Project name:** `standard-barrels-inventory-tracker-backend` (`package.json:2`). The directory uses “taker” while the package uses “tracker”; the package name is treated as authoritative.
- **Repository/directory:** `standard-barrels-inventory-taker-backend`.
- **Project type:** TypeScript REST API and PostgreSQL data layer for warehouse inventory, purchasing, and sales.
- **Current development status:** Active, incomplete development. Phase 1 restored Express 5 startup, secured public signup, connected auth validation, repaired update/return route IDs, and added focused tests/build scripts. Broader domain and production-readiness gaps remain.
- **One-sentence description:** An internal inventory backend intended to track stock by product, SKU, warehouse, and expiry batch while recording purchases, sales, returns, transfers, adjustments, alerts, and audit logs.

## 2. Project Overview

The project is an API-only backend for inventory operations. It is intended to replace informal or fragmented stock tracking with transactional records covering warehouse receipts, outgoing sales, physical counts, inter-warehouse movement, and loss/return events. Its schema supports multiple warehouses, multiple sale/purchase units per product, expiry-aware stock batches, suppliers and buyers, and users with operational roles (`prisma/schema.prisma:10-162`).

Likely users are internal administrators, warehouse staff, managers, and auditors. This is inferred from the `UserRole` enum and route authorization (`prisma/schema.prisma:164-169`, `routes/inventory.ts:13-20`), not from user documentation, which is absent.

Expected interaction is through a separate client or API consumer sending JSON over HTTP. No frontend is present. A user signs up or logs in to receive a JWT, sends it as a Bearer token, then invokes purchase, sale, or inventory endpoints (`controllers/auth.ts:58-65`, `middlewares/auth.ts:13-58`).

Apparent goals and scope:

- Maintain a global product stock counter and warehouse/batch stock allocations.
- Preserve a stock movement ledger through `StockLog`.
- Convert configured sale/purchase units into base-unit stock quantities.
- Track monetary, fulfillment, receiving, and transaction states on orders.
- Alert on low and soon-to-expire stock.
- Eventually expose analytics, operational reports, rebalancing recommendations, and return ledgers.

There is no repository README, product requirements document, API specification, or deployment guide. Business ownership, production readiness criteria, and the relationship to a frontend are **Unconfirmed**.

## 3. Technology Stack

### Programming language

- **TypeScript:** All application source is TypeScript. Strict mode is enabled (`tsconfig.json:84`), though several controllers use `any` or type assertions to bypass Prisma constraints (`controllers/inventory.ts:43`, `controllers/inventory.ts:183`, `controllers/analytics.ts:25-27`).

### Frontend

- None in this repository. No page, component, styling, browser-state, or accessibility code was found.

### Backend

- **Node.js:** Runtime for the HTTP service; an exact supported Node version is not declared.
- **Express 5.2.1:** Defines middleware and REST routes (`package.json`, `app.ts`). The fallback is now an unpathed terminal middleware compatible with Express 5.
- **Morgan:** Development-style request logging is always enabled (`app.ts:12`).
- **dotenv:** Loads environment variables in Prisma and authentication modules (`prisma/index.ts:3`, `controllers/auth.ts:3`).

### Database and ORM

- **PostgreSQL:** Database provider (`prisma/schema.prisma:6-8`).
- **Prisma 7.7/7.8 packages:** Models, migrations, transactions, queries, and generated types (`package.json:15-16`, `package.json:30`). The package versions are not aligned exactly: adapter `^7.8.0` versus client/CLI `^7.7.0`.
- **PostgreSQL driver/adapter:** `pg` and `@prisma/adapter-pg` supply the Prisma connection adapter (`prisma/index.ts:1-6`).

### Authentication and authorization

- **bcryptjs:** Hashes signup passwords with cost 12 and verifies login credentials (`controllers/auth.ts:38-39`, `controllers/auth.ts:81-85`).
- **jsonwebtoken:** Issues JWTs containing a user ID and verifies Bearer tokens (`controllers/auth.ts:10-18`, `middlewares/auth.ts:17-40`).
- **Role middleware:** `restrictTo` checks `ADMIN`, `AUDITOR`, `MANAGER`, or `STAFF` roles where attached (`middlewares/auth.ts:65-81`). Authorization coverage is inconsistent across routes.

### Validation

- **Zod:** Used locally to recognize UUID contact/category identifiers in order controllers (`controllers/purchaseOrder.ts:32-43`, `controllers/saleOrder.ts:27-38`). Reusable auth schemas and a `validateBody` middleware exist (`schemas/auth.ts`, `middlewares/validate.ts`) but are not connected to auth routes.
- Most operational payload validation is handwritten and incomplete.

### Testing

- **Vitest and Supertest:** Run focused route-level tests with a mocked Prisma boundary; the suite does not connect to or mutate a real database (`tests/app.test.ts`).

### Package/build/development tools

- **pnpm:** `pnpm-lock.yaml` is present (lockfile version 9) and Prisma’s seed command explicitly uses pnpm (`prisma.config.ts:8`).
- **tsx:** Runs TypeScript directly and watches during development (`package.json:8`).
- **TypeScript compiler:** Declared directly and used by `typecheck` and `build` scripts (`package.json`).
- Production build/start scripts now compile CommonJS output into ignored `dist/` and start `dist/index.js`; lint, formatting, and generated-client scripts remain absent.

### External services, hosting, and infrastructure

- PostgreSQL is the only confirmed external service.
- No Dockerfile, Compose file, cloud integration, CI/CD workflow, hosting manifest, message queue, object storage, email provider, or payment processor was found.
- Deployment target and infrastructure are **Unconfirmed**.

## 4. Architecture and Project Structure

### Overall architecture

The application is a small layered monolith:

1. `index.ts` verifies the database connection before listening, reads `PORT` with a 5000 fallback, and handles SIGINT/SIGTERM disconnection. Importing `app.ts` remains side-effect-free.
2. `app.ts` registers JSON parsing, logging, and four route groups (`app.ts:12-20`).
3. Route modules map endpoints to authentication/role middleware and controllers.
4. Controllers validate some request data and directly call Prisma; there is no service/repository layer.
5. Prisma transactions coordinate multi-record order and stock mutations.
6. `catchAsync` forwards rejected controller promises to the global error handler (`utils/catchAsync.ts:3`, `middlewares/error.ts:38-83`).

### Concise directory tree

```text
.
|-- app.ts                         # Express composition and mounted routes
|-- index.ts                       # Database-first process startup and shutdown
|-- controllers/
|   |-- auth.ts                    # Signup/login
|   |-- purchaseOrder.ts           # Purchase create/update/return
|   |-- saleOrder.ts               # Sale create/update/return
|   |-- inventory.ts               # Adjust/transfer/alert logic
|   |-- analytics.ts               # Unmounted rebalancing recommendation
|   `-- reports.ts                 # Unmounted report functions
|-- routes/                        # Express route declarations
|-- middlewares/
|   |-- auth.ts                    # JWT authentication and role checks
|   |-- error.ts                   # Global error response mapping
|   `-- validate.ts                # Unused Zod body validator
|-- schemas/auth.ts                # Unused signup/login schemas
|-- prisma/
|   |-- schema.prisma              # Domain model
|   |-- index.ts                   # Prisma client and connection check
|   |-- seed.ts                    # Destructive development seed
|   `-- migrations/                # 12 migration directories
|-- types/                         # Express and request-body declarations
|-- utils/                         # AppError and async wrapper
|-- generated/prisma/              # Generated client, gitignored
|-- package.json
|-- pnpm-lock.yaml
|-- prisma.config.ts
`-- tsconfig.json
```

`services/` and `src/` exist but are empty.

### Routing structure

Mounted base paths (`app.ts:17-20`):

| Method | Path | Middleware | Controller/status |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | Zod body validation | Always creates `STAFF`; rejects unexpected properties |
| POST | `/api/v1/auth/login` | Zod body validation | Body-based credential login |
| POST | `/api/v1/purchase/create` | `protect` | `createPurchaseOrder` |
| PATCH | `/api/v1/purchase/:id` | ID validation, `protect`, ADMIN/MANAGER | Purchase update |
| POST | `/api/v1/purchase/:id/return` | ID validation, `protect`, ADMIN/MANAGER | Purchase return |
| POST | `/api/v1/sale/create` | `protect` | `createSaleOrder` |
| PATCH | `/api/v1/sale/:id` | ID validation, `protect`, ADMIN/MANAGER | Sale update |
| POST | `/api/v1/sale/:id/return` | ID validation, `protect`, ADMIN/MANAGER | Sale return |
| POST | `/api/v1/inventory/adjust` | `protect`, ADMIN/AUDITOR | `adjustStock` |
| POST | `/api/v1/inventory/transfer` | `protect`, ADMIN/AUDITOR/MANAGER | `transferStock` |
| GET | `/api/v1/inventory/low-stock` | `protect` | `getLowStockAlerts` |
| GET | `/api/v1/inventory/expiring-soon` | `protect` | `getExpiringSoonAlerts` |

`routes/reports.ts` is empty, is not mounted, and no analytics route exists. Therefore functions in `controllers/reports.ts` and `controllers/analytics.ts` are not API features.

### Data flow and database access

The client sends JSON and an optional `Authorization: Bearer <token>` header. Protected routes verify the JWT, fetch the current user, and attach a password-omitted user object to `req.user` (`middlewares/auth.ts:38-58`, `types/express.d.ts:4-8`). Controllers then query Prisma directly. Multi-record writes use interactive transactions, so thrown errors should roll back a controller’s database operations.

Order quantities are expressed in a `ProductUnit`; stock levels and the global `Product.quantityInStock` are intended to use base units. Controller loops multiply order quantities by `ProductUnit.multiplier` before stock movement (`controllers/purchaseOrder.ts:170-193`, `controllers/saleOrder.ts:129-190`). Responses are controller-specific JSON objects rather than a documented shared contract.

No frontend-to-backend client, state-management layer, service layer, cache, scheduled job, webhook, or event bus is present.

## 5. Features

Because application startup currently fails, “implemented” below means the code path is materially present; it does not mean the feature is currently deployable end to end.

### Fully implemented at code level

- **JWT login and authentication middleware:** Credential comparison, token creation, Bearer verification, current-user lookup, and request attachment are present (`controllers/auth.ts:72-103`, `middlewares/auth.ts:13-58`). The login route method is defective, so end-to-end status is partial.
- **Transactional purchase creation:** Resolves/creates suppliers, categories, products, units, and warehouses; creates order/items; updates receipt/payment status; increments stock and logs movements (`controllers/purchaseOrder.ts:14-227`).
- **Transactional sale creation:** Resolves buyers/SKUs, prechecks global batch stock, creates order/items, deducts across stock locations, updates global stock, and logs movements (`controllers/saleOrder.ts:10-218`).
- **Inventory physical adjustment:** Reconciles a warehouse/batch count, changes global stock, and writes a categorized log in one transaction (`controllers/inventory.ts:7-122`).
- **Single-batch warehouse transfer:** Moves a quantity between warehouses and creates paired transfer logs (`controllers/inventory.ts:124-248`). It only uses one source batch, despite FEFO wording.
- **Authenticated low-stock and expiring-soon queries:** Implemented and mounted (`controllers/inventory.ts:250-349`, `routes/inventory.ts:19-20`).
- **Central async/error plumbing:** Controller rejection forwarding and Prisma/JWT error mapping are present (`utils/catchAsync.ts`, `middlewares/error.ts`).

### Partially implemented or broken

- **Purchase/sale updates:** ID-bearing routes now reach the existing controllers, but controller calculation risks remain: they calculate totals only from supplied/matched items.
- **Purchase/sales returns:** ID-bearing routes now reach the existing controllers, but returns still use negative companion orders and the schema has no return marker or original-order relationship (`controllers/saleOrder.ts:300-314`).
- **Expiry-batch persistence on purchase:** `lookUpExpiry` is used in the upsert selector but omitted from `create`, so a newly created stock row loses the supplied expiry date (`controllers/purchaseOrder.ts:170-178`). Update purchase has the same issue (`controllers/purchaseOrder.ts:266-273`).
- **Role authorization:** Inventory mutations and order update/return routes have role checks, but order creation allows every authenticated role, including `AUDITOR`, and signup is public with selectable roles.
- **Request validation:** Auth schemas are now connected and strict; order/inventory payloads still rely on partial manual checks.

### Planned or placeholder features

- Supplier credit notes/balances are a TODO (`controllers/purchaseOrder.ts:11-12`).
- A first-class return/original-order model is explicitly contemplated but absent (`controllers/saleOrder.ts:300-314`).
- Reports for sales volume, cost leakage, product velocity, and warehouse capacity exist as controller drafts but are unmounted (`controllers/reports.ts:5-246`, empty `routes/reports.ts`). The sales-volume controller references `quantityOrder`, which does not match schema field `quantityOrdered` (`controllers/reports.ts:9-23`, `prisma/schema.prisma:125`).
- A stock-rebalancing recommendation controller exists but is unmounted and uses hard-coded thresholds (`controllers/analytics.ts:5-97`).
- `services/` and `src/` are empty placeholders.

### Mentioned in documentation but not found in code

- None. There is no repository documentation beyond code comments and package metadata.

### Present in code but missing from documentation

All substantive features are undocumented outside the code: authentication, role checks, purchases, sales, returns, warehouse/batch inventory, transfers, adjustments, alerts, seeding, reports, and analytics.

## 6. User Roles and Main Workflows

### Roles and effective permissions

| Role | Confirmed effective access |
|---|---|
| `ADMIN` | All mounted protected routes, adjustment, transfer, order updates, and returns |
| `MANAGER` | All general protected routes, transfers, order updates, and returns; not physical adjustment |
| `AUDITOR` | All general protected routes, physical adjustment, transfers, and order creation; not order updates/returns |
| `STAFF` | All generally protected reads and purchase/sale creation; no adjustment, transfer, updates, or returns |

Evidence: role enum (`prisma/schema.prisma:164-169`) and route middleware (`routes/inventory.ts:13-20`, `routes/purchaseOrder.ts:11-17`, `routes/saleOrder.ts:11-17`). No role-policy document exists, so whether these permissions match intended policy is **Unconfirmed**.

### Registration and authentication

1. Caller sends name, email, and password to signup. Unexpected properties, including `role`, are rejected.
2. Controller checks presence and email uniqueness, hashes the password, creates the user, and returns a JWT (`controllers/auth.ts:25-65`).
3. Existing user submits email/password through POST login; controller verifies the hash and returns a JWT/user summary (`controllers/auth.ts:72-103`).
4. Protected requests pass the token in a Bearer header; middleware verifies it and reloads the user (`middlewares/auth.ts:13-58`).

There is no onboarding, email verification, password reset, logout/revocation, refresh token, password-change timestamp, account lockout, or user-management API.

### Purchase workflow

1. Authenticated user creates an order with supplier, items, status, extra cost, and amount paid.
2. Supplier/contact and item master data may be resolved or created automatically.
3. Each received item creates a purchase line. Non-draft received stock is converted to base units, added to warehouse/global stock, and logged.
4. Payment and receiving statuses are computed; fully received forces transaction completion.
5. Update and vendor-return flows are coded, but their mounted routes do not carry the required order ID.

### Sale workflow

1. Authenticated user creates an order with buyer, SKU lines, status, costs, payment, delivery quantities, and preferred warehouse.
2. Controller validates aggregate stock for the selected expiry batch.
3. It creates line items and deducts base units across matching stock rows inside a transaction, recording localized stock logs.
4. Payment and delivery statuses are computed.
5. Update and customer-return flows are coded, but disconnected from their required ID route parameter.

### Inventory workflow

- An ADMIN/AUDITOR can overwrite a physical warehouse/batch count; the delta updates global stock and is logged.
- An ADMIN/AUDITOR/MANAGER can move stock from one source batch to a destination warehouse; global stock remains unchanged and paired logs are written.
- Any authenticated user can query low global product stock and upcoming batch expiry.

CRUD listing/detail/deletion endpoints for products, categories, warehouses, contacts, users, orders, stock levels, or logs are not present.

## 7. Data Model and API

### Important entities and relationships

- **User:** Unique email, password hash, role, timestamps; receives purchases and sells sale orders (`prisma/schema.prisma:10-21`).
- **Contact:** Can be a supplier, buyer, or both; relates to purchase and sale orders (`prisma/schema.prisma:23-30`).
- **Category -> Product:** Category groups products. A product stores base unit, global quantity, and reorder point (`prisma/schema.prisma:32-51`).
- **Product -> ProductUnit:** Each unit has a multiplier, price, globally unique SKU, and product relationship (`prisma/schema.prisma:53-63`).
- **Warehouse + Product -> StockLevel:** Per-warehouse, optional-expiry batch quantity with a composite unique key (`prisma/schema.prisma:65-83`).
- **SaleOrder/PurchaseOrder -> line items:** Orders track counterparty, responsible user, transaction/payment/fulfillment state, money totals, and items (`prisma/schema.prisma:85-147`).
- **StockLog:** Immutable-by-convention movement record linked to product, warehouse, and optionally a sale or purchase (`prisma/schema.prisma:149-162`). No database rule actually prevents updates/deletes.

### Validation and authorization

Mounted protected endpoints rely on JWT authentication. Role checks occur only where explicitly declared in routes. Zod auth validation is not used. Numeric, enum, date, array-item, money, and relationship constraints are incompletely validated before Prisma calls. Types alone do not validate runtime JSON.

### Request/response flow

Controllers usually return `{ status: "success", data: ... }`, sometimes with `message`, `results`, or `config`. Failures pass `AppError` or Prisma errors to the global handler, which returns verbose diagnostics only when `NODE_ENV === "development"` (`middlewares/error.ts:69-82`). There is no OpenAPI schema, API version contract beyond the URL prefix, pagination, filtering standard, or response serializer.

### External integrations

Only PostgreSQL is confirmed. No payment, accounting, messaging, shipping, identity-provider, or analytics API integration exists.

## 8. Configuration and Running the Project

### Confirmed prerequisites

- Node.js: required, exact version **Unconfirmed**.
- pnpm compatible with lockfile version 9: required by repository conventions.
- PostgreSQL: required.

### Supported repository commands

```powershell
pnpm install
pnpm run dev
pnpm test
```

`pnpm install` is the conventional installation command supported by the lockfile. Supported scripts are `pnpm run dev`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, and `pnpm start`. Build output is written to ignored `dist/`.

Prisma config defines the following seed invocation:

```powershell
pnpm dlx tsx prisma/seed.ts
```

This is configuration evidence, not a recommendation to run it: the seed deletes all rows from every modeled table before inserting demonstration data (`prisma/seed.ts:8-20`). It also inserts a mock password string that is not a bcrypt hash (`prisma/seed.ts:23-30`), so the seeded admin cannot authenticate through normal login.

### Environment-variable names

Confirmed from code/current local environment file names only; values were not inspected or reproduced:

- `DATABASE_URL` — PostgreSQL connection string (`prisma.config.ts:10-12`, `prisma/index.ts:5`).
- `JWT_SECRET` — signing and verification secret (`controllers/auth.ts:11-17`, `middlewares/auth.ts:28`).
- `JWT_EXPIRES_IN` — token duration (`controllers/auth.ts:12-18`).
- `NODE_ENV` — optional error-response mode switch (`middlewares/error.ts:69-82`); not present in the current `.env` name scan.

No `.env.example` exists.

### Database setup and migrations

The repository contains 12 chronological migrations under `prisma/migrations/`, from the initial schema through authentication and reorder-point changes. No package script documents migration deployment or client generation. Prisma CLI conventions such as `prisma migrate deploy` should not be presented as repository-supported project commands until they are documented/added.

Two migrations add required fields without safe backfill defaults at the moment they are introduced: `20260521041619_add_reorderpoint_the_product_model/migration.sql` and `20260523103435_add_auth_and_relations_to_user/migration.sql`. Their own warnings indicate failure risk on populated databases. The later auth migration sets a reorder default, but that does not make the earlier migration safe on existing data.

`pnpm exec prisma validate` could not be completed during review because Prisma attempted to download a schema-engine checksum from `binaries.prisma.sh` and network access was unavailable. Schema validity is therefore **Unconfirmed** by the Prisma engine in this review.

### Deployment

No deployment configuration exists. Port 5000 is hard-coded rather than read from `PORT` (`index.ts:4`). Production build/start procedures, process manager, database migration release step, health endpoint, and hosting platform are **Unconfirmed**.

## 9. Codebase Health

### Critical

1. **Migration sequence is unsafe for a populated database.** Required `Product.reorderPoint`, `User.password`, and `User.updatedAt` columns are added without values for existing rows (`prisma/migrations/20260521041619_add_reorderpoint_the_product_model/migration.sql`, `prisma/migrations/20260523103435_add_auth_and_relations_to_user/migration.sql`). Deployment can fail or require data loss/manual intervention.

Resolved in Phase 1: Express 5 initialization, public role escalation, POST login routing, strict auth validation, and ID-bearing update/return route contracts.

### Important

1. **The seed is destructive and produces an unusable login account.** It deletes all domain/auth data and stores a non-bcrypt mock password (`prisma/seed.ts:8-30`). It must never run against a non-disposable database.
3. **Order mutation authorization is overly broad/inconsistent.** Any authenticated role, including AUDITOR, can create purchase/sale orders (`routes/purchaseOrder.ts:11`, `routes/saleOrder.ts:11`). Intended least-privilege policy is **Unconfirmed**.
4. **Runtime validation is incomplete and reusable validation is disconnected.** Auth schemas exist but are unused (`schemas/auth.ts`, `routes/auth.ts`). Operational controllers accept unchecked enum values, negative/NaN quantities or money, invalid dates, incomplete item shapes, and arbitrary nested objects in several paths.
5. **Stock/order semantics can diverge.** Sale creation deducts `quantityOrdered`, not `quantityDelivered` (`controllers/saleOrder.ts:125-190`), while fulfillment state uses delivered quantity. Purchase stock creation omits `expiryDate` even when its selector includes it (`controllers/purchaseOrder.ts:170-178`). Product global quantity duplicates the sum of stock levels and depends on every write path staying correct (`prisma/schema.prisma:43`, `prisma/schema.prisma:73-83`).
6. **Nullable expiry dates undermine the compound-key strategy.** `StockLevel` makes `expiryDate` optional while including it in the compound unique key (`prisma/schema.prisma:73-83`). Controllers cast `null` into a required-looking generated compound selector (`controllers/inventory.ts:43-52`, `controllers/inventory.ts:180-184`). PostgreSQL uniqueness also does not normally treat two `NULL` values as equal. Non-perishable upsert/find behavior therefore needs explicit database-backed verification and likely a different key/batch representation.
7. **Update calculations can corrupt status/totals.** Update loops only total items supplied and matched in the request, silently ignore unknown SKUs, treat zero quantities as “use old value” via `||`, and default unpaid/nonreceived cases to PARTLY rather than NOT states (`controllers/purchaseOrder.ts:248-315`, `controllers/saleOrder.ts:236-270`).
8. **Return controls are insufficient.** Repeat returns are not cumulatively limited, negative/zero quantities are not rejected, returns lack an original-order relation/type, and a sale return may assign stock to an arbitrary warehouse/existing batch (`controllers/purchaseOrder.ts:321-445`, `controllers/saleOrder.ts:277-403`).
9. **Stock transfer only handles one batch.** It selects the first expiry batch and rejects if that single row is insufficient even when total warehouse stock across batches is enough (`controllers/inventory.ts:157-171`).
10. **Startup/operational robustness is weak.** The server listens before database verification, port is fixed, Morgan logs every environment, there is no health check, and graceful shutdown/disconnect handling is absent (`index.ts:4-8`, `app.ts:12`).

### Improvement

1. **Expand tests and enforce them in CI.** Phase 1 adds focused route/auth tests, but transactional stock invariants, migration behavior, and full controller integration coverage remain absent; no CI workflow exists.
2. **Declare and standardize tooling.** Add direct TypeScript dependency and supported scripts for typecheck, Prisma generation/validation, migration deployment, build, start, lint, and test. Align Prisma package versions (`package.json:15-16`, `package.json:30`).
3. **Introduce structured service/domain boundaries.** Large controllers mix input parsing, master-data creation, pricing, inventory allocation, order state, and persistence; `services/` is empty. This makes invariants hard to reuse and test.
4. **Reduce unsafe casts and `any`.** Expiry composite-key queries rely on casts (`controllers/inventory.ts:43`, `controllers/inventory.ts:183`, `controllers/saleOrder.ts:160`); analytics uses `any[]` (`controllers/analytics.ts:25-27`).
5. **Define API/documentation contracts.** Add README/setup guidance, `.env.example`, OpenAPI, status/role rules, error contract, unit semantics, and safe seed documentation.
6. **Add database constraints/indexes where business rules require them.** Category and contact names are not unique, monetary/quantity nonnegativity is not enforced, and common foreign-key/time query indexes are absent from the schema.
7. **Separate development logging from production behavior.** Use environment-aware request logging and structured logs; avoid exposing raw database error messages through the default Prisma error handler (`middlewares/error.ts:23-25`).

### Observation

1. **Organization is understandable but flat.** Routes/controllers/middleware are easy to locate, but controller files are large and naming/style varies (quotes, spacing, “sale” versus “sales”, `taker` versus `tracker`).
2. **TypeScript strict mode currently passes.** `pnpm run typecheck` exited 0 on the Phase 1 tree. This does not prove runtime safety for remaining non-auth request JSON.
3. **Error handling is centralized.** `AppError`, `catchAsync`, and Prisma/JWT mapping are a good base, though operational/programmer error separation is not actually enforced despite `isOperational` (`utils/appError.ts:1-13`, `middlewares/error.ts:38-83`).
4. **Transactions are used appropriately for multi-table mutations.** This is a strong foundation for consistency, subject to correcting business logic and concurrency assumptions.
5. **Accessibility is not applicable to this backend repository.** API error clarity and documentation are the relevant usability concerns.
6. **Performance is acceptable for small data but will degrade.** Purchase/sale loops issue many sequential queries; report/analytics code performs in-memory joins; endpoints have no pagination; and indexes for common analytics/expiry access patterns are not explicit.
7. **Dead/legacy/incomplete code is visible.** Empty `src/`, `services/`, and `routes/reports.ts`; unmounted reports/analytics; unused imports such as `PrismaClientKnownRequestError`; and comments referring to nonexistent fields all increase ambiguity.

## 10. Current State and Recommended Next Steps

### What currently works

- The current source passes TypeScript checking with installed dependencies.
- Prisma schema and migrations express a coherent inventory domain with users, warehouses, products/SKUs, orders, stock batches, and logs.
- Controller-level transactional logic exists for major inventory movements.
- JWT authentication, role middleware, alerts, error middleware, and development seed code exist.
- Express app source/build imports, focused route tests, auth validation, and production build output are verified in Phase 1 without a real database.

Live database-backed HTTP workflows were not executed; tests mock the Prisma boundary and must not be described as database integration coverage.

### What is unfinished or broken

- Complete runtime schemas and documented API contracts.
- Safe migration/seed practices.
- Report/analytics route integration and correctness.
- Product/master-data read APIs, order retrieval APIs, user administration, and production operations.

### Major technical risks

The primary remaining risks are inventory/financial inconsistency from incomplete non-auth validation and ambiguous quantity semantics, unsafe deployment migrations, destructive seed behavior, and limited integration coverage.

### Five highest-value next actions

1. **Protect inventory invariants:** Decide ordered-versus-delivered stock semantics, fix expiry persistence and FEFO allocation across batches, prevent repeat over-returns, and test that global stock equals stock-level sums after every workflow.
2. **Complete runtime/API contracts:** Validate remaining operational bodies/params/queries, define the role matrix for all mutations, and document response/error shapes in OpenAPI.
3. **Make database setup safe:** Backfill unsafe historical migration changes through an approved strategy and make the destructive seed explicitly development-only with a real hashed fixture password.
4. **Add database integration coverage:** Use a disposable test database to verify migrations, startup health, transactional controllers, and stock invariants without touching real data.
5. **Create a safe release pipeline:** Add CI gates for typecheck, tests, build, Prisma validation, migration tests, and secret scanning.

## 11. Uncertainties

- **Business requirements and intended users:** Unconfirmed; obtain a requirements document and stakeholder-approved role/workflow matrix.
- **Frontend/client contract:** Unconfirmed; inspect the consuming application or API collection.
- **Node/pnpm/PostgreSQL supported versions:** Unconfirmed; add an engines/toolchain file and deployment documentation.
- **Current database schema/data and migration status:** Unconfirmed; inspect migration status against a non-production or approved database without exposing credentials.
- **Live database compatibility:** Unconfirmed. `prisma validate` now passes, but no migration or database-backed workflow was run.
- **Whether uncommitted files are accepted/current work:** Unconfirmed. The review intentionally describes the working tree, which differs substantially from `HEAD`.
- **Intended stock decrement point:** Unconfirmed whether stock should leave on order, delivery, or transaction completion.
- **Pricing meaning:** Unconfirmed whether `ProductUnit.price` is purchase cost, sale price, or both; both purchase and sale logic reuse it.
- **Returns accounting:** Unconfirmed whether negative companion orders are acceptable or credit-note entities are required.
- **Warehouse capacity and rebalancing thresholds:** Unconfirmed; current unmounted controllers hard-code 10,000 units and reorder-point multipliers.
- **Production deployment, observability, backups, and recovery:** Unconfirmed; no infrastructure configuration is present.
- **Generated client/schema synchronization:** The checked generated client contains current major fields, but it is gitignored and Prisma validation/generation was not completed during review.

## 12. Executive Summary

This repository is an early-stage TypeScript/Express/Prisma backend for multi-warehouse inventory. Its data model and transactional controllers cover a meaningful domain: products with SKU/unit conversions, expiry-aware warehouse stock, purchase/sale orders, returns, transfers, physical adjustments, alerts, and movement logs. The structure is small and navigable, strict TypeScript checking passes, and Prisma transactions provide a solid consistency foundation.

Phase 1 makes the backend importable/buildable, closes public role escalation, moves login to POST, repairs update/return route IDs, validates auth bodies, adds focused tests, and establishes build/start scripts. It is still not production-ready: migration and seed paths are unsafe for real data; non-auth payload validation is incomplete; broader integration coverage, CI, API documentation, and deployment configuration are absent; and report/analytics code remains unmounted and assumption-heavy.

The most effective path is to first restore startup and a tested health baseline, then secure authentication/roles, repair and validate route contracts, formalize stock/accounting invariants with integration tests, and finally establish safe migration and release automation. Until those steps are complete, the repository should be treated as active development code rather than a deployable inventory service.
