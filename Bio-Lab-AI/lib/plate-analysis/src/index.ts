import { fit4PL, type DosePoint } from "./fit";

export const WELL_ID = /^[A-H](?:[1-9]|1[0-2])$/;
export const DOSE_UNITS = ["M", "mM", "µM", "nM", "pM", "mg/mL", "µg/mL", "ng/mL"] as const;
export const FIT_R2_FLOOR = 0.8;
export type WellRole = "pos" | "neg" | "blank" | "sample";

export interface PlateWell {
  well: string;
  value: number | null;
  status?: string;
}

export interface PlateLayout {
  roles: Record<string, WellRole>;
  series: {
    axis: "columns" | "rows";
    first: number;
    last: number;
    topAt: "first" | "last";
    topConcentration: number | null;
    dilutionFactor: number | null;
    unit: typeof DOSE_UNITS[number] | null;
  } | null;
}

function summarize(wells: PlateWell[]) {
  const measured = wells.filter((well): well is PlateWell & { value: number } =>
    well.value !== null && Number.isFinite(well.value),
  );
  const count = measured.length;
  const mean = count ? measured.reduce((sum, well) => sum + well.value, 0) / count : null;
  const sd = count > 1 && mean !== null
    ? Math.sqrt(measured.reduce((sum, well) => sum + (well.value - mean) ** 2, 0) / (count - 1))
    : null;
  return {
    wells: measured.map(({ well }) => well),
    count,
    mean,
    sd,
    cvPercent: sd !== null && mean ? 100 * sd / Math.abs(mean) : null,
  };
}

export type PlateResults = ReturnType<typeof calculatePlateResults>;

export function calculatePlateResults(
  wells: PlateWell[],
  layout: PlateLayout | null,
  source: "user" | "sample" = "user",
) {
  const group = (role: WellRole) => summarize(wells.filter(({ well }) => layout?.roles[well] === role));
  const vehicle = group("pos");
  const kill = group("neg");
  const blank = group("blank");
  const window = vehicle.mean !== null && blank.mean !== null ? vehicle.mean - blank.mean : null;
  const zPrime = vehicle.sd !== null && kill.sd !== null && vehicle.mean !== kill.mean
    ? 1 - 3 * (vehicle.sd + kill.sd) / Math.abs(vehicle.mean! - kill.mean!)
    : null;
  const normalized = layout && window !== null && window > 0
    ? wells.flatMap(({ well, value }) => value !== null && Number.isFinite(value)
      ? [{ well, percent: 100 * (value - blank.mean!) / window }]
      : [])
    : [];
  const normalization = new Map(normalized.map(({ well, percent }) => [well, percent]));
  const series = layout?.series;
  const points: Array<DosePoint & { wells: string[]; cvPercent: number | null }> = [];
  const measured: Array<DosePoint & { well: string }> = [];
  let fit: (NonNullable<ReturnType<typeof fit4PL>> & { unit: NonNullable<NonNullable<PlateLayout["series"]>["unit"]>; label: "IC50" | "EC50" }) | null = null;
  let refusal: string | null = null;
  let direction: "rises" | "falls" | null = null;

  if (!layout) refusal = "Confirm the plate layout before calculating potency.";
  else if (!series) refusal = "Define a dose series to calculate potency.";
  else if (!series.unit || !series.topConcentration || !series.dilutionFactor) {
    refusal = "Enter the top concentration, concentration unit, and dilution factor.";
  } else if (vehicle.mean === null || blank.mean === null || window === null || window <= 0) {
    refusal = "Mark measured vehicle and blank wells with a positive signal window.";
  } else {
    const { axis, first, last, topAt, topConcentration, dilutionFactor, unit } = series;
    for (let position = first; position <= last; position++) {
      const offset = topAt === "first" ? position - first : last - position;
      const dose = topConcentration / dilutionFactor ** offset;
      const treated = wells.filter(({ well }) => {
        const lane = axis === "columns" ? Number(well.slice(1)) : well.charCodeAt(0) - 64;
        const role = layout.roles[well];
        return lane === position && (role === undefined || role === "sample");
      }).flatMap(({ well }) => {
        const percent = normalization.get(well);
        return percent === undefined ? [] : [{ well, value: percent }];
      });
      const stats = summarize(treated);
      if (stats.mean !== null && Number.isFinite(dose) && dose > 0) {
        points.push({ dose, response: stats.mean, wells: stats.wells, cvPercent: stats.cvPercent });
        measured.push(...treated.map(({ well, value }) => ({ dose, response: value, well })));
      }
    }
    points.sort((a, b) => a.dose - b.dose);
    if (new Set(points.map(({ dose }) => dose)).size < 5) {
      refusal = "At least five distinct concentrations with measurements are required.";
    } else {
      const responses = points.map(({ response }) => response);
      if (Math.max(...responses) - Math.min(...responses) < 5) {
        refusal = "The response spans less than five percentage points of the vehicle signal.";
      } else {
        const candidate = fit4PL(points);
        if (!candidate || candidate.r2 < FIT_R2_FLOOR) refusal = "The curve does not meet the minimum fit quality (R² ≥ 0.80).";
        else if (!candidate.ic50InRange) refusal = "The fitted midpoint is outside the tested concentration range.";
        else if (candidate.hill < 0.2 || candidate.hill > 5) refusal = "The fitted Hill slope is outside the supported range (0.2–5).";
        else if (!candidate.confidenceInterval) refusal = "The fit does not have an estimable confidence interval.";
        else {
          direction = candidate.top > candidate.bottom ? "falls" : "rises";
          // The coefficients in the equation describe the low- and high-dose
          // plateaus. For an increasing response the latter is the upper plateau.
          fit = { ...candidate, unit, label: direction === "falls" ? "IC50" : "EC50" };
        }
      }
    }
  }

  return {
    version: 1 as const,
    layout,
    layoutSource: layout ? source : null,
    qc: {
      plate: summarize(wells),
      vehicle,
      kill,
      blank,
      window,
      signalToBackground: vehicle.mean !== null && blank.mean !== null && blank.mean > 0 ? vehicle.mean / blank.mean : null,
      zPrime,
    },
    points,
    measured,
    normalized,
    fit,
    refusal,
    direction,
  };
}

// The persisted object is generated only by the calculator. Unknown versions
// fail closed so legacy text or another schema cannot supply potency values.
export function readPlateResults(value: string | null | undefined): PlateResults | null {
  if (!value) return null;
  try {
    const results = JSON.parse(value) as PlateResults;
    return results?.version === 1 ? results : null;
  } catch {
    return null;
  }
}

export function formatPlateNumber(value: number): string {
  return Number(value.toPrecision(4)).toString();
}

export function potencyAnswer(results: PlateResults | null): string {
  if (!results) return "Confirm the plate layout before calculating potency.";
  if (!results.fit) return results.refusal ?? "A reliable dose-response fit is unavailable.";
  const { label, ic50, unit, confidenceInterval } = results.fit;
  const interval = confidenceInterval?.map(formatPlateNumber).join(" to ");
  return `Calculated ${label}: ${formatPlateNumber(ic50)} ${unit} (95% CI: ${interval} ${unit}).`;
}

export { parseDelimitedRows, parsePlateRows, previewRows, type PlateSelection, type WellData } from "./parser";

export const SAMPLE_LAYOUT: PlateLayout = {
  roles: Object.fromEntries("ABCDEFGH".split("").flatMap((row): Array<[string, WellRole]> => [
    [`${row}1`, "pos"], [`${row}2`, "pos"],
    [`${row}11`, row === "H" ? "blank" : "neg"], [`${row}12`, row === "H" ? "blank" : "neg"],
  ])),
  series: { axis: "columns", first: 3, last: 10, topAt: "last", topConcentration: 100, dilutionFactor: 3, unit: "µM" },
};
