# Phase 2A: Inventory Domain Design and Migration Plan

Status: Phase 2B-1 schema foundation documented; posting business logic, controllers, routes, and database application remain deferred.
Repository snapshot reviewed: current working tree on 2026-07-21, including all uncommitted files and all 12 existing migration directories.

## 1. Executive summary

The current backend stores a warehouse/expiry aggregate in `StockLevel`, duplicates that total in `Product.quantityInStock`, and writes loosely linked `StockLog` rows. That shape cannot distinguish two non-expiring receipts in the same warehouse, cannot provide FIFO, cannot prove whether an order quantity was already posted, and cannot cumulatively constrain repeated returns. The controllers compensate with read-then-write logic and mutable order totals, which leaves duplicate-posting and concurrency gaps (`prisma/schema.prisma:38-162`, `controllers/purchaseOrder.ts:152-195`, `controllers/saleOrder.ts:40-190`).

The smallest safe long-term architecture is:

1. Introduce a dedicated, location-bound `InventoryBatch` for every independently received stock lot. Each batch records product, warehouse, optional expiry date, reliable receipt time, disposition, remaining base-unit quantity, and provenance.
2. Introduce an immutable `InventoryPosting` header with a unique idempotency key and immutable `StockMovement` rows. Every stock-changing command—receipt, sale issue, return, transfer, adjustment, or reversal—must own exactly one posting.
3. Model purchase receipts explicitly instead of inferring postings from `PurchaseItem.quantityReceived`; model sale allocations explicitly so the system knows which batches were consumed.
4. Replace negative companion orders with dedicated `PurchaseReturn`/`PurchaseReturnItem` and `SaleReturn`/`SaleReturnItem` models directly linked to their original order items.
5. Treat `ProductUnit.price` as purchase/cost price. Snapshot actual purchase cost on purchase items/receipt items and actual agreed selling price on sale items. Do not derive historical sale revenue from the current product-unit cost.
6. Make batch balances authoritative and eventually remove `Product.quantityInStock`. During migration, retain it only as a compatibility cache, reconcile it to sellable batch totals, and dual-write until all readers have moved.
7. Post inventory inside PostgreSQL transactions using unique posting keys, deterministic batch ordering, row locks or conditional updates, and retries for safe serialization/deadlock failures.

For posted sales, reversal back to `DRAFT` should be prohibited. Corrections should use an explicit reversal posting, preserving the original issue and the compensating movements. A batch with a date-only expiry is valid through that business-local calendar date and becomes expired at the start of the following date in the configured warehouse/business timezone.

## 2. Current implementation analysis

### 2.1 Current model inventory

| Current model | Current representation | Keep | Clarify/add/replace |
|---|---|---|---|
| `Product` | UUID identity, name, base unit, category, global `quantityInStock`, reorder point (`prisma/schema.prisma:38-51`) | Identity, name, category, base unit, reorder point | `quantityInStock` duplicates batch balances. Retain temporarily as a compatibility cache, then remove or rename explicitly to `cachedSellableQuantity` during transition. Add batch relation. |
| `ProductUnit` | Integer identity, name, multiplier, `Decimal price`, unique SKU (`prisma/schema.prisma:53-63`) | SKU, product relation, multiplier, unit name | Confirm `price` means purchase/cost price. Prefer a future rename to `purchaseCost`; snapshot multiplier and actual price on order items so later changes do not rewrite history. Add positive multiplier/cost constraints. |
| `Warehouse` | Integer identity, unique name, optional location (`prisma/schema.prisma:65-71`) | All current fields | Add relations to batches, receipts, returns, and movement source/destination roles. Capacity is not currently modeled; the 10,000-unit report constant is not domain data (`controllers/reports.ts:185-237`). |
| `StockLevel` | Product + warehouse + nullable expiry + aggregate quantity (`prisma/schema.prisma:73-83`) | No long-term model; use only as migration source/compatibility view | Replace with `InventoryBatch`. It lacks receipt time, origin, disposition, posting identity, and independent non-expiring batches. Nullable compound uniqueness is unsafe because PostgreSQL normally permits multiple `NULL` values and Prisma callers currently cast null into compound selectors (`controllers/inventory.ts:42-54`). |
| `StockLog` | Product, one warehouse, signed quantity, broad type, optional sale/purchase order, timestamp (`prisma/schema.prisma:149-162`) | Signed-quantity idea and timestamp | Replace with richer immutable `StockMovement` linked to batch, posting, actor, source/destination context, returns, reason, and notes. Current log cannot authoritatively detect duplicates or reconstruct batch balances. |
| `PurchaseOrder` | Supplier/receiver, commercial transaction/payment/receiving statuses, totals and items (`prisma/schema.prisma:103-119`) | Identity, parties, timestamps, commercial/payment fields, order items | Receiving status should be derived or transactionally cached from explicit receipt items. Add receipts and supplier returns. Do not use order status alone as posting state. |
| `PurchaseItem` | Ordered and mutable received quantities, unit/cost snapshots (`prisma/schema.prisma:135-147`) | Original order link, product/unit, ordered quantity, precise cost fields | Rename semantics to `unitCost`; add multiplier snapshot. Make receipts the authority for received quantity. `quantityReceived` may remain a derived/cache field during transition. Add receipt and return item relations. |
| `SaleOrder` | Buyer/seller, transaction/payment/delivery statuses, totals and items (`prisma/schema.prisma:85-101`) | Identity, parties, timestamps, commercial/payment/delivery fields | Add one inventory activation posting and customer returns. Status remains commercial state, not proof of stock posting. Posted-to-draft is prohibited; reversal is explicit. |
| `SaleItem` | Ordered/delivered quantities, unit, `unitPrice`, total (`prisma/schema.prisma:121-133`) | Order/product/unit links and precise decimal snapshots | Current controller copies `ProductUnit.price`, which is now confirmed as cost (`controllers/saleOrder.ts:99-123`). Replace/rename `unitPrice` as actual `unitSalePrice`; add multiplier snapshot and allocation relation. Historical rows require classification before backfill. |
| `Contact` | Buyer/supplier flags and order relations (`prisma/schema.prisma:23-30`) | Current fields | Relation property names `sales` and `purchases` are counterintuitive: `sales` points to purchase orders and `purchases` to sale orders. Rename relation properties in code without changing columns when practical. |
| `User` | UUID, credentials, role, order relations, timestamps (`prisma/schema.prisma:10-21`) | Current fields | Add relations for who posted receipts, sales, returns, transfers, adjustments, and reversals. Store actor on the posting/ledger. |

Relevant statuses can remain for commercial workflow, but they do not express inventory posting. `TransactionStatus` conflates draft, active, completed, cancelled; `ReceivingStatus` and `DeliveryStatus` can be calculated from explicit receipts/allocations and may remain cached for API compatibility. `StockChangeType` is too broad and should be superseded by a precise movement enum.

### 2.2 Verified current behavior and failure modes

- Purchase creation adds stock for `PENDING` or `COMPLETED` using the submitted `quantityReceived`, increments the global counter, and writes one log (`controllers/purchaseOrder.ts:152-195`). It omits `expiryDate` from the batch creation data even though the selector includes it (`controllers/purchaseOrder.ts:170-178`).
- Purchase update computes a delta against mutable `PurchaseItem.quantityReceived`; repeated or concurrent requests can race, negative deltas can reduce stock without checking availability, and the same logical receipt has no identity (`controllers/purchaseOrder.ts:248-315`).
- Sale creation treats every non-`DRAFT` order as stock-affecting and deducts `quantityOrdered`, not `quantityDelivered` (`controllers/saleOrder.ts:40-75`, `controllers/saleOrder.ts:125-190`). It has no posting record, so retries cannot be distinguished from a second sale request.
- Sale allocation filters for one caller-provided expiry value instead of selecting FEFO/FIFO candidates and uses a warehouse ordering expression that does not actually prioritize the requested warehouse (`controllers/saleOrder.ts:129-146`). It does not exclude expired stock.
- Sale update changes delivery/payment/status data but creates no stock movement for `DRAFT` to non-`DRAFT` and no safe reversal for the opposite transition (`controllers/saleOrder.ts:220-275`).
- Transfers select only the first expiry row, fail rather than continue across batches, and have no transfer identity linking the two log rows (`controllers/inventory.ts:157-230`).
- Physical adjustment overwrites an aggregate stock row and logs a delta, but cannot identify which receipt batch was counted (`controllers/inventory.ts:31-113`).
- Purchase and customer returns create negative companion orders. They compare one return only against the original line, do not sum previous returns, do not directly link to the original order, and do not distinguish sellable from damaged customer returns (`controllers/purchaseOrder.ts:321-445`, `controllers/saleOrder.ts:277-403`).
- Reports convert Prisma `Decimal` to JavaScript `number` and perform floating-point multiplication for loss values (`controllers/reports.ts:87-110`). That is unsafe for authoritative money; money calculations must stay `Decimal` or be performed in SQL decimals.
- Existing tests are Phase 1 route/auth tests with Prisma mocked. They do not cover domain transactions or concurrency (`tests/app.test.ts`).

### 2.3 Can `StockLevel` represent FIFO batches?

No. Two non-expiring receipts of the same product into the same warehouse both have `expiryDate = NULL`. Even if PostgreSQL permits multiple rows because nulls are distinct, there is no receipt timestamp or origin to order them reliably, and Prisma compound-unique operations with nullable inputs require unsafe casts. If application code instead merges them, receipt identity is destroyed. Neither behavior supports reliable FIFO. A dedicated batch model is required.

## 3. Confirmed business rules and resulting invariants

The following are design constraints, not open questions:

- `DRAFT` purchases and sales do not affect inventory.
- A sale created non-draft posts its eligible base-unit quantity once. Moving among non-draft statuses does not post again. A draft-to-active transition creates the one issue posting.
- A posted sale cannot be moved back to draft. An authorized explicit reversal creates compensating movements and leaves the original audit trail intact.
- Purchases increase stock only through posted receipt quantities. Partial and multiple receipts are first-class operations; editing an order does not itself repost inventory.
- FEFO selects sellable, positive-quantity, non-expired batches by earliest expiry, then receipt time, then stable ID. Allocation continues across batches.
- FIFO selects sellable, positive-quantity, non-expiring batches by receipt time, then stable ID. Allocation continues across batches.
- Expiry is date-based: an `expiryDate` is the final sellable business-local calendar date. At local `00:00` on the next date, the batch is expired. Store it as PostgreSQL `DATE` (`DateTime @db.Date` in Prisma) and calculate “today” in one configured business timezone. Do not compare arbitrary server-local timestamps.
- Sellable customer returns create/increase sellable stock in the selected warehouse. Damaged returns are recorded as on-hand non-sellable inventory and count toward cumulative returned quantity.
- Supplier returns reference original purchase items and explicitly selected warehouse batches, reduce stock, and cannot cumulatively exceed received quantity or available batch quantity.
- Customer returns reference original sale items and cannot cumulatively exceed the eligible issued/delivered quantity. Every condition counts toward that cap.
- All order quantities are converted with the multiplier snapshot into integer base units before inventory operations.
- All multi-row operations are atomic and idempotent. No normal operation may produce a negative batch balance.
- Every mutation owns an immutable posting and movement records. Batch balances are stored for efficient locking/allocation; movements are the audit history and should reconcile to balances.
- Money remains database `Decimal`. Do not use JavaScript `number` for authoritative totals.

## 4. Recommended domain model

### 4.1 Batch approach comparison

| Approach | Benefits | Problems | Decision |
|---|---|---|---|
| A. Extend `StockLevel` | Fewest new model names; could add receipt time/origin | Existing identity means “aggregate,” current nullable unique key is unsafe, migration semantics remain ambiguous, and one row cannot naturally represent one receipt while existing code expects an aggregate | Reject as long-term design. It saves schema lines but retains the wrong identity. |
| B. Dedicated `InventoryBatch` | Explicit receipt identity, FIFO/FEFO ordering, provenance, per-batch locks, clear transfer/return behavior, easy allocation relations | Requires additive migration and temporary dual-write/read transition | **Recommended.** It is the smallest option that satisfies correctness and auditability. |
| C. Sellable batches plus separate non-sellable return records | Strong separation of sellable and damaged stock | Duplicates warehouse/product/provenance logic, complicates disposition changes such as quarantine release, and fragments physical inventory queries | Do not split now. Represent sellable and non-sellable physical lots in one batch table with disposition. |

### 4.2 Recommended batch semantics

An `InventoryBatch` is a quantity of one product, in one warehouse, with one provenance/receipt time, expiry, and disposition. Its quantity is always in the product base unit.

- Purchase receipt: one receipt item normally creates one batch for its product/warehouse/expiry.
- Customer return: create a new return-origin batch. Do not silently merge it into the original sold batch because receipt time, condition, inspection, and potentially expiry differ.
- Transfer: decrement source batches and create destination batches. Preserve provenance using `sourceBatchId`; the destination is a new location-bound batch because one batch cannot belong to two warehouses. A single transfer can create multiple destination batches when multiple source batches are consumed.
- Sellable and damaged stock use the same table with `SELLABLE` or `DAMAGED` disposition. `QUARANTINED` is useful now because returned goods commonly require inspection before release; include it if operations can use it. `EXPIRED` is also useful as a non-sellable disposition, though expiration can initially be derived from the date and materialized only when processed. `DISPOSED` describes a movement/outcome rather than on-hand inventory and can be deferred unless disposal workflows are in Phase 2B.
- A batch remains independently identifiable even if product, warehouse, expiry, and receipt timestamp equal another batch. No compound uniqueness should merge batches.

### 4.3 Global quantity recommendation

The authoritative sellable total should be `SUM(InventoryBatch.quantityOnHandBase)` where disposition is `SELLABLE` and the batch is not expired (whether expired inventory remains physically on hand is separate from sellability). `Product.quantityInStock` should ultimately be removed. During transition:

1. Rename its meaning in code/documentation to cached sellable quantity.
2. Backfill it from batches after discrepancies are resolved.
3. Dual-write it in the same transactions as batch updates.
4. Add a reconciliation check/metric.
5. Move low-stock/report reads to batch aggregation.
6. Drop the column only in a later cleanup migration after parity is proven.

## 5. Draft Prisma schema changes

The following is an architectural draft, not an executable migration and not a complete replacement schema. Relation names may be adjusted while integrating with the full schema. PostgreSQL check constraints and partial indexes noted after the draft require migration SQL because Prisma schema syntax does not express all of them.

```prisma
// DRAFT ONLY - DO NOT APPLY IN PHASE 2A

enum BatchDisposition {
  SELLABLE
  DAMAGED
  QUARANTINED
  EXPIRED
}

enum PostingStatus {
  POSTED
  REVERSED
}

enum PostingKind {
  PURCHASE_RECEIPT
  SALE_ISSUE
  CUSTOMER_RETURN
  SUPPLIER_RETURN
  TRANSFER
  ADJUSTMENT
  REVERSAL
  MIGRATION_OPENING_BALANCE
}

enum StockMovementType {
  PURCHASE_RECEIPT
  SALE_ISSUE
  CUSTOMER_RETURN_SELLABLE
  CUSTOMER_RETURN_DAMAGED
  CUSTOMER_RETURN_QUARANTINED
  SUPPLIER_RETURN
  TRANSFER_OUT
  TRANSFER_IN
  POSITIVE_ADJUSTMENT
  NEGATIVE_ADJUSTMENT
  EXPIRY_RECLASSIFICATION
  REVERSAL
  MIGRATION_OPENING_BALANCE
}

enum ReceiptStatus {
  DRAFT
  POSTED
  REVERSED
}

enum ReturnStatus {
  DRAFT
  POSTED
  REVERSED
  CANCELLED
}

enum ReturnCondition {
  SELLABLE
  DAMAGED
  QUARANTINED
}

model InventoryBatch {
  id                    String           @id @default(uuid())
  productId             String
  warehouseId           Int
  expiryDate            DateTime?        @db.Date
  receivedAt            DateTime
  quantityOnHandBase    Int
  disposition           BatchDisposition @default(SELLABLE)
  purchaseReceiptItemId Int?              @unique
  saleReturnItemId      Int?              @unique
  sourceBatchId         String?
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt

  product               Product           @relation(fields: [productId], references: [id])
  warehouse             Warehouse         @relation(fields: [warehouseId], references: [id])
  purchaseReceiptItem   PurchaseReceiptItem? @relation(fields: [purchaseReceiptItemId], references: [id])
  saleReturnItem        SaleReturnItem?    @relation(fields: [saleReturnItemId], references: [id])
  sourceBatch           InventoryBatch?   @relation("BatchDerivation", fields: [sourceBatchId], references: [id])
  derivedBatches        InventoryBatch[]  @relation("BatchDerivation")
  saleAllocations       SaleAllocation[]
  movements             StockMovement[]

  @@index([productId, warehouseId, disposition, expiryDate, receivedAt])
  @@index([sourceBatchId])
}

model InventoryPosting {
  id                String        @id @default(uuid())
  idempotencyKey    String        @unique
  kind              PostingKind
  status            PostingStatus @default(POSTED)
  performedById     String
  postedAt          DateTime      @default(now())
  reversalOfId      String?       @unique
  notes             String?
  purchaseReceiptId Int?          @unique
  saleOrderId       Int?          @unique
  purchaseReturnId  Int?          @unique
  saleReturnId      Int?          @unique

  performedBy       User          @relation(fields: [performedById], references: [id])
  purchaseReceipt   PurchaseReceipt? @relation(fields: [purchaseReceiptId], references: [id])
  saleOrder         SaleOrder?       @relation(fields: [saleOrderId], references: [id])
  purchaseReturn    PurchaseReturn?  @relation(fields: [purchaseReturnId], references: [id])
  saleReturn        SaleReturn?      @relation(fields: [saleReturnId], references: [id])
  reversalOf        InventoryPosting? @relation("PostingReversal", fields: [reversalOfId], references: [id])
  reversedBy        InventoryPosting? @relation("PostingReversal")
  movements         StockMovement[]
}

model StockMovement {
  id                  String            @id @default(uuid())
  postingId           String
  sequence            Int
  type                StockMovementType
  productId           String
  batchId             String
  warehouseId         Int
  sourceWarehouseId   Int?
  destinationWarehouseId Int?
  quantityChangeBase  Int
  adjustmentReason    String?
  notes               String?
  performedById       String
  createdAt           DateTime          @default(now())

  posting             InventoryPosting  @relation(fields: [postingId], references: [id])
  product             Product           @relation(fields: [productId], references: [id])
  batch               InventoryBatch    @relation(fields: [batchId], references: [id])
  warehouse           Warehouse         @relation(fields: [warehouseId], references: [id])
  sourceWarehouse     Warehouse?         @relation("MovementSourceWarehouse", fields: [sourceWarehouseId], references: [id])
  destinationWarehouse Warehouse?        @relation("MovementDestinationWarehouse", fields: [destinationWarehouseId], references: [id])
  performedBy         User              @relation(fields: [performedById], references: [id])

  @@unique([postingId, sequence])
  @@index([productId, createdAt])
  @@index([batchId, createdAt])
  @@index([warehouseId, createdAt])
}

model PurchaseReceipt {
  id                Int           @id @default(autoincrement())
  purchaseOrderId   Int
  idempotencyKey    String        @unique
  status            ReceiptStatus @default(DRAFT)
  receivedAt        DateTime
  receivedById      String
  createdAt         DateTime      @default(now())
  postedAt          DateTime?
  notes             String?

  purchaseOrder     PurchaseOrder @relation(fields: [purchaseOrderId], references: [id])
  receivedBy        User          @relation(fields: [receivedById], references: [id])
  items             PurchaseReceiptItem[]
}

model PurchaseReceiptItem {
  id                   Int             @id @default(autoincrement())
  receiptId            Int
  purchaseItemId       Int
  warehouseId          Int
  quantityInOrderUnit  Int
  unitMultiplier       Int
  quantityBase         Int
  actualUnitCost       Decimal         @db.Decimal(18, 4)
  expiryDate           DateTime?       @db.Date

  receipt              PurchaseReceipt @relation(fields: [receiptId], references: [id])
  purchaseItem         PurchaseItem    @relation(fields: [purchaseItemId], references: [id])
  warehouse            Warehouse       @relation(fields: [warehouseId], references: [id])
  batch                InventoryBatch?

  @@index([purchaseItemId])
}

model SaleAllocation {
  id                Int            @id @default(autoincrement())
  saleItemId        Int
  batchId           String
  quantityBase      Int
  createdAt         DateTime       @default(now())

  saleItem          SaleItem       @relation(fields: [saleItemId], references: [id])
  batch             InventoryBatch @relation(fields: [batchId], references: [id])

  @@unique([saleItemId, batchId])
  @@index([batchId])
}

model PurchaseReturn {
  id                    Int          @id @default(autoincrement())
  originalPurchaseId    Int
  idempotencyKey        String       @unique
  status                ReturnStatus @default(DRAFT)
  processedById         String
  refundAmount          Decimal      @default(0) @db.Decimal(18, 2)
  reason                String?
  createdAt             DateTime     @default(now())
  postedAt              DateTime?

  originalPurchase      PurchaseOrder @relation(fields: [originalPurchaseId], references: [id])
  processedBy           User          @relation(fields: [processedById], references: [id])
  items                 PurchaseReturnItem[]

  @@index([originalPurchaseId])
}

model PurchaseReturnItem {
  id                      Int                @id @default(autoincrement())
  purchaseReturnId        Int
  originalPurchaseItemId  Int
  sourceBatchId           String
  warehouseId             Int
  quantityInOrderUnit     Int
  unitMultiplier          Int
  quantityBase            Int
  unitRefundCost          Decimal?           @db.Decimal(18, 4)

  purchaseReturn          PurchaseReturn     @relation(fields: [purchaseReturnId], references: [id])
  originalPurchaseItem    PurchaseItem       @relation(fields: [originalPurchaseItemId], references: [id])
  sourceBatch             InventoryBatch     @relation(fields: [sourceBatchId], references: [id])
  warehouse               Warehouse          @relation(fields: [warehouseId], references: [id])

  @@index([originalPurchaseItemId])
  @@index([sourceBatchId])
}

model SaleReturn {
  id                 Int          @id @default(autoincrement())
  originalSaleId     Int
  idempotencyKey     String       @unique
  status             ReturnStatus @default(DRAFT)
  processedById      String
  refundAmount       Decimal      @default(0) @db.Decimal(18, 2)
  reason             String?
  createdAt          DateTime     @default(now())
  postedAt           DateTime?

  originalSale       SaleOrder    @relation(fields: [originalSaleId], references: [id])
  processedBy        User         @relation(fields: [processedById], references: [id])
  items              SaleReturnItem[]

  @@index([originalSaleId])
}

model SaleReturnItem {
  id                    Int             @id @default(autoincrement())
  saleReturnId          Int
  originalSaleItemId    Int
  warehouseId           Int
  condition             ReturnCondition
  quantityInOrderUnit   Int
  unitMultiplier        Int
  quantityBase          Int
  expiryDate            DateTime?        @db.Date
  unitRefundPrice       Decimal?          @db.Decimal(18, 4)

  saleReturn            SaleReturn       @relation(fields: [saleReturnId], references: [id])
  originalSaleItem      SaleItem         @relation(fields: [originalSaleItemId], references: [id])
  warehouse             Warehouse        @relation(fields: [warehouseId], references: [id])
  resultingBatch        InventoryBatch?

  @@index([originalSaleItemId])
}

// Existing-model additions/semantic changes (illustrative):
// Product.batches InventoryBatch[]
// Product.quantityInStock remains only during compatibility transition, then drops.
// ProductUnit.price remains purchase/cost price; later rename to purchaseCost.
// PurchaseOrder.receipts PurchaseReceipt[]
// PurchaseOrder.purchaseReturns PurchaseReturn[]
// PurchaseItem.unitMultiplierSnapshot Int
// PurchaseItem.unitCost Decimal @db.Decimal(18, 4)
// PurchaseItem.receiptItems PurchaseReceiptItem[]
// PurchaseItem.returnItems PurchaseReturnItem[]
// SaleOrder.inventoryPosting InventoryPosting?
// SaleOrder.saleReturns SaleReturn[]
// SaleItem.unitMultiplierSnapshot Int
// SaleItem.unitSalePrice Decimal @db.Decimal(18, 4)
// SaleItem.allocations SaleAllocation[]
// SaleItem.returnItems SaleReturnItem[]
```

Required raw-SQL constraints/indexes in the eventual forward migration:

- `CHECK (quantityOnHandBase >= 0)` on batches.
- `CHECK (quantityBase > 0)` on receipt/allocation/return items.
- `CHECK (quantityChangeBase <> 0)` on movements.
- Positive multiplier and ordered-quantity checks.
- Partial FEFO index on `(productId, warehouseId, expiryDate, receivedAt, id)` for sellable, positive, expiring batches.
- Partial FIFO index on `(productId, warehouseId, receivedAt, id)` for sellable, positive, non-expiring batches.
- Optional database trigger is not recommended initially; application transactions plus constraints/posting uniqueness are simpler. Reconciliation remains mandatory.

## 6. Batch-allocation design

### 6.1 Candidate rules

Allocation occurs within the requested warehouse unless a future API explicitly permits cross-warehouse fulfillment. The current controller silently searches system-wide stock after asking for a preferred warehouse; Phase 2B should make warehouse scope explicit.

For a requested base quantity:

1. Filter `productId`, `warehouseId`, `disposition = SELLABLE`, and `quantityOnHandBase > 0`.
2. Exclude expired batches.
3. For expiring inventory, order by `expiryDate ASC`, `receivedAt ASC`, `id ASC`.
4. For non-expiring inventory, order by `receivedAt ASC`, `id ASC`.
5. Allocate across candidates until fulfilled; if total is insufficient, abort the complete transaction.

Mixed expiring and non-expiring stock needs an approved product policy. Recommended default: consume valid expiring batches first by FEFO, then non-expiring batches by FIFO, because this minimizes expiry loss. If product categories require strict lot types, store an allocation policy on `Product` later. This is listed for approval in section 16.

### 6.2 Expiry comparison

Use a configured IANA business timezone, not the host machine timezone. Convert the current instant to a business-local date. A batch is eligible when `expiryDate IS NULL OR expiryDate >= businessToday`; it is expired when `expiryDate < businessToday`. Storing expiry as PostgreSQL `DATE` avoids accidental midday/timezone expiry. Changing an expiry date after posting should require an audited adjustment, not a silent edit.

### 6.3 Transfer behavior

A transfer creates one posting. It allocates and locks source batches using the same FEFO/FIFO rules unless the caller explicitly selects batch IDs. Each source batch receives a negative `TRANSFER_OUT` movement. Each destination batch receives a positive `TRANSFER_IN` movement and references its source batch. Total sellable stock across all warehouses is unchanged. Source and destination movements have equal absolute quantities; that equality is verified before commit.

## 7. Purchase posting lifecycle

1. **Draft order:** Create commercial order/items. Snapshot SKU/unit, multiplier, ordered quantity, and agreed unit cost. No inventory posting.
2. **Order activation:** `PENDING` means approved/active but still does not add stock. Ordered quantity is not stock.
3. **Draft receipt:** Create a `PurchaseReceipt` with a client idempotency key and receipt items referencing original purchase items, selected warehouses, quantities, cost, and expiry. Validate cumulative quantity but do not change stock.
4. **Post receipt:** In one transaction, lock the purchase order/items; reject duplicate idempotency key; verify each new cumulative received quantity does not exceed the ordered quantity unless an explicit over-receipt policy is later approved; create batches; create one posting and receipt movements; mark receipt posted; update cached received/receiving state and compatibility global counters.
5. **Partial/multiple receipts:** Each receipt is immutable once posted. Later receipts add only their own quantities; the sum of posted receipt items is authoritative.
6. **Correction:** Do not edit a posted received quantity. Reverse the original receipt (if none of its quantity has been sold/returned/transferred, or through a controlled compensating workflow), then post a corrected receipt. This is safer than using an untraceable negative delta.
7. **Completion:** `receivingStatus` is `NOT_RECEIVED`, `PARTLY_RECEIVED`, or `FULLY_RECEIVED` based on posted receipt sums. Commercial completion may require full receipt and any payment rule, but does not itself post inventory.
8. **Cancellation:** A draft/unreceived order may cancel directly. An order with posted receipts cannot cancel without explicit receipt reversal or supplier returns; never delete its history.

`PurchaseItem.quantityReceived` can remain as a transactionally maintained cache during compatibility but must equal the sum of non-reversed receipt items. It must never be the idempotency mechanism.

Order total purchase cost should be `SUM(quantityOrdered * agreed unit cost)` plus `extraCost` under the current system’s apparent behavior. If extra cost represents freight/fees, retain it at order level; do not automatically allocate it into per-unit inventory valuation until accounting requirements are approved. Actual receipt cost may differ from ordered cost, so `PurchaseReceiptItem.actualUnitCost` snapshots the received cost. All calculations remain Decimal.

## 8. Sale posting lifecycle

1. **Draft order:** Create order/items with product/unit, multiplier snapshot, ordered quantity, and actual agreed selling price. No stock change.
2. **Create as non-draft:** In the same transaction as order creation, create a unique `SALE_ISSUE` posting, lock/allocate eligible batches, decrement batch balances, create `SaleAllocation` rows and negative movements, and set the inventory posting relation. A retry with the same idempotency key returns the existing result.
3. **Draft to non-draft:** Use the same posting service. The unique `InventoryPosting.saleOrderId` guarantees only one activation issue.
4. **Non-draft to another non-draft:** Update commercial/delivery state only. Presence of the sale posting proves stock has already moved.
5. **Quantity increase after posting:** Do not mutate the original allocation invisibly. Post an explicit supplemental issue linked to an order revision, or prohibit quantity changes in initial Phase 2B. The smallest safe initial rule is to prohibit changes to posted quantities and require cancellation/replacement or an explicit later amendment feature.
6. **Completion:** Completion is commercial/fulfillment state and does not issue inventory again.
7. **Cancellation:** An unposted draft may cancel. A posted sale requires a reversal posting, subject to stock/provenance rules, and then moves to `CANCELLED`; it must not return to `DRAFT`.
8. **Reversal:** Authorized operation creates a `REVERSAL` posting referencing the original posting and compensating batch movements. If downstream returns/transfers make exact restoration impossible, reject automated reversal and require an audited adjustment workflow.

The approved “non-draft sale decreases stock” rule is best implemented by posting the ordered base quantity on activation, matching current behavior. Whether delivery quantity should instead define the eligible issue is a remaining operational decision because the schema independently tracks ordered and delivered quantities; see section 16.

## 9. Customer return lifecycle

1. Create a `SaleReturn` linked directly to the original sale and items linked to original sale items.
2. Capture selected destination warehouse, quantity in sale unit, multiplier snapshot, base quantity, condition, refund information, and optional expiry.
3. Before posting, lock the original sale item and aggregate all non-reversed prior return items across every condition.
4. Eligible cumulative quantity must not exceed the original posted/eligible quantity. Damaged and quarantined returns count fully toward this cap.
5. Post once using the return idempotency key.
6. Create a new `QUARANTINED` customer-return batch and a positive `CUSTOMER_RETURN_QUARANTINED` movement. The return posting does not increase sellable inventory.
7. Record the checklist inspection and final condition before reclassification. Final condition must be `SELLABLE` or `DAMAGED`.
8. Under one unique `RETURN_INSPECTION_RECLASSIFICATION` posting, decrease the original quarantined batch and create a new derived batch in the same warehouse with `sourceBatchId` pointing to that quarantined batch. Write a negative movement against the quarantined batch and an equal positive movement against the derived batch.
9. A return is immutable after posting. Correction uses reversal, not editing/deletion.

`EXPIRED` is useful as an eventual return condition only if expired goods may physically come back and require separate reporting. It can be represented by an `EXPIRED` batch disposition but deferred from the Phase 2B public contract. `DISPOSED` should be a later movement from damaged/quarantined/expired stock, not a return condition.

### 9.1 Inspection reclassification invariant

Inspection does not mutate the original returned batch from `QUARANTINED` to another disposition. It transfers the inspected quantity between two batches: the quarantined batch is decreased, while a new derived `SELLABLE` or `DAMAGED` batch is increased by exactly the same base quantity. The paired movements belong to the inspection's single posting, so their net physical quantity is zero. Only a `SELLABLE` derived batch increases sellable quantity; a `DAMAGED` derived batch remains physical but non-sellable.

The Phase 2B-1 schema supports this without further model changes: `InventoryBatch.sourceBatchId` records derivation, each movement identifies its batch and signed base-quantity change, `InventoryPosting.returnInspectionId` uniquely identifies the inspection posting, and the database posting-source checks require that relationship only for `RETURN_INSPECTION_RECLASSIFICATION`. Transactional balancing and batch creation remain Phase 2B-2 business logic and are deliberately not implemented here.

## 10. Supplier return lifecycle

1. Create a `PurchaseReturn` linked to the original purchase and each item to its original purchase item.
2. Require explicit source batch and warehouse selection. Do not infer “oldest” when the operator is returning a physically selected lot.
3. Lock the original purchase item, selected batch, and prior posted purchase returns.
4. Verify cumulative returned quantity does not exceed posted receipt quantity for that purchase item; draft/unreceived order quantity is ineligible.
5. Verify the selected batch belongs to the same product and warehouse and has enough on-hand quantity. If one return spans batches, use separate return item rows.
6. In one transaction, create the posting, decrement batches conditionally, write negative `SUPPLIER_RETURN` movements, mark the return posted, and update compatibility counters.
7. Refund/credit remains a precise Decimal snapshot but does not implement accounts payable. Supplier credit-note accounting remains deferred.

## 11. Return representation comparison

| Option | Traceability and cumulative limits | Condition/warehouse/batch fit | Reporting/query cost | Migration | Decision |
|---|---|---|---|---|---|
| A. Negative companion orders | Weak: no direct original-item link; repeated returns require heuristic matching | Awkward; negative quantities overload order semantics and damaged returns look like normal inventory | Pollutes sales/purchase totals and status logic | Already used by current controller but legacy data is ambiguous | Reject. Preserve legacy rows during migration, do not create new ones. |
| B. Dedicated purchase and sale return models | Strong direct relations and purpose-specific constraints | Natural: sale conditions differ from supplier batch deductions | Straightforward domain queries and financial separation | Additive tables; legacy mapping required | **Recommended.** |
| C. Shared typed return model | Can be traceable but requires many mutually exclusive nullable FKs and conditional constraints | One item shape cannot cleanly express customer destination/condition and supplier source batch | More conditional query logic | One table but harder backfill/validation | Reject for this codebase; apparent schema economy produces domain ambiguity. |

## 12. Stock-movement ledger design

### 12.1 Authority and convention

`InventoryBatch.quantityOnHandBase` is the operational balance used for allocation and locking. `StockMovement` is the immutable audit ledger and reconciliation source. Recomputing all balances from the entire ledger for every request would be too expensive, but batch opening balance plus movements must reconcile exactly.

`quantityChangeBase` is signed relative to the referenced batch:

- Positive: quantity entered that batch.
- Negative: quantity left that batch.
- Zero is prohibited.

A transfer therefore has at least two movements under one posting: negative source and positive destination. Customer damaged returns have a positive movement into a non-sellable batch but zero effect on sellable totals.

### 12.2 Required context

Every movement includes posting, product, affected batch/warehouse, actor, type, signed base quantity, timestamp, and optional reason/notes. Source and destination warehouse IDs are populated where direction matters: sale/supplier-return rows have a source, receipt/customer-return rows have a destination, and both transfer rows carry the same source/destination pair. The posting supplies direct unique source relations to the purchase receipt, sale order, purchase return, or sale return. This avoids duplicating several nullable order/return IDs on every movement while keeping the relationship queryable.

Movement types are the precise list shown in the draft. Existing `PURCHASE`, `SALE`, `RETURN`, and `ADJUSTMENT` are not precise enough to distinguish supplier/customer direction or disposition.

### 12.3 Duplicate prevention and detection

- Client or server operation ID becomes `InventoryPosting.idempotencyKey`, unique in the database.
- Source uniqueness (for example one activation posting per sale order, one posting per receipt/return) is also enforced with unique relations.
- `StockMovement(postingId, sequence)` is unique, so a retry cannot create an extra line within a posting.
- A posting is created inside the same transaction as balance changes. It cannot say POSTED without all movements and balance updates committing.
- Reconciliation can group movements by posting and assert expected type/direction pairs, then compare batch opening quantities plus movement sums with current balances.

Application code must never update/delete posted movements. Database permissions should eventually deny those operations to the application role if operationally feasible.

## 13. Concurrency and transaction strategy

### 13.1 Current race exposure

- Sales aggregate available stock, then later decrement rows; two transactions can both observe enough stock and oversell (`controllers/saleOrder.ts:57-73`, `controllers/saleOrder.ts:133-190`).
- Purchase update reads received quantity then applies a delta; concurrent updates can post the same delta or lose one update (`controllers/purchaseOrder.ts:248-290`).
- Returns check only the current request against the original line, so concurrent/repeated returns can exceed eligibility.
- Transfers read one row before decrementing and can conflict with sales/other transfers (`controllers/inventory.ts:157-189`).
- Global and warehouse totals are separate writes. Although current controllers usually wrap them in transactions, missing paths or future code can diverge them.

### 13.2 Phase 2B transaction pattern

For each posting command:

1. Begin a Prisma interactive transaction with PostgreSQL `Serializable` isolation where practical.
2. Insert or fetch the unique posting/idempotency record. A uniqueness conflict means “already posted”; return the existing result rather than applying again.
3. Lock the source order/item and relevant eligibility rows.
4. Select candidate batches deterministically and lock them with `SELECT ... FOR UPDATE` (optionally `SKIP LOCKED` only if the API is designed to retry/reselect). Prisma does not currently expose a first-class row-lock query; parameterized `$queryRaw` inside the transaction is the practical PostgreSQL-specific tool.
5. Apply conditional decrements (`quantityOnHandBase >= requested`) and verify the affected count, even after locks, to prevent negative stock.
6. Insert allocation/receipt/return records and movements; update compatibility caches; mark posting/source posted.
7. Commit atomically.
8. Retry a small bounded number of times for recognized serialization/deadlock failures only. Reuse the same idempotency key. Do not retry validation or insufficient-stock errors.

Alternative without raw locks: use deterministic `updateMany` conditional decrements and verify counts, but multi-batch allocation remains harder to make race-free. Serializable isolation plus retry can work, yet explicit row locks make intent clearer and reduce wasted retries. The recommended implementation uses raw SQL only for locked candidate selection and keeps writes in Prisma where possible.

Database constraints remain the final guardrails: nonnegative batch quantities, positive item quantities, unique posting keys/source relations, nonzero movements, and foreign keys. Avoid read-then-write updates without a conditional predicate.

## 14. Safe migration sequence

Do not edit historical migrations. Some existing migrations add required fields without backfills (`20260501111753`, `20260521041619`, `20260523103435`), but they may already be applied. Changing them would create checksum/history divergence. Handle environments where they are unapplied through an explicit deployment preflight or database baseline plan, not silent edits.

### 14.1 Existing migration review

| Migration | Verified effect | Phase 2A implication |
|---|---|---|
| `20260429162820_init` | Creates all current core tables/enums, aggregate `StockLevel`, broad `StockLog`, integer order IDs, Decimal money, and initial FKs/indexes | Establishes legacy identities and IDs that must be preserved. Initial `ProductUnit.price` is `DECIMAL(65,30)` while order snapshots are `DECIMAL(10,2)`. |
| `20260501054023_update_transaction_status` | Adds default `PENDING` to sale transaction status | Commercial default exists but must not serve as posting proof. |
| `20260501111753_update_total_price` | Adds required amount/total columns without backfills and purchase/sale monetary fields | Unsafe on nonempty unapplied databases; do not rewrite history. Preflight deployment status and retain Decimal semantics. |
| `20260505225303_update_category_id` | Converts category primary/foreign keys from integer to text | Preserve resulting text IDs and verify partial-failure history in migration status. Not otherwise inventory-specific. |
| `20260510110937_update_product_unit_sku_field_to_be_unique` | Adds unique SKU index | Can fail where duplicates predate it; confirm migration applied and duplicates absent before relying on SKU identity. |
| `20260510180544_update_add_extra_cost_field_to_sale_order` | Adds sale `extraCost` with safe zero default | Preserve as order-level monetary snapshot; it does not define inventory value. |
| `20260516044115_add_expiry_date_field_to_stock_level_record` | Adds nullable timestamp expiry | Existing timestamp data must be normalized carefully to business-local date when moving to `@db.Date`. |
| `20260516045532_make_expiry_date_a_unique_constraint_for_stock_level` | Replaces product/warehouse unique index with product/warehouse/nullable-expiry unique index | Does not prevent duplicate null-expiry rows in normal PostgreSQL semantics and still cannot provide FIFO. Treat every legacy row independently. |
| `20260517214846_add_new_stock_change_types` | Adds transfer-in/out enum values | Preserve legacy log meaning during mapping; paired rows lack a common posting identity. |
| `20260517220136_add_expired_to_the_stock_change_type` | Adds expired enum value | Legacy expired logs need mapping to precise adjustment/reclassification movement semantics. |
| `20260521041619_add_reorderpoint_the_product_model` | Adds required reorder point without a default | Unsafe on nonempty unapplied databases; later default does not retroactively make this migration safe. |
| `20260523103435_add_auth_and_relations_to_user` | Adds manager role, sets future reorder default, and adds required password/updatedAt without backfills | Unsafe on populated unapplied databases. Actor relations in new postings can rely on user IDs only after auth migration/data integrity is confirmed. |

All Phase 2 changes should be new forward migrations. A fresh installation and an already-migrated installation may need different operational preflight steps, but they must converge on the same schema without changing historical checksums.

### 14.2 Stage 0: inventory and recovery preparation

- Obtain an approved backup/snapshot and tested restore procedure.
- Record Prisma migration status per environment without exposing credentials.
- Quiesce inventory writes or deploy maintenance/read-only mode for the cutover snapshot.
- Run preflight queries for row counts, negative quantities, duplicate SKUs, duplicate/nullable stock aggregates, orphan relations, and global-versus-stock discrepancies.
- Export ambiguous negative companion orders to a review artifact.

### 14.3 Stage 1: additive schema

- Add new enums and tables as nullable/additive structures.
- Add item multiplier/cost/sale-price snapshot columns as nullable initially.
- Keep `StockLevel`, `StockLog`, and `Product.quantityInStock` untouched.
- Create constraints as `NOT VALID` where PostgreSQL permits, or add them only after backfill.
- Create indexes concurrently in a separately managed step if table size/locking warrants it; Prisma-generated transactional migrations may need hand-authored safe SQL.

### 14.4 Stage 2: classify and backfill historical orders/prices

- Backfill purchase multiplier snapshot from current `ProductUnit.multiplier`; preserve current `PurchaseItem.unitPrice` as historical unit cost unless contrary evidence exists.
- Existing `SaleItem.unitPrice` was populated from `ProductUnit.price` in current code, so it is cost-like, not confirmed sale price. Do not relabel it as authoritative sale revenue. Add nullable `unitSalePrice`, classify rows as `PRICE_UNCONFIRMED`, and require an approved data source/manual reconciliation before financial reporting treats them as sale prices.
- Detect negative companion order candidates using negative item quantities/amounts and temporal/counterparty/SKU evidence. Do not automatically link ambiguous records.

### 14.5 Stage 3: backfill batches from `StockLevel`

- Create one `InventoryBatch` per existing `StockLevel` row; do not merge rows merely because keys match.
- Preserve product, warehouse, expiry, and quantity exactly. Reject/flag negative quantities rather than importing them into constrained balances.
- Because `StockLevel` has no receipt timestamp, true historical FIFO order cannot be reconstructed. Use the earliest credible related positive `StockLog.createdAt` when uniquely attributable; otherwise use one common migration cutover timestamp and mark the batch origin `MIGRATION_OPENING_BALANCE`. Stable ID breaks ties. Document that pre-cutover FIFO provenance is approximate.
- Null-expiry rows remain independent non-expiring opening batches. This safely handles multiple rows enabled by PostgreSQL null uniqueness.
- Create one migration opening-balance posting/movement per imported batch or a bounded posting group with deterministic sequences. Retain the legacy stock-level ID in a migration mapping table/file for traceability.

### 14.6 Stage 4: reconcile before constraints/cutover

- Compare each product’s current `Product.quantityInStock` with the sum of imported sellable batch quantities.
- Compare warehouse/product totals between old stock levels and new batches.
- Never choose a winner silently. Produce a discrepancy report. Recommended authority is verified physical/batch stock, not the duplicated global counter; an authorized operator approves migration adjustment postings for differences.
- Validate order-item received/delivered totals and catalog legacy returns.
- Require zero unexplained negative balances and zero orphan batches/postings before cutover.

### 14.7 Stage 5: compatible application release

- Deploy Phase 2B code behind a feature flag or versioned service boundary.
- Dual-write old compatibility totals and new batches/movements in the same transaction; do not run two independent write paths.
- Shadow-read and compare old/new availability without changing allocation decisions first.
- Switch allocation and alert/report reads to batches after parity checks.

### 14.8 Stage 6: enforce and retire

- Backfill all required fields, then set them non-null.
- Validate check constraints and partial indexes.
- Stop writing `StockLevel`/legacy `StockLog`; retain read-only for a defined observation period.
- Remove `Product.quantityInStock` only after all consumers and reconciliation checks use batches.
- Drop legacy tables/columns in a later migration, not the initial cutover.

### 14.9 Rollback/recovery

The additive stages can roll back application behavior by disabling new reads while keeping new tables. Do not delete new posting data during rollback. Once new-only postings occur, rollback requires a forward recovery or a controlled projection back into compatibility tables; restoring a backup would lose post-backup transactions and therefore requires an explicit business decision. Keep a cutover checkpoint, migration mapping, discrepancy report, and idempotent backfill scripts so the process can resume safely.

## 15. Data-reconciliation plan

Run validation queries in an approved non-production copy first. Illustrative SQL (names will follow the final migration):

```sql
-- Current duplicated-total discrepancies
SELECT p.id, p."quantityInStock", COALESCE(SUM(sl.quantity), 0) AS stock_level_total
FROM "Product" p
LEFT JOIN "StockLevel" sl ON sl."productId" = p.id
GROUP BY p.id, p."quantityInStock"
HAVING p."quantityInStock" <> COALESCE(SUM(sl.quantity), 0);

-- Existing invalid/ambiguous stock
SELECT * FROM "StockLevel" WHERE quantity < 0;
SELECT "productId", "warehouseId", "expiryDate", COUNT(*)
FROM "StockLevel"
GROUP BY "productId", "warehouseId", "expiryDate"
HAVING COUNT(*) > 1;

-- Post-backfill parity by warehouse/product
SELECT sl."productId", sl."warehouseId", SUM(sl.quantity) AS old_total,
       COALESCE(nb.new_total, 0) AS new_total
FROM "StockLevel" sl
LEFT JOIN (
  SELECT "productId", "warehouseId", SUM("quantityOnHandBase") AS new_total
  FROM "InventoryBatch"
  GROUP BY "productId", "warehouseId"
) nb ON nb."productId" = sl."productId" AND nb."warehouseId" = sl."warehouseId"
GROUP BY sl."productId", sl."warehouseId", nb.new_total
HAVING SUM(sl.quantity) <> COALESCE(nb.new_total, 0);

-- Batch constraints/reconciliation after cutover
SELECT * FROM "InventoryBatch" WHERE "quantityOnHandBase" < 0;
SELECT b.id, b."quantityOnHandBase", COALESCE(SUM(m."quantityChangeBase"), 0) AS movement_total
FROM "InventoryBatch" b
LEFT JOIN "StockMovement" m ON m."batchId" = b.id
GROUP BY b.id, b."quantityOnHandBase"
HAVING b."quantityOnHandBase" <> COALESCE(SUM(m."quantityChangeBase"), 0);
```

The last query assumes every migrated batch receives an opening-balance movement. Reconciliation reports must distinguish sellable, damaged, quarantined, and expired physical totals. Decimal monetary checks must stay in SQL/Prisma Decimal; do not convert them to JavaScript `number` as current report drafts do.

Legacy negative companion returns require a dedicated inventory:

- Find negative `SaleItem.quantityOrdered/quantityDelivered` and `PurchaseItem.quantityOrdered/quantityReceived`.
- Identify companion headers with negative `amountPaid` or zero totals.
- Attempt deterministic original-item linkage only where counterparty, product/unit, quantity, and chronology produce one candidate.
- Mark ambiguous rows for manual resolution. Preserve the original rows and mapping; never delete them in backfill.

## 16. Phase 2B test matrix

Legend: **Unit/mock** tests pure conversion, validation, ordering, and orchestration errors. **PostgreSQL integration** uses a disposable isolated database and is mandatory for constraints, row locks, isolation, idempotency, and rollback. Mocked Prisma cannot prove concurrency or transaction correctness.

| Scenario | Unit/mock | Disposable PostgreSQL integration |
|---|---:|---:|
| Draft purchase does not increase stock | Yes | Yes |
| Ordered but unreceived purchase does not increase stock | Yes | Yes |
| Partial receipt increases stock by received base quantity | Yes | Yes |
| Same receipt/idempotency key cannot post twice | Limited | **Required** |
| Later receipt/increased cumulative quantity posts only new receipt amount | Yes | **Required** |
| Receipt beyond ordered quantity rejected and rolled back | Yes | **Required** |
| Draft sale does not reduce stock | Yes | Yes |
| Non-draft sale reduces stock exactly once | Yes | **Required** |
| Draft-to-non-draft issues once | Yes | **Required** |
| Non-draft status transition does not issue again | Yes | **Required** |
| Posted sale cannot return to draft; reversal is explicit | Yes | Yes |
| FEFO chooses earliest valid expiry | Yes | **Required** |
| FEFO spans multiple batches | Yes | **Required** |
| Batch expiring today remains valid in business timezone | Yes | Yes |
| Expired batch is excluded | Yes | **Required** |
| FIFO chooses earliest `receivedAt`, not ID | Yes | **Required** |
| FIFO spans multiple non-expiring batches | Yes | **Required** |
| Mixed expiring/non-expiring follows approved policy | Yes | Yes |
| Insufficient stock rolls back allocations, movements, and order posting | Limited | **Required** |
| Two concurrent sales cannot oversell | No | **Required** |
| Serialization/deadlock retry reuses idempotency key | Limited | **Required** |
| Sellable customer return increases selected warehouse sellable batch | Yes | **Required** |
| Damaged return creates non-sellable stock only | Yes | **Required** |
| Quarantined return remains non-sellable | Yes | Yes if included |
| Multiple/concurrent sale returns cannot exceed eligible quantity | Limited | **Required** |
| Purchase return decrements explicitly selected batch | Yes | **Required** |
| Draft/unreceived purchase quantity cannot be returned | Yes | Yes |
| Multiple/concurrent supplier returns cannot exceed received quantity | Limited | **Required** |
| Transfer spanning batches preserves global sellable total | Yes | **Required** |
| Conflicting transfer/sale cannot make source batch negative | No | **Required** |
| Positive/negative adjustments create exact movements and balances | Yes | **Required** |
| Product compatibility counter equals sellable batch total | Yes | **Required during transition** |
| Purchase costs remain stable after ProductUnit cost changes | Yes | Yes |
| Sale prices remain stable after any catalog changes | Yes | Yes |
| Unit multiplier snapshots preserve historical conversions | Yes | Yes |
| Every mutation creates expected posting/movement rows | Yes | **Required** |
| Repeating a request returns existing result without extra movements | Yes | **Required** |
| Migration backfill preserves per-product/warehouse totals | No | **Required against sanitized snapshot** |
| Constraint rejects negative batch or zero movement | No | **Required** |

Integration tests must create and destroy only a disposable database/schema identified explicitly for tests. They must never run the current destructive seed or point at the normal `DATABASE_URL` without a safety guard.

## 17. Approved Phase 2B-1 decisions

The previously open decisions below are approved as follows:

- Issue `SaleItem.quantityOrdered` exactly once on sale activation. The activation posting is unique; a reversal is a separate linked posting.
- Consume valid expiring stock by FEFO, then non-expiring stock by FIFO.
- Select one source warehouse per sale item and allocate only from it; use explicit transfers for cross-warehouse fulfillment.
- Reject cumulative purchase receipts above the ordered quantity.
- Put customer returns into `QUARANTINED`; a checklist inspection reclassifies them to `SELLABLE` or `DAMAGED`. Photos and disposal remain deferred.
- Resolve legacy discrepancies only through approved physical or warehouse-level reconciliation.
- Keep quantities as Prisma `Int` / PostgreSQL signed `INTEGER`, with a maximum stored value of 2,147,483,647.
- Keep `ProductUnit.price` as cost. Store confirmed actual sale price separately and nullable so historical prices remain explicitly unconfirmed.

The subsections preserve the rationale and consequences that led to these approvals.

### 17.1 Sale issue quantity

- **Approved:** Inventory issues `quantityOrdered` once on non-draft activation.
- **Why it matters:** Current creation deducts ordered quantity while status reporting distinguishes delivery; return eligibility depends on what actually left stock.
- **Options:** Issue ordered quantity immediately; issue delivered quantity and post later deltas; introduce reservation versus issue.
- **Recommendation:** For the smallest implementation matching the approved “non-draft decreases stock” rule and current behavior, issue ordered quantity once. Treat allocation sum as return cap. Add reservations only later.
- **Consequence:** An active but undelivered order removes stock from availability. Clients must not use non-draft merely as a quotation state.

### 17.2 Mixed expiring/non-expiring allocation

- **Approved:** Valid expiring batches are consumed first, followed by non-expiring batches.
- **Recommendation:** Valid expiring batches by FEFO, then non-expiring by FIFO.
- **Consequence:** Minimizes expiry loss but assumes batches are interchangeable. If not, add a product allocation policy.

### 17.3 Warehouse scope for sales

- **Approved:** One sale line allocates only from its selected warehouse.
- **Options:** Selected warehouse only; explicit ordered list; automatic system-wide allocation.
- **Recommendation:** Selected warehouse only in initial Phase 2B. Require explicit transfer or a later fulfillment plan for cross-warehouse sales.
- **Consequence:** Predictable responsibility and locking; some sales may require a transfer first.

### 17.4 Over-receipts

- **Approved:** Posted cumulative receipts may not exceed ordered quantity.
- **Recommendation:** Reject initially. Add an explicit tolerance/approval workflow only if the business confirms it.
- **Consequence:** Prevents accidental inflation and simplifies cumulative constraints.

### 17.5 Return inspection

- **Approved:** Customer returns default to `QUARANTINED` and require checklist inspection before final classification.
- **Implementation rule:** Always create the returned batch as quarantined, then use the recorded inspection posting to derive a sellable or damaged batch.
- **Consequence:** Quarantine is safer but adds a disposition workflow.

### 17.6 Pre-cutover discrepancy authority

- **Approved:** Neither legacy value is selected automatically; an approved reconciliation establishes the cutover quantity.
- **Recommendation:** No automatic choice. Perform/approve a physical or warehouse-level reconciliation; use approved batch totals and record migration adjustments.
- **Consequence:** Cutover may pause for manual review, but no inventory is silently invented or removed.

### 17.7 Quantity scale

- **Approved:** Stored quantities remain within signed PostgreSQL `INTEGER` range.
- **Recommendation:** Keep `Int` for the smallest migration only if operational limits are safely below 2,147,483,647; otherwise move new quantity fields to `BigInt` and define API string serialization before implementation.
- **Consequence:** `BigInt` is safer for extreme counts but requires explicit JSON handling in Node.

### 17.8 Historical sale prices

- **Approved:** Historical sale prices remain unconfirmed unless sourced from trusted evidence.
- **Recommendation:** Backfill only from a trusted invoice/client export. Otherwise mark historical price unconfirmed; do not present cost copied from `ProductUnit.price` as revenue.
- **Consequence:** Some historical revenue reports remain unavailable until reconciled.

## 18. Recommended Phase 2B implementation sequence

1. Approve the remaining decisions, especially issue quantity, warehouse scope, mixed allocation, and discrepancy authority.
2. Write precise invariants and API schemas; add a disposable PostgreSQL test harness with hard safety guards.
3. Add the additive batch/posting/movement/receipt/return schema in a new forward migration; do not remove legacy fields.
4. Implement reusable base-unit conversion and Decimal money helpers with unit tests.
5. Implement the idempotent posting transaction primitive and movement writer.
6. Implement batch candidate selection and locked FEFO/FIFO allocation with integration concurrency tests.
7. Implement purchase receipts and compatibility received totals.
8. Implement sale activation/allocation and prohibit posted-to-draft transitions.
9. Implement customer and supplier returns with cumulative locked validation.
10. Convert transfers and adjustments to postings/batches.
11. Build idempotent backfill/reconciliation scripts; rehearse against a sanitized production-like snapshot.
12. Deploy dual-write/shadow-read, monitor parity, then switch reads.
13. Only after an observation period, plan a separate legacy retirement migration.

## 19. Explicitly deferred features

- Full accounting, general ledger, accounts receivable/payable, tax, and credit-note balances.
- Stock reservations distinct from sale issue, unless the sale-quantity decision requires them.
- Backorders and automated cross-warehouse fulfillment.
- Full warehouse capacity/space modeling.
- Automatic rebalancing and report endpoints.
- Serial-number tracking, manufacturing lots, and supplier lot codes beyond optional batch metadata.
- Disposal workflow and regulatory chain-of-custody beyond disposition/movement basics.
- Cost-flow accounting methods such as weighted average, landed-cost allocation, or COGS recognition.
- Product, warehouse, user, and order CRUD expansion.
- Historical sale-price reconstruction without an authoritative source.
- Editing or squashing historical migrations.
- Dropping legacy stock/log/global-counter structures in the first Phase 2B release.

## 20. Design verification checklist

- Every approved sale/purchase/draft/delta rule maps to an explicit posting lifecycle.
- FEFO/FIFO have deterministic order, multi-batch continuation, and an explicit expiry rule.
- Customer returns capture warehouse and condition; damaged stock is physical but non-sellable.
- Both return types directly reference original orders/items and enforce cumulative caps.
- Purchase cost and sale price semantics are separated and snapshotted with Decimal.
- Unique posting keys and source uniqueness prevent duplicate stock movement.
- Every stock change creates immutable movement rows in the same transaction as balances.
- Batch nonnegativity, locks/conditional updates, serializable transactions, and retries address concurrency.
- Migration is additive, preserves IDs/data, handles null-expiry rows and legacy returns, and does not edit historical migrations.
- Reconciliation covers global/batch totals, opening balances, ambiguous rows, and legacy negative companions.
- Test matrix distinguishes mockable logic from PostgreSQL-only concurrency/constraint proof.
- `prisma/schema.prisma`, migrations, source code, dependencies, and databases remain unchanged by Phase 2A.
