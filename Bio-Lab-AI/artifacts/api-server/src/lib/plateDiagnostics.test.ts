import test from "node:test";
import assert from "node:assert/strict";

import {
  describeDiagnostics,
  detectEdgeEffect,
  diagnosePlate,
  type DiagnosticWell,
} from "./plateDiagnostics";

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** Build a 96-well plate from a function of row index and column number. */
function plate(valueAt: (rowIndex: number, col: number) => number | null): DiagnosticWell[] {
  const wells: DiagnosticWell[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 1; c <= 12; c++) {
      wells.push({ well: `${ROWS[r]}${c}`, row: ROWS[r], col: c, value: valueAt(r, c) });
    }
  }
  return wells;
}

const isEdge = (r: number, c: number) => r === 0 || r === 7 || c === 1 || c === 12;

// Small deterministic jitter so plates have a non-zero spread without a RNG.
const jitter = (r: number, c: number) => ((r * 12 + c) % 5) * 0.001;

test("a uniform plate reports no edge effect and no lane outliers", () => {
  const d = diagnosePlate(plate((r, c) => 1 + jitter(r, c)));

  assert.equal(d.edgeEffect?.flagged, false);
  assert.deepEqual(d.rowOutliers, []);
  assert.deepEqual(d.columnOutliers, []);
  assert.equal(d.analysedWellCount, 96);
});

test("evaporation at the perimeter is detected with its direction and size", () => {
  // Edge wells read 30% high, the classic evaporation signature.
  const d = diagnosePlate(plate((r, c) => (isEdge(r, c) ? 1.3 : 1.0) + jitter(r, c)));

  assert.ok(d.edgeEffect);
  assert.equal(d.edgeEffect!.flagged, true);
  assert.ok(d.edgeEffect!.percentDifference > 25, `got ${d.edgeEffect!.percentDifference}`);
  assert.ok(d.edgeEffect!.effectSize > 0, "edge reads higher, so the effect size is positive");
  // Perimeter of an 8x12 plate: rows A and H (12 each) plus the ends of rows
  // B-G (6 each) — the corners belong to the rows, not counted twice.
  assert.equal(d.edgeEffect!.nEdge, 36);
  assert.equal(d.edgeEffect!.nInterior, 60);
});

test("an edge that reads low is reported as a negative effect", () => {
  const d = diagnosePlate(plate((r, c) => (isEdge(r, c) ? 0.6 : 1.0) + jitter(r, c)));

  assert.equal(d.edgeEffect!.flagged, true);
  assert.ok(d.edgeEffect!.percentDifference < 0);
  assert.ok(d.edgeEffect!.effectSize < 0);
});

test("a tiny but consistent edge difference is not flagged", () => {
  // 2% high. Real, but not worth sending a scientist to check the incubator.
  const d = diagnosePlate(plate((r, c) => (isEdge(r, c) ? 1.02 : 1.0) + jitter(r, c)));

  assert.ok(d.edgeEffect);
  assert.equal(d.edgeEffect!.flagged, false);
});

test("a single mis-pipetted row is caught as a row outlier", () => {
  const d = diagnosePlate(plate((r, c) => (r === 3 ? 2.0 : 1.0) + jitter(r, c)));

  assert.equal(d.rowOutliers.length, 1);
  assert.equal(d.rowOutliers[0].label, "D");
  assert.ok(d.rowOutliers[0].robustZ > 3.5);
  assert.deepEqual(d.columnOutliers, []);
});

test("a bad dispense down one column is caught as a column outlier", () => {
  const d = diagnosePlate(plate((r, c) => (c === 7 ? 0.2 : 1.0) + jitter(r, c)));

  assert.equal(d.columnOutliers.length, 1);
  assert.equal(d.columnOutliers[0].label, "7");
  assert.ok(d.columnOutliers[0].robustZ < -3.5);
});

test("control wells are not mistaken for column bias when a layout is marked", () => {
  // Column 1 is the positive control and reads high BY DESIGN. Without the
  // layout that looks exactly like a dispensing fault.
  const wells = plate((r, c) => (c === 1 ? 3.0 : 1.0) + jitter(r, c));
  const roles: Record<string, string> = {};
  for (const r of ROWS) roles[`${r}1`] = "pos";
  for (const r of ROWS) for (let c = 2; c <= 12; c++) roles[`${r}${c}`] = "sample";

  const withLayout = diagnosePlate(wells, roles);
  assert.deepEqual(withLayout.columnOutliers, [], "controls must be excluded");
  assert.equal(withLayout.usedPlateLayout, true);
  assert.equal(withLayout.analysedWellCount, 88);

  // Same plate, no layout: the control column is indistinguishable from a fault.
  const withoutLayout = diagnosePlate(wells);
  assert.equal(withoutLayout.columnOutliers.length, 1);
  assert.equal(withoutLayout.usedPlateLayout, false);
});

test("unread wells are ignored rather than treated as zero", () => {
  const d = diagnosePlate(plate((r, c) => (r === 0 && c <= 6 ? null : 1 + jitter(r, c))));

  assert.equal(d.analysedWellCount, 90);
  assert.equal(d.edgeEffect!.flagged, false);
  assert.deepEqual(d.rowOutliers, []);
});

test("a plate with almost no readings yields no edge verdict", () => {
  const wells = plate(() => null);
  wells[0].value = 1;
  wells[1].value = 1;

  assert.equal(detectEdgeEffect(wells), null);
  assert.equal(diagnosePlate(wells).analysedWellCount, 2);
});

test("a layout marking everything as control falls back to the whole plate", () => {
  const wells = plate((r, c) => 1 + jitter(r, c));
  const roles: Record<string, string> = {};
  for (const w of wells) roles[w.well] = "neg";

  const d = diagnosePlate(wells, roles);
  assert.equal(d.usedPlateLayout, false);
  assert.equal(d.analysedWellCount, 96);
});

test("the description states the negative findings, not just the alarming ones", () => {
  const clean = describeDiagnostics(diagnosePlate(plate((r, c) => 1 + jitter(r, c))));
  assert.match(clean, /No meaningful edge effect/);
  assert.match(clean, /No row reads as an outlier/);
  assert.match(clean, /No column reads as an outlier/);

  const bad = describeDiagnostics(diagnosePlate(plate((r, c) => (isEdge(r, c) ? 1.4 : 1.0) + jitter(r, c))));
  assert.match(bad, /Edge effect DETECTED/);
  assert.match(bad, /evaporation or thermal gradient/);
});

test("the description says whether controls were excluded", () => {
  const wells = plate((r, c) => 1 + jitter(r, c));
  const roles: Record<string, string> = {};
  for (const r of ROWS) roles[`${r}1`] = "neg";

  assert.match(describeDiagnostics(diagnosePlate(wells, roles)), /controls and blanks excluded/);
  assert.match(describeDiagnostics(diagnosePlate(wells)), /no plate layout marked/);
});
