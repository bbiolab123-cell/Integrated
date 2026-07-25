import { eq, and, desc } from "drizzle-orm";
import { db, projects, experiments, projectDocuments } from "@workspace/db";
import { generateContentWithRetry } from "./aiRetry";
import { logger } from "./logger";

interface ExperimentComparisonRow {
  name: string;
  date: string;
  assay_type: string;
  status: string;
  mean: number | null;
  sd: number | null;
  cv_pct: number | null;
  well_count: number | null;
}

// Real, deterministically-computed per-experiment stats — pulled straight from
// the plate stats saved at upload time (parseSynergyH1Rows), never invented.
// This is what lets the synthesis prompt below reference actual numbers instead
// of asking the AI to guess at trends across runs.
function buildComparisonRow(exp: { name: string; date: string; assay_type: string; status: string; raw_data_json: string | null }): ExperimentComparisonRow {
  let mean: number | null = null;
  let sd: number | null = null;
  let cv_pct: number | null = null;
  let well_count: number | null = null;
  if (exp.raw_data_json) {
    try {
      const parsed = JSON.parse(exp.raw_data_json) as Record<string, unknown>;
      if (parsed._type === "plate96" && parsed.stats && typeof parsed.stats === "object") {
        const stats = parsed.stats as Record<string, unknown>;
        mean = typeof stats.mean === "number" ? stats.mean : null;
        sd = typeof stats.sd === "number" ? stats.sd : null;
        cv_pct = typeof stats.cv_pct === "number" ? stats.cv_pct : null;
        well_count = typeof stats.well_count === "number" ? stats.well_count : null;
      }
    } catch {
      // raw_data_json is malformed or not plate96 — leave stats null, not fabricated.
    }
  }
  return { name: exp.name, date: exp.date, assay_type: exp.assay_type, status: exp.status, mean, sd, cv_pct, well_count };
}

function comparisonTable(rows: ExperimentComparisonRow[]): string {
  if (!rows.length) return "(no experiments)";
  const header = "name | date | assay_type | status | mean | sd | cv_pct | well_count";
  const lines = rows.map((r) =>
    `${r.name} | ${r.date} | ${r.assay_type} | ${r.status} | ${r.mean ?? "n/a"} | ${r.sd ?? "n/a"} | ${r.cv_pct ?? "n/a"} | ${r.well_count ?? "n/a"}`,
  );
  return [header, ...lines].join("\n");
}

// Re-synthesizes projects.ai_summary from the project's goal, every linked
// experiment's real computed stats + AI summary, and attached context docs.
// Used both by the manual "Bioalyze project" button and by the auto-trigger
// fired when an experiment in this project gets new data or an analysis report.
export async function synthesizeProject(projectId: number, userId: string): Promise<{ ai_summary: string } | { error: string; status: number }> {
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
  let docsBudget = 40000;
  const docsBlock = docs.length
    ? "\n\nCONTEXT DOCUMENTS:\n" + docs.map((d) => {
        const slice = d.content.slice(0, Math.max(0, docsBudget));
        docsBudget -= slice.length;
        return `[${d.name}]\n${slice}`;
      }).join("\n\n")
    : "";

  const expBlock = projExperiments
    .map((e, i) => `Experiment ${i + 1}: ${e.name} (${e.date}, ${e.status})\n  notes: ${e.notes ?? "none"}\n  result: ${e.ai_summary ?? "not analyzed"}`)
    .join("\n\n");

  const comparisonRows = projExperiments.map((e) => buildComparisonRow(e));
  const comparisonBlock = `\n\nREAL COMPUTED STATS PER EXPERIMENT (from the plate reader — use these numbers directly if you reference a trend; never invent a number that isn't in this table or the experiment results above):\n${comparisonTable(comparisonRows)}`;

  const systemInstruction = `You are a research strategist reviewing an entire project for a bench scientist. Synthesize ACROSS the experiments — don't summarize them one by one. Identify what has been established, patterns and contradictions between runs, what's still unresolved, and the 2-3 highest-value next experiments to advance the project's goal. Be specific and reference experiments by name. If you cite a number (a mean, an SD, a trend), it must come from the computed stats table or the experiment results provided — never estimate or invent one. Write concise markdown with short bold section headers.`;

  const userPrompt = `PROJECT: ${proj.name}\nGOAL: ${proj.goal ?? "(not specified)"}\n\nEXPERIMENTS:\n${expBlock}${comparisonBlock}${docsBlock}\n\nWrite the "state of the project" synthesis now.`;

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: { systemInstruction, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
  });

  const summary = (response.text ?? "").trim();
  if (!summary) return { error: "The AI returned an empty synthesis (it may be rate-limited). Please try again.", status: 502 };

  await db.update(projects).set({ ai_summary: summary, ai_summary_generated_at: new Date(), updated_at: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  return { ai_summary: summary };
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
