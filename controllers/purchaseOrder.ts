import { NextFunction, Request, Response } from "express";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import prisma from "../prisma";
import z from "zod";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { Decimal } from "@prisma/client/runtime/client";
import { PaymentStatus, ReceivingStatus } from "../generated/prisma/enums";
import { PurchaseReturnBody } from "../types/purchase";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";
import {
  createDraftReceipt,
  createV2PurchaseOrder,
  postPurchaseReceipt,
  updateV2PurchaseOrder,
} from "../services/inventory/orderWorkflows";
import {
  receiptCreateSchema,
  receiptPathSchema,
  v2PurchaseCreateSchema,
  v2PurchaseUpdateSchema,
} from "../schemas/inventoryV2";
import { inventoryHttpError } from "../utils/inventoryHttpError";

// TODO:
// 1. Implement "Credit Note" or "Balance" on the Contact's account in overpaid transactions

const createPurchaseOrderLegacy = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user)
      return next(
        new AppError(
          "Authentication required to process purchase orders.",
          401,
        ),
      );
    const { id: receiverId } = req.user;

    const { supplier, items, transactionStatus, extraCost, amountPaid } =
      req.body;

    // 1. Validate Inputs
    if (
      !items ||
      !transactionStatus ||
      extraCost === undefined ||
      amountPaid === undefined
    ) {
      return next(new AppError("Purchase missing required field(s)!", 400));
    }

    if (!Array.isArray(items) || items.length === 0) {
      return next(
        new AppError("Purchase order must contain at least one item!", 400),
      );
    }

    // 2. Start Transaction
    const result = await prisma.$transaction(async (tx) => {
      const IdSchema = z.uuid();
      const isInt = (input: any) => Number.isInteger(Number.parseInt(input));

      // --- RESOLVE SUPPLIER ---
      let contact;
      if (IdSchema.safeParse(supplier).success) {
        contact = await tx.contact.update({
          where: { id: supplier },
          data: { isSupplier: true },
        });
      } else {
        const existingContact = await tx.contact.findFirst({
          where: { name: supplier },
        });
        contact = existingContact
          ? await tx.contact.update({
              where: { id: existingContact.id },
              data: { isSupplier: true },
            })
          : await tx.contact.create({
              data: { name: supplier, isSupplier: true },
            });
      }

      // --- INITIALIZE PURCHASE ORDER ---
      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          supplierId: contact.id,
          receiverId,
          transactionStatus,
          paymentStatus: "NOT_PAID",
          receivingStatus: "NOT_RECEIVED",
          extraCost: new Decimal(extraCost),
          totalPurchaseCost: 0,
          amountPaid: new Decimal(amountPaid),
        },
      });

      let totalPurchaseCost = new Decimal(0);
      let totalQtyOrdered = 0;
      let totalQtyReceived = 0;

      // --- ITEM LOOP ---
      for (const item of items) {
        const {
          product,
          stockKeepingUnit,
          quantityOrdered,
          quantityReceived,
          unit,
          price,
          multiplier,
          baseUnit,
          category,
          warehouse,
          expiryDate,
        } = item;

        let resolvedProductId: string;
        let resolvedUnitId: number;
        let resolvedMultiplier: number;
        let resolvedPrice: Decimal;

        // A. SKU-FIRST RESOLUTION
        const existingUnit = await tx.productUnit.findUnique({
          where: { sku: stockKeepingUnit },
          include: { product: true },
        });

        if (existingUnit) {
          resolvedProductId = existingUnit.productId;
          resolvedUnitId = existingUnit.id;
          resolvedMultiplier = existingUnit.multiplier;
          resolvedPrice = new Decimal(price || existingUnit.price);
        } else {
          // B. NEW SKU / PRODUCT RESOLUTION
          if (!baseUnit || !category || !multiplier || !price) {
            throw new AppError(
              `New SKU ${stockKeepingUnit} requires baseUnit, category, multiplier, and price.`,
              400,
            );
          }

          // Resolve Category
          let categoryId: string;
          if (IdSchema.safeParse(category).success) {
            const cat = await tx.category.findUnique({
              where: { id: category },
            });
            if (!cat) throw new AppError("Category not found", 404);
            categoryId = cat.id;
          } else {
            const cat =
              (await tx.category.findFirst({ where: { name: category } })) ||
              (await tx.category.create({ data: { name: category } }));
            categoryId = cat.id;
          }

          // Resolve Product (Search name within category context)
          const existingProd = await tx.product.findFirst({
            where: { name: product, categoryId },
          });

          if (existingProd) {
            resolvedProductId = existingProd.id;
          } else {
            const newProd = await tx.product.create({
              data: { name: product, baseUnit, categoryId, quantityInStock: 0 },
            });
            resolvedProductId = newProd.id;
          }

          // Create New Unit
          const newUnit = await tx.productUnit.create({
            data: {
              name: unit,
              multiplier: Number(multiplier),
              price: new Decimal(price),
              sku: stockKeepingUnit,
              productId: resolvedProductId,
            },
          });
          resolvedUnitId = newUnit.id;
          resolvedMultiplier = newUnit.multiplier;
          resolvedPrice = new Decimal(price);
        }

        // C. CREATE PURCHASE ITEM
        const lineTotalPrice = resolvedPrice.times(quantityOrdered);
        await tx.purchaseItem.create({
          data: {
            purchaseId: purchaseOrder.id,
            productId: resolvedProductId,
            quantityOrdered,
            quantityReceived,
            unitId: resolvedUnitId,
            unitPrice: resolvedPrice,
            totalPrice: lineTotalPrice,
          },
        });

        totalPurchaseCost = totalPurchaseCost.plus(lineTotalPrice);
        totalQtyOrdered += quantityOrdered;
        totalQtyReceived += quantityReceived;

        // D. STOCK MOVEMENT GATEKEEPER
        // Only move stock if Status is COMPLETED or PENDING with items arriving
        const shouldMoveStock =
          (transactionStatus === "COMPLETED" ||
            transactionStatus === "PENDING") &&
          quantityReceived > 0;

        if (shouldMoveStock) {
          if (!warehouse)
            throw new AppError("Warehouse is required for stock movement", 400);

          let resolvedWarehouseId: number;
          if (isInt(warehouse)) {
            const wh = await tx.warehouse.findUnique({
              where: { id: Number(warehouse) },
            });
            if (!wh) throw new AppError("Warehouse not found", 404);
            resolvedWarehouseId = wh.id;
          } else {
            const wh =
              (await tx.warehouse.findUnique({ where: { name: warehouse } })) ||
              (await tx.warehouse.create({ data: { name: warehouse } }));
            resolvedWarehouseId = wh.id;
          }

          const baseUnitQty = quantityReceived * resolvedMultiplier;
          const lookUpExpiry = expiryDate ? new Date(expiryDate) : null;

          // Update Warehouse Stock
          await tx.stockLevel.upsert({
            where: {
              productId_warehouseId_expiryDate: {
                productId: resolvedProductId,
                warehouseId: resolvedWarehouseId,
                expiryDate: lookUpExpiry as any,
              },
            },
            update: { quantity: { increment: baseUnitQty } },
            create: {
              productId: resolvedProductId,
              warehouseId: resolvedWarehouseId,
              quantity: baseUnitQty,
            },
          });

          // Update Global Product Stock
          await tx.product.update({
            where: { id: resolvedProductId },
            data: { quantityInStock: { increment: baseUnitQty } },
          });

          // Create Incremental Stock Log
          await tx.stockLog.create({
            data: {
              productId: resolvedProductId,
              warehouseId: resolvedWarehouseId,
              quantityChange: baseUnitQty,
              type: "PURCHASE",
              purchaseOrderId: purchaseOrder.id,
            },
          });
        }
      }

      // --- FINAL CALCULATIONS ---
      const amountPaidDec = new Decimal(amountPaid);
      let payStatus: PaymentStatus = "NOT_PAID";
      if (amountPaidDec.greaterThan(0)) {
        payStatus = amountPaidDec.greaterThanOrEqualTo(
          totalPurchaseCost.plus(extraCost),
        )
          ? "FULLY_PAID"
          : "PARTLY_PAID";
      }

      let recStatus: ReceivingStatus = "NOT_RECEIVED";
      if (totalQtyReceived > 0) {
        recStatus =
          totalQtyReceived >= totalQtyOrdered
            ? "FULLY_RECEIVED"
            : "PARTLY_RECEIVED";
      }

      // Final closure logic: If everything is received, force COMPLETED status
      const finalStatus =
        recStatus === "FULLY_RECEIVED" ? "COMPLETED" : transactionStatus;

      return await tx.purchaseOrder.update({
        where: { id: purchaseOrder.id },
        data: {
          totalPurchaseCost,
          paymentStatus: payStatus,
          receivingStatus: recStatus,
          transactionStatus: finalStatus,
        },
      });
    });

    res.status(200).json({ status: "success", data: result });
  },
);

const updatePurchaseOrderLegacy = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = Number(req.params.id);
    const { transactionStatus, amountPaid, items, extraCost } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch Order and Items in ONE query (Avoids N+1)
      const existingOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: { include: { unit: true } } },
      });

      if (!existingOrder) throw new AppError("Purchase Order not found", 404);
      if (existingOrder.transactionStatus === "COMPLETED")
        throw new AppError("Cannot update a completed order", 400);

      let totalPurchaseCost = new Decimal(0);
      let totalQtyOrdered = 0;
      let totalQtyReceived = 0;

      // 2. Process Items and Calculate Deltas
      for (const itemUpdate of items) {
        const existingItem = existingOrder.items.find(
          (i) => i.unit.sku === itemUpdate.stockKeepingUnit,
        );
        if (!existingItem) continue;

        const newReceived =
          itemUpdate.quantityReceived || existingItem.quantityReceived;
        const delta = newReceived - existingItem.quantityReceived;

        // Update PurchaseItem record
        await tx.purchaseItem.update({
          where: { id: existingItem.id },
          data: { quantityReceived: newReceived },
        });

        // 3. Update Stock ONLY if there is a change
        if (delta !== 0 && transactionStatus !== "DRAFT") {
          const baseUnitDelta = delta * existingItem.unit.multiplier;

          const lookUpExpiry = itemUpdate.expiryDate
            ? new Date(itemUpdate.expiryDate)
            : null;

          // Atomic Upsert for StockLevel
          await tx.stockLevel.upsert({
            where: {
              productId_warehouseId_expiryDate: {
                productId: existingItem.productId,
                warehouseId: itemUpdate.warehouseId,
                expiryDate: lookUpExpiry as any,
              },
            },
            update: { quantity: { increment: baseUnitDelta } },
            create: {
              productId: existingItem.productId,
              warehouseId: itemUpdate.warehouseId,
              quantity: baseUnitDelta,
            },
          });

          // Atomic Global Product Update
          await tx.product.update({
            where: { id: existingItem.productId },
            data: { quantityInStock: { increment: baseUnitDelta } },
          });

          // Create the Log for the Delta
          await tx.stockLog.create({
            data: {
              productId: existingItem.productId,
              warehouseId: itemUpdate.warehouseId,
              quantityChange: baseUnitDelta,
              type: "PURCHASE",
              purchaseOrderId: id,
            },
          });
        }

        totalPurchaseCost = totalPurchaseCost.plus(existingItem.totalPrice);
        totalQtyOrdered += existingItem.quantityOrdered;
        totalQtyReceived += newReceived;
      }

      // 4. Final Status Re-calculation
      const amountPaidDec = new Decimal(amountPaid ?? existingOrder.amountPaid);
      const finalExtra = new Decimal(extraCost ?? existingOrder.extraCost);
      const totalDue = totalPurchaseCost.plus(finalExtra);

      const payStatus = amountPaidDec.greaterThanOrEqualTo(totalDue)
        ? "FULLY_PAID"
        : "PARTLY_PAID";
      const recStatus =
        totalQtyReceived >= totalQtyOrdered
          ? "FULLY_RECEIVED"
          : "PARTLY_RECEIVED";

      return await tx.purchaseOrder.update({
        where: { id },
        data: {
          transactionStatus:
            recStatus === "FULLY_RECEIVED" ? "COMPLETED" : transactionStatus,
          paymentStatus: payStatus,
          receivingStatus: recStatus,
          amountPaid: amountPaidDec,
          extraCost: finalExtra,
        },
      });
    });

    res.status(200).json({ status: "success", data: result });
  },
);

export const createPurchaseReturn = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id: originalPurchaseId } = req.params; // Original Purchase Order UUID from URL
    const { items, amountRefundedBySupplier, reason }: PurchaseReturnBody =
      req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return next(new AppError("Purchase return items must be provided.", 400));
    }

    if (Number.isNaN(Number(originalPurchaseId)))
      return next(new AppError("Purchase Order Id must be an interger.", 400));

    const result = await prisma.$transaction(async (tx) => {
      // 1. Verify original purchase order exists
      const originalOrder = await tx.purchaseOrder.findUnique({
        where: { id: Number(originalPurchaseId) },
        include: { items: { include: { unit: true } } },
      });

      if (!originalOrder) {
        throw new AppError("Original purchase order not found.", 404);
      }

      // 2. Create a companion Purchase Order record as a return ledger
      const returnOrder = await tx.purchaseOrder.create({
        data: {
          supplierId: originalOrder.supplierId,
          receiverId: originalOrder.receiverId,
          transactionStatus: "COMPLETED",
          receivingStatus: "FULLY_RECEIVED",
          paymentStatus: "FULLY_PAID", // Refund settled with vendor
          totalPurchaseCost: new Decimal(0),
          amountPaid: new Decimal(
            amountRefundedBySupplier ? -amountRefundedBySupplier : 0,
          ), // Negative cash flow out means money returning
          extraCost: new Decimal(0),
        },
      });

      // 3. Process each item being sent back
      for (const returnedItem of items) {
        const { stockKeepingUnit, quantityReturned, warehouseId } =
          returnedItem;

        // Verify item belonged to the original invoice
        const originalLineItem = originalOrder.items.find(
          (i) => i.unit.sku === stockKeepingUnit,
        );

        if (!originalLineItem) {
          throw new AppError(
            `SKU ${stockKeepingUnit} was not part of the original purchase order.`,
            400,
          );
        }

        // Guardrail: Can't return more to the vendor than you originally received
        if (quantityReturned > originalLineItem.quantityReceived) {
          throw new AppError(
            `Cannot return more items (${quantityReturned}) than were actually received (${originalLineItem.quantityReceived}) for SKU ${stockKeepingUnit}.`,
            400,
          );
        }

        const baseUnitReturnQty =
          quantityReturned * originalLineItem.unit.multiplier;

        // --- EXPIRES LOOKUP ---
        // Match the batch in the target warehouse that aligns with this product profile
        const targetStock = await tx.stockLevel.findFirst({
          where: {
            productId: originalLineItem.productId,
            warehouseId: Number(warehouseId),
          },
          orderBy: { expiryDate: "asc" }, // Pull from soonest expiring batch or match null
        });
        const activeExpiry = targetStock?.expiryDate || null;

        // Verify we actually have enough stock on hand in this warehouse to return
        if (!targetStock || targetStock.quantity < baseUnitReturnQty) {
          throw new AppError(
            `Insufficient physical stock in warehouse ${warehouseId} to execute vendor return for SKU ${stockKeepingUnit}.`,
            400,
          );
        }

        // 4. DEDUCT INVENTORY FROM SHELF
        await tx.stockLevel.update({
          where: {
            productId_warehouseId_expiryDate: {
              productId: originalLineItem.productId,
              warehouseId: Number(warehouseId),
              expiryDate: activeExpiry as any,
            },
          },
          data: {
            quantity: { decrement: baseUnitReturnQty },
          },
        });

        // Sync global metrics
        await tx.product.update({
          where: { id: originalLineItem.productId },
          data: { quantityInStock: { decrement: baseUnitReturnQty } },
        });

        // 5. CREATE IMMUTABLE AUDIT LOG (Negative Change)
        await tx.stockLog.create({
          data: {
            productId: originalLineItem.productId,
            warehouseId: Number(warehouseId),
            quantityChange: -baseUnitReturnQty, // NEGATIVE value means stock leaving building
            type: "RETURN",
            purchaseOrderId: returnOrder.id,
          },
        });

        // 6. Record line item history on the companion transaction ledger
        await tx.purchaseItem.create({
          data: {
            purchaseId: returnOrder.id,
            productId: originalLineItem.productId,
            quantityOrdered: -quantityReturned,
            quantityReceived: -quantityReturned,
            unitId: originalLineItem.unitId,
            unitPrice: originalLineItem.unitPrice,
            totalPrice: originalLineItem.unitPrice.times(-quantityReturned),
          },
        });
      }

      return returnOrder;
    });

    res.status(201).json({
      status: "success",
      message:
        "Purchase return successfully issued to vendor. Inventory deducted.",
      data: result,
    });
  },
);

export const createPurchaseOrder = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!isInventoryV2Enabled())
      return createPurchaseOrderLegacy(req, res, next);
    if (!req.user)
      return next(
        new AppError(
          "Authentication required to process purchase orders.",
          401,
        ),
      );
    const parsed = v2PurchaseCreateSchema.safeParse(req.body);
    if (!parsed.success)
      return next(
        new AppError(
          `Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
          400,
        ),
      );
    try {
      const result = await createV2PurchaseOrder(
        prisma,
        parsed.data,
        req.user.id,
        req.idempotencyKey!,
      );
      res
        .status(result.replayed ? 200 : 201)
        .json({ status: "success", data: result });
    } catch (error) {
      next(inventoryHttpError(error));
    }
  },
);

export const updatePurchaseOrder = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!isInventoryV2Enabled())
      return updatePurchaseOrderLegacy(req, res, next);
    if (!req.user)
      return next(
        new AppError("Authentication required to update purchase orders.", 401),
      );
    const parsed = v2PurchaseUpdateSchema.safeParse(req.body);
    if (!parsed.success)
      return next(
        new AppError(
          `Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
          400,
        ),
      );
    try {
      const result = await updateV2PurchaseOrder(
        prisma,
        Number(req.params.id),
        parsed.data,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (error) {
      next(inventoryHttpError(error));
    }
  },
);

export const createPurchaseReceipt = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!isInventoryV2Enabled())
      return next(new AppError("Purchase receipts require Inventory V2.", 503));
    if (!req.user)
      return next(
        new AppError("Authentication required to receive purchases.", 401),
      );
    const parsed = receiptCreateSchema.safeParse(req.body);
    if (!parsed.success)
      return next(
        new AppError(
          `Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
          400,
        ),
      );
    try {
      const result = await createDraftReceipt(
        prisma,
        Number(req.params.id),
        parsed.data,
        req.user.id,
        req.idempotencyKey!,
      );
      res
        .status(result.replayed ? 200 : 201)
        .json({ status: "success", data: result });
    } catch (error) {
      next(inventoryHttpError(error));
    }
  },
);

export const postPurchaseReceiptController = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    
    if (!isInventoryV2Enabled())
      return next(new AppError("Purchase receipts require Inventory V2.", 503));
    if (!req.user)
      return next(
        new AppError("Authentication required to post receipts.", 401),
      );
      
    const path = receiptPathSchema.safeParse({
      purchaseId: Number(req.params.purchaseId),
      receiptId: Number(req.params.receiptId),
    });
    if (!path.success)
      return next(
        new AppError(
          "Purchase and receipt IDs must be positive 32-bit integers.",
          400,
        ),
      );
      
    try {
      const result = await postPurchaseReceipt(
        prisma,
        path.data.purchaseId,
        path.data.receiptId,
        req.user.id,
        req.idempotencyKey!,
      );
      
      res.status(200).json({ status: "success", data: result });
    } catch (error) {
      next(inventoryHttpError(error));
    }
  },
);
