import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiTrainingExamples, db } from "@workspace/db";
import { AI_TASK_TYPES } from "../lib/ai";
import { getRequestUserId } from "../lib/requestUser";
import { requireTrainingAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

const FeedbackSchema = z.object({
  request_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  corrected_output: z.string().trim().max(50_000).optional(),
  approved_for_training: z.boolean().default(false),
});

function splitFor(example: typeof aiTrainingExamples.$inferSelect): "train" | "validation" | "test" {
  const group = example.project_id != null
    ? `project:${example.project_id}`
    : example.experiment_id != null
      ? `experiment:${example.experiment_id}`
      : `request:${example.request_id}`;
  const bucket = Number.parseInt(createHash("sha256").update(group).digest("hex").slice(0, 8), 16) % 10;
  if (bucket === 0) return "test";
  if (bucket === 1) return "validation";
  return "train";
}

function trainingStatus(rows: Array<typeof aiTrainingExamples.$inferSelect>) {
  const approved = rows.filter((row) => row.approved_for_training && row.corrected_output?.trim());
  const coverage = Object.fromEntries(AI_TASK_TYPES.map((task) => [task, 0])) as Record<string, number>;
  for (const row of approved) coverage[row.task_type] = (coverage[row.task_type] ?? 0) + 1;
  const missing_tasks = AI_TASK_TYPES.filter((task) => !coverage[task]);
  const split_counts = { train: 0, validation: 0, test: 0 };
  for (const row of approved) split_counts[splitFor(row)] += 1;
  const missing_splits = (Object.entries(split_counts) as Array<[keyof typeof split_counts, number]>)
    .filter(([, count]) => count === 0)
    .map(([split]) => split);
  return {
    total_generations: rows.length,
    approved_examples: approved.length,
    minimum_examples: 200,
    coverage,
    missing_tasks,
    split_counts,
    missing_splits,
    ready_for_training: approved.length >= 200 && missing_tasks.length === 0 && missing_splits.length === 0,
  };
}

router.post("/ai/feedback", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const body = FeedbackSchema.parse(req.body);
    const correctedOutput = body.corrected_output?.trim() || null;
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
    if (body.approved_for_training && correctedOutput === existing.model_output.trim()) {
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
    res.json(trainingStatus(rows));
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
    const validRows = rows.filter((row) => row.corrected_output?.trim());
    const status = trainingStatus(rows);
    const lines = validRows.map((row) => {
      let inputMessages: unknown = [];
      try { inputMessages = JSON.parse(row.input_json); } catch { /* filtered below */ }
      const messages = Array.isArray(inputMessages)
        ? inputMessages.filter((message) => message && typeof message === "object")
        : [];
      return JSON.stringify({
        task_type: row.task_type,
        split: splitFor(row),
        schema_version: row.schema_version,
        provenance: row.provenance,
        messages: [
          ...messages,
          { role: "assistant", content: row.corrected_output },
        ],
      });
    });

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=biolab-ai-training.jsonl");
    res.setHeader("X-Training-Examples", String(validRows.length));
    res.setHeader("X-Training-Ready", String(status.ready_for_training));
    res.send(lines.length ? `${lines.join("\n")}\n` : "");
  } catch (error) {
    req.log.error({ error }, "Failed to export AI training data");
    res.status(500).json({ error: "Failed to export AI training data." });
  }
});

export default router;
