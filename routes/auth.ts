import { Router } from "express";
import { login, signup } from "../controllers/auth";
import { validateBody } from "../middlewares/validate";
import { loginSchema, signupSchema } from "../schemas/auth";
import { protect, restrictTo } from "../middlewares/auth";
import { createInvitation, inspectInvitation, acceptInvitation } from "../controllers/invitations";
import { createInvitationSchema, inspectInvitationSchema, acceptInvitationSchema } from "../schemas/invitations";

const router = Router();

router.route("/signup").post(validateBody(signupSchema), signup);
router.route("/login").post(validateBody(loginSchema), login);
router.post("/invitations", protect, restrictTo("ADMIN"), validateBody(createInvitationSchema), createInvitation);
router.post("/invitations/inspect", validateBody(inspectInvitationSchema), inspectInvitation);
router.post("/invitations/accept", validateBody(acceptInvitationSchema), acceptInvitation);

export default router;
