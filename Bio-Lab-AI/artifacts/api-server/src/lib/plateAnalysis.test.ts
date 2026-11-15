import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calculatePlateResults,
  parseDelimitedRows,
  parsePlateRows,
  potencyAnswer,
  SAMPLE_LAYOUT,
  type PlateLayout,
} from "@workspace/plate-analysis";
import { answerPlateQuestion, ConfirmPlateLayoutBody, validatePlateNarration } from "./plateAnalysis";

const layout: PlateLayout = {
  roles: { A1: "pos", B1: "pos", A2: "blank", B2: "blank", A12: "neg", B12: "neg" },
  series: { axis: "columns", first: 3, last: 11, topAt: "last", topConcentration: 256, dilutionFactor: 2, unit: "µM" },
};

function referencePlate(midpoint: number, hill: number, increasing = false) {
  const controls = [
    { well: "A1", value: 1.01 }, { well: "B1", value: 0.99 },
    { well: "A2", value: 0.04 }, { well: "B2", value: 0.06 },
    { well: "A12", value: 0.1 }, { well: "B12", value: 0.11 },
  ];
  const treated = Array.from({ length: 9 }, (_, index) => {
    const dose = 2 ** index;
    const remaining = 1 / (1 + (dose / midpoint) ** hill);
    return { well: `A${index + 3}`, value: 0.05 + 0.95 * (0.1 + 0.8 * (increasing ? 1 - remaining : remaining)) };
  });
  return [...controls, ...treated];
}

for (const [midpoint, hill] of [[4, 0.5], [8, 1], [16, 1.5], [32, 2], [64, 3], [128, 4]]) {
  test(`known 4PL midpoint ${midpoint} and Hill slope ${hill}`, () => {
    const result = calculatePlateResults(referencePlate(midpoint, hill), layout);
    assert.ok(result.fit, result.refusal ?? "");
    assert.ok(Math.abs(result.fit.ic50 / midpoint - 1) < 0.01, String(result.fit.ic50));
    assert.ok(Math.abs(result.fit.hill - hill) < 0.02, String(result.fit.hill));
    assert.ok(Math.abs(result.fit!.top - 90) < 0.3);
    assert.ok(Math.abs(result.fit!.bottom - 10) < 0.3);
    assert.ok(result.fit.confidenceInterval?.every(Number.isFinite));
    assert.equal(result.direction, "falls");
    assert.equal(answerPlateQuestion("What is the IC50?", result), potencyAnswer(result));
  });
}

test("increasing dose response is labeled EC50", () => {
  const result = calculatePlateResults(referencePlate(32, 2, true), layout);
  assert.equal(result.fit?.label, "EC50");
  assert.equal(result.direction, "rises");
});

test("unconfirmed layouts, omitted units, missing vehicle and too few dose groups refuse potency", () => {
  assert.ok(calculatePlateResults(referencePlate(16, 1), null).refusal?.includes("Confirm"));
  assert.match(calculatePlateResults(referencePlate(16, 1), { ...layout, series: { ...layout.series!, unit: null } }).refusal!, /unit/);
  assert.match(calculatePlateResults(referencePlate(16, 1), { ...layout, roles: {} }).refusal!, /vehicle/);
  assert.match(calculatePlateResults(referencePlate(16, 1).slice(0, 10), layout).refusal!, /five distinct/);
});

test("flat and extrapolated curves withhold potency", () => {
  const flat = referencePlate(16, 1).map((well, i) => i < 6 ? well : { ...well, value: 0.5 });
  assert.match(calculatePlateResults(flat, layout).refusal!, /spans less/);
  const outside = calculatePlateResults(referencePlate(350, 1), layout);
  assert.equal(outside.fit, null);
  assert.match(outside.refusal!, /outside the tested/);
});

test("marks controls out of treated groups without shifting concentrations", () => {
  const result = calculatePlateResults([...referencePlate(16, 1), { well: "B5", value: 1 }], {
    ...layout, roles: { ...layout.roles, B5: "pos" },
  });
  assert.equal(result.points.find(({ dose }) => dose === 4)?.wells.join(), "A5");
  assert.ok(!result.measured.some(({ well }) => well === "B5"));
});

test("blank-vs-vehicle signal window does not substitute for Z′", () => {
  const result = calculatePlateResults(referencePlate(16, 1), {
    ...layout, roles: { A1: "pos", B1: "pos", A2: "blank", B2: "blank" },
  });
  assert.equal(result.qc.zPrime, null);
  assert.ok(Math.abs(result.qc.window! - 0.95) < 1e-9);
  assert.match(answerPlateQuestion("What is Z′?", result), /needs replicate vehicle and kill/);
});

test("sample CSV is parsed and fits dose groups without using controls", () => {
  const csv = readFileSync(new URL("../../../../examples/demo-dose-response-plate.csv", import.meta.url), "utf8");
  const plate = parsePlateRows(parseDelimitedRows(csv, "sample.csv"), "sample.csv");
  assert.equal(plate?.stats.well_count, 96);
  const result = calculatePlateResults(plate!.wells, SAMPLE_LAYOUT);
  assert.equal(result.fit?.label, "IC50", result.refusal ?? "");
  assert.equal(result.points.length, 8);
  assert.equal(result.measured.length, 64);
  assert.ok(result.qc.zPrime! > 0.9);
  // Independent SciPy least-squares fit to the eight blank-corrected dose means.
  assert.ok(Math.abs(result.fit!.ic50 - 9.1091) < 0.02);
  assert.ok(Math.abs(result.fit!.hill - 0.4400) < 0.01);
  assert.ok(Math.abs(result.fit!.confidenceInterval![0] - 6.2640) < 0.03);
  assert.ok(Math.abs(result.fit!.confidenceInterval![1] - 13.2465) < 0.04);
});

test("plate narration rejects values and conflicting direction before display", () => {
  const result = calculatePlateResults(referencePlate(16, 1), layout);
  assert.equal(validatePlateNarration("Potency is 0.44 µM.", result), null);
  assert.equal(validatePlateNarration("The signal rises with dose.", result), null);
  assert.equal(validatePlateNarration(String.raw`The response falls with dose.\nReview the control wells.`, result), "The response falls with dose.\nReview the control wells.");
  assert.equal(validatePlateNarration("The result is highly confident.", result), null);
});

test("layout validation rejects unknown wells, reversed bounds, and unsupported dilutions", () => {
  const data = { updatedAt: new Date().toISOString(), layout };
  assert.equal(ConfirmPlateLayoutBody.safeParse(data).success, true);
  for (const invalid of [
    { ...layout, roles: { X3: "pos" } },
    { ...layout, series: { ...layout.series!, first: 10, last: 2 } },
    { ...layout, series: { ...layout.series!, dilutionFactor: 1 } },
  ]) {
    assert.equal(ConfirmPlateLayoutBody.safeParse({ ...data, layout: invalid }).success, false);
  }
});
