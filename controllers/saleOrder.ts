import { Request, NextFunction, Response } from "express";
import prisma from "../prisma";
import { catchAsync } from "../utils/catchAsync";
import AppError from "../utils/appError";
import z from "zod";
import { DeliveryStatus, PaymentStatus, Prisma, TransactionStatus } from "../generated/prisma/client";

interface SaleItemInput {
  productId: string;
  unitId: number;
  unitPrice: number;
  quantityOrdered: number;
  quantityDelivered: number;
  totalPrice: number;
  warehouseId: number;
}

interface SaleOrderCreateBody {
  items: SaleItemInput[];
  buyer: string;
  transactionStatus: TransactionStatus;
  amountPaid: number;
}

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

export const createSaleOrder = catchAsync(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { id: sellerId } = (req as any).user;

    // Verify Authentication
    if (!sellerId)
      return next(new AppError("Log in to access this route!", 400));

    const { items, buyer, transactionStatus, amountPaid }: SaleOrderCreateBody =
      req.body;

    // Validate Input
    if (!items || !buyer || !transactionStatus || !amountPaid)
      return next(new AppError("Missing required field(s)!", 400));

    // validate sale items
    if (!Array.isArray(items) || items.length === 0) {
      return next(
        new AppError("Sale order must contain at least one item!", 400),
      );
    }
    for (const item of items) {
      const {
        productId,
        unitId,
        unitPrice,
        quantityOrdered,
        quantityDelivered,
        warehouseId,
      } = item;
      if (
        !productId ||
        !unitId ||
        !unitPrice ||
        !quantityOrdered ||
        !quantityDelivered ||
        !warehouseId
      )
        return next(new AppError("Sale Item missing required field(s)!", 400));
    }

    // start transaction
    const result = await prisma.$transaction(async (tx) => {
      // resolve buyer
      const IdSchema = z.uuid();
      let contact;
      try {
        if (IdSchema.safeParse(buyer).success) {
          contact = await tx.contact.update({
            where: { id: buyer },
            data: { isBuyer: true },
          });
        } else {
          const existingContact = await tx.contact.findFirst({
            where: { name: buyer },
          });

          if (existingContact) {
            contact = await tx.contact.update({
              where: { id: existingContact.id },
              data: {
                isBuyer: true,
              },
            });
          } else
            contact = await tx.contact.create({
              data: { name: buyer, isBuyer: true },
            });
        }
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2025"
        ) {
          return next(
            new AppError(`Buyer with ID "${buyer}" does not exist.`, 400),
          );
        }
      }
      const buyerId = contact?.id;

      // create saleOrder row with the minimum requirement
      const saleOrder = await tx.saleOrder.create({
        data: {
          buyerId,
          sellerId,
          transactionStatus,
          paymentStatus: "NOT_PAID",
          deliveryStatus: "NOT_DELIVERED",
          totalSaleAmount: 0,
          amountPaid: Number(amountPaid),
        },
      });

      let totalSaleAmount = 0;
      let totalQuantityDelivered = 0;
      let totalQuantityOrdered = 0;

      // create/resolve sale items
      for (const item of items) {
        const unit = await tx.productUnit.findUnique({
          where: { id: item.unitId },
        });

        if (!unit) throw new AppError(`Unit ID ${item.unitId} not found`, 404);

        const totalDeduction = item.quantityOrdered * unit.multiplier;
        const lineTotalPrice = item.quantityOrdered * item.unitPrice;
        totalSaleAmount += lineTotalPrice;
        totalQuantityDelivered += item.quantityDelivered;
        totalQuantityOrdered += item.quantityOrdered;


        // Check stock
        const currentStock = await tx.stockLevel.findUnique({
          where: {
            productId_warehouseId: {
              productId: item.productId,
              warehouseId: item.warehouseId,
            },
          },
        });

        if (!currentStock || currentStock.quantity < totalDeduction)
          throw new AppError(
            `Insufficient stock for product ${item.productId} in warehouse ${item.warehouseId}`,
            400,
          );

        // update warehouse stock
        await tx.stockLevel.update({
          where: {
            productId_warehouseId: {
              productId: item.productId,
              warehouseId: item.warehouseId,
            },
          },
          data: {
            quantity: { decrement: totalDeduction },
          },
        });

        // update product quantity
        await tx.product.update({
          where: { id: item.productId },
          data: { quantityInStock: { decrement: totalDeduction } },
        });

        // create sale item
        await tx.saleItem.create({
          data: {
            saleId: saleOrder.id,
            productId: item.productId,
            quantityOrdered: item.quantityOrdered,
            quantityDelivered: item.quantityDelivered,
            unitId: item.unitId,
            unitPrice: item.unitPrice,
            totalPrice: lineTotalPrice,
          },
        });

        // create stock log
        await tx.stockLog.create({
          data: {
            productId: item.productId,
            warehouseId: item.warehouseId,
            quantityChange: -totalDeduction,
            type: "SALE",
            saleOrderId: saleOrder.id,
          },
        });
      }

      // TODO: Update the sale transactionStatus, paymentStatus and deliveryStatus
      let actualPaymentStatus: PaymentStatus;
      if (totalSaleAmount === amountPaid) {
        actualPaymentStatus = 'FULLY_PAID';
      } else if (amountPaid === 0) {
        actualPaymentStatus = 'NOT_PAID';
      } else if (totalSaleAmount > amountPaid) {
        actualPaymentStatus = 'PARTLY_PAID';
      } else {
        actualPaymentStatus = 'NOT_PAID';
      }

      let actualDeliveryStatus: DeliveryStatus;
      if (totalQuantityDelivered === totalQuantityOrdered) {
        actualDeliveryStatus = 'FULLY_DELIVERED';
      } else if (totalQuantityDelivered === 0) {
        actualDeliveryStatus = 'NOT_DELIVERED';
      } else if (totalQuantityOrdered > totalQuantityDelivered) {
        actualDeliveryStatus = 'PARTLY_DELIVERED';
      } else {
        actualDeliveryStatus = 'NOT_DELIVERED';
      }

      const finalSaleOrder = await tx.saleOrder.update({
        where: { id: saleOrder.id },
        data: {
          totalSaleAmount,
          paymentStatus: actualPaymentStatus,
          deliveryStatus: actualDeliveryStatus,
        },
      });

      return finalSaleOrder;
    });

    // send response
    res.status(200).json({
      message: "Sale order created successfully!",
      status: "success",
      data: result,
    });
  },
);
