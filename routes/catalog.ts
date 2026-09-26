import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth";
import * as c from "../controllers/catalog";

const router = Router();

const read = restrictTo("ADMIN", "MANAGER", "STAFF", "AUDITOR"),
  write = restrictTo("ADMIN", "MANAGER");

router.use(protect);

router
  .route("/categories")
  .post(write, c.createCategory)
  .get(read, c.listCategories);

router
  .route("/categories/:id")
  .get(read, c.getCategory)
  .patch(write, c.updateCategory);

router
  .route("/products")
  .post(write, c.createProduct)
  .get(read, c.listProducts);

router
  .route("/products/:id")
  .get(read, c.getProduct)
  .patch(write, c.updateProduct);

router
  .route("/products/:productId/units")
  .post(write, c.createUnit)
  .get(read, c.listUnits);

router
  .route("/products/:productId/units/:unitId")
  .get(read, c.getUnit)
  .patch(write, c.updateUnit);
  
export default router;
