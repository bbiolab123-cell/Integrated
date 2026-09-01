import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, experiments } from "@workspace/db";
import { logger } from "./logger";
import { parseDelimitedRows, parsePlateRows } from "./plateImport";
import { isDemoMode } from "./runtimeConfig";

const DEMO_USER_ID = "demo_user";
const DEMO_FILE_NAME = "demo-dose-response-plate.csv";
const DEMO_EXPERIMENT_NAME = "Demo · Compound-X viability plate";

const DEMO_CONTROL_SUMMARY = {
  positive_control_wells: ["A1", "A2", "B1", "B2"],
  negative_control_wells: ["A11", "A12", "B11", "B12"],
  blank_wells: ["H11", "H12"],
  sample_wells: [],
  mean_positive: 0.994,
  mean_negative: 0.061,
  zprime: 0.966,
  signal_to_background: 16.366,
};

/**
 * Create one immediately useful experiment for explicit local demo mode.
 * The same CSV stays in examples/ so the demo never depends on a physical
 * Synergy H1 or on opaque data generated only inside the database.
 */
export async function seedIfEmpty(): Promise<void> {
  if (!isDemoMode) return;
  try {
    const existing = await db.select({ id: experiments.id })
      .from(experiments)
      .where(and(eq(experiments.user_id, DEMO_USER_ID), eq(experiments.file_name, DEMO_FILE_NAME)))
      .limit(1);
    if (existing[0]) {
      logger.info(
        { demoExperimentId: existing[0].id, seedSkipped: true },
        "The local demo plate already exists, so demo seeding was skipped and the existing record was preserved.",
      );
      return;
    }

    const samplePath = resolve(process.cwd(), "examples", DEMO_FILE_NAME);
    const content = await readFile(samplePath, "utf-8");
    const parsed = parsePlateRows(parseDelimitedRows(content, DEMO_FILE_NAME), DEMO_FILE_NAME);
    if (!parsed || parsed.stats.well_count !== 96) {
      throw new Error("Bundled demo plate did not parse as a complete 96-well plate.");
    }

    const [inserted] = await db.insert(experiments).values({
      user_id: DEMO_USER_ID,
      name: DEMO_EXPERIMENT_NAME,
      date: "2026-08-15",
      assay_type: "Cell viability dose response",
      instrument: parsed.metadata.instrument ?? "Plate reader",
      status: "success",
      notes: "Bundled demo: a complete 96-well viability plate with positive, negative, and blank controls. Explore the heatmap, Z′, CV%, and dose-response tools without connecting an instrument.",
      file_name: DEMO_FILE_NAME,
      raw_data_json: JSON.stringify({ ...parsed, _type: "plate96" }),
      control_summary_json: JSON.stringify(DEMO_CONTROL_SUMMARY),
    }).returning({ id: experiments.id });

    logger.info(
      { demoExperimentId: inserted?.id, fileName: DEMO_FILE_NAME },
      "The bundled sample plate was inserted for the explicit local demo account and is ready for deterministic analysis.",
    );
  } catch (error) {
    logger.error(
      { err: error, demoUserId: DEMO_USER_ID, fileName: DEMO_FILE_NAME, retryExpected: false },
      "The local demo sample plate could not be seeded; the API remains available, but the no-instrument demo will be empty. Verify that examples/demo-dose-response-plate.csv is included in the deployment.",
    );
  }
}
