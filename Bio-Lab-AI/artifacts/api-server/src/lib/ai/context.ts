import type { Experiment } from "@workspace/db";
import { parseStructuredProtocol } from "../protocol";
import { describeDiagnostics, diagnosePlate, type DiagnosticWell } from "../plateDiagnostics";
import { sanitizeAiValue } from "./sanitize";

type ExperimentContextOptions = {
  includeData?: boolean;
  includeProtocol?: boolean;
  includeControls?: boolean;
  includePreviousReport?: boolean;
  sensitiveTerms?: string[];
};

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactPlateData(rawDataJson: string | null): unknown {
  const parsed = parseJson(rawDataJson);
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  if (data._type !== "plate96") return data;
  const sourceWells = Array.isArray(data.wells) ? data.wells : [];
  const columnTotals = new Map<number, { sum: number; count: number }>();
  for (const well of sourceWells) {
    if (!well || typeof well !== "object") continue;
    const record = well as Record<string, unknown>;
    if (record.status === "blank" || typeof record.value !== "number" || !Number.isFinite(record.value)) continue;
    const column = typeof record.col === "number"
      ? record.col
      : Number.parseInt(String(record.well ?? "").replace(/^[A-H]/i, ""), 10);
    if (!Number.isInteger(column) || column < 1 || column > 12) continue;
    const current = columnTotals.get(column) ?? { sum: 0, count: 0 };
    current.sum += record.value;
    current.count += 1;
    columnTotals.set(column, current);
  }
  // `read_matrix` duplicates the values already represented by all 96 well
  // records. Keeping `wells` preserves every measurement while avoiding a
  // second, token-heavy copy of the plate.
  return {
    _type: "plate96",
    metadata: data.metadata ?? null,
    stats: data.stats ?? null,
    graph_series: {
      mean_signal_by_plate_column: Array.from(columnTotals, ([column, total]) => [
        column,
        total.sum / total.count,
        total.count,
      ]).sort((a, b) => a[0] - b[0]),
      fields: ["column", "mean", "n"],
    },
    // Rows/columns are encoded by the well ID, so use field-labelled tuples to
    // retain every measurement without repeating six property names 96 times.
    well_fields: ["well", "value", "status", "cv_pct"],
    wells: sourceWells.length
      ? sourceWells.map((well) => {
          if (!well || typeof well !== "object") return [null, null, null, null];
          const record = well as Record<string, unknown>;
          return [record.well ?? null, record.value ?? null, record.status ?? null, record.cv_pct ?? null];
        })
      : [],
  };
}

/**
 * Measure the plate's spatial artifacts so the model is given findings instead
 * of a grid to squint at.
 *
 * The assay knowledge base instructs the analyzer to check for edge effects and
 * row/column bias, but nothing computed them — so those claims were the model's
 * impression of 96 numbers. Now they are arithmetic, and the model is told to
 * treat them as fact.
 */
function plateSpatialDiagnostics(experiment: Experiment): { summary: string; findings: unknown } | null {
  const parsed = parseJson(experiment.raw_data_json);
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  if (data._type !== "plate96" || !Array.isArray(data.wells)) return null;

  const wells: DiagnosticWell[] = [];
  for (const entry of data.wells) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const wellId = typeof record.well === "string" ? record.well : null;
    if (!wellId) continue;
    const row = typeof record.row === "string" ? record.row : wellId.charAt(0).toUpperCase();
    const col = typeof record.col === "number"
      ? record.col
      : Number.parseInt(wellId.replace(/^[A-H]/i, ""), 10);
    if (!Number.isInteger(col)) continue;
    wells.push({
      well: wellId,
      row,
      col,
      value: typeof record.value === "number" && Number.isFinite(record.value) ? record.value : null,
      status: typeof record.status === "string" ? record.status : undefined,
    });
  }
  if (wells.length === 0) return null;

  const layout = parseJson(experiment.plate_layout_json);
  const roles = layout && typeof layout === "object" && !Array.isArray(layout)
    ? (layout as Record<string, string>)
    : undefined;

  const diagnostics = diagnosePlate(wells, roles);
  return { summary: describeDiagnostics(diagnostics), findings: diagnostics };
}

export function buildExperimentContext(
  experiment: Experiment,
  options: ExperimentContextOptions = {},
): string {
  const context: Record<string, unknown> = {
    experiment_ref: "current-experiment",
    date: experiment.date,
    assay_type: experiment.assay_type,
    instrument: experiment.instrument,
    status: experiment.status,
    notes: experiment.notes ?? null,
  };
  if (options.includeProtocol !== false) {
    context.protocol = experiment.protocol_json
      ? parseStructuredProtocol(experiment.protocol_json) ?? parseJson(experiment.protocol_json)
      : null;
  }
  if (options.includeData !== false) {
    context.quantitative_data = compactPlateData(experiment.raw_data_json);
    const spatial = plateSpatialDiagnostics(experiment);
    if (spatial) {
      context.spatial_diagnostics = spatial.findings;
      context.spatial_diagnostics_summary = spatial.summary;
    }
  }
  if (options.includeControls !== false) context.control_summary = parseJson(experiment.control_summary_json);
  // Only reuse a report generated by this provider. Legacy Gemini reports have
  // no request id and must never leak into the owned training dataset.
  if (options.includePreviousReport && experiment.data_analysis_request_id) {
    context.previous_report = experiment.data_analysis_report ?? null;
  }
  return JSON.stringify(sanitizeAiValue(context, options.sensitiveTerms), null, 2);
}

export function buildRelatedExperimentContext(
  experimentRows: Experiment[],
  sensitiveTerms: string[] = [],
  options: { includeData?: boolean; metadataOnly?: boolean } = {},
): string {
  const rows = experimentRows.map((experiment, index) => ({
    experiment_ref: `related-${index + 1}`,
    date: experiment.date,
    assay_type: experiment.assay_type,
    instrument: experiment.instrument,
    status: experiment.status,
    notes: options.metadataOnly ? undefined : experiment.notes ?? null,
    protocol: !options.metadataOnly && experiment.protocol_json
      ? parseStructuredProtocol(experiment.protocol_json) ?? parseJson(experiment.protocol_json)
      : undefined,
    quantitative_data: options.includeData ? compactPlateData(experiment.raw_data_json) : undefined,
    // Summaries without a request id predate this provider and are excluded.
    provider_summary: options.metadataOnly
      ? undefined
      : experiment.ai_summary_request_id ? experiment.ai_summary : null,
  }));
  return JSON.stringify(sanitizeAiValue(rows, sensitiveTerms), null, 2);
}

export function normalizeControlSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const wells = (key: string) => Array.isArray(record[key])
    ? (record[key] as unknown[])
        .map((well) => String(well).trim().toUpperCase())
        .filter((well) => /^[A-H](?:[1-9]|1[0-2])$/.test(well))
        .slice(0, 96)
    : [];
  const metric = (key: string) => typeof record[key] === "number" && Number.isFinite(record[key])
    ? record[key] as number
    : null;
  return {
    positive_control_wells: wells("positive_control_wells"),
    negative_control_wells: wells("negative_control_wells"),
    blank_wells: wells("blank_wells"),
    sample_wells: wells("sample_wells"),
    mean_positive: metric("mean_positive"),
    mean_negative: metric("mean_negative"),
    zprime: metric("zprime"),
    signal_to_background: metric("signal_to_background"),
  };
}
