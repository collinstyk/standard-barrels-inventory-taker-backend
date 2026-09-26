# Phase 2B-4A customer returns

Customer returns use `SaleReturn`, `SaleReturnItem`, `InventoryBatch`, `InventoryPosting`, `StockMovement`, and `ReturnInspection`. Inventory V2 must be explicitly enabled.

## Lifecycle and quantity authority

1. Creating a `DRAFT` return records requested quantities using the persisted sale-item multiplier and does not change or reserve inventory. Each line must belong to the issued sale, be unique in the request, have a positive authoritative `SaleAllocation`, and not exceed that line's issued base quantity. Competing valid drafts may coexist.
2. Receiving locks the sale, return, and affected sale items. Previously accepted non-reversed quantities plus the current return must not exceed authoritative issued allocation. One `CUSTOMER_RETURN` posting creates independent `QUARANTINED` batches in the explicitly selected warehouses. The sellable cache does not change.
3. Inspection may partially classify quarantine as `SELLABLE`, `DAMAGED`, or `REJECTED`. Each inspection records its authenticated inspector, inspection timestamp, checklist, notes, quantity, source batch, final warehouse, derived batch when applicable, and posting.
4. Remaining quarantine across all batches belonging to this return determines status: positive remaining quantity is `PARTLY_INSPECTED`; zero is `INSPECTED`.

`SaleReturnItem.condition` is the intake classification and is exposed as `intakeCondition`. It is not a single final outcome. Inspection rows and derived batches are authoritative for mixed outcomes.

## Inspection checklist semantics

Every check is required and accepts `PASSED`, `FAILED`, or `NOT_APPLICABLE`:

- `packagingIntact`: packaging is sufficiently intact for the proposed disposition.
- `sealIntact`: any applicable manufacturer or safety seal is intact.
- `correctProduct`: the physical product matches the issued sale item.
- `correctQuantity`: the inspected physical quantity matches the inspection command.
- `expiryChecked`: the stored expiry information was physically verified where expiry exists.
- `visibleDamage`: `PASSED` means no disqualifying visible damage was found; `FAILED` means visible damage supports a non-sellable outcome.
- `returnReasonConfirmed`: the inspector confirmed the stated return reason against the goods and available evidence.

`NOT_APPLICABLE` must represent a genuinely inapplicable check, not a skipped inspection.

Outcome rules:

- `SELLABLE` requires passed product, quantity, visible-damage, and return-reason checks and permits no failed check. A source batch with an expiry date also requires `expiryChecked = PASSED`.
- `DAMAGED` requires passed product and quantity identification plus either a failed packaging, seal, or visible-damage check, or detailed notes describing damage not represented by those checks.
- `REJECTED` requires explicit product and quantity evidence, meaningful rejection notes, and at least one failed relevant check.

Expired inventory cannot become sellable. Inspection never edits expiry provenance; derived sellable and damaged batches retain the source expiry date. The current Product schema has no authoritative “expiry required” policy, so expiry evidence is mandatory whenever a stored expiry exists. Correcting an incorrectly posted expiry requires a future controlled correction workflow.

## API

- `POST /api/v1/sale/:saleId/returns` — create a draft.
- `POST /api/v1/sale/:saleId/returns/:returnId/receive` — receive every draft line into quarantine.
- `POST /api/v1/sale/:saleId/returns/:returnId/inspections` — record one partial inspection.
- `POST /api/v1/sale/:saleId/returns/:returnId/cancel` — cancel an unreceived draft only.
- `GET /api/v1/sale/:saleId/returns`
- `GET /api/v1/sale/:saleId/returns/:returnId`

Example inspection body:

```json
{
  "saleReturnItemId": 1,
  "sourceBatchId": "a53a18be-3d88-4c54-975f-6f556d290d63",
  "warehouseId": 1,
  "quantityInOrderUnit": 3,
  "outcome": "SELLABLE",
  "inspectedAt": "2026-07-21T12:00:00.000Z",
  "notes": "Packaging and product verified.",
  "checks": {
    "packagingIntact": "PASSED",
    "sealIntact": "PASSED",
    "correctProduct": "PASSED",
    "correctQuantity": "PASSED",
    "expiryChecked": "PASSED",
    "visibleDamage": "PASSED",
    "returnReasonConfirmed": "PASSED"
  }
}
```

The client cannot submit `inspectorId`; it comes from the authenticated user. `inspectedAt` is inspection evidence time, while `createdAt` remains the server persistence time.

Read responses include safe inspector identity, checklist evidence, inspection and posting/movement identities, source and destination batches, final warehouse, and per-line plus return-level quantities for sellable, damaged, rejected, and remaining quarantine. Product cost and credential fields are not selected.

## Idempotency, authorization, and accounting

Create, receive, and inspection require a client `Idempotency-Key`. A shared transaction-scoped PostgreSQL advisory lock serializes a normalized key. Same-key/same-command replay reconstructs persisted identities without mutations; any changed user, route identity, item, outcome, quantity, checklist, notes, timestamp, expiry, or warehouse conflicts.

ADMIN and MANAGER may perform every command. STAFF may create, receive, cancel unreceived drafts, and read, but cannot inspect. AUDITOR is read-only.

SELLABLE inspection moves quantity from quarantine to a derived sellable batch and increases `Product.quantityInStock`. DAMAGED moves it to a derived non-sellable physical batch without changing that cache. REJECTED removes it from business-held physical inventory through an immutable rejected movement, creates no destination batch, and does not increase sellable stock.

Cancellation after receipt is blocked because reversal is deferred. The existing schema has no product-level expiry-required policy. Supplier returns, purchase returns, general reversals, transfer, adjustment, reconciliation, backfill, and legacy removal remain outside Phase 2B-4A.
