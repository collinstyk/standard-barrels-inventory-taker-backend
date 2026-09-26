import type { PrismaClient } from "../../generated/prisma/client";
import { PostingInvariantError } from "./errors";
import { getBusinessDate } from "./businessDate";
import { POSTGRES_INTEGER_MAX } from "./validation";

export async function getWarehouseAvailability(
  client: PrismaClient,
  productId: string,
  unitId: number,
  requestedQuantityInUnit?: number,
) {
  const unit = await client.productUnit.findUnique({ where: { id: unitId } });
  if (!unit || unit.productId !== productId) throw new PostingInvariantError("Product unit not found for the selected product.");
  const businessDate = getBusinessDate();
  const batches = await client.inventoryBatch.findMany({
    where: {
      productId,
      disposition: "SELLABLE",
      quantityOnHandBase: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gte: new Date(`${businessDate}T00:00:00.000Z`) } }],
    },
    select: { warehouseId: true, quantityOnHandBase: true, expiryDate: true, receivedAt: true, warehouse: { select: { name: true, location: true } } },
    orderBy: [{ warehouse: { name: "asc" } }, { warehouseId: "asc" }, { expiryDate: "asc" }, { receivedAt: "asc" }],
  });
  const grouped = new Map<number, { name: string; location: string | null; total: number; expiring: boolean; nonExpiring: boolean; earliest: Date | null }>();
  for (const batch of batches) {
    const current = grouped.get(batch.warehouseId) ?? { name: batch.warehouse.name, location: batch.warehouse.location, total: 0, expiring: false, nonExpiring: false, earliest: null };
    current.total += batch.quantityOnHandBase;
    if (!Number.isSafeInteger(current.total) || current.total > POSTGRES_INTEGER_MAX) throw new PostingInvariantError("Warehouse availability exceeds the database range.");
    if (batch.expiryDate) {
      current.expiring = true;
      if (!current.earliest || batch.expiryDate < current.earliest) current.earliest = batch.expiryDate;
    } else current.nonExpiring = true;
    grouped.set(batch.warehouseId, current);
  }
  const requestedBase = requestedQuantityInUnit === undefined ? undefined : requestedQuantityInUnit * unit.multiplier;
  if (requestedBase !== undefined && (!Number.isSafeInteger(requestedBase) || requestedBase > POSTGRES_INTEGER_MAX)) throw new PostingInvariantError("Requested quantity exceeds the database range.");
  const warehouses = [...grouped.entries()].map(([warehouseId, entry]) => ({
    warehouseId,
    warehouseName: entry.name,
    warehouseLocation: entry.location,
    sellableQuantityBase: entry.total,
    availableQuantityInRequestedUnit: Math.floor(entry.total / unit.multiplier),
    baseUnitRemainder: entry.total % unit.multiplier,
    earliestEligibleExpiryDate: entry.earliest?.toISOString().slice(0, 10) ?? null,
    inventoryComposition: entry.expiring && entry.nonExpiring ? "MIXED" as const : entry.expiring ? "EXPIRING" as const : "NON_EXPIRING" as const,
    sufficientForRequestedQuantity: requestedBase === undefined ? null : entry.total >= requestedBase,
    suggested: false,
  }));
  if (requestedBase !== undefined) {
    const sufficient = warehouses.filter((warehouse) => warehouse.sellableQuantityBase >= requestedBase);
    if (sufficient.length === 1) sufficient[0]!.suggested = true;
    else if (sufficient.length > 1) {
      sufficient.sort((left, right) => (left.earliestEligibleExpiryDate ?? "9999-12-31").localeCompare(right.earliestEligibleExpiryDate ?? "9999-12-31") || left.warehouseName.localeCompare(right.warehouseName) || left.warehouseId - right.warehouseId);
      sufficient[0]!.suggested = true;
    }
  }
  return { previewedAt: new Date().toISOString(), businessDate, productId, unitId, unitMultiplier: unit.multiplier, requestedQuantityInUnit: requestedQuantityInUnit ?? null, informationalOnly: true, warehouses };
}
