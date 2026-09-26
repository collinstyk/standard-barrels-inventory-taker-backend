import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth";
import * as c from "../controllers/contact";

const router = Router();

router.use(protect);

router
  .route("/")
  .post(restrictTo("ADMIN", "MANAGER"), c.createContact)
  .get(restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), c.listContacts);

router
  .route("/:id")
  .get(restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"), c.getContact)
  .patch(restrictTo("ADMIN", "MANAGER"), c.updateContact);

export default router;
