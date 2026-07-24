import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiTrainingExamples, db } from "@workspace/db";
import { buildTrainingDataset, sanitizeAiText, trainingPolicyFromEnv } from "../lib/ai";
import { getRequestUserId } from "../lib/requestUser";
import { requireTrainingAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

const FeedbackSchema = z.object({
  request_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  corrected_output: z.string().trim().max(50_000).optional(),
  approved_for_training: z.boolean().default(false),
});

router.post("/ai/feedback", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const body = FeedbackSchema.parse(req.body);
    const submittedOutput = body.corrected_output?.trim() || null;
    const correctedOutput = submittedOutput
      ? sanitizeAiText(submittedOutput).trim() || null
      : null;
    if (body.approved_for_training && !correctedOutput) {
      res.status(400).json({ error: "Review or correct the output before approving it for training." });
      return;
    }

    const [existing] = await db.select({ model_output: aiTrainingExamples.model_output })
      .from(aiTrainingExamples)
      .where(and(
        eq(aiTrainingExamples.request_id, body.request_id),
        eq(aiTrainingExamples.user_id, userId),
      ))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "AI generation not found." });
      return;
    }
    if (body.approved_for_training && submittedOutput === existing.model_output.trim()) {
      res.status(400).json({ error: "Make at least one human correction before approving this example for training." });
      return;
    }

    const [updated] = await db.update(aiTrainingExamples).set({
      rating: body.rating,
      corrected_output: correctedOutput,
      approved_for_training: body.approved_for_training,
      provenance: correctedOutput ? "human_corrected" : "human_rated",
      updated_at: new Date(),
    }).where(and(
      eq(aiTrainingExamples.request_id, body.request_id),
      eq(aiTrainingExamples.user_id, userId),
    )).returning({ request_id: aiTrainingExamples.request_id });

    if (!updated) {
      res.status(404).json({ error: "AI generation not found." });
      return;
    }
    res.json({ ok: true, request_id: updated.request_id, approved_for_training: body.approved_for_training });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid feedback." });
      return;
    }
    req.log.error({ error }, "Failed to save AI feedback");
    res.status(500).json({ error: "Failed to save AI feedback." });
  }
});

router.get("/ai/training/status", requireTrainingAdmin, async (req, res) => {
  try {
    const rows = await db.select().from(aiTrainingExamples).orderBy(asc(aiTrainingExamples.created_at));
    res.json(buildTrainingDataset(rows, trainingPolicyFromEnv()).status);
  } catch (error) {
    req.log.error({ error }, "Failed to read AI training status");
    res.status(500).json({ error: "Failed to read AI training status." });
  }
});

router.get("/ai/training/export", requireTrainingAdmin, async (req, res) => {
  try {
    const rows = await db.select().from(aiTrainingExamples)
      .where(eq(aiTrainingExamples.approved_for_training, true))
      .orderBy(asc(aiTrainingExamples.created_at));
    const dataset = buildTrainingDataset(rows, trainingPolicyFromEnv());

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=biolab-ai-training.jsonl");
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Training-Examples", String(dataset.rows.length));
    res.setHeader("X-Training-Ready", String(dataset.status.ready_for_training));
    res.setHeader("X-Dataset-Schema-Version", String(dataset.status.dataset_schema_version));
    res.setHeader("X-Dataset-SHA256", dataset.status.dataset_sha256);
    res.send(dataset.lines.length ? `${dataset.lines.join("\n")}\n` : "");
  } catch (error) {
    req.log.error({ error }, "Failed to export AI training data");
    res.status(500).json({ error: "Failed to export AI training data." });
  }
});

export default router;
