import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const oldName = '20260929140000_add_sale_dispatch';
const newName = '20260929131000_add_sale_dispatch';
const expectedOldChecksum = '916137e473cea9a02b637327431269ea206a613f1b4b2e01f764bfa98208692d';
const migrationFile = fileURLToPath(new URL(`../prisma/migrations/${newName}/migration.sql`, import.meta.url));
const checksum = createHash('sha256').update(await readFile(migrationFile)).digest('hex');
const apply = process.argv.includes('--apply');

if (checksum !== expectedOldChecksum) throw new Error('Patched SQL checksum differs from the recorded migration; no changes made');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');
  await client.query('LOCK TABLE "_prisma_migrations" IN EXCLUSIVE MODE');
  const { rows } = await client.query(
    'SELECT id, migration_name, checksum, finished_at, rolled_back_at, logs FROM "_prisma_migrations" WHERE migration_name = ANY($1)',
    [[oldName, newName, '20260929132054_add_sale_dispatch_workflow']],
  );
  const original = rows.find((row) => row.migration_name === oldName);
  const workflow = rows.find((row) => row.migration_name === '20260929132054_add_sale_dispatch_workflow');
  const failed = rows.find((row) => row.migration_name === newName);
  const expectedFailure = failed && failed.checksum === expectedOldChecksum && !failed.finished_at && !!failed.rolled_back_at && failed.logs?.includes('relation "SaleDispatch" already exists');
  if (rows.length !== 3 || !original || !workflow || !expectedFailure || original.checksum !== expectedOldChecksum || !original.finished_at || original.rolled_back_at || !workflow.finished_at || workflow.rolled_back_at) {
    throw new Error('Migration history differs from the recorded state; no changes made');
  }
  const { rows: tables } = await client.query(
    `SELECT to_regclass('"SaleDispatch"') AS dispatch, to_regclass('"SaleDispatchLine"') AS line`,
  );
  const { rows: columns } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'SaleDispatchLine'`,
  );
  if (!tables[0].dispatch || !tables[0].line || !columns.some((row) => row.column_name === 'saleItemId')) {
    throw new Error('Dispatch schema differs from the recorded state; no changes made');
  }
  if (apply) {
    // Prisma has marked the failed new-name attempt rolled back. Remove only that exact history row.
    const removed = await client.query(
      'DELETE FROM "_prisma_migrations" WHERE id = $1 AND migration_name = $2 AND checksum = $3 AND finished_at IS NULL AND rolled_back_at IS NOT NULL RETURNING id',
      [failed.id, newName, expectedOldChecksum],
    );
    if (removed.rowCount !== 1) throw new Error('Failed attempt could not be removed safely');
    const result = await client.query(
      'UPDATE "_prisma_migrations" SET migration_name = $1, checksum = $2 WHERE migration_name = $3 AND checksum = $4',
      [newName, checksum, oldName, expectedOldChecksum],
    );
    if (result.rowCount !== 1) throw new Error('History update did not affect exactly one row');
    await client.query('COMMIT');
    console.log(`Removed one failed attempt and updated the successful migration-history row to ${newName} with checksum ${checksum}.`);
  } else {
    await client.query('ROLLBACK');
    console.log(`Read-only check passed for the rolled-back deploy state. Back up the database and test on a clone before --apply. Checksum: ${checksum}`);
  }
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
