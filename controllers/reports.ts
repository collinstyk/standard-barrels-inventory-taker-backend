import { Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";

export const getSalesVolumeReport = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    
    // 1. Let the database aggregate the real quantities across all sales rows
    const aggregateResult = await prisma.saleItem.aggregate({
      _sum: {
        quantityOrder: true,     // Total items buyers wanted
        quantityDelivered: true, // Total items physically moved out of the warehouse
        totalPrice: true,        // Gross revenue based on items processed
      },
      _count: {
        id: true,                // Total sales order line items
      },
    });

    // 2. Extract values cleanly (fallback to 0 if no records exist)
    const totalOrdered = aggregateResult._sum.quantityOrder || 0;
    const totalDelivered = aggregateResult._sum.quantityDelivered || 0;
    const grossRevenue = aggregateResult._sum.totalPrice?.toNumber() || 0;
    const totalLinesProcessed = aggregateResult._count.id || 0;

    // 3. Compute business performance metrics
    // Backlog: Items ordered but not yet delivered (out of stock, delayed, etc.)
    const backlogQuantity = totalOrdered - totalDelivered;

    // Fulfillment Rate: Percentage of ordered stock successfully delivered (Target: ~95-100%)
    const fulfillmentRate = totalOrdered > 0
      ? parseFloat(((totalDelivered / totalOrdered) * 100).toFixed(2))
      : 0;

    // 4. Return clean, high-value warehouse operational summary
    res.status(200).json({
      status: "success",
      data: {
        summary: {
          grossRevenue,
          totalLineItemsProcessed: totalLinesProcessed,
          volumeMetrics: {
            totalUnitsOrdered: totalOrdered,
            totalUnitsDelivered: totalDelivered,
            backlogUnitsRemaining: backlogQuantity,
          },
          efficiencyMetrics: {
            fulfillmentRate: `${fulfillmentRate}%`,
            status: fulfillmentRate >= 95 ? "EXCELLENT" : fulfillmentRate >= 80 ? "HEALTHY" : "CRITICAL_BACKLOG"
          }
        }
      }
    });
  }
);

export const getCostLeakageReport = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    
    // 1. Group stock logs by product and type where stock was lost due to damage or expiration
    const leakageGroups = await prisma.stockLog.groupBy({
      by: ["productId", "type"],
      where: {
        type: {
          in: ["DAMAGE", "EXPIRED"], // Filter strictly out structural write-offs
        },
      },
      _sum: {
        quantityChange: true, // This will be a negative number (e.g., -5)
      },
    });

    // 2. Pull product details and baseline pricing to evaluate the financial cost of the loss
    const products = await prisma.product.findMany({
      select: {
        id: true,
        name: true,
        baseUnit: true,
        units: {
          where: { multiplier: 1 }, // Map to the baseline unit variation price
          select: { price: true },
          take: 1,
        },
      },
    });

    let totalGlobalLossValue = 0;
    const leakageManifest: any[] = [];

    // 3. Map the aggregated database rows to financial figures
    leakageGroups.forEach((logGroup) => {
      const product = products.find((p) => p.id === logGroup.productId);
      if (!product) return;

      const productPrice = product.units[0]?.price?.toNumber() || 0;
      
      // Convert negative database delta to a absolute positive count of units lost
      const absoluteUnitsLost = Math.abs(logGroup._sum.quantityChange || 0);
      const financialLossValue = absoluteUnitsLost * productPrice;

      totalGlobalLossValue += financialLossValue;

      leakageManifest.push({
        productId: logGroup.productId,
        productName: product.name,
        baseUnit: product.baseUnit,
        lossType: logGroup.type, // "DAMAGE" or "EXPIRED"
        totalUnitsLost: absoluteUnitsLost,
        unitCost: productPrice,
        estimatedFinancialLoss: financialLossValue,
      });
    });

    // 4. Return the cost leakage analysis payload
    res.status(200).json({
      status: "success",
      data: {
        leakageSummary: {
          totalFinancialLoss: totalGlobalLossValue,
          breakdownByIncidentCount: leakageGroups.length,
        },
        leakageDetails: leakageManifest.sort((a, b) => b.estimatedFinancialLoss - a.estimatedFinancialLoss),
      },
    });
  }
);

export const getProductVelocityAudit = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    
    // 1. Aggregate total units delivered per product across all historical sales records
    const salesVelocity = await prisma.saleItem.groupBy({
      by: ["productId"],
      _sum: {
        quantityDelivered: true,
      },
    });

    // 2. Fetch product details to map back to the aggregated volumes
    const products = await prisma.product.findMany({
      select: {
        id: true,
        name: true,
        baseUnit: true,
      },
    });

    // 3. Process records and categorize into performance velocity tiers
    const velocityAudit = products.map((product) => {
      const salesData = salesVelocity.find((v) => v.productId === product.id);
      const totalUnitsMoved = salesData?._sum?.quantityDelivered || 0;

      // Classify performance bands based on volume moved
      let velocityClass: "FAST_MOVING" | "MEDIUM_MOVING" | "SLOW_MOVING";
      if (totalUnitsMoved > 100) {
        velocityClass = "FAST_MOVING"; // High layout prioritization
      } else if (totalUnitsMoved > 20) {
        velocityClass = "MEDIUM_MOVING";
      } else {
        velocityClass = "SLOW_MOVING"; // Low layout prioritization (back of the warehouse)
      }

      return {
        productId: product.id,
        productName: product.name,
        baseUnit: product.baseUnit,
        totalUnitsDelivered: totalUnitsMoved,
        velocityTier: velocityClass,
      };
    });

    // Sort report to show top sales performers first
    const sortedAudit = velocityAudit.sort((a, b) => b.totalUnitsDelivered - a.totalUnitsDelivered);

    res.status(200).json({
      status: "success",
      results: sortedAudit.length,
      data: {
        velocityAudit: sortedAudit,
      },
    });
  }
);

export const getWarehouseCapacityUtilization = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    
    // 1. Group the current live stock rows by warehouse to calculate occupancy loads
    const stockLoadByWarehouse = await prisma.stockLevel.groupBy({
      by: ["warehouseId"],
      _sum: {
        quantity: true, // Adds up all raw base items inside each specific building
      },
    });

    // 2. Fetch warehouse metadata structures
    const warehouses = await prisma.warehouse.findMany({
      select: {
        id: true,
        name: true,
        location: true,
      },
    });

    // For this engine, let's assume an identical standard volumetric storage ceiling 
    // of 10,000 baseline units per facility for safety threshold calculations.
    const STATIC_MAX_CAPACITY = 10000;

    // 3. Blend layout totals with structural capacities
    const capacityReport = warehouses.map((warehouse) => {
      const stockData = stockLoadByWarehouse.find((s) => s.warehouseId === warehouse.id);
      const currentOccupiedUnits = stockData?._sum?.quantity || 0;

      // Calculate percentage utilization load
      const utilizationPercentage = parseFloat(
        ((currentOccupiedUnits / STATIC_MAX_CAPACITY) * 100).toFixed(2)
      );

      let status: "OPTIMAL" | "WARNING_NEAR_CAPACITY" | "OVER_CAPACITY";
      if (utilizationPercentage > 90) {
        status = "OVER_CAPACITY"; // Reorder allocations or split inbound freight immediately
      } else if (utilizationPercentage > 75) {
        status = "WARNING_NEAR_CAPACITY";
      } else {
        status = "OPTIMAL";
      }

      return {
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        location: warehouse.location,
        currentOccupiedUnits,
        maxCapacityCeiling: STATIC_MAX_CAPACITY,
        utilizationPercentage: `${utilizationPercentage}%`,
        status,
      };
    });

    res.status(200).json({
      status: "success",
      data: {
        capacityUtilizationReport: capacityReport,
      },
    });
  }
);