import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { isDemoMode } from "../lib/runtimeConfig";

/**
 * Demo mode: when CLERK_SECRET_KEY is not set, all requests are treated as
 * authenticated under a single shared "demo_user" account.
 * Set CLERK_SECRET_KEY in your environment to enable real auth.
 */
const DEMO_USER_ID = "demo_user";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isDemoMode) {
    (req as Request & { userId: string }).userId = DEMO_USER_ID;
    req.log = req.log.child({ userId: DEMO_USER_ID });
    next();
    return;
  }

  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as Request & { userId: string }).userId = userId as string;
  req.log = req.log.child({ userId });
  next();
}
