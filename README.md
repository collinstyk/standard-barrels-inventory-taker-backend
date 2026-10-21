# Standard Barrels Inventory Taker Backend

A multi-warehouse inventory API for product and warehouse master data, purchase orders and explicit goods receipts, batch-level Inventory V2, FEFO allocation for expiring stock, FIFO allocation for non-expiring stock, multi-warehouse sale fulfilment, customer and supplier returns, quarantine inspection, physical-count adjustments, and immutable inventory postings and movements.

## Technology and prerequisites

The service uses Node.js, TypeScript, Express, PostgreSQL, Prisma, Zod, Vitest, and Supertest. Docker Compose is used only for the disposable PostgreSQL integration-test workflow; it is not required for normal production operation.

- Node.js `^20.19`, `^22.12`, or `>=24` (matching Prisma 7's installed engine requirement)
- pnpm
- PostgreSQL
- Docker Desktop or Docker Engine only for disposable integration tests

## Local setup

```powershell
pnpm install
Copy-Item .env.example .env
# Configure DATABASE_URL, JWT_SECRET, and the remaining settings in .env.
pnpm exec prisma generate
pnpm exec prisma migrate deploy

$env:ADMIN_BOOTSTRAP_ENABLED="true"
$env:ADMIN_BOOTSTRAP_NAME="<administrator name>"
$env:ADMIN_BOOTSTRAP_EMAIL="<administrator email>"
$env:ADMIN_BOOTSTRAP_PASSWORD="<private password of 12 to 128 characters>"
pnpm run bootstrap:admin

pnpm run dev
```

After bootstrap succeeds, remove `ADMIN_BOOTSTRAP_PASSWORD` and set `ADMIN_BOOTSTRAP_ENABLED=false`. The bootstrap is a one-time command and is never run automatically. `prisma/seed.ts` is intentionally disabled.

Never use the disposable Docker test database for application or production data.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm run dev` | Run the TypeScript development server with watch mode. |
| `pnpm run typecheck` | Type-check without emitting JavaScript. |
| `pnpm run test` | Run the complete test suite serially. |
| `pnpm run test:unit` | Run focused unit tests. |
| `pnpm run test:integration` | Run PostgreSQL integration tests. |
| `pnpm run test:all` | Run the complete suite serially. |
| `pnpm run build` | Compile the production application into `dist`. |
| `pnpm run start` | Start the compiled application. |
| `pnpm run bootstrap:admin` | Create the first administrator once. |

## Production configuration

- `INVENTORY_V2_ENABLED=true` is mandatory in production.
- `PUBLIC_SIGNUP_ENABLED` defaults to `false`; enabled public signup can create only STAFF users.
- `JWT_SECRET` must be a secure, non-placeholder value containing at least 32 characters.
- Apply all migrations before starting the service.
- `InventoryBatch` is authoritative for V2 stock. `Product.quantityInStock` is only a temporary compatibility cache.

See [.env.example](.env.example) and [the secure startup guide](docs/v1-f5-secure-startup-and-admin-bootstrap.md).

## API overview

- Authentication: `POST /api/v1/auth/login`, `POST /api/v1/auth/signup`
- Admin invitations: `POST /api/v1/auth/invitations` with an ADMIN JWT and `{ "email": "person@example.com", "role": "STAFF" }` (also MANAGER or AUDITOR). The response contains a one-time token; share it privately. `POST /api/v1/auth/invitations/inspect` with `{ "token": "..." }` displays the recipient and role. `POST /api/v1/auth/invitations/accept` with `{ "token": "...", "name": "Person", "password": "StrongPass1!" }` creates the account and returns a JWT. Links expire after 48 hours. Keep `PUBLIC_SIGNUP_ENABLED=false`. Manual link sharing proves possession of the link; email ownership verification requires delivery to the invited mailbox.
- Catalog: `/api/v1/catalog/categories`, `/api/v1/catalog/products`, and product-unit subroutes
- Warehouses and contacts: `/api/v1/warehouses`, `/api/v1/contacts`
- Purchases and receipts: `/api/v1/purchase`, `/api/v1/purchase/:id/receipts`, and receipt posting
- Supplier returns: `/api/v1/purchase/:purchaseId/returns`
- Sales: `/api/v1/sale`, sale creation, updates, and issued-sale cancellation
- Customer returns and inspection: `/api/v1/sale/:saleId/returns`
- Inventory reads: `/api/v1/inventory/availability`, `/low-stock`, and `/expiring-soon`
- Physical counts: `POST /api/v1/inventory/adjustments`

Mutation commands require `Idempotency-Key` where enforced by their route. Public signup cannot select a role. Sale fulfilments explicitly select warehouses. Received or issued inventory cannot be cancelled without its applicable reversal workflow.

## Integration-test safety

`TEST_DATABASE_URL` must identify a completely separate database whose name is test-marked. The guard rejects the normal application database, unsafe names, production markers, and alternate schemas within the same database. Integration tests may truncate the validated disposable database. Never point integration tests at `DATABASE_URL` or a database containing application data.
