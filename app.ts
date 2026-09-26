import express from "express";
import morgan from "morgan";
import saleRoutes from "./routes/saleOrder";
import purchaseRoutes from "./routes/purchaseOrder";
import inventoryRoutes from "./routes/inventory";
import authRoutes from "./routes/auth";
import { globalErrorHandler } from "./middlewares/error";
import AppError from "./utils/appError";
import catalogRoutes from "./routes/catalog";
import warehouseRoutes from "./routes/warehouse";
import contactRoutes from "./routes/contact";

const app = express();

app.use(morgan("dev"));

app.use(express.json());

// routes
app.use("/api/v1/purchase", purchaseRoutes);
app.use("/api/v1/sale", saleRoutes);
app.use("/api/v1/inventory", inventoryRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/catalog", catalogRoutes);
app.use("/api/v1/warehouses", warehouseRoutes);
app.use("/api/v1/contacts", contactRoutes);

// fallback route
app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this service!`, 404));
});

// GLOBAL ERROR MIDDLEWARE
app.use(globalErrorHandler);

export default app;
