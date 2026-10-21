# Dispatch migration repair and backend state

Recorded 2026-10-21 (Africa/Lagos). The backend was inspected read-only; its database was not changed.

## Why this patch exists

Prisma replays migration directories by name into a shadow database. `20260929132054_add_sale_dispatch_workflow` alters `SaleDispatchLine`, but `20260929140000_add_sale_dispatch` creates that table later in the directory order. The live database applied the table creation first, then the workflow, so this error appears during shadow replay rather than from a missing live table.

This patch renames the table creation directory to `20260929131000_add_sale_dispatch`, preserving its SQL statements. Git normalizes its working-copy line endings; the patched file's SHA-256 is `916137e473cea9a02b637327431269ea206a613f1b4b2e01f764bfa98208692d`, equal to the checksum already stored by Prisma. The database has already recorded the old name, so the included guarded script reconciles that single metadata row. This is a history repair; test it against a database clone and back up the live database before applying it there.

## Recorded backend state

- Backend: `standard-barrels-inventory-taker-backend`, branch `main`, HEAD `d6692dc634a4eeb2b34e3cdd869f51089de6bd17` (`update sale dispatch`, 2026-10-15).
- Working tree was dirty. The table creation migration was reported modified by Git due to working-copy line endings; its Git diff had no SQL content changes. Other tracked modifications included `.gitignore`, `README.md`, `app.ts`, controllers, routes, schemas, inventory services, `prisma.config.ts`, `prisma/schema.prisma`, TypeScript configuration and types. Untracked files included invitations controller/schema and `20261015080000_add_user_invitations` migration. Review your own `git status` before applying.
- Prisma reported 24 migration directories, with only `20261015080000_add_user_invitations` pending.
- Live migration row `20260929140000_add_sale_dispatch`: finished 2026-09-29 13:17:56 UTC; recorded checksum `916137e473cea9a02b637327431269ea206a613f1b4b2e01f764bfa98208692d`.
- Live migration row `20260929132054_add_sale_dispatch_workflow`: finished 2026-09-29 13:20:58 UTC; recorded checksum `66264219e876b152bfe14ca9bcd1e444deb0bbf3f36d66a3415956d1c079489e`.
- Current table creation SQL working-copy SHA-256: `24d45b1b68f84ccc095358000ddf5940a1d0a760711dbdfe68eb1191795ce1fc` because of line endings. The patched file's SHA-256 matches the recorded checksum. The repair script computes it from the patched file at execution time.
- Current workflow SQL SHA-256 matches its recorded checksum.
- Live `SaleDispatchLine` exists with `dispatchId`, `fulfillmentId`, `id`, `quantityBase`, `quantityInOrderUnit`, and `saleItemId`. Read-only counts: 3 products, 2 warehouses, 7 purchases, 10 sales, 9 batches.

## Apply and verify

From the backend root, with the patch path adjusted to where you saved it:

```powershell
git apply --check C:\path\to\backend-dispatch-migration-repair.patch
git apply C:\path\to\backend-dispatch-migration-repair.patch
node scripts/reconcile-dispatch-migration-history.mjs
```

The script defaults to read-only and refuses a different recorded migration state. Back up the database, test on a clone, then run `node scripts/reconcile-dispatch-migration-history.mjs --apply` against the intended database. It changes only the matching migration-history row, in a transaction. Check `DATABASE_URL` carefully; the script uses the same variable as Prisma.

Then run `pnpm exec prisma migrate status`. To verify shadow replay, use a disposable database and a distinct disposable shadow database with `prisma migrate dev --create-only`. Never use the live database as a shadow database or reset it to troubleshoot this error. This patch has not been applied to the backend or the live database.
