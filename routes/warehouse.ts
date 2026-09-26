import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth";
import * as c from "../controllers/warehouse";

const router = Router();

router.use(protect);

router
  .route("/")
  .post(restrictTo("ADMIN", "MANAGER"), c.createWarehouse)
  .get(restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), c.listWarehouses);

  router
  .route("/:id")
  .get(restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), c.getWarehouse)
  .patch(restrictTo("ADMIN", "MANAGER"), c.updateWarehouse);

  export default router;
