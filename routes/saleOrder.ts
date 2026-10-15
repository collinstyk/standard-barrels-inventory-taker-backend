import { Router } from "express";
import {
  createSaleOrder,
  createSalesReturn,
  updateSaleOrder,
} from "../controllers/saleOrder";
import { protect, restrictTo } from "../middlewares/auth";
import { validateIdParam } from "../middlewares/validateId";
import { requireIdempotencyKey, requireIdempotencyKeyWhenV2 } from "../middlewares/idempotency";
import { blockLegacyMutationWhenV2 } from "../middlewares/inventoryV2";
import { cancelCustomerReturn, createCustomerReturn, getCustomerReturn, inspectCustomerReturn, listCustomerReturns, receiveCustomerReturn } from "../controllers/saleReturn";
import { cancelIssuedSale } from "../controllers/saleCancellation";
import { getSaleOrder, listSaleOrders } from "../controllers/orderReads";
import { dispatchSaleOrder } from "../controllers/saleDispatch";

const router = Router();

router.get("/", protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), listSaleOrders);

router.route("/create").post(protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKeyWhenV2, createSaleOrder);
router.post("/:id/dispatches", validateIdParam, protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKey, dispatchSaleOrder);
router.post("/:id/cancel-issued", protect, restrictTo("ADMIN", "MANAGER"), requireIdempotencyKey, cancelIssuedSale);
router.route("/:saleId/returns").post(protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKey, createCustomerReturn).get(protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), listCustomerReturns);
router.route("/:saleId/returns/:returnId").get(protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), getCustomerReturn);
router.route("/:saleId/returns/:returnId/receive").post(protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKey, receiveCustomerReturn);
router.route("/:saleId/returns/:returnId/inspections").post(protect, restrictTo("ADMIN", "MANAGER"), requireIdempotencyKey, inspectCustomerReturn);
router.route("/:saleId/returns/:returnId/cancel").post(protect, restrictTo("ADMIN", "MANAGER", "STAFF"), cancelCustomerReturn);
router.patch("/", validateIdParam);
router.post("/return", validateIdParam);
router
  .route("/:id")
  .get(protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), getSaleOrder)
  .patch(validateIdParam, protect, restrictTo("ADMIN", "MANAGER"), updateSaleOrder);
router
  .route("/:id/return")
  .post(validateIdParam, protect, restrictTo("ADMIN", "MANAGER"), blockLegacyMutationWhenV2, createSalesReturn);

export default router;
