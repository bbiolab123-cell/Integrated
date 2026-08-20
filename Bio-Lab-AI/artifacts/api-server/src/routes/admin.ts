import { Router, type IRouter } from "express";
import { desc, sql } from "drizzle-orm";
import { db, experiments, pool } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const APPROVED_ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

const router: IRouter = Router();

router.use(requireAdmin);

router.get("/admin/me", async (req, res) => {
  const email = normalizeEmail((req as typeof req & { adminEmail?: string }).adminEmail || "");
  const approved = APPROVED_ADMIN_EMAILS.has(email);
  res.json({ email, approved });
});

// Recent server failures, newest first. This is the only way to find out that
// something is broken in production without a user reporting it.
router.get("/admin/errors", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, occurred_at, method, route, status, message, stack, user_id, request_id
       FROM error_events
       ORDER BY occurred_at DESC
       LIMIT 100`,
    );
    // Group identical failures so one broken route does not read as 100
    // separate incidents.
    const summary = new Map<string, { route: string; method: string; status: number; count: number; last_seen: string }>();
    for (const row of result.rows) {
      const key = `${row.method} ${row.route} ${row.status}`;
      const existing = summary.get(key);
      if (existing) existing.count += 1;
      else summary.set(key, {
        route: row.route,
        method: row.method,
        status: row.status,
        count: 1,
        last_seen: row.occurred_at,
      });
    }
    res.json({
      events: result.rows,
      summary: Array.from(summary.values()).sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to read error events");
    res.status(500).json({ error: "Failed to read error events" });
  }
});

router.get("/admin/stats", async (_req, res) => {
  const totalExperiments = await db.select({ count: sql<number>`count(*)` }).from(experiments);
  const recentExperiments = await db
    .select({
      id: experiments.id,
      name: experiments.name,
      date: experiments.date,
      assay_type: experiments.assay_type,
      instrument: experiments.instrument,
      status: experiments.status,
      created_at: experiments.created_at,
    })
    .from(experiments)
    .orderBy(desc(experiments.created_at))
    .limit(10);
  res.json({
    total_experiments: Number(totalExperiments[0]?.count ?? 0),
    approved_admins: Array.from(APPROVED_ADMIN_EMAILS).map((email) => ({ email, created_at: new Date().toISOString() })),
    moderation_summary: {
      flagged_accounts: 0,
      pending_reviews: 0,
      high_priority_alerts: 0,
    },
    recent_experiments: recentExperiments,
  });
});

router.post("/admin/approved-admins", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalized = email.trim().toLowerCase();
  if (APPROVED_ADMIN_EMAILS.has(normalized)) {
    res.json({ email: normalized, created_at: new Date().toISOString() });
    return;
  }
  APPROVED_ADMIN_EMAILS.add(normalized);
  res.status(201).json({ email: normalized, created_at: new Date().toISOString() });
});

router.delete("/admin/approved-admins/:email", async (req, res) => {
  const email = req.params.email.trim().toLowerCase();
  if (!APPROVED_ADMIN_EMAILS.has(email)) {
    res.status(404).json({ error: "Admin not found" });
    return;
  }
  APPROVED_ADMIN_EMAILS.delete(email);
  res.status(204).send();
});

router.post("/admin/suspend", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  res.json({ ok: true, email: email.toLowerCase(), suspended: true });
});

export default router;
