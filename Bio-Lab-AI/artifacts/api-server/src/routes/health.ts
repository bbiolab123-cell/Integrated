import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const build = process.env.RENDER_GIT_COMMIT?.trim().slice(0, 12)
    || process.env.GIT_COMMIT_SHA?.trim().slice(0, 12)
    || "local";
  res.setHeader("X-BioLab-Build", build);
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
