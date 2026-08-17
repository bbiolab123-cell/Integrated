/**
 * seed-templates.ts
 *
 * Seeds the 5 core experiment templates into the database.
 * Run with:
 *   DATABASE_URL=<your_url> pnpm --filter @workspace/scripts run seed-templates
 *
 * Safe to run multiple times — checks for existing names and skips duplicates.
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { experimentTemplates } from "@workspace/db/schema";

const { Pool } = pg;

function info(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", component: "experiment-template-seed", message, ...fields }));
}

function errorDetails(err: unknown): Record<string, unknown> {
  return err instanceof Error
    ? { errorName: err.name, errorMessage: err.message, errorStack: err.stack }
    : { error: err };
}

function error(message: string, err?: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    level: "error",
    component: "experiment-template-seed",
    message,
    ...fields,
    ...(typeof err === "undefined" ? {} : errorDetails(err)),
  }));
}

if (!process.env.DATABASE_URL) {
  error(
    "Experiment template seeding cannot start because DATABASE_URL is missing; no templates were changed. Set DATABASE_URL to the intended database and rerun the seed command.",
    undefined,
    { database: "primary", exitCode: 1, retryExpected: false },
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: { experimentTemplates } });

// ─────────────────────────────────────────────────────────────
//  Template definitions
// ─────────────────────────────────────────────────────────────

const templates = [
  {
    name: "MTT Cell Viability",
    assay_type: "Cell Viability",
    instrument: "Synergy H1",
    description:
      "Measures metabolic activity as a proxy for cell viability. Formazan dye produced by living cells is read at 570 nm (reference 630 nm). Suitable for cytotoxicity studies and IC50 determination.",
    default_notes:
      "Seed cells at appropriate density 24 h before treatment. Include:\n" +
      "- Untreated control (100% viability) in columns 1–2\n" +
      "- Dead cell control (e.g. 1% Triton X-100) in columns 11–12\n" +
      "- 8-point compound dilution series (3-fold) in columns 3–10\n" +
      "Add MTT (5 mg/mL) for 4 h, then dissolve formazan in DMSO before reading.",
    expected_columns_json: JSON.stringify(["well", "absorbance_570", "absorbance_630", "corrected_od", "% viability"]),
    expected_control_rule: "Mean untreated ≥ 1.5 OD; CV% ≤ 15 for controls; Z' ≥ 0.5",
    expected_status_default: "designing",
    ai_prompt_hint:
      "This is an MTT cell viability assay. Calculate % viability relative to untreated controls. " +
      "Fit a 4-parameter logistic (4PL) curve to determine IC50 with 95% CI. " +
      "Calculate Z'-factor to report plate quality. " +
      "Flag wells with CV% > 20 as outliers. " +
      "Suggest follow-up dose range if the IC50 falls outside the tested range.",
  },
  {
    name: "ELISA (Sandwich)",
    assay_type: "ELISA",
    instrument: "Synergy H1",
    description:
      "Quantitative sandwich ELISA for protein detection in samples. Standard curve generated from known concentrations; sample concentrations interpolated from the curve.",
    default_notes:
      "Protocol checklist:\n" +
      "- Coat plate overnight at 4°C with capture antibody (2–4 μg/mL)\n" +
      "- Block 1 h at RT with 1% BSA / 5% non-fat milk\n" +
      "- Standard curve: 8 points (2-fold serial dilution) in columns 1–2\n" +
      "- Blank (diluent only): row H, columns 1–2\n" +
      "- Unknowns: columns 3–12 in duplicate\n" +
      "Read at 450 nm, reference at 570 nm. Subtract blank before curve fitting.",
    expected_columns_json: JSON.stringify(["well", "absorbance_450", "absorbance_570", "corrected_od", "concentration_pg_ml"]),
    expected_control_rule: "R² of standard curve ≥ 0.99; CV% between duplicates ≤ 10; blank ≤ 0.05 OD",
    expected_status_default: "designing",
    ai_prompt_hint:
      "This is a sandwich ELISA. Fit a 4PL standard curve to the known standards (subtract blank first). " +
      "Report R² and flag if < 0.99. Interpolate sample concentrations from the curve; " +
      "flag any samples outside the linear dynamic range (above top standard or below LLOQ). " +
      "Calculate CV% for duplicates. Identify outlier wells (CV% > 15). " +
      "Report mean ± SD for each sample group in the original unit of the standard.",
  },
  {
    name: "qPCR Gene Expression (ΔΔCt)",
    assay_type: "Gene Expression",
    instrument: "Bio-Rad CFX96",
    description:
      "Relative quantification of gene expression using the ΔΔCt method. Requires a reference (housekeeping) gene and a calibrator sample.",
    default_notes:
      "Setup:\n" +
      "- Reference gene: GAPDH or ACTB (confirm stable in your model)\n" +
      "- Calibrator: untreated / vehicle control sample\n" +
      "- Run in technical triplicates\n" +
      "- Include NTC (no template control) for each primer set\n" +
      "- Standard curve optional but recommended for primer efficiency\n" +
      "Export as .csv or .xlsx from CFX Maestro / QuantStudio Design & Analysis.",
    expected_columns_json: JSON.stringify(["well", "sample", "target", "Cq", "Cq_mean", "delta_Ct", "delta_delta_Ct", "fold_change"]),
    expected_control_rule: "NTC must have no amplification (Cq = 0 or undetermined); replicate SD ≤ 0.3 Cq; efficiency 90–110%",
    expected_status_default: "designing",
    ai_prompt_hint:
      "This is a qPCR gene expression experiment using ΔΔCt. " +
      "Calculate ΔCt = target Ct − reference Ct for each sample. " +
      "Calculate ΔΔCt = sample ΔCt − calibrator ΔCt. " +
      "Calculate fold change = 2^(-ΔΔCt) with ± SD propagated from technical replicates. " +
      "Flag any NTC with Ct < 35 as contamination. " +
      "Flag replicates with SD > 0.5 Ct as inconsistent. " +
      "Classify genes as upregulated (fold change > 2), downregulated (fold change < 0.5), or unchanged. " +
      "Suggest biological validation for any gene with > 4-fold change.",
  },
  {
    name: "Flow Cytometry — Apoptosis (Annexin V / PI)",
    assay_type: "Apoptosis",
    instrument: "BD LSRFortessa",
    description:
      "Quantifies early apoptosis (Annexin V+/PI−), late apoptosis/necrosis (Annexin V+/PI+), and live cells (Annexin V−/PI−) in treated and untreated populations.",
    default_notes:
      "Panel: Annexin V-FITC, Propidium Iodide (PI)\n" +
      "Gating strategy:\n" +
      "  1. Singlet gate on FSC-H vs FSC-A\n" +
      "  2. Live/dead: FSC/SSC to remove debris\n" +
      "  3. Q1: PI+ / Annexin V− = necrotic\n" +
      "  4. Q2: PI+ / Annexin V+ = late apoptosis\n" +
      "  5. Q3: PI− / Annexin V− = live\n" +
      "  6. Q4: PI− / Annexin V+ = early apoptosis\n" +
      "Include unstained, single-color controls for compensation.\n" +
      "Export .fcs files; analyze in FlowJo or equivalent.",
    expected_columns_json: JSON.stringify(["sample", "total_events", "%live", "%early_apoptosis", "%late_apoptosis", "%necrotic"]),
    expected_control_rule: "Untreated control: live ≥ 90%; Positive control (e.g. staurosporine): apoptosis > 30%",
    expected_status_default: "designing",
    ai_prompt_hint:
      "This is a flow cytometry apoptosis assay using Annexin V/PI staining. " +
      "Report % live, % early apoptosis (Annexin V+/PI−), % late apoptosis (Annexin V+/PI+), and % necrotic (Annexin V−/PI+) per sample. " +
      "Compare treated vs untreated controls. Flag if live cell % drops below 70% in untreated as potential assay quality issue. " +
      "Calculate absolute increase in apoptotic cells over untreated baseline. " +
      "Suggest whether the mechanism appears cytostatic vs cytotoxic based on the ratio of early to late apoptosis.",
  },
  {
    name: "Western Blot — Protein Expression",
    assay_type: "Protein Expression",
    instrument: "Bio-Rad ChemiDoc MP",
    description:
      "Semi-quantitative protein detection via SDS-PAGE and immunoblotting. Band intensities normalized to a loading control (β-actin, GAPDH, or total protein stain).",
    default_notes:
      "Protocol notes:\n" +
      "- Load equal protein (20–50 μg/lane) — confirm with BCA/Bradford assay first\n" +
      "- Include molecular weight ladder in lane 1\n" +
      "- Use positive control lysate for each new antibody\n" +
      "- Block 1 h in 5% milk/TBST; primary antibody overnight at 4°C\n" +
      "- Expose to film or imager; export as 16-bit TIFF\n" +
      "- Loading control: β-actin (42 kDa), GAPDH (37 kDa), or total protein (Stain-Free)\n" +
      "Upload image file — AI will estimate band intensities and normalization.",
    expected_columns_json: JSON.stringify(["lane", "sample", "target_intensity", "loading_control_intensity", "normalized_ratio", "fold_change_vs_ctrl"]),
    expected_control_rule: "Loading control CV% ≤ 15 across lanes; no band at target MW in negative control lane",
    expected_status_default: "designing",
    ai_prompt_hint:
      "This is a western blot protein expression experiment. " +
      "Estimate relative band intensities from the image. Normalize each target band to the loading control in the same lane. " +
      "Calculate fold change relative to the untreated/vehicle control lane. " +
      "Flag lanes where loading control CV% > 20 as unequal loading. " +
      "Note any non-specific bands near the target MW. " +
      "Suggest whether a change is biologically meaningful based on the fold change magnitude (threshold: > 1.5x). " +
      "Recommend orthogonal validation if fold change > 3x.",
  },
];

// ─────────────────────────────────────────────────────────────
//  Seed logic
// ─────────────────────────────────────────────────────────────

async function main() {
  info(
    "Experiment template seeding started; existing templates will be preserved and only missing names will be inserted.",
    { database: "primary", plannedTemplateCount: templates.length },
  );

  let inserted = 0;
  let skipped = 0;

  for (const template of templates) {
    // Check if already exists by name
    const existing = await db
      .select({ id: experimentTemplates.id })
      .from(experimentTemplates)
      .where(eq(experimentTemplates.name, template.name))
      .limit(1);

    if (existing.length > 0) {
      info(
        "An experiment template was skipped because a template with the same name already exists; this is normal for an idempotent seed and no action is required.",
        { templateName: template.name, seedSkipped: true },
      );
      skipped++;
      continue;
    }

    await db.insert(experimentTemplates).values(template);
    info(
      "An experiment template was inserted successfully; no operator action is required.",
      { templateName: template.name },
    );
    inserted++;
  }

  info(
    "Experiment template seeding completed successfully; skipped templates were already present and were left unchanged.",
    { insertedCount: inserted, skippedCount: skipped, totalTemplateCount: templates.length },
  );
  await pool.end();
}

main().catch((err) => {
  error(
    "Experiment template seeding stopped before completion; templates inserted before the failure may remain, and rerunning is safe because existing names are skipped. Check database connectivity, schema, and write permissions before retrying.",
    err,
    { database: "primary", exitCode: 1, retryExpected: true },
  );
  pool.end().finally(() => process.exit(1));
});
