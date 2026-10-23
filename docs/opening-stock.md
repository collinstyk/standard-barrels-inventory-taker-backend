# Opening stock (Inventory V2)

`POST /api/v1/inventory/opening-stock` records stock already on hand when a product and warehouse are first brought into Inventory V2. It is an ADMIN/MANAGER command, requires `INVENTORY_V2_ENABLED=true` and a fresh `Idempotency-Key`, and does not create a purchase, receipt, supplier balance, or payment. STAFF and AUDITOR are denied.

```json
{
  "notes": "Counted before go-live",
  "lines": [
    { "productId": "<UUID>", "unitId": 1, "warehouseId": 1, "quantityInUnit": 12, "expiryDate": "2027-12-31" },
    { "productId": "<UUID>", "unitId": 2, "warehouseId": 2, "quantityInUnit": 4, "expiryDate": null }
  ]
}
```

The strict body requires 1–100 lines. Quantity is a positive integer in the selected ProductUnit; the server applies that unit's multiplier and returns both the entered and base-unit quantities. `expiryDate` is optional, in `YYYY-MM-DD` format, and cannot be before the configured business date. All opening stock is sellable. A product/warehouse may have several opening lines with different expiry dates, but no duplicate product/warehouse/expiry line. The server refuses opening stock for a product/warehouse that already has an InventoryBatch or legacy StockLevel, and refuses a product whose sellable cache does not reconcile with its existing batches. Use physical-count adjustments for later corrections to existing batches.

The whole request is one serializable transaction. It creates an `OPENING_STOCK` posting, one new batch and positive movement per line, and updates each product's sellable cache. The response has `status: "success"` and `data` containing posting ID/status/time, actor, `replayed`, notes, and each line's batch and movement IDs, ProductUnit multiplier, entered quantity, base quantity, warehouse, expiry, and resulting product cache. First success is HTTP 201; an exact replay is HTTP 200 with `replayed: true`. Reusing a key with a different payload or command returns 409. No automatic offline replay is intended.

Apply the included migration before enabling this route, then run `pnpm exec prisma generate`, `pnpm typecheck`, and tests. The migration adds `OPENING_STOCK` to the posting and movement enums; it does not alter existing rows.
