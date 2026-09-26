# Phase 2B-4C-1: Sale-Issue Reversal

This phase adds one deliberately narrow cancellation workflow for an issued `PENDING` sale whose goods have never left business custody. It is not a customer return: a customer return records goods coming back after delivery, while this operation compensates an issue that never resulted in delivery.

## API and eligibility

`POST /api/v1/sale/:id/cancel-issued` requires Inventory V2, authentication, an `ADMIN` or `MANAGER` role, and an `Idempotency-Key`. Its strict body contains only a meaningful `reason` and the exact declaration `custodyConfirmation: "GOODS_REMAIN_IN_BUSINESS_CUSTODY"`. The declaration is an authorized operator attestation; software cannot independently prove physical custody.

The workflow accepts only a `PENDING` sale with an active posted `SALE_ISSUE`, zero delivered quantity on every line, consistent persisted movements and allocations, and no active customer return. A draft return must be cancelled explicitly first. Draft, completed, delivered, already cancelled, already reversed, missing-posting, and inconsistent-history cases are state conflicts.

## Atomic reversal lifecycle

One bounded-retry serializable transaction locks the idempotency key, sale, source posting, and affected batches in deterministic order. Reversal quantities, products, batches, and warehouses come only from persisted issue movements and allocations. The transaction creates one `REVERSAL` posting, adds positive compensating movements to the original sellable batches, restores the per-product compatibility cache, marks the issue `REVERSED`, and changes the sale to `CANCELLED`. Allocations remain unchanged as audit evidence. Any failure rolls all these changes back.

For compensating movements, `warehouseId` and `destinationWarehouseId` both identify the original issue warehouse because quantity is restored into that same warehouse; `sourceWarehouseId` is null because this is not a transfer from another warehouse.

`InventoryPosting.requestFingerprint` persists the command identity. The fingerprint covers the command kind, sale, actor, reason, and custody declaration. The same key and same command reconstruct the persisted result without mutations; a changed payload, different command, or second reversal conflicts. Concurrent cancellation and customer-return creation serialize on the sale lock, so only one consistent workflow can win.

## Scope boundary

There is no generic reversal endpoint. Completed or delivered sale cancellation, purchase-receipt reversal, customer-return reversal, supplier-return reversal, transfer reversal, adjustment reversal, and accounting/refund automation remain deferred. Existing customer and supplier return workflows are unchanged.
