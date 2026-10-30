# Query indexes and before/after measurements

This migration adds 29 B-tree indexes across 14 models. It targets the existing order-list filters and sort order, order-item relations, master-data lists, warehouse inventory, and legacy stock relations. It does not remove existing indexes or change business data.

Run these commands from the backend root against the **same database**. Capture the first measurement after applying the patch to the source tree but **before** migrating the database:

```powershell
node scripts/benchmarkQueryIndexes.cjs before > query-index-before.json
pnpm exec prisma migrate deploy
node scripts/benchmarkQueryIndexes.cjs after > query-index-after.json
node scripts/compareQueryIndexBenchmarks.cjs query-index-before.json query-index-after.json
```

The benchmark uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on read-only SELECTs, with five timed runs after one warm-up. It sets a 15-second statement timeout. It does not create indexes or write stock. A migration on populated tables can take time and block concurrent writes while each standard PostgreSQL index is built; schedule deployment accordingly. `migrate dev` can be used on a development database instead of `migrate deploy`.

Check row counts and query plans as well as elapsed time. Small tables may continue to use sequential scans because they are cheaper, and percentage changes on sub-millisecond queries are noisy. The comparison is only meaningful with similar data volume and database load on both runs. Further case-insensitive substring search indexes need a separate `pg_trgm` decision and production query evidence; B-tree indexes in this patch address list ordering and equality filters.
