# Recovery from failed dispatch migration deploy

Recorded 2026-10-21 (Africa/Lagos). This patch updates the earlier guarded repair script. It does not execute it or change the database.

## Verified state

- Local migrations contain `20260929131000_add_sale_dispatch` before `20260929132054_add_sale_dispatch_workflow`.
- The renamed SQL file SHA-256 is `916137e473cea9a02b637327431269ea206a613f1b4b2e01f764bfa98208692d`.
- The live database has the successful old-name `20260929140000_add_sale_dispatch` row with that checksum, followed by the successful workflow row.
- `migrate deploy` added a failed `20260929131000_add_sale_dispatch` row on 2026-10-21. It failed with PostgreSQL `42P07` because `SaleDispatch` already exists.
- `migrate status` says the old-name migration is missing locally and the invitations migration is pending.

The revised script requires exactly those three dispatch-related history rows and checks the SQL checksum and live dispatch tables. Its default mode rolls back a read-only transaction. With `--apply`, it transactionally removes the failed attempt row and renames the existing successful old-name row. It does not run migration SQL, reset stock, or alter application tables.

## Procedure

1. Apply this patch in the backend root with `git apply --check <patch>` and `git apply <patch>`.
2. Back up the database, including `_prisma_migrations`. Verify `DATABASE_URL` points to the intended database. Test the following steps on a clone first.
3. Run `node scripts/reconcile-dispatch-migration-history.mjs` for its read-only check.
4. Run `node scripts/reconcile-dispatch-migration-history.mjs --apply` only after the clone and backup checks pass.
5. Run `pnpm exec prisma migrate status`. The only pending migration should be `20261015080000_add_user_invitations`.
6. Verify `migrate dev` shadow replay using a disposable database and separate disposable shadow database. Apply the pending invitations migration separately when intended.

The script's direct edit to `_prisma_migrations` is necessary because Prisma's `migrate resolve` only handles failed migrations; it cannot rename the already successful old-name row. Do not run `migrate reset` against this database.
