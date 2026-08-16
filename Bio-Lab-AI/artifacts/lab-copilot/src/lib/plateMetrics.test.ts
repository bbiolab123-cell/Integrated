import test from "node:test";
import assert from "node:assert/strict";

import {
  buildControlSummary,
  computeControlMetrics,
  percentOfControl,
  type MetricWell,
  type WellRole,
} from "./plateMetrics";

function wells(spec: Record<string, number | null>): MetricWell[] {
  return Object.entries(spec).map(([well, value]) => ({ well, value }));
}

function roles(spec: Record<string, WellRole>): Record<string, WellRole> {
  return spec;
}

test("a perfectly separated assay scores Z' = 1", () => {
  // No spread in either control, so 3(sigma_p + sigma_n) is zero.
  const m = computeControlMetrics(
    wells({ A1: 100, A2: 100, B1: 0, B2: 0 }),
    roles({ A1: "pos", A2: "pos", B1: "neg", B2: "neg" }),
  );
  assert.equal(m.zPrime, 1);
  assert.equal(m.meanPos, 100);
  assert.equal(m.meanNeg, 0);
  assert.equal(m.nPos, 2);
  assert.equal(m.nNeg, 2);
});

test("Z' matches the hand-computed value for a realistic plate", () => {
  // pos = [102, 98] -> mean 100, sample sd sqrt(8) = 2.8284
  // neg = [12, 8]   -> mean 10,  sample sd sqrt(8) = 2.8284
  // Z' = 1 - 3(2.8284 + 2.8284) / |100 - 10| = 1 - 16.9706/90 = 0.81144
  const m = computeControlMetrics(
    wells({ A1: 102, A2: 98, B1: 12, B2: 8 }),
    roles({ A1: "pos", A2: "pos", B1: "neg", B2: "neg" }),
  );
  assert.ok(m.zPrime !== null);
  assert.ok(Math.abs(m.zPrime! - 0.81144) < 1e-4, `got ${m.zPrime}`);
});

test("a screen-quality assay beats 0.5 and a sloppy one goes negative", () => {
  const good = computeControlMetrics(
    wells({ A1: 100, A2: 101, A3: 99, B1: 10, B2: 11, B3: 9 }),
    roles({ A1: "pos", A2: "pos", A3: "pos", B1: "neg", B2: "neg", B3: "neg" }),
  );
  assert.ok(good.zPrime! > 0.5, `expected a strong assay, got ${good.zPrime}`);

  const sloppy = computeControlMetrics(
    wells({ A1: 150, A2: 50, A3: 100, B1: 60, B2: 0, B3: 30 }),
    roles({ A1: "pos", A2: "pos", A3: "pos", B1: "neg", B2: "neg", B3: "neg" }),
  );
  assert.ok(sloppy.zPrime! < 0, `expected an unusable assay, got ${sloppy.zPrime}`);
});

test("Z' needs at least two of each control", () => {
  const m = computeControlMetrics(
    wells({ A1: 100, B1: 0, B2: 0 }),
    roles({ A1: "pos", B1: "neg", B2: "neg" }),
  );
  assert.equal(m.zPrime, null);
  assert.equal(m.meanPos, 100); // the mean is still reportable
});

test("Z' is undefined when the controls do not separate", () => {
  const m = computeControlMetrics(
    wells({ A1: 50, A2: 50, B1: 50, B2: 50 }),
    roles({ A1: "pos", A2: "pos", B1: "neg", B2: "neg" }),
  );
  assert.equal(m.zPrime, null);
});

test("wells with no reading are excluded rather than counted as zero", () => {
  const m = computeControlMetrics(
    wells({ A1: 100, A2: null, B1: 0, B2: 0 }),
    roles({ A1: "pos", A2: "pos", B1: "neg", B2: "neg" }),
  );
  assert.equal(m.nPos, 1);
  assert.equal(m.meanPos, 100);
});

test("signal:background is reported as a ratio >= 1 whichever way the assay reads", () => {
  const rising = computeControlMetrics(
    wells({ A1: 100, B1: 10 }),
    roles({ A1: "pos", B1: "neg" }),
  );
  assert.equal(rising.signalToBackground, 10);

  // An assay whose signal drops (positive control is the LOW value) should not
  // report a fraction — the ratio is inverted so it stays comparable.
  const falling = computeControlMetrics(
    wells({ A1: 10, B1: 100 }),
    roles({ A1: "pos", B1: "neg" }),
  );
  assert.equal(falling.signalToBackground, 10);
});

test("percent-of-control anchors 0% at the negative and 100% at the positive control", () => {
  assert.equal(percentOfControl(10, 100, 10), 0);
  assert.equal(percentOfControl(100, 100, 10), 100);
  assert.equal(percentOfControl(55, 100, 10), 50);
  // Works when the assay reads downward too.
  assert.equal(percentOfControl(10, 10, 100), 100);
  // Undefined when the controls coincide.
  assert.equal(percentOfControl(50, 50, 50), null);
});

test("no marked wells means no control summary at all", () => {
  assert.equal(buildControlSummary(wells({ A1: 1 }), {}), undefined);
});

test("the control summary groups wells by role and rounds the derived stats", () => {
  const summary = buildControlSummary(
    wells({ A1: 100, A2: 100, B1: 0, B2: 0, C1: 55, D1: 1 }),
    roles({ A1: "pos", A2: "pos", B1: "neg", B2: "neg", C1: "sample", D1: "blank" }),
  );
  assert.ok(summary);
  assert.deepEqual(summary!.positive_control_wells, ["A1", "A2"]);
  assert.deepEqual(summary!.negative_control_wells, ["B1", "B2"]);
  assert.deepEqual(summary!.sample_wells, ["C1"]);
  assert.deepEqual(summary!.blank_wells, ["D1"]);
  assert.equal(summary!.mean_positive, 100);
  assert.equal(summary!.mean_negative, 0);
  assert.equal(summary!.zprime, 1);
});

test("well lists read in plate order, not lexicographic order", () => {
  // "A10" sorts before "A2" as a string, which would hand the AI a control
  // list that reads A1, A10, A11, A2 — wrong to a scientist scanning it.
  const spec: Record<string, WellRole> = {
    A1: "pos", A2: "pos", A10: "pos", A11: "pos", B3: "pos",
  };
  const summary = buildControlSummary(
    wells({ A1: 1, A2: 1, A10: 1, A11: 1, B3: 1 }),
    spec,
  );
  assert.deepEqual(summary!.positive_control_wells, ["A1", "A2", "A10", "A11", "B3"]);
});
