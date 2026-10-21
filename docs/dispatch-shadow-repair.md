# Dispatch shadow-migration repair

State inspected 2026-10-21 (Africa/Lagos). The live database was read only during preparation.

The workflow migration `20260929132054_add_sale_dispatch_workflow` alters `SaleDispatchLine`. The current `20260929140000_add_sale_dispatch` directory creates it too late for Prisma shadow replay. This patch renames the table creation directory to `20260929131000_add_sale_dispatch` without changing its SQL. The SHA-256 remains `916137e473cea9a02b637327431269ea206a613f1b4b2e01f764bfa98208692d`.

The live database has the successful old-name migration and workflow migration, plus a failed new-name attempt that Prisma marked rolled back. The updated script verifies this exact state, the migration checksum, and the existing dispatch tables. Its default run is read only. After a database backup and successful rehearsal on a clone, `--apply` removes the rolled-back attempt row and renames the successful old-name row in one transaction. It does not execute migration SQL or change stock tables.

From the backend root:

```powershell
git apply --check C:\path\to\backend-dispatch-shadow-repair.patch
git apply C:\path\to\backend-dispatch-shadow-repair.patch
node scripts/reconcile-dispatch-migration-history.mjs
```

Back up the database including `_prisma_migrations`, verify `DATABASE_URL`, and rehearse on a clone. Then run `node scripts/reconcile-dispatch-migration-history.mjs --apply` against the intended database. Verify with `pnpm exec prisma migrate status`. Only the invitations migration should remain pending.

Use a disposable development database and a distinct disposable shadow database to check `migrate dev`. Do not run `migrate reset` on the current database, and do not run `migrate deploy` until history is reconciled. This patch was checked against the current backend worktree but was not applied to it or the database.
