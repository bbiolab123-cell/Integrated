import test from "node:test";
import assert from "node:assert/strict";

import { fit4PL, serialDilution, type DosePoint } from "./doseResponse";

// Generate ideal 4PL data so the fit has a known right answer to recover.
function syntheticCurve(
  ic50: number,
  hill: number,
  doses: number[],
  top = 100,
  bottom = 0,
): DosePoint[] {
  return doses.map((dose) => ({
    dose,
    response: bottom + (top - bottom) / (1 + Math.pow(dose / ic50, hill)),
  }));
}

test("recovers a known IC50 from an ideal curve", () => {
  const doses = serialDilution(100, 2, 10);
  const fit = fit4PL(syntheticCurve(5, 1, doses));

  assert.ok(fit);
  assert.ok(Math.abs(fit!.ic50 - 5) / 5 < 0.05, `IC50 was ${fit!.ic50}, expected ~5`);
  assert.ok(fit!.r2 > 0.99, `R² was ${fit!.r2}`);
  assert.equal(fit!.ic50InRange, true);
});

test("recovers a steeper Hill slope", () => {
  const doses = serialDilution(100, 2, 10);
  const fit = fit4PL(syntheticCurve(10, 2, doses));

  assert.ok(fit);
  assert.ok(Math.abs(fit!.ic50 - 10) / 10 < 0.05, `IC50 was ${fit!.ic50}`);
  assert.ok(fit!.hill > 1.5, `Hill was ${fit!.hill}, expected a steep slope`);
});

test("recovers the IC50 of a curve that never reaches its plateaus", () => {
  // The regression this guards: with the plateaus pinned to the observed
  // response extremes, this exact curve reported an IC50 of 40 against a true
  // value of 1000 — and called it in-range. The plateaus are now fitted, so the
  // transition is located properly even though no dose gets near it.
  const doses = serialDilution(100, 2, 8);
  const fit = fit4PL(syntheticCurve(1000, 1, doses));

  assert.ok(fit);
  assert.ok(
    Math.abs(fit!.ic50 - 1000) / 1000 < 0.05,
    `IC50 was ${fit!.ic50}, expected ~1000`,
  );
});

test("flags an IC50 that falls outside the tested dose range", () => {
  // The doses bend the curve but never reach half-maximal effect, so the
  // reported IC50 is extrapolated and must not be read as measured.
  const doses = serialDilution(100, 2, 8);
  const fit = fit4PL(syntheticCurve(1000, 1, doses));

  assert.ok(fit);
  assert.ok(fit!.ic50 > Math.max(...doses), `IC50 ${fit!.ic50} should sit past the top dose`);
  assert.equal(fit!.ic50InRange, false);
});

test("refuses to fit fewer than four usable points", () => {
  assert.equal(fit4PL(syntheticCurve(5, 1, [100, 10, 1])), null);
});

test("non-positive and non-finite doses are discarded before fitting", () => {
  // A zero dose is the usual vehicle-control row and would blow up log spacing;
  // the fit must land in exactly the same place with the junk present as without.
  const good = syntheticCurve(5, 1, serialDilution(100, 2, 8));
  const polluted: DosePoint[] = [
    ...good,
    { dose: 0, response: 100 },
    { dose: -1, response: 100 },
    { dose: NaN, response: 50 },
    { dose: 10, response: NaN },
  ];

  const clean = fit4PL(good);
  const fit = fit4PL(polluted);
  assert.ok(clean && fit);
  assert.equal(fit!.ic50, clean!.ic50);
  assert.equal(fit!.top, clean!.top);
  assert.equal(fit!.bottom, clean!.bottom);
});

test("a series with only one distinct dose cannot be fitted", () => {
  const points = [1, 2, 3, 4].map(() => ({ dose: 10, response: 50 }));
  assert.equal(fit4PL(points), null);
});

test("the plotted curve spans the dose range and is finite throughout", () => {
  const doses = serialDilution(100, 2, 8);
  const fit = fit4PL(syntheticCurve(5, 1, doses));

  assert.ok(fit);
  assert.ok(fit!.curve.length > 1);
  assert.equal(fit!.curve.every((p) => Number.isFinite(p.response) && Number.isFinite(p.dose)), true);
  // Curve is log-spaced and ascends in dose, padded slightly past the data.
  assert.ok(fit!.curve[0].dose < Math.min(...doses));
  assert.ok(fit!.curve[fit!.curve.length - 1].dose > Math.max(...doses));
});

test("serial dilution halves from the top concentration", () => {
  assert.deepEqual(serialDilution(100, 2, 4), [100, 50, 25, 12.5]);
});

test("serial dilution handles a 1:10 series and a zero-length request", () => {
  assert.deepEqual(serialDilution(1000, 10, 3), [1000, 100, 10]);
  assert.deepEqual(serialDilution(100, 2, 0), []);
});
