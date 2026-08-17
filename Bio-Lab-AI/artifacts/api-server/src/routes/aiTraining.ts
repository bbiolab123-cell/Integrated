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
      req.log.warn(
        { aiRequestId: body.request_id, approvalRequested: true, rejectionReason: "missing_human_correction", statusCode: 400, retryExpected: false },
        "AI feedback approval was rejected because no usable human correction was supplied; this is an expected data-quality safeguard and the generation record was not approved. Submit a reviewed correction before retrying.",
      );
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
      req.log.warn(
        { aiRequestId: body.request_id, database: "primary", statusCode: 404, retryExpected: false },
        "AI feedback was not saved because the referenced generation does not exist for this user; this is normally a stale or foreign request ID. Refresh the generation state and submit feedback only for an owned request.",
      );
      res.status(404).json({ error: "AI generation not found." });
      return;
    }
    if (body.approved_for_training && submittedOutput === existing.model_output.trim()) {
      req.log.warn(
        { aiRequestId: body.request_id, approvalRequested: true, rejectionReason: "unedited_model_output", statusCode: 400, retryExpected: false },
        "AI feedback approval was rejected because the submitted text is unchanged from the model output; this is an expected training-quality safeguard. Make a genuine human correction before approving the example.",
      );
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
      req.log.warn(
        { aiRequestId: body.request_id, database: "primary", statusCode: 404, retryExpected: false },
        "AI feedback was not saved because the generation disappeared or was not owned when the update ran; no training approval changed. Refresh the generation state before trying again.",
      );
      res.status(404).json({ error: "AI generation not found." });
      return;
    }
    res.json({ ok: true, request_id: updated.request_id, approved_for_training: body.approved_for_training });
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { validationIssueCount: error.issues.length, statusCode: 400, retryExpected: false },
        "AI feedback was rejected because the request body did not match the feedback contract; this is a client-input problem and no training record changed. Correct the request ID, rating, correction, or approval fields before retrying.",
      );
      res.status(400).json({ error: "Invalid feedback." });
      return;
    }
    req.log.error(
      { err: error, database: "primary", statusCode: 500, retryExpected: true },
      "AI feedback could not be stored, so the referenced generation's rating and training approval remain unchanged. Check database connectivity and the ai_training_examples table before retrying.",
    );
    res.status(500).json({ error: "Failed to save AI feedback." });
  }
});

router.get("/ai/training/status", requireTrainingAdmin, async (req, res) => {
  try {
    const rows = await db.select().from(aiTrainingExamples).orderBy(asc(aiTrainingExamples.created_at));
    res.json(buildTrainingDataset(rows, trainingPolicyFromEnv()).status);
  } catch (error) {
    req.log.error(
      { err: error, database: "primary", statusCode: 500, retryExpected: true },
      "AI training readiness status could not be calculated because generation records were unavailable or invalid to process. Check database connectivity and the ai_training_examples schema before retrying.",
    );
    res.status(500).json({ error: "Failed to read AI training status." });
  }
});

router.get("/ai/training/export", requireTrainingAdmin, async (req, res) => {
  try {
    const rows = await db.select().from(aiTrainingExamples)
      .where(eq(aiTrainingExamples.approved_for_training, true))
      .orderBy(asc(aiTrainingExamples.created_at));
    const dataset = buildTrainingDataset(rows, trainingPolicyFromEnv());
    if (!dataset.status.ready_for_training) {
      req.log.warn(
        {
          approvedSubmissions: dataset.status.approved_submissions,
          exportedExamples: dataset.status.approved_examples,
          excludedExamples: dataset.status.excluded_examples,
          missingTasks: dataset.status.missing_tasks,
          missingSplits: dataset.status.missing_splits,
          invalidReasonCounts: dataset.status.invalid_reason_counts,
          retryExpected: false,
        },
        "The AI training export was generated, but the dataset does not satisfy release-readiness gates; the file is suitable for review, not production training. Add or correct the missing coverage and excluded examples, then check training status again.",
      );
    }

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
    req.log.error(
      { err: error, database: "primary", statusCode: 500, retryExpected: true },
      "The AI training dataset could not be built or returned, so no trustworthy export was produced. Check database connectivity, training policy configuration, and stored example integrity before retrying.",
    );
    res.status(500).json({ error: "Failed to export AI training data." });
  }
});

export default router;
