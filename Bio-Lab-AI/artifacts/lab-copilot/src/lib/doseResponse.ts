// 4-parameter logistic (4PL) dose-response fit, dependency-free.
//   y = bottom + (top - bottom) / (1 + (x / ic50)^hill)
// Fitted by a coarse-to-fine grid search over ic50 and Hill slope (robust and
// adequate for a readout the scientist also eyeballs against the plotted curve).

export interface DosePoint {
  dose: number;
  response: number;
}

export interface FitResult {
  ic50: number;
  hill: number;
  top: number;
  bottom: number;
  r2: number;
  /** smooth fitted curve for plotting (log-spaced x across the dose range) */
  curve: { dose: number; response: number }[];
  ic50InRange: boolean;
}

function fourPL(x: number, top: number, bottom: number, ic50: number, hill: number): number {
  return bottom + (top - bottom) / (1 + Math.pow(x / ic50, hill));
}

function sse(points: DosePoint[], top: number, bottom: number, ic50: number, hill: number): number {
  let s = 0;
  for (const p of points) {
    const yhat = fourPL(p.dose, top, bottom, ic50, hill);
    s += (p.response - yhat) ** 2;
  }
  return s;
}

/**
 * Best-fit plateaus for a given ic50/hill, solved exactly.
 *
 * Once ic50 and hill are fixed the 4PL is *linear* in the plateaus:
 *   y = bottom·(1-f) + top·f,  f = 1 / (1 + (x/ic50)^hill)
 * so the optimal pair is the solution of the 2x2 normal equations (separable
 * least squares). Taking the plateaus from the observed response extremes
 * instead — as this did originally — makes any curve that never reaches
 * saturation unrepresentable, and the fit compensates by dragging ic50 toward
 * the middle of the tested range: a true IC50 of 1000 came back as 40, flagged
 * as measured rather than extrapolated.
 *
 * Returns null when the system is degenerate (a flat curve, or doses that all
 * sit on one side of the transition), leaving the caller to fall back.
 */
function solvePlateaus(
  points: DosePoint[],
  ic50: number,
  hill: number,
): { top: number; bottom: number } | null {
  let suu = 0, suv = 0, svv = 0, suy = 0, svy = 0;
  for (const p of points) {
    const v = 1 / (1 + Math.pow(p.dose / ic50, hill)); // weight on `top`
    const u = 1 - v;                                    // weight on `bottom`
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suy += u * p.response;
    svy += v * p.response;
  }
  const det = suu * svv - suv * suv;
  // Scale-aware degeneracy check: suu*svv is the natural magnitude here.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12 * Math.max(1, suu * svv)) return null;
  const bottom = (suy * svv - svy * suv) / det;
  const top = (svy * suu - suy * suv) / det;
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  return { top, bottom };
}

/** Fit a 4PL curve. Needs >=4 points with positive, non-identical doses. */
export function fit4PL(raw: DosePoint[]): FitResult | null {
  const points = raw.filter((p) => Number.isFinite(p.dose) && p.dose > 0 && Number.isFinite(p.response));
  if (points.length < 4) return null;

  const doses = points.map((p) => p.dose);
  const responses = points.map((p) => p.response);
  const minDose = Math.min(...doses);
  const maxDose = Math.max(...doses);
  if (minDose === maxDose) return null;

  // Fallback plateaus, used only when the exact solve is degenerate.
  const maxResp = Math.max(...responses);
  const minResp = Math.min(...responses);

  const logMin = Math.log10(minDose);
  const logMax = Math.log10(maxDose);

  // Coarse grid over ic50 (log-spaced, slightly beyond the tested range) and
  // Hill; the plateaus are solved exactly for each candidate rather than
  // searched, so the grid stays two-dimensional and just as fast.
  let best = {
    ic50: Math.sqrt(minDose * maxDose),
    hill: 1,
    top: maxResp,
    bottom: minResp,
    err: Infinity,
  };
  const searchOnce = (loIc50Log: number, hiIc50Log: number, loHill: number, hiHill: number, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const ic50 = Math.pow(10, loIc50Log + ((hiIc50Log - loIc50Log) * i) / steps);
      for (let j = 0; j <= steps; j++) {
        const hill = loHill + ((hiHill - loHill) * j) / steps;
        if (hill === 0) continue;
        const plateaus = solvePlateaus(points, ic50, hill) ?? { top: maxResp, bottom: minResp };
        const err = sse(points, plateaus.top, plateaus.bottom, ic50, hill);
        if (err < best.err) best = { ic50, hill, top: plateaus.top, bottom: plateaus.bottom, err };
      }
    }
  };

  searchOnce(logMin - 1, logMax + 1, 0.2, 5, 60);
  // Refine locally around the best estimate.
  const l = Math.log10(best.ic50);
  searchOnce(l - 0.5, l + 0.5, Math.max(0.1, best.hill - 1), best.hill + 1, 40);

  const meanResp = responses.reduce((a, b) => a + b, 0) / responses.length;
  const sst = responses.reduce((a, b) => a + (b - meanResp) ** 2, 0);
  const r2 = sst > 0 ? 1 - best.err / sst : 0;

  const curve: { dose: number; response: number }[] = [];
  for (let i = 0; i <= 60; i++) {
    const dose = Math.pow(10, (logMin - 0.3) + (((logMax + 0.3) - (logMin - 0.3)) * i) / 60);
    curve.push({ dose, response: fourPL(dose, best.top, best.bottom, best.ic50, best.hill) });
  }

  return {
    ic50: best.ic50,
    hill: best.hill,
    top: best.top,
    bottom: best.bottom,
    r2,
    curve,
    ic50InRange: best.ic50 >= minDose && best.ic50 <= maxDose,
  };
}

/** Serial-dilution dose series: first point = topConc, each next divided by `factor`. */
export function serialDilution(topConc: number, factor: number, n: number): number[] {
  const out: number[] = [];
  let c = topConc;
  for (let i = 0; i < n; i++) {
    out.push(c);
    c = c / factor;
  }
  return out;
}
