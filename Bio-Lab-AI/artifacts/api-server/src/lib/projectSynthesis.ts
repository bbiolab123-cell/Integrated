import { eq, and, desc } from "drizzle-orm";
import { db, projects, experiments, projectDocuments } from "@workspace/db";
import { buildRelatedExperimentContext, generateAiText, numericAuditNotice } from "./ai";
import { logger } from "./logger";

// Re-synthesizes projects.ai_summary from the project's goal, every linked
// experiment's real computed stats (buildRelatedExperimentContext's
// includeData already carries each experiment's plate stats — mean/SD/CV%/well
// count — straight from what was computed at upload time) + AI summary, and
// attached context docs. Used both by the manual "Bioalyze project" button and
// by the auto-trigger fired when an experiment in this project gets new data
// or an analysis report.
export async function synthesizeProject(
  projectId: number,
  userId: string,
): Promise<{ ai_summary: string; request_id: string } | { error: string; status: number }> {
  const projRows = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1);
  const proj = projRows[0];
  if (!proj) return { error: "Project not found", status: 404 };

  const projExperiments = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.project_id, projectId), eq(experiments.user_id, userId)))
    .orderBy(desc(experiments.date));
  if (projExperiments.length === 0) {
    return { error: "Add experiments to this project before synthesizing.", status: 400 };
  }

  const docs = await db
    .select({ name: projectDocuments.name, content: projectDocuments.content })
    .from(projectDocuments)
    .where(and(eq(projectDocuments.project_id, projectId), eq(projectDocuments.user_id, userId)));
  let docsBudget = 8_000;
  const docsBlock = docs.length
    ? "\n\nCONTEXT DOCUMENTS:\n" + docs.map((d) => {
        const slice = d.content.slice(0, Math.max(0, docsBudget));
        docsBudget -= slice.length;
        return `[${d.name}]\n${slice}`;
      }).join("\n\n")
    : "";

  const sensitiveTerms = [proj.name, ...projExperiments.map((experiment) => experiment.name), ...docs.map((doc) => doc.name)];
  const expBlock = buildRelatedExperimentContext(projExperiments, sensitiveTerms, { includeData: true });

  const systemInstruction = `You are a research strategist reviewing an entire project for a bench scientist. Synthesize ACROSS the experiments — don't summarize them one by one. Identify what has been established, patterns and contradictions between runs, what's still unresolved, and the 2-3 highest-value next experiments to advance the project's goal. Be specific and reference experiments by experiment_ref. Write concise markdown with short bold section headers.`;

  const userPrompt = `PROJECT REF: current-project\nGOAL: ${proj.goal ?? "(not specified)"}\n\nEXPERIMENTS:\n${expBlock}${docsBlock}\n\nWrite the "state of the project" synthesis now.`;

  const response = await generateAiText({
    taskType: "project_synthesis",
    userId,
    projectId,
    systemInstruction,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 4096,
    sensitiveTerms,
  });

  let summary = response.text.trim();
  if (!summary) return { error: "The AI returned an empty synthesis (it may be rate-limited). Please try again.", status: 502 };
  const auditNotice = numericAuditNotice(summary, `${systemInstruction}\n${userPrompt}`);
  if (auditNotice) summary += `\n\n> **Numeric verification notice:** ${auditNotice}`;

  await db.update(projects).set({
    ai_summary: summary,
    ai_summary_request_id: response.requestId,
    ai_summary_generated_at: new Date(),
    updated_at: new Date(),
  }).where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  return { ai_summary: summary, request_id: response.requestId };
}

// Fire-and-forget re-synthesis after an experiment's data/analysis changes.
// Never awaited by the caller — a slow or failed synthesis must not delay or
// break the data-upload/analysis response it was triggered from.
export function triggerProjectSynthesis(projectId: number | null, userId: string): void {
  if (!projectId) return;
  synthesizeProject(projectId, userId).catch((err) => {
    logger.warn({ err, projectId }, "Auto project synthesis failed");
  });
}
