import { Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";

export const getRebalancingManifest = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    
    // 1. Gather live inventory cross-sections across all facilities
    const stockLevels = await prisma.stockLevel.findMany({
      include: {
        product: {
          select: {
            name: true,
            baseUnit: true,
            reorderPoint: true,
          },
        },
      },
    });

    // We'll set an operating standard maximum stocking threshold 
    // to identify when an individual item is overstocked in a facility.
    const SURPLUS_THRESHOLD_MULTIPLIER = 4; 

    const supplySurplus: any[] = [];
    const supplyDeficit: any[] = [];
    const rebalancingActions: any[] = [];

    // 2. Classify individual product locations into surplus or deficit buckets
    stockLevels.forEach((stock) => {
      const reorderPoint = stock.product?.reorderPoint || 10;
      const surplusMark = reorderPoint * SURPLUS_THRESHOLD_MULTIPLIER;

      if (stock.quantity <= reorderPoint) {
        // Warehouse is running dry on this product
        supplyDeficit.push({
          warehouseId: stock.warehouseId,
          productId: stock.productId,
          productName: stock.product?.name,
          currentQty: stock.quantity,
          targetMinQty: reorderPoint * 2, // Desired healthy baseline buffer
          shortage: (reorderPoint * 2) - stock.quantity,
        });
      } else if (stock.quantity >= surplusMark) {
        // Warehouse has way too much cash/space tied up in this product
        supplySurplus.push({
          warehouseId: stock.warehouseId,
          productId: stock.productId,
          productName: stock.product?.name,
          currentQty: stock.quantity,
          safeMaxQty: surplusMark,
          excess: stock.quantity - surplusMark,
        });
      }
    });

    // 3. Matchmaker Algorithmic Pass: Resolve deficits using surplus stock
    supplyDeficit.forEach((deficit) => {
      // Look for a warehouse that has a surplus of this EXACT same product
      const matchingSurplus = supplySurplus.find(
        (surplus) => surplus.productId === deficit.productId && surplus.excess > 0
      );

      if (matchingSurplus) {
        // Calculate the optimal amount to move
        const transferAmountSuggested = Math.min(deficit.shortage, matchingSurplus.excess);

        if (transferAmountSuggested > 0) {
          rebalancingActions.push({
            productId: deficit.productId,
            productName: deficit.productName,
            sourceWarehouseId: matchingSurplus.warehouseId,      // Send from here
            destinationWarehouseId: deficit.warehouseId,       // Receive here
            suggestedTransferQuantity: transferAmountSuggested,
            reason: `Relieve surplus in WH ${matchingSurplus.warehouseId} (+${matchingSurplus.excess}) to clear deficit in WH ${deficit.warehouseId} (-${deficit.shortage})`,
          });

          // Deduct from local temporary memory array to prevent double allocation checks
          matchingSurplus.excess -= transferAmountSuggested;
        }
      }
    });

    // 4. Return the intelligent automated relocation manifest
    res.status(200).json({
      status: "success",
      data: {
        rebalancingSummary: {
          totalOptimizationsRecommended: rebalancingActions.length,
          activeDeficitPocketsIdentified: supplyDeficit.length,
          activeSurplusPocketsIdentified: supplySurplus.filter(s => s.excess > 0).length,
        },
        recommendedTransfers: rebalancingActions,
      },
    });
  }
);