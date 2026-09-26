export interface ReturnItemInput {
  stockKeepingUnit: string;
  quantityReturned: number;
  warehouseId: number; // The warehouse destination (e.g., Main Shelf or Quarantine)
}

export interface SalesReturnBody {
  items: ReturnItemInput[];
  amountRefunded: number;
  reason?: string;
}