import { Router } from "express";
import {
  adjustStock,
  transferStock,
  getLowStockAlerts,
  getExpiringSoonAlerts,
  getInventoryAvailability,
  createPhysicalCountAdjustment,
  createOpeningStock,
} from "../controllers/inventory";
import { protect, restrictTo } from "../middlewares/auth";
import { UserRole } from "../generated/prisma/enums";
import { blockLegacyMutationWhenV2 } from "../middlewares/inventoryV2";
import { requireIdempotencyKey } from "../middlewares/idempotency";

const router = Router();

router.route("/availability").get(protect, restrictTo(UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF, UserRole.AUDITOR), getInventoryAvailability);
router.post("/adjustments",protect,restrictTo(UserRole.ADMIN,UserRole.MANAGER),requireIdempotencyKey,createPhysicalCountAdjustment);
router.post("/opening-stock", protect, restrictTo(UserRole.ADMIN, UserRole.MANAGER), requireIdempotencyKey, createOpeningStock);

router
  .route("/adjust")
  .post(protect, restrictTo(UserRole.ADMIN, UserRole.AUDITOR), blockLegacyMutationWhenV2, adjustStock);
router
  .route("/transfer")
  .post(protect, restrictTo(UserRole.ADMIN, UserRole.AUDITOR, UserRole.MANAGER), blockLegacyMutationWhenV2, transferStock);
router.route("/low-stock").get(protect, restrictTo(UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF, UserRole.AUDITOR), getLowStockAlerts);
router.route("/expiring-soon").get(protect, restrictTo(UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF, UserRole.AUDITOR), getExpiringSoonAlerts);

export default router;
