import { Router } from "express";
import { login, signup } from "../controllers/auth";
import { validateBody } from "../middlewares/validate";
import { loginSchema, signupSchema } from "../schemas/auth";

const router = Router();

router.route("/signup").post(validateBody(signupSchema), signup);
router.route("/login").post(validateBody(loginSchema), login);

export default router;
