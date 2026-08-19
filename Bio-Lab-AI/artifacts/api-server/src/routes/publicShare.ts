import { Router, type IRouter } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, experiments } from "@workspace/db";

import { toPublicExperiment } from "../lib/publicExperiment";

// The ONLY unauthenticated data route in the product. Mounted before
// requireAuth in routes/index.ts, so everything here must assume an anonymous,
// possibly hostile caller.
const router: IRouter = Router();

// Tokens are 32 random bytes hex-encoded. Anything that is not exactly that
// shape is rejected before it reaches the database.
const SHARE_TOKEN_RE = /^[a-f0-9]{64}$/;

router.get("/public/experiments/:token", async (req, res) => {
  try {
    const token = String(req.params.token ?? "");
    if (!SHARE_TOKEN_RE.test(token)) {
      // Same response as a revoked link: never distinguish "malformed" from
      // "no longer shared" for an anonymous caller.
      return res.status(404).json({ error: "This shared experiment is not available." });
    }

    const rows = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.share_token, token), isNotNull(experiments.share_token)))
      .limit(1);

    if (!rows[0]) {
      return res.status(404).json({ error: "This shared experiment is not available." });
    }

    // A share link is a capability, not a public document: keep it out of
    // search indexes and shared caches.
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.json(toPublicExperiment(rows[0]));
  } catch (err) {
    req.log?.error({ err }, "Failed to load shared experiment");
    return res.status(500).json({ error: "Failed to load shared experiment" });
  }
});

export default router;
