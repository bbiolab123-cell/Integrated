import { Router, type IRouter, type RequestHandler } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

export const healthCheck: RequestHandler = (_req, res) => {
  const build = process.env.RENDER_GIT_COMMIT?.trim().slice(0, 12)
    || process.env.GIT_COMMIT_SHA?.trim().slice(0, 12)
    || "local";
  res.setHeader("X-BioLab-Build", build);
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

// Keep the existing deployment probe and provide the shorter compatibility
// path used by external uptime/keep-alive monitors.
router.get(["/healthz", "/health"], healthCheck);

export default router;
