import { db, experiments } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const SEED_EXPERIMENTS = [
  {
    name: "MTT Viability Assay - Run 1",
    date: "2026-01-10",
    assay_type: "Cell Viability",
    instrument: "SpectraMax M5 Plate Reader",
    status: "failed",
    notes: `Conditions: HeLa cells, 10% FBS, 50uM Compound X, 72hr incubation.
Results: Cell viability 12% vs 85% control. Mass cell death observed.
Notes: Possible media contamination. pH looked off. Recommend checking media prep and compound stock concentration before next run.`,
  },
  {
    name: "MTT Viability Assay - Run 2",
    date: "2026-01-18",
    assay_type: "Cell Viability",
    instrument: "SpectraMax M5 Plate Reader",
    status: "success",
    notes: `Conditions: HeLa cells, 10% FBS, 25uM Compound X, 48hr incubation. Fresh media batch.
Results: Cell viability 78% vs 85% control.
Notes: Reduced dose and time improved results significantly. Fresh media resolved contamination concern.`,
  },
  {
    name: "ELISA Cytokine Panel - Batch 1",
    date: "2026-02-03",
    assay_type: "ELISA",
    instrument: "BioTek Synergy H1",
    status: "failed",
    notes: `Conditions: IL-6 and TNF-a detection, patient serum samples, standard protocol.
Results: High background noise, inconsistent duplicates. OD values unreliable across all wells.
Notes: Suspect antibody degradation. Antibody stored at wrong temperature over weekend. CV exceeded 25% across duplicates.`,
  },
  {
    name: "ELISA Cytokine Panel - Batch 2",
    date: "2026-02-14",
    assay_type: "ELISA",
    instrument: "BioTek Synergy H1",
    status: "success",
    notes: `Conditions: IL-6 and TNF-a detection, fresh antibody lot, 4 degree storage confirmed throughout.
Results: Clean signal, CV below 10% across all duplicates. IL-6 range 12-340 pg/mL, TNF-a range 8-210 pg/mL.
Notes: New antibody lot resolved the inconsistency issue. Storage protocol updated for all future ELISA reagents.`,
  },
  {
    name: "CRISPR KO Efficiency - TP53",
    date: "2026-03-01",
    assay_type: "CRISPR Genome Editing",
    instrument: "Bio-Rad CFX96 qPCR",
    status: "in_progress",
    notes: `Conditions: HEK293T cells, Cas9 + sgRNA targeting TP53 exon 4, lipofection transfection.
Results: Western blot pending. PCR shows 60% indel frequency by T7E1 assay. Sanger sequencing confirms edits at target locus.
Notes: Awaiting protein-level confirmation by Western blot. Results look promising so far. Cell viability post-transfection was 85%.`,
  },
];

// Seed data is demo-only and owned by a synthetic system user.
const SEED_USER_ID = "system_seed";

export async function seedIfEmpty(): Promise<void> {
  try {
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(experiments);

    const total = Number(count[0]?.count ?? 0);
    if (total > 0) {
      logger.info(
        { database: "primary", existingExperimentCount: total, seedSkipped: true },
        "Initial demo experiment seeding was skipped because the database already contains experiments; this is normal and existing data was left unchanged.",
      );
      return;
    }

    logger.info(
      { database: "primary", plannedInsertCount: SEED_EXPERIMENTS.length },
      "No experiments exist, so the optional initial demo dataset is being inserted. No operator action is required unless this is not a demo environment.",
    );

    for (const exp of SEED_EXPERIMENTS) {
      await db.insert(experiments).values({ ...exp, user_id: SEED_USER_ID });
    }

    logger.info(
      { database: "primary", insertedCount: SEED_EXPERIMENTS.length },
      "Initial demo experiment seeding completed successfully; the inserted records are available to the shared synthetic seed user.",
    );
  } catch (err) {
    logger.error(
      { err, database: "primary", attemptedInsertCount: SEED_EXPERIMENTS.length, retryExpected: true },
      "Initial demo experiment seeding did not complete; the API remains available, but demo records may be absent or partial. Check database connectivity and write permissions before rerunning the idempotent seed task.",
    );
  }
}
