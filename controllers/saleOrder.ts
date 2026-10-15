import { Request, NextFunction, Response } from "express";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import z from "zod";
import {
  DeliveryStatus,
  PaymentStatus,
  Prisma,
  TransactionStatus,
} from "../generated/prisma/client";
import { Decimal } from "@prisma/client/runtime/client";
import { SalesReturnBody } from "../types/sale";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";
import {
  createV2SaleOrder,
  updateV2SaleOrder,
} from "../services/inventory/orderWorkflows";
import { v2SaleCreateSchema, v2SaleUpdateSchema } from "../schemas/inventoryV2";
import { inventoryHttpError } from "../utils/inventoryHttpError";

const createSaleOrderLegacy = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user)
      return next(new AppError("Authentication required to sale orders.", 401));
    const { id: sellerId } = req.user;

    const { items, buyer, transactionStatus, extraCost, amountPaid } = req.body;

    // 1. Basic Validation
    if (!items || !buyer || !transactionStatus || amountPaid === undefined)
      return next(new AppError("Missing required field(s)!", 400));

    if (!Array.isArray(items) || items.length === 0)
      return next(
        new AppError("Sale order must contain at least one item!", 400),
      );

    // 2. Transaction Start
    const result = await prisma.$transaction(async (tx) => {
      const IdSchema = z.uuid();

      // --- RESOLVE BUYER ---
      let contact;
      if (IdSchema.safeParse(buyer).success) {
        contact = await tx.contact.update({
          where: { id: buyer },
          data: { isBuyer: true },
        });
      } else {
        const existing = await tx.contact.findFirst({ where: { name: buyer } });
        contact = existing
          ? await tx.contact.update({
              where: { id: existing.id },
              data: { isBuyer: true },
            })
          : await tx.contact.create({ data: { name: buyer, isBuyer: true } });
      }

      // --- PRE-VALIDATION: GLOBAL STOCK CHECK ---
      // Guardrail: Ensure systemic total availability before making modifications
      const shouldDeductStock = transactionStatus !== "DRAFT";

      if (shouldDeductStock) {
        for (const item of items) {
          const { stockKeepingUnit, quantityOrdered } = item;
          if (quantityOrdered <= 0) continue;

          const unit = await tx.productUnit.findUnique({
            where: { sku: stockKeepingUnit },
          });
          if (!unit)
            throw new AppError(
              `SKU ${stockKeepingUnit} not found during pre-check.`,
              404,
            );

          const totalBaseDeductionNeeded = quantityOrdered * unit.multiplier;
          const lookUpExpiry = item.expiryDate
            ? new Date(item.expiryDate)
            : null;

          const aggregateStock = await tx.stockLevel.aggregate({
            where: {
              productId: unit.productId,
              expiryDate: lookUpExpiry as unknown as Date,
            },
            _sum: { quantity: true },
          });

          const totalAvailableGlobally = aggregateStock._sum.quantity || 0;

          if (totalAvailableGlobally < totalBaseDeductionNeeded) {
            const prod = await tx.product.findUnique({
              where: { id: unit.productId },
              select: { name: true },
            });
            throw new AppError(
              `Insufficient global systemic stock for ${prod?.name || "Product"}. Requested: ${totalBaseDeductionNeeded} base units, Available System-wide: ${totalAvailableGlobally}`,
              400,
            );
          }
        }
      }

      // --- INITIALIZE SALE ORDER ---
      const saleOrder = await tx.saleOrder.create({
        data: {
          buyerId: contact.id,
          sellerId,
          transactionStatus,
          paymentStatus: "NOT_PAID",
          deliveryStatus: "NOT_DELIVERED",
          extraCost: new Decimal(extraCost) || 0,
          totalSaleAmount: 0,
          amountPaid: new Decimal(amountPaid),
        },
      });

      let totalSaleAmount = new Decimal(0);
      let totalQtyOrdered = 0;
      let totalQtyDelivered = 0;

      // --- ITEM LOOP ---
      for (const item of items) {
        const {
          stockKeepingUnit,
          quantityOrdered,
          quantityDelivered,
          warehouseId,
          expiryDate,
        } = item;

        // A. SKU-FIRST LOOKUP
        const unit = await tx.productUnit.findUnique({
          where: { sku: stockKeepingUnit },
          include: { product: true },
        });

        if (!unit) throw new AppError(`SKU ${stockKeepingUnit} not found`, 404);

        const lineTotalPrice = unit.price.times(quantityOrdered);
        totalSaleAmount = totalSaleAmount.plus(lineTotalPrice);
        totalQtyOrdered += quantityOrdered;
        totalQtyDelivered += quantityDelivered;

        // B. CREATE SALE ITEM
        await tx.saleItem.create({
          data: {
            saleId: saleOrder.id,
            productId: unit.productId,
            quantityOrdered,
            quantityDelivered,
            unitId: unit.id,
            unitPrice: unit.price,
            totalPrice: lineTotalPrice,
          },
        });

        // C. MULTI-WAREHOUSE DEDUCTION LOGIC
        if (shouldDeductStock && quantityOrdered > 0) {
          if (!warehouseId)
            throw new AppError(
              "Preferred Warehouse ID required for stock deduction processing",
              400,
            );

          let remainingToFulfill = quantityOrdered * unit.multiplier; // Convert ordered quantity to base units
          const lookUpExpiry = expiryDate ? new Date(expiryDate) : null;

          // Query stock allocations, prioritizing the preferred warehouse, then descending by availability
          const stockLocations = await tx.stockLevel.findMany({
            where: {
              productId: unit.productId,
              expiryDate: lookUpExpiry as unknown as Date,
              quantity: { gt: 0 },
            },
            orderBy: [
              {
                // Custom prioritization: places preferred warehouse records at the head of the array
                warehouseId: Number(warehouseId) ? "asc" : "desc",
              },
              { quantity: "desc" },
            ],
          });

          // Deduct from available storage allocations incrementally
          for (const location of stockLocations) {
            if (remainingToFulfill <= 0) break;

            const takeAmount = Math.min(remainingToFulfill, location.quantity);

            // Deduct fractional allocations from the specific warehouse batch
            await tx.stockLevel.update({
              where: {
                productId_warehouseId_expiryDate: {
                  productId: unit.productId,
                  warehouseId: location.warehouseId,
                  expiryDate: location.expiryDate as string | Date,
                },
              },
              data: { quantity: { decrement: takeAmount } },
            });

            // Write matching localized ledger line item
            await tx.stockLog.create({
              data: {
                productId: unit.productId,
                warehouseId: location.warehouseId,
                quantityChange: -takeAmount,
                type: "SALE",
                saleOrderId: saleOrder.id,
              },
            });

            remainingToFulfill -= takeAmount;
          }

          // If loop exhausted allocations but units remain unfulfilled (fallback safety check)
          if (remainingToFulfill > 0) {
            throw new AppError(
              `Stock allocation mismatch while processing ${unit.product.name}. Clearances fell short by ${remainingToFulfill} units.`,
              400,
            );
          }

          // Update Global Product Stock Counter by total item allocation volume
          const totalBaseDeduction = quantityOrdered * unit.multiplier;
          await tx.product.update({
            where: { id: unit.productId },
            data: { quantityInStock: { decrement: totalBaseDeduction } },
          });
        }
      }

      // --- FINAL CALCULATIONS ---
      const amountPaidDec = new Decimal(amountPaid);
      let payStatus: PaymentStatus = "NOT_PAID";
      if (amountPaidDec.greaterThan(0)) {
        payStatus = amountPaidDec.greaterThanOrEqualTo(totalSaleAmount)
          ? "FULLY_PAID"
          : "PARTLY_PAID";
      }

      let delStatus: DeliveryStatus = "NOT_DELIVERED";
      if (totalQtyDelivered > 0) {
        delStatus =
          totalQtyDelivered >= totalQtyOrdered
            ? "FULLY_DELIVERED"
            : "PARTLY_DELIVERED";
      }

      return await tx.saleOrder.update({
        where: { id: saleOrder.id },
        data: {
          totalSaleAmount,
          paymentStatus: payStatus,
          deliveryStatus: delStatus,
        },
      });
    });

    res.status(200).json({ status: "success", data: result });
  },
);

const updateSaleOrderLegacy = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const id = Number(req.params.id);
    const { transactionStatus, amountPaid, extraCost, items } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.saleOrder.findUnique({
        where: { id },
        include: { items: { include: { unit: true } } },
      });

      if (!existingOrder) throw new AppError("Sale Order not found", 404);

      let totalSaleAmount = new Decimal(0);
      let totalQtyOrdered = 0;
      let totalQtyDelivered = 0;

      // 1. Process Items (Focus on Delivery Tracking)
      for (const itemUpdate of items) {
        const existingItem = existingOrder.items.find(
          (i) => i.unit.sku === itemUpdate.stockKeepingUnit,
        );
        if (!existingItem) continue;

        const newDelivered =
          itemUpdate.quantityDelivered || existingItem.quantityDelivered;

        await tx.saleItem.update({
          where: { id: existingItem.id },
          data: { quantityDelivered: newDelivered },
        });

        totalSaleAmount = totalSaleAmount.plus(existingItem.totalPrice);
        totalQtyOrdered += existingItem.quantityOrdered;
        totalQtyDelivered += newDelivered;
      }

      // 2. Handle Forfeiture & Payment Logic
      // If extraCost is sent as 0, it is forfeited. If undefined, we keep the old one.
      const finalExtra =
        extraCost !== undefined
          ? new Decimal(extraCost)
          : existingOrder.extraCost;
      const amountPaidDec =
        amountPaid !== undefined
          ? new Decimal(amountPaid)
          : existingOrder.amountPaid;

      const totalDue = totalSaleAmount.plus(finalExtra);
      const payStatus = amountPaidDec.greaterThanOrEqualTo(totalDue)
        ? "FULLY_PAID"
        : "PARTLY_PAID";
      const delStatus =
        totalQtyDelivered >= totalQtyOrdered
          ? "FULLY_DELIVERED"
          : "PARTLY_DELIVERED";

      return await tx.saleOrder.update({
        where: { id },
        data: {
          transactionStatus:
            payStatus === "FULLY_PAID" && delStatus === "FULLY_DELIVERED"
              ? "COMPLETED"
              : transactionStatus,
          paymentStatus: payStatus,
          deliveryStatus: delStatus,
          extraCost: finalExtra,
          amountPaid: amountPaidDec,
        },
      });
    });

    res.status(200).json({ status: "success", data: result });
  },
);

export const createSalesReturn = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id: originalSaleId } = req.params; // Original Sale UUID passed via URL
    const { items, amountRefunded, reason }: SalesReturnBody = req.body;

    // 1. Basic Payload Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return next(new AppError("Return items must be provided.", 400));
    }

    if (Number.isNaN(Number(originalSaleId)))
      return next(new AppError("Sale Order ID must be an interger.", 400));

    const result = await prisma.$transaction(async (tx) => {
      // 2. Verify original sale order exists
      const originalOrder = await tx.saleOrder.findUnique({
        where: { id: Number(originalSaleId) },
        include: { items: { include: { unit: true } } },
      });

      if (!originalOrder) {
        throw new AppError("Original sale order not found.", 404);
      }

      // 3. Create a descriptive Return Session Record
      // Note: Assuming you added 'isReturn' or a dedicated Return model to your schema.
      // If using your existing saleOrder table as a ledger, pass specialized flags:
      const returnOrder = await tx.saleOrder.create({
        data: {
          buyerId: originalOrder.buyerId,
          sellerId: originalOrder.sellerId,
          transactionStatus: "COMPLETED", // Returns are usually immediate
          paymentStatus: "FULLY_PAID", // Refund processed
          deliveryStatus: "FULLY_DELIVERED",
          totalSaleAmount: new Decimal(0), // Calculating negative or absolute baseline value
          amountPaid: new Decimal(amountRefunded ? -amountRefunded : 0), // Negative ledger cash flow
          extraCost: new Decimal(0), // Transport isn't re-charged
          // originalSaleId: originalOrder.id (If relation column is implemented)
        },
      });

      // 4. Process Each Returned Item
      for (const returnedItem of items) {
        const { stockKeepingUnit, quantityReturned, warehouseId } =
          returnedItem;

        // Fetch original item context via SKU
        const originalLineItem = originalOrder.items.find(
          (i) => i.unit.sku === stockKeepingUnit,
        );

        if (!originalLineItem) {
          throw new AppError(
            `SKU ${stockKeepingUnit} was not part of the original purchase order.`,
            400,
          );
        }

        // Validate they aren't returning more than they bought
        if (quantityReturned > originalLineItem.quantityDelivered) {
          throw new AppError(
            `Cannot return more items (${quantityReturned}) than originally ordered (${originalLineItem.quantityDelivered}) for SKU ${stockKeepingUnit}.`,
            400,
          );
        }

        const baseUnitReturnQty =
          quantityReturned * originalLineItem.unit.multiplier;

        // --- EXPIRES HANDLING (Safe Fallback Alignment) ---
        // Grab the oldest active stock level criteria matching product or use null
        const targetStock = await tx.stockLevel.findFirst({
          where: {
            productId: originalLineItem.productId,
            warehouseId: Number(warehouseId),
          },
          orderBy: { expiryDate: "asc" },
        });
        const activeExpiry = targetStock?.expiryDate || null;

        // 5. RESTOCK INVENTORY (Atomic Upsert)
        await tx.stockLevel.upsert({
          where: {
            productId_warehouseId_expiryDate: {
              productId: originalLineItem.productId,
              warehouseId: Number(warehouseId),
              expiryDate: activeExpiry as any,
            },
          },
          update: {
            quantity: { increment: baseUnitReturnQty },
          },
          create: {
            productId: originalLineItem.productId,
            warehouseId: Number(warehouseId),
            expiryDate: activeExpiry,
            quantity: baseUnitReturnQty,
          },
        });

        // Update global product stock metrics
        await tx.product.update({
          where: { id: originalLineItem.productId },
          data: { quantityInStock: { increment: baseUnitReturnQty } },
        });

        // 6. CREATE IMMUTABLE AUDIT LOG
        await tx.stockLog.create({
          data: {
            productId: originalLineItem.productId,
            warehouseId: Number(warehouseId),
            quantityChange: baseUnitReturnQty, // POSITIVE addition back to stock
            type: "RETURN", // Tracking exact category
            saleOrderId: returnOrder.id,
          },
        });

        // 7. Track item inside the transaction items history record
        await tx.saleItem.create({
          data: {
            saleId: returnOrder.id,
            productId: originalLineItem.productId,
            quantityOrdered: -quantityReturned, // Stored as a reduction profile
            quantityDelivered: -quantityReturned,
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
      message: "Sales return registered and inventory reverted successfully.",
      data: result,
    });
  },
);

export const createSaleOrder = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!isInventoryV2Enabled()) return createSaleOrderLegacy(req, res, next);
    if (!req.user)
      return next(
        new AppError("Authentication required to create sale orders.", 401),
      );
    const parsed = v2SaleCreateSchema.safeParse(req.body);
    if (!parsed.success)
      return next(
        new AppError(
          `Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
          400,
        ),
      );
    try {
      const result = await createV2SaleOrder(
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

export const updateSaleOrder = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!isInventoryV2Enabled()) return updateSaleOrderLegacy(req, res, next);
    if (!req.user)
      return next(
        new AppError("Authentication required to update sale orders.", 401),
      );
    const parsed = v2SaleUpdateSchema.safeParse(req.body);
    if (!parsed.success)
      return next(
        new AppError(
          `Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
          400,
        ),
      );
    try {
      const result = await updateV2SaleOrder(
        prisma,
        Number(req.params.id),
        parsed.data,
        req.user.id,
        req.get("Idempotency-Key"),
      ); 
      res.status(200).json({ status: "success", data: result });
    } catch (error) {
      next(inventoryHttpError(error));
    }
  },
);
