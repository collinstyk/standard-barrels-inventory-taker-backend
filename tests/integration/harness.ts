import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { validateTestDatabaseUrl, type SafeTestDatabaseTarget } from "../../services/inventory/testDatabaseGuard";

export interface IntegrationHarness {
  client: PrismaClient;
  target: SafeTestDatabaseTarget;
}

export function createIntegrationHarness(): IntegrationHarness {
  const target = validateTestDatabaseUrl();
  process.stdout.write(`PostgreSQL integration target: ${target.displayName}\n`);
  const prismaCli = resolve(process.cwd(), "node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: target.connectionString },
    stdio: "inherit",
  });
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.connectionString }) });
  return { client, target };
}

export async function clearDisposableDatabase(harness: IntegrationHarness): Promise<void> {
  validateTestDatabaseUrl(harness.target.connectionString, process.env.DATABASE_URL);
  await harness.client.$executeRaw(Prisma.sql`
    TRUNCATE TABLE
      "StockMovement", "SaleAllocation", "SaleItemFulfillment", "InventoryPosting", "InventoryBatch",
      "ReturnInspection", "SaleReturnItem", "SaleReturn", "PurchaseReturnItem",
      "PurchaseReturn", "PurchaseReceiptItem", "PurchaseReceipt", "StockLog",
      "SaleItem", "PurchaseItem", "SaleOrder", "PurchaseOrder", "StockLevel",
      "ProductUnit", "Product", "Warehouse", "Category", "Contact", "User"
    RESTART IDENTITY CASCADE
  `);
}
