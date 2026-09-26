export interface StockTransferBody {
  productId: string;
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  quantityToTransfer: number; // Given in sales/purchase units
}

export interface StockAdjustmentBody {
  productId: string;
  warehouseId: number;
  expiryDate?: string; // Optional: can be an ISO string or omitted for non-perishables
  physicalCount: number; // The actual number of items physically counted on the shelf
  reason: "DAMAGE" | "ADJUSTMENT" | "EXPIRED"; // Enforces clean structural audit categorization
}