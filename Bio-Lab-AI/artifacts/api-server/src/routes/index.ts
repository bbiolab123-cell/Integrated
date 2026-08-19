import { Router, type IRouter } from "express";
import healthRouter from "./health";
import experimentsRouter from "./experiments";
import projectsRouter from "./projects";
import aiRouter from "./gemini";
import adminRouter from "./admin";
import aiTrainingRouter from "./aiTraining";
import publicShareRouter from "./publicShare";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
// Read-only share links are reachable without an account — that is the point,
// so a PI or collaborator can open a result without signing up. Mounted ahead
// of requireAuth deliberately; everything it serves goes through the allowlist
// in lib/publicExperiment.ts.
router.use(publicShareRouter);
router.use(requireAuth);
router.use(experimentsRouter);
router.use(projectsRouter);
router.use(aiRouter);
router.use(aiTrainingRouter);
router.use(adminRouter);

export default router;
