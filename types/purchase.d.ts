interface PurchaseReturnItemInput {
  stockKeepingUnit: string;
  quantityReturned: number;
  warehouseId: number; // The warehouse where the stock is being pulled from
}

interface PurchaseReturnBody {
  items: PurchaseReturnItemInput[];
  amountRefundedBySupplier: number;
  reason?: string;
}

export {PurchaseReturnBody, PurchaseReturnItemInput}