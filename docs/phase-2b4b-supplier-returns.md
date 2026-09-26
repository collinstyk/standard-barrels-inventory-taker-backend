# Phase 2B-4B supplier returns

Supplier returns use the existing `PurchaseReturn`, `PurchaseReturnItem`, `InventoryPosting`, `StockMovement`, and `InventoryBatch` records. Inventory V2 must be explicitly enabled.

## Lifecycle

1. `POST /api/v1/purchase/:purchaseId/returns` creates an inventory-neutral `DRAFT` with explicit purchase item, source batch, and source warehouse selections.
2. `POST /api/v1/purchase/:purchaseId/returns/:returnId/post` atomically revalidates and deducts only those batches, writes one `SUPPLIER_RETURN` posting and negative movements, and marks the return `POSTED`.
3. `POST /api/v1/purchase/:purchaseId/returns/:returnId/cancel` changes an unposted draft to terminal `CANCELLED`. Posted returns require a future explicit reversal and cannot be cancelled or edited.
4. `GET /api/v1/purchase/:purchaseId/returns` and `GET /api/v1/purchase/:purchaseId/returns/:returnId` provide safe operational reads.

ADMIN and MANAGER may create, post, cancel, and read. STAFF and AUDITOR are read-only. Missing Inventory V2 returns 503. The legacy `POST /api/v1/purchase/:id/return` remains unchanged while V2 is false and remains blocked before legacy StockLevel logic while V2 is true.

## Draft contract

```json
{
  "reason": "Damaged goods returned to supplier",
  "notes": "Supplier approved the physical return.",
  "refundAmount": "15000.00",
  "items": [
    {
      "originalPurchaseItemId": 12,
      "sourceBatchId": "a53a18be-3d88-4c54-975f-6f556d290d63",
      "sourceWarehouseId": 3,
      "quantityInOrderUnit": 4,
      "refundedUnitCost": "3750.0000"
    }
  ]
}
```

Money is accepted as nonnegative decimal strings and persisted as Prisma Decimal. The service derives multiplier and base quantity from the original purchase-item snapshot. Caller-supplied multipliers, base quantities, totals, and availability are rejected by the strict schema.

## Provenance and quantity authority

The selected batch must directly reference a `PurchaseReceiptItem`; that item must reference the selected original purchase item; its receipt must be `POSTED`; and the receipt must belong to the route purchase. Product and warehouse must match. Customer-return, ambiguous legacy, unrelated, and derived batches are rejected. Derived provenance traversal is deferred until transfers and adjustments have authoritative lineage.

Draft validation rejects zero stock and quantities over each selected batch balance. It converts every line with the persisted multiplier, aggregates base quantity by original purchase item, rejects aggregate overflow, and compares each item aggregate with authoritative posted receipt quantity. Thus two individually valid lines of 6 cannot form an impossible aggregate of 12 against 10 received. Drafts do not reserve inventory. Posting repeats every check while holding locks in this order: idempotency key, purchase, return, purchase items by ID, batches by ID.

Posting enforces both:

- prior posted, non-reversed supplier-return base quantity plus current base quantity cannot exceed posted receipt base quantity for the purchase item;
- each selected batch must still have sufficient on-hand base quantity.

Conditional batch decrements are the final safeguard against concurrent sales and returns. A failed line rolls back the posting, every earlier decrement, movements, status, and cache changes.

A purchase is eligible when it exists, is not `CANCELLED`, and the exact selected batches prove posted receipt provenance. Commercial `DRAFT` or `PENDING` status does not override valid receipt evidence. Commercial status alone never proves receipt, and a purchase with no posted receipt provenance is ineligible.

## Quantity response structure

Creation, posting, replay, list, and detail responses group quantities as `quantitySummary.products[]`. Each product contains `productId`, `totalBaseQuantity`, and `unitGroups`; every unit group contains `unitId`, `quantityInOrderUnit`, `multiplierSnapshot`, and `baseQuantity`. `lineCount` is global because lines are countable, but order-unit and base quantities from unrelated products are never added into a global inventory total.

For example, three cartons of product A and five bottles of product B appear as two product groups, not as eight fungible order units. If one product uses multiple units, it has multiple unit groups and a product-level base total.

## Disposition and compatibility cache

Directly provenanced SELLABLE, DAMAGED, QUARANTINED, and EXPIRED batches may be physically returned. Every outcome decrements its exact physical batch and creates a negative supplier-return movement. Only SELLABLE removal decrements `Product.quantityInStock`. That cache update is conditional; an insufficient cache aborts the complete transaction rather than becoming negative.

## Financial and read policy

`refundAmount` and optional `refundedUnitCost` are immutable commercial snapshots. Financial responses use:

- `declaredRefundAmount`: the unchanged return-level recorded amount;
- `calculatedLineRefundAmount`: the Decimal sum of line unit refunds times order-unit quantities, or `null` if any line cost is absent;
- `refundDifference`: declared minus calculated, or `null` when comparison is incomplete;
- `lineRefundComplete`: whether every line supplied a refund unit cost.

These amounts are not required to be equal. They do not change the original purchase total, amount paid, receipt quantities, or historical movements. Refund settlement and accounting ledger integration remain separate future workflows.

ADMIN and MANAGER reads include serialized decimal refund unit costs and the explicit financial summary. STAFF and AUDITOR reads omit refund unit costs, declared amounts, calculated totals, differences, and completeness. All reads include safe supplier and actor identity, products, grouped quantities, source warehouse and batch, disposition, expiry, posting identity, and movement summary. Credentials, unrelated costs, and internal errors are not selected.

## Idempotency

All V2 mutation keys follow a globally unique policy across purchase/sale creation, receipt creation/posting, customer-return commands, supplier-return commands, and inventory postings. A shared transaction-scoped advisory lock serializes equal keys, and collision checks inspect every existing V2 command source. A same-key/same-command replay reconstructs persisted identities without mutations; changed command type, actor, route identity, payload, quantity, batch, warehouse, money, reason, or notes conflicts.

The current implementation performs cross-source checks without a new command registry. A dedicated registry may be considered later if additional V2 command families make those checks unwieldy.

PostgreSQL concurrency coverage verifies that a supplier return and sale allocation competing for one batch cannot make it negative: only one succeeds when combined demand exceeds stock, while both succeed when stock is sufficient. It also verifies the compatibility cache equals remaining sellable quantity, different batches still share the receipt-level cap, and multi-line failure remains all-or-nothing.

General posting reversals, receipt corrections, sale cancellation reversals, transfers, adjustments, reconciliation, backfill, deployment, accounting settlement, and legacy removal are not part of Phase 2B-4B.
