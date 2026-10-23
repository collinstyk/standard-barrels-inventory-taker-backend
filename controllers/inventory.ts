import { Request, NextFunction, Response } from "express";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import { StockAdjustmentBody, StockTransferBody } from "../types/inventory";
import { getAuthoritativeExpiringSoon, getAuthoritativeLowStock, isInventoryV2Enabled, getWarehouseAvailability } from "../services/inventory";
import { availabilityQuerySchema, expiringSoonQuerySchema, lowStockQuerySchema } from "../schemas/inventoryV2";
import { openingStockSchema, physicalCountAdjustmentSchema } from "../schemas/inventoryV2";
import { adjustInventoryBatch, recordOpeningStock } from "../services/inventory";
import { inventoryHttpError } from "../utils/inventoryHttpError";

export const getInventoryAvailability = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isInventoryV2Enabled()) return next(new AppError("Inventory V2 availability is unavailable while Inventory V2 is disabled.", 503));
  const parsed = availabilityQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(`Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`, 400));
  try {
    const availability = await getWarehouseAvailability(prisma, parsed.data.productId, parsed.data.unitId, parsed.data.requestedQuantity);
    res.status(200).json({ status: "success", data: availability });
  } catch (error) {
    next(inventoryHttpError(error));
  }
});

export const createPhysicalCountAdjustment = catchAsync(async(req:Request,res:Response,next:NextFunction)=>{
  if(!isInventoryV2Enabled())return next(new AppError("Inventory V2 adjustments are unavailable while Inventory V2 is disabled.",503));
  const parsed=physicalCountAdjustmentSchema.safeParse(req.body);if(!parsed.success)return next(new AppError(`Validation Failed: ${parsed.error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,400));
  try{res.status(200).json({status:"success",data:await adjustInventoryBatch(prisma,parsed.data,req.user!.id,req.idempotencyKey!)});}catch(error){next(inventoryHttpError(error));}
});

export const createOpeningStock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isInventoryV2Enabled()) return next(new AppError("Opening stock is unavailable while Inventory V2 is disabled.", 503));
  const parsed = openingStockSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(`Validation Failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`, 400));
  try {
    const data = await recordOpeningStock(prisma, parsed.data, req.user!.id, req.idempotencyKey!);
    res.status(data.replayed ? 200 : 201).json({ status: "success", data });
  } catch (error) {
    next(inventoryHttpError(error));
  }
});

export const adjustStock = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      productId,
      warehouseId,
      expiryDate,
      physicalCount,
      reason,
    }: StockAdjustmentBody = req.body;

    // 1. Guardrail Validations
    if (!productId || !warehouseId || physicalCount === undefined || !reason) {
      return next(new AppError("Product ID, Warehouse ID, physical count, and reason are required.", 400));
    }

    if (physicalCount < 0) {
      return next(new AppError("Physical count cannot be a negative value.", 400));
    }

    const allowedReasons = ["DAMAGE", "ADJUSTMENT", "EXPIRED"];
    if (!allowedReasons.includes(reason)) {
      return next(new AppError(`Invalid reason code. Allowed values: ${allowedReasons.join(", ")}`, 400));
    }

    const result = await prisma.$transaction(async (tx) => {
      // 2. Verify product exists
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, quantityInStock: true },
      });

      if (!product) {
        throw new AppError("Product not found.", 404);
      }

      // Handle lookups cleanly bypassing strict TypeScript compiler types
      const lookUpExpiry = (expiryDate ? new Date(expiryDate) : null) as unknown as Date;

      // 3. Check what our database currently thinks the stock level is
      const currentStockLevel = await tx.stockLevel.findUnique({
        where: {
          productId_warehouseId_expiryDate: {
            productId,
            warehouseId: Number(warehouseId),
            expiryDate: lookUpExpiry,
          },
        },
      });

      const currentQuantity = currentStockLevel ? currentStockLevel.quantity : 0;
      
      // Calculate the delta (Reality - System Expectation)
      // e.g., We counted 8 bottles, but system says 10. Delta = 8 - 10 = -2 (Decrement)
      // e.g., We counted 12 bottles, but system says 10. Delta = 12 - 10 = +2 (Increment)
      const delta = physicalCount - currentQuantity;

      // 4. If nothing changed, exit early to avoid wasted database write operations
      if (delta === 0) {
        return { productId, warehouseId, currentQuantity, physicalCount, delta: 0 };
      }

      // 5. Update the individual Warehouse Stock Level Atomically
      const updatedStockLevel = await tx.stockLevel.upsert({
        where: {
          productId_warehouseId_expiryDate: {
            productId,
            warehouseId: Number(warehouseId),
            expiryDate: lookUpExpiry,
          },
        },
        update: {
          quantity: physicalCount, // Direct overwrite to reality
        },
        create: {
          productId,
          warehouseId: Number(warehouseId),
          expiryDate: lookUpExpiry,
          quantity: physicalCount,
        },
      });

      // 6. Sync the Delta out to the Global Product Profile Table
      await tx.product.update({
        where: { id: productId },
        data: {
          quantityInStock: { increment: delta }, // Will add if positive, subtract if negative
        },
      });

      // 7. Write an Immutable Audit Log entries for tracking histories
      await tx.stockLog.create({
        data: {
          productId,
          warehouseId: Number(warehouseId),
          quantityChange: delta, // Captures exact direction (-2 or +5)
          type: reason, // Logs directly as DAMAGE, EXPIRED, or ADJUSTMENT
        },
      });

      return {
        productId,
        warehouseId,
        expiryDate: currentStockLevel?.expiryDate || expiryDate || null,
        previousSystemQuantity: currentQuantity,
        newPhysicalQuantity: updatedStockLevel.quantity,
        adjustmentDeltaApplied: delta,
      };
    });

    res.status(200).json({
      status: "success",
      message: "Inventory adjustment executed successfully.",
      data: result,
    });
  }
);

export const transferStock = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      productId,
      sourceWarehouseId,
      destinationWarehouseId,
      quantityToTransfer, // This is now directly the base unit quantity to move
    }: StockTransferBody = req.body;

    // 1. Basic Validation Guardrails
    if (!productId || !sourceWarehouseId || !destinationWarehouseId || !quantityToTransfer) {
      return next(new AppError("All transfer fields are required.", 400));
    }

    if (sourceWarehouseId === destinationWarehouseId) {
      return next(new AppError("Source and destination warehouses must be different.", 400));
    }

    if (quantityToTransfer <= 0) {
      return next(new AppError("Transfer quantity must be greater than zero.", 400));
    }

    const result = await prisma.$transaction(async (tx) => {
      // 2. Verify product exists
      const productExists = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true } // Lean query just to verify existence
      });

      if (!productExists) {
        throw new AppError("Product not found.", 404);
      }

      // 3. Find the oldest expiring batch in the SOURCE warehouse (FEFO alignment)
      const sourceStock = await tx.stockLevel.findFirst({
        where: {
          productId,
          warehouseId: Number(sourceWarehouseId),
        },
        orderBy: { expiryDate: "asc" }, // Target the soonest expiring batch first
      });

      // Guardrail: Ensure inventory physically exists to pull from
      if (!sourceStock || sourceStock.quantity < quantityToTransfer) {
        throw new AppError(
          `Insufficient stock in source warehouse ${sourceWarehouseId}. Available: ${sourceStock?.quantity || 0}, Requested: ${quantityToTransfer}`,
          400
        );
      }

      // Safeguard the exact expiry date token profile (can be a Date or null)
      const activeExpiry = sourceStock.expiryDate; 

      // 4. DECREMENT SOURCE WAREHOUSE STOCK
      await tx.stockLevel.update({
        where: {
          productId_warehouseId_expiryDate: {
            productId,
            warehouseId: Number(sourceWarehouseId),
            expiryDate: (activeExpiry as any),
          },
        },
        data: {
          quantity: { decrement: quantityToTransfer },
        },
      });

      // 5. INCREMENT DESTINATION WAREHOUSE STOCK (Atomic Upsert)
      const updatedDestStock = await tx.stockLevel.upsert({
        where: {
          productId_warehouseId_expiryDate: {
            productId,
            warehouseId: Number(destinationWarehouseId),
            expiryDate: (activeExpiry as any), // Preserve the batch date in its new home
          },
        },
        update: {
          quantity: { increment: quantityToTransfer },
        },
        create: {
          productId,
          warehouseId: Number(destinationWarehouseId),
          expiryDate: activeExpiry,
          quantity: quantityToTransfer,
        },
      });

      // 6. CREATE IMUTABLE AUDIT LOGS
      // Log outbound movement from Source
      await tx.stockLog.create({
        data: {
          productId,
          warehouseId: Number(sourceWarehouseId),
          quantityChange: -quantityToTransfer, // Negative value
          type: "TRANSFER_OUT",
        },
      });

      // Log inbound movement into Destination
      await tx.stockLog.create({
        data: {
          productId,
          warehouseId: Number(destinationWarehouseId),
          quantityChange: quantityToTransfer, // Positive value
          type: "TRANSFER_IN",
        },
      });

      return {
        productId,
        expiryDate: activeExpiry,
        sourceWarehouseId,
        destinationWarehouseId,
        unitsTransferred: quantityToTransfer,
        newDestinationQuantity: updatedDestStock.quantity,
      };
    });

    res.status(200).json({
      status: "success",
      message: "Stock transferred successfully between warehouses.",
      data: result,
    });
  }
);

const getLegacyLowStockAlerts = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // 1. Query products where current stock is at or below the threshold
    const lowStockItems = await prisma.product.findMany({
      where: {
        quantityInStock: {
          lte: prisma.product.fields.reorderPoint, // Direct database column comparison
        },
      },
      select: {
        id: true,
        name: true,
        quantityInStock: true,
        reorderPoint: true,
        baseUnit: true, // Shows the layout string like "bottle" or "box"
      },
      orderBy: {
        quantityInStock: "asc", // Prioritize critical shortages first
      },
    });

    // 2. Map structural metadata to give the frontend helpful context
    const alerts = lowStockItems.map((product) => ({
      productId: product.id,
      productName: product.name,
      currentStock: product.quantityInStock,
      threshold: product.reorderPoint,
      shortageAmount: product.reorderPoint - product.quantityInStock,
      unit: product.baseUnit,
      severity: product.quantityInStock === 0 ? "CRITICAL_OUT_OF_STOCK" : "LOW_STOCK",
    }));

    res.status(200).json({
      status: "success",
      results: alerts.length,
      data: { alerts },
    });
  }
);

const getLegacyExpiringSoonAlerts = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // Read the threshold window from query parameters, defaulting to 90 days
    const daysWindow = Number(req.query.days) || 90;

    const today = new Date();
    
    // Calculate the future cutoff date marker boundary
    const targetCutoffDate = new Date();
    targetCutoffDate.setDate(today.getDate() + daysWindow);

    // Query specific warehouse batch allocations facing expiration risks
    const expiringBatches = await prisma.stockLevel.findMany({
      where: {
        quantity: { gt: 0 }, // Only track items we actually still have on hand
        expiryDate: {
          gt: today,          // Not already expired
          lte: targetCutoffDate, // Expiring within our designated window
        },
      },
      include: {
        product: {
          select: {
            name: true,
            baseUnit: true,
          },
        },
      },
      orderBy: {
        expiryDate: "asc", // Prioritize items expiring soonest
      },
    });

    // Format data cleanly for procurement dashboards
    const alerts = expiringBatches.map((batch) => {
      const timeDiff = new Date(batch.expiryDate!).getTime() - today.getTime();
      const daysRemaining = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

      return {
        productId: batch.productId,
        productName: batch.product?.name,
        warehouseId: batch.warehouseId,
        batchQuantity: batch.quantity,
        unit: batch.product?.baseUnit,
        expiryDate: batch.expiryDate,
        daysRemaining,
      };
    });

    res.status(200).json({
      status: "success",
      results: alerts.length,
      config: {
        alertWindowDays: daysWindow,
        evaluatedAt: today,
      },
      data: { alerts },
    });
  }
);

function validationError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): AppError {
  return new AppError(`Validation Failed: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`, 400);
}

export const getLowStockAlerts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isInventoryV2Enabled()) return getLegacyLowStockAlerts(req, res, next);
  const parsed = lowStockQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError(parsed.error));
  try {
    const result = await getAuthoritativeLowStock(prisma, parsed.data);
    res.status(200).json({ status: "success", ...result });
  } catch (error) {
    next(inventoryHttpError(error));
  }
});

export const getExpiringSoonAlerts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!isInventoryV2Enabled()) return getLegacyExpiringSoonAlerts(req, res, next);
  const parsed = expiringSoonQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError(parsed.error));
  try {
    const result = await getAuthoritativeExpiringSoon(prisma, parsed.data);
    res.status(200).json({ status: "success", ...result });
  } catch (error) {
    next(inventoryHttpError(error));
  }
});
