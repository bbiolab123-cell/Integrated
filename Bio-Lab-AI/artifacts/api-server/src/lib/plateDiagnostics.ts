// Deterministic detection of the spatial artifacts that ruin plate assays.
//
// The assay knowledge base tells the analyzer to "check for edge effects" and
// row/column bias, but nothing ever computed them — the model was handed a grid
// of numbers and asked to eyeball a pattern. That is exactly the kind of claim
// an LLM will produce confidently and wrongly. These functions measure the
// artifacts instead, so the AI reasons from evidence and the scientist gets a
// number they can check.
//
// Pure functions, no database and no model calls, so they are cheap to test.

export interface DiagnosticWell {
  well: string;               // "A1"
  row: string;                // "A".."H"
  col: number;                // 1..12
  value: number | null;
  status?: string;
}

/** Role assignments from the plate layout, when the scientist has marked them. */
export type DiagnosticRoles = Record<string, string>;

export interface EdgeEffect {
  edgeMean: number;
  interiorMean: number;
  /** Edge relative to interior, as a percentage. Positive = edge reads higher. */
  percentDifference: number;
  /** Standardised effect size (Cohen's d) against the pooled SD. */
  effectSize: number;
  nEdge: number;
  nInterior: number;
  /** True when the difference is large enough to act on. */
  flagged: boolean;
}

export interface AxisBias {
  /** "A".."H" for rows, "1".."12" for columns. */
  label: string;
  mean: number;
  n: number;
  /** Robust z-score against the median of all lane means (MAD-scaled). */
  robustZ: number;
}

export interface PlateDiagnostics {
  edgeEffect: EdgeEffect | null;
  /** Rows whose mean is a robust outlier against the other rows. */
  rowOutliers: AxisBias[];
  /** Columns whose mean is a robust outlier against the other columns. */
  columnOutliers: AxisBias[];
  /** How many wells the analysis was based on, after excluding controls. */
  analysedWellCount: number;
  /** True when controls/blanks were excluded using a marked plate layout. */
  usedPlateLayout: boolean;
}

// A large standardised difference. 0.8 is the conventional "large effect"
// threshold, and pairs with the percentage gate below so a tight plate with a
// trivial absolute difference does not get flagged on precision alone.
const EDGE_EFFECT_SIZE_GATE = 0.8;
const EDGE_PERCENT_GATE = 10;

// Standard MAD-outlier cutoff. Deliberately strict: a false "column 6 is
// biased" sends a scientist chasing a pipetting fault that never happened.
const ROBUST_Z_GATE = 3.5;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Sample variance (n-1), matching the convention used everywhere else. */
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

/**
 * Wells that carry a real reading and belong in a uniformity analysis.
 *
 * Controls are *supposed* to differ from samples, so leaving them in would
 * manufacture bias: a positive-control column reads high by design and would be
 * reported as a pipetting artifact. When the scientist has marked a layout we
 * analyse samples only; with no layout we use every well that was read.
 */
function analysableWells(
  wells: DiagnosticWell[],
  roles?: DiagnosticRoles,
): { wells: (DiagnosticWell & { value: number })[]; usedPlateLayout: boolean } {
  const read = wells.filter(
    (w): w is DiagnosticWell & { value: number } =>
      w.value !== null && Number.isFinite(w.value),
  );
  const marked = roles && Object.keys(roles).length > 0;
  if (!marked) return { wells: read, usedPlateLayout: false };

  const samples = read.filter((w) => {
    const role = roles![w.well];
    return role === undefined || role === "sample";
  });
  // A layout that marks everything as a control leaves nothing to analyse; fall
  // back to the whole plate rather than reporting a confident empty result.
  if (samples.length < 8) return { wells: read, usedPlateLayout: false };
  return { wells: samples, usedPlateLayout: true };
}

function isPerimeter(w: DiagnosticWell): boolean {
  return w.row === "A" || w.row === "H" || w.col === 1 || w.col === 12;
}

/**
 * Compare the plate's perimeter against its interior.
 *
 * Edge wells evaporate faster and sit at a different temperature, which is the
 * single most common systematic artifact in plate assays.
 */
export function detectEdgeEffect(
  wells: DiagnosticWell[],
  roles?: DiagnosticRoles,
): EdgeEffect | null {
  const { wells: usable } = analysableWells(wells, roles);
  const edge = usable.filter(isPerimeter).map((w) => w.value);
  const interior = usable.filter((w) => !isPerimeter(w)).map((w) => w.value);
  // Two wells on a side is not a measurement.
  if (edge.length < 3 || interior.length < 3) return null;

  const edgeMean = mean(edge);
  const interiorMean = mean(interior);

  // Pooled SD across the two groups.
  const pooledVar =
    ((edge.length - 1) * variance(edge) + (interior.length - 1) * variance(interior)) /
    (edge.length + interior.length - 2);
  const pooledSd = Math.sqrt(pooledVar);

  const effectSize = pooledSd > 0 ? (edgeMean - interiorMean) / pooledSd : 0;
  const percentDifference =
    interiorMean !== 0 ? ((edgeMean - interiorMean) / Math.abs(interiorMean)) * 100 : 0;

  return {
    edgeMean,
    interiorMean,
    percentDifference,
    effectSize,
    nEdge: edge.length,
    nInterior: interior.length,
    flagged:
      Math.abs(effectSize) >= EDGE_EFFECT_SIZE_GATE &&
      Math.abs(percentDifference) >= EDGE_PERCENT_GATE,
  };
}

/**
 * Lanes (rows or columns) whose mean is a robust outlier against the others.
 *
 * Uses the median and MAD rather than mean and SD: with only 8 rows, one badly
 * pipetted row drags the mean and inflates the SD enough to hide itself.
 */
function detectAxisBias(
  wells: (DiagnosticWell & { value: number })[],
  keyOf: (w: DiagnosticWell) => string,
  order: string[],
): AxisBias[] {
  const lanes = new Map<string, number[]>();
  for (const w of wells) {
    const key = keyOf(w);
    const bucket = lanes.get(key);
    if (bucket) bucket.push(w.value);
    else lanes.set(key, [w.value]);
  }

  const summaries = order
    .filter((label) => (lanes.get(label)?.length ?? 0) >= 3)
    .map((label) => {
      const values = lanes.get(label)!;
      return { label, mean: mean(values), n: values.length };
    });
  // Robust statistics need something to be robust against.
  if (summaries.length < 4) return [];

  const means = summaries.map((s) => s.mean);
  const med = median(means);
  const mad = median(means.map((m) => Math.abs(m - med)));
  // 0.6745 scales the MAD to a standard-deviation equivalent for normal data.
  const scale = mad * 1.4826;
  if (!(scale > 0)) return [];

  return summaries
    .map((s) => ({ ...s, robustZ: (s.mean - med) / scale }))
    .filter((s) => Math.abs(s.robustZ) >= ROBUST_Z_GATE);
}

const ROW_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H"];
const COL_ORDER = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

/** Run every spatial check over a plate. */
export function diagnosePlate(
  wells: DiagnosticWell[],
  roles?: DiagnosticRoles,
): PlateDiagnostics {
  const { wells: usable, usedPlateLayout } = analysableWells(wells, roles);
  return {
    edgeEffect: detectEdgeEffect(wells, roles),
    rowOutliers: detectAxisBias(usable, (w) => w.row, ROW_ORDER),
    columnOutliers: detectAxisBias(usable, (w) => String(w.col), COL_ORDER),
    analysedWellCount: usable.length,
    usedPlateLayout,
  };
}

/**
 * Render the findings for the model's context.
 *
 * Deliberately states the negative case too: without it the analyzer treats
 * "no edge-effect line" as "nobody checked" and hedges about it anyway.
 */
export function describeDiagnostics(d: PlateDiagnostics): string {
  if (d.analysedWellCount === 0) return "No wells with readings were available for spatial checks.";

  const lines: string[] = [];
  const basis = d.usedPlateLayout
    ? `${d.analysedWellCount} sample wells (controls and blanks excluded via the marked plate layout)`
    : `${d.analysedWellCount} wells (no plate layout marked, so every read well was included)`;
  lines.push(`Spatial checks computed from ${basis}:`);

  if (!d.edgeEffect) {
    lines.push("- Edge effect: not enough wells to compare perimeter against interior.");
  } else {
    const e = d.edgeEffect;
    const direction = e.percentDifference >= 0 ? "higher" : "lower";
    const detail = `perimeter mean ${e.edgeMean.toFixed(4)} vs interior ${e.interiorMean.toFixed(4)} (${Math.abs(e.percentDifference).toFixed(1)}% ${direction}, effect size ${e.effectSize.toFixed(2)})`;
    lines.push(
      e.flagged
        ? `- Edge effect DETECTED: ${detail}. Consistent with evaporation or thermal gradient at the plate edge.`
        : `- No meaningful edge effect: ${detail}.`,
    );
  }

  lines.push(
    d.rowOutliers.length === 0
      ? "- No row reads as an outlier against the others."
      : `- Row outliers: ${d.rowOutliers.map((r) => `${r.label} (mean ${r.mean.toFixed(4)}, robust z ${r.robustZ.toFixed(1)})`).join("; ")}.`,
  );
  lines.push(
    d.columnOutliers.length === 0
      ? "- No column reads as an outlier against the others."
      : `- Column outliers: ${d.columnOutliers.map((c) => `${c.label} (mean ${c.mean.toFixed(4)}, robust z ${c.robustZ.toFixed(1)})`).join("; ")}.`,
  );

  lines.push(
    "These figures are computed directly from the well values. Treat them as measured fact and do not contradict them.",
  );
  return lines.join("\n");
}
