import { NextFunction, Request, Response } from "express";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import prisma from "../prisma";
import z from "zod";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { Decimal } from "../generated/prisma/internal/prismaNamespace";
import { PaymentStatus, ReceivingStatus } from "../generated/prisma/enums";

export const createPurchaseOrder = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id: receiverId } = req.user;

    const { supplier, items, transactionStatus, extraCost, amountPaid } =
      req.body;

    // Validate Inputs
    if (!items || !transactionStatus || !extraCost || !amountPaid)
      throw new AppError("Missing required field(s)!", 400);

    // validate purchase items
    if (!Array.isArray(items) || items.length === 0)
      throw new AppError("Purchase order must contain atleast one item!", 400);
    for (const item of items) {
      const { product, quantityOrdered, quantityReceived, unit } = item;
      if (!product || !quantityOrdered || !quantityReceived || !unit)
        return next(new AppError("Purchase item missing required field(s)!", 400));
    }

    // start transaction
    const result = await prisma.$transaction(async (tx) => {
      // resolve supplier
      const IdSchema = z.uuid();
      const isInt = (input: any) => Number.isInteger(Number.parseInt(input));
      let contact;
      try {
        if (IdSchema.safeParse(supplier).success) {
          contact = await tx.contact.update({
            where: { id: supplier },
            data: { isSupplier: true },
          });
        } else {
          const existingContact = await tx.contact.findFirst({
            where: { name: supplier },
          });

          if (existingContact) {
            contact = await tx.contact.update({
              where: { id: existingContact.id },
              data: { isSupplier: true },
            });
          } else {
            contact = await tx.contact.create({
              data: { name: supplier, isSupplier: true },
            });
          }
        }
      } catch (error) {
        if (
          error instanceof PrismaClientKnownRequestError &&
          error.code === "P2025"
        )
          throw new AppError(
            `Supplier with ID "${supplier}" does not exist.`,
            400,
          );
      }

      const supplierId = contact?.id;

      // create purchase order with the minimum requirement
      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          supplierId,
          receiverId,
          transactionStatus,
          paymentStatus: "NOT_PAID",
          receivingStatus: "NOT_RECEIVED",
          extraCost,
          totalPurchaseCost: 0,
          amountPaid: 0,
        },
      });

      let totalPurchaseCost = new Decimal(0);
      let totalQuantityOrdered = 0;
      let totalQuantityReceived = 0;
      // CREATE PURCHASE ITEMS
      for (const item of items) {
        const {
          product,
          quantityOrdered,
          quantityReceived,
          unit,
          price,
          stockKeepingUnit,
          multiplier,
          baseUnit,
          category,
          warehouse,
        } = item;

        totalQuantityReceived += quantityReceived;
        totalQuantityOrdered += quantityOrdered;

        // RESOLVE THE CATEGORY
        let categoryId: string | undefined;
        if (!IdSchema.safeParse(product).success) {
          if (!baseUnit)
            throw new AppError(
              "Provide the baseUnit for the product storage.",
              400,
            );

          //  Handle category assignment
          if (IdSchema.safeParse(category).success) {
            const existingCategory = await tx.category.findUnique({
              where: { id: category },
            });

            if (!existingCategory)
              throw new AppError(
                `Category with ID ${category} does not exist!`,
                404,
              );

            categoryId = existingCategory.id;
          } else {
            const newCategory = await tx.category.create({
              data: {
                name: category,
              },
            });

            categoryId = newCategory.id;
          }
        }

        // RESOLVE THE PRODUCT
        let productId;
        if (IdSchema.safeParse(product).success) {
          const existingProduct = await tx.product.findUnique({
            where: { id: product },
          });

          if (!existingProduct)
            return next(new AppError(
              `Product with ID ${product} does not exist!`,
              404,
            ));
          productId = existingProduct.id;
        } else {
          const newProduct = await tx.product.create({
            data: {
              name: product,
              baseUnit,
              categoryId: categoryId!,
              quantityInStock: 0,
            },
          });
          productId = newProduct.id;
        }

        // RESOLVE THE PRODUCT UNIT
        let productUnitId;
        if (isInt(unit)) {
          const existingProductUnit = await tx.productUnit.findUnique({
            where: { id: unit },
          });

          if (!existingProductUnit)
            return next(new AppError(
              `Product unit with ID ${unit} does not exist!`,
              400,
            ));

          productUnitId = existingProductUnit.id;
        } else {
          if (!multiplier || !price || !stockKeepingUnit)
            return next(new AppError("Product unit missing required fields", 400));
          const newProductUnit = await tx.productUnit.create({
            data: {
              name: unit,
              multiplier: multiplier,
              price,
              sku: stockKeepingUnit,
              productId,
            },
          });
          productUnitId = newProductUnit.id;
        }

        // CREATE PURCHASE ITEM
        const purchaseItem = await tx.purchaseItem.create({
          data: {
            purchaseId: purchaseOrder.id,
            productId,
            quantityOrdered,
            quantityReceived,
            unitId: productUnitId,
            unitPrice: price,
            totalPrice: price * quantityOrdered,
          },
        });

        totalPurchaseCost = totalPurchaseCost.plus(purchaseItem.totalPrice);

        // RESOLVE THE WAREHOUSE
        if (!warehouse)
          throw new AppError(
            "Provide a warehouse name or ID for the stock storage.",
            400,
          );

        let resolvedWarehouseId: number;
        if (isInt(warehouse)) {
          const existingWarehouse = await tx.warehouse.findUnique({
            where: { id: Number(warehouse) },
          });
          if (!existingWarehouse)
            throw new AppError(
              `Warehouse with ID ${warehouse} does not exist!`,
              404,
            );
          resolvedWarehouseId = existingWarehouse.id;
        } else {
          const existingWarehouseByName = await tx.warehouse.findUnique({
            where: { name: warehouse },
          });
          if (existingWarehouseByName) {
            resolvedWarehouseId = existingWarehouseByName.id;
          } else {
            const newWarehouse = await tx.warehouse.create({
              data: { name: warehouse },
            });
            resolvedWarehouseId = newWarehouse.id;
          }
        }

        // RESOLVE THE STOCK LEVEL
        const actualMultiplier = multiplier ? Number(multiplier) : 1;
        const baseUnitQuantityAdded = quantityReceived * actualMultiplier;

        await tx.stockLevel.upsert({
          where: {
            productId_warehouseId: {
              productId,
              warehouseId: resolvedWarehouseId,
            },
          },
          update: {
            quantity: { increment: baseUnitQuantityAdded },
          },
          create: {
            productId,
            warehouseId: resolvedWarehouseId,
            quantity: baseUnitQuantityAdded,
          },
        });

        // UPDATE THE PRODUCT
        await tx.product.update({
            where: {id: productId},
            data: {
                quantityInStock: {increment: baseUnitQuantityAdded},
            }
        })

        // CREATE THE STOCK LOG
        await tx.stockLog.create({
          data: {
            productId,
            warehouseId: resolvedWarehouseId,
            quantityChange: baseUnitQuantityAdded,
            type: "PURCHASE",
            purchaseOrderId: purchaseOrder.id,
          },
        });
      }

      // RESOLVE PAYMENT STATUS
      let actualPaymentStatus: PaymentStatus;
      const amountPaidDecimal = new Decimal(amountPaid);
      if (totalPurchaseCost.greaterThan(amountPaidDecimal)) {
        actualPaymentStatus = "PARTLY_PAID";
      } else if (amountPaidDecimal.equals(0)) {
        actualPaymentStatus = "NOT_PAID";
      } else if (totalPurchaseCost.equals(amountPaidDecimal)) {
        actualPaymentStatus = "FULLY_PAID";
      } else {
        actualPaymentStatus = 'NOT_PAID'
      }

      // RESOLVE RECEIVING STATUS
      let actualReceivingStatus: ReceivingStatus;
      if (totalQuantityOrdered === totalQuantityReceived)  {
          actualReceivingStatus = "FULLY_RECEIVED";
        } else if (totalQuantityReceived === 0) {
            actualReceivingStatus = "NOT_RECEIVED";
        } else if (totalQuantityOrdered > totalQuantityReceived) {
          actualReceivingStatus = "PARTLY_RECEIVED";
      } else {
        actualReceivingStatus = 'NOT_RECEIVED';
      }

      // UPDATE AND RETURN PURCHASE ORDER
      const updatedPurchaseOrder = await tx.purchaseOrder.update({
        where: {id: purchaseOrder.id},
            data: {
                paymentStatus: actualPaymentStatus,
                receivingStatus: actualReceivingStatus,
                totalPurchaseCost: totalPurchaseCost
            }
      })

      // UPDATE AND RETURN PURCHASE ORDER
      return updatedPurchaseOrder;
    });

    res.status(200).json({
      message: "Purchase order created successfully!",
      data: result,
    });
  },
);
