// Run before and after applying the query-index migration against the same database.
// EXPLAIN ANALYZE executes read-only SELECTs; it does not create or change indexes.
require('dotenv/config');
const { Client } = require('pg');

const label = process.argv[2];
if (!['before', 'after'].includes(label) || !process.env.DATABASE_URL) {
  console.error('Usage: node scripts/benchmarkQueryIndexes.cjs before|after (DATABASE_URL required)');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
const samples = 5;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function one(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] || null;
}
async function measure(name, sql, params = []) {
  const times = [];
  let plan = null;
  // Warm once, then capture a median to reduce cache and timing noise.
  for (let run = 0; run <= samples; run++) {
    const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const value = rows[0]['QUERY PLAN'][0];
    if (run > 0) times.push(value['Execution Time']);
    plan = value.Plan;
  }
  return { name, medianExecutionMs: median(times), samples: times, topPlanNode: plan['Node Type'], rows: plan['Actual Rows'] };
}

(async () => {
  try {
    await client.connect();
    await client.query("SET statement_timeout = '15s'");
    await client.query('SET default_transaction_read_only = on');
    const results = [];
    const add = async (name, sql, params) => results.push(await measure(name, sql, params));
    await add('sales_recent', 'SELECT id FROM "SaleOrder" ORDER BY "createdAt" DESC, id DESC LIMIT 20');
    await add('purchases_recent', 'SELECT id FROM "PurchaseOrder" ORDER BY "createdAt" DESC, id DESC LIMIT 50');
    await add('contacts_by_name', 'SELECT id FROM "Contact" ORDER BY name, id LIMIT 100');
    await add('products_by_name', 'SELECT id FROM "Product" ORDER BY name, id LIMIT 100');
    await add('categories_by_name', 'SELECT id FROM "Category" ORDER BY name, id LIMIT 100');
    const sale = await one('SELECT id, "paymentStatus", "deliveryStatus" FROM "SaleOrder" ORDER BY id DESC LIMIT 1');
    if (sale) {
      await add('sales_by_payment', 'SELECT id FROM "SaleOrder" WHERE "paymentStatus" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 20', [sale.paymentStatus]);
      await add('sales_by_delivery', 'SELECT id FROM "SaleOrder" WHERE "deliveryStatus" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 20', [sale.deliveryStatus]);
      await add('sale_items', 'SELECT id FROM "SaleItem" WHERE "saleId" = $1', [sale.id]);
    }
    const purchase = await one('SELECT id, "transactionStatus", "receivingStatus" FROM "PurchaseOrder" ORDER BY id DESC LIMIT 1');
    if (purchase) {
      await add('purchases_by_commercial', 'SELECT id FROM "PurchaseOrder" WHERE "transactionStatus" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 50', [purchase.transactionStatus]);
      await add('purchases_by_receiving', 'SELECT id FROM "PurchaseOrder" WHERE "receivingStatus" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 50', [purchase.receivingStatus]);
      await add('purchase_items', 'SELECT id FROM "PurchaseItem" WHERE "purchaseId" = $1', [purchase.id]);
    }
    const product = await one('SELECT "categoryId" FROM "Product" LIMIT 1');
    if (product) await add('products_by_category', 'SELECT id FROM "Product" WHERE "categoryId" = $1 ORDER BY name, id LIMIT 100', [product.categoryId]);
    const batch = await one('SELECT "warehouseId" FROM "InventoryBatch" LIMIT 1');
    if (batch) await add('batches_by_warehouse', 'SELECT id FROM "InventoryBatch" WHERE "warehouseId" = $1 ORDER BY "productId" LIMIT 100', [batch.warehouseId]);
    console.log(JSON.stringify({ label, capturedAt: new Date().toISOString(), measurements: results }, null, 2));
  } catch (error) {
    console.error(`Benchmark failed: ${error.code || error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
