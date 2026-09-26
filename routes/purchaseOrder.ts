import { Router } from "express";
import {
  createPurchaseOrder,
  createPurchaseReturn,
  createPurchaseReceipt,
  postPurchaseReceiptController,
  updatePurchaseOrder,
} from "../controllers/purchaseOrder";
import { protect, restrictTo } from "../middlewares/auth";
import { validateIdParam } from "../middlewares/validateId";
import { requireIdempotencyKey, requireIdempotencyKeyWhenV2 } from "../middlewares/idempotency";
import { blockLegacyMutationWhenV2 } from "../middlewares/inventoryV2";
import { cancelSupplierReturn, createSupplierReturn, getSupplierReturn, listSupplierReturns, postSupplierReturn } from "../controllers/purchaseReturn";
import { getPurchaseOrder, listPurchaseOrders } from "../controllers/orderReads";

const router = Router();

router.get("/", protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), listPurchaseOrders);

router.route("/create").post(protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKeyWhenV2, createPurchaseOrder);
router.route("/:purchaseId/returns").post(protect, restrictTo("ADMIN", "MANAGER"), requireIdempotencyKey, createSupplierReturn).get(protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), listSupplierReturns);
router.route("/:purchaseId/returns/:returnId").get(protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), getSupplierReturn);
router.route("/:purchaseId/returns/:returnId/post").post(protect, restrictTo("ADMIN", "MANAGER"), requireIdempotencyKey, postSupplierReturn);
router.route("/:purchaseId/returns/:returnId/cancel").post(protect, restrictTo("ADMIN", "MANAGER"), cancelSupplierReturn);
router.patch("/", validateIdParam);
router.post("/return", validateIdParam);
router
  .route("/:id")
  .get(protect, restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), getPurchaseOrder)
  .patch(validateIdParam, protect, restrictTo("ADMIN", "MANAGER"), updatePurchaseOrder);
router
  .route("/:id/return")
  .post(validateIdParam, protect, restrictTo("ADMIN", "MANAGER"), blockLegacyMutationWhenV2, createPurchaseReturn);
router
  .route("/:id/receipts")
  .post(validateIdParam, protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKey, createPurchaseReceipt);
router
  .route("/:purchaseId/receipts/:receiptId/post")
  .post(protect, restrictTo("ADMIN", "MANAGER", "STAFF"), requireIdempotencyKey, postPurchaseReceiptController);

export default router;
