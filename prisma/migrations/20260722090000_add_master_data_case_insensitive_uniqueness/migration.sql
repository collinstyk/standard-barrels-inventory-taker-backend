-- Prisma cannot model PostgreSQL expression indexes directly.
-- These additive indexes make master-data name uniqueness concurrency-safe.
CREATE UNIQUE INDEX "Category_name_ci_key" ON "Category" (LOWER(BTRIM("name")));
CREATE UNIQUE INDEX "ProductUnit_productId_name_ci_key" ON "ProductUnit" ("productId", LOWER(BTRIM("name")));
CREATE UNIQUE INDEX "Warehouse_name_ci_key" ON "Warehouse" (LOWER(BTRIM("name")));
