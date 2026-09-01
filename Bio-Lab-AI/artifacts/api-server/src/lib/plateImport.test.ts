import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDelimitedRows, parsePlateRows } from "./plateImport";

const matrix = Array.from({ length: 8 }, (_, row) => [
  String.fromCharCode(65 + row),
  ...Array.from({ length: 12 }, (_, column) => row * 12 + column + 1),
]);

test("detects a labeled 8x12 matrix at an arbitrary offset", () => {
  const rows = [
    ["Vendor", "Example Reader"],
    ["", "", ...Array.from({ length: 12 }, (_, index) => index + 1)],
    ...matrix.map(([label, ...values]) => ["ignored", label, ...values]),
  ];
  const parsed = parsePlateRows(rows, "vendor.xlsx");
  assert.equal(parsed?.stats.well_count, 96);
  assert.equal(parsed?.wells[0].value, 1);
  assert.equal(parsed?.wells[95].value, 96);
  assert.equal(parsed?.detection.mode, "automatic");
});

test("detects long-form well and signal exports", () => {
  const rows: unknown[][] = [["Sample", "Well", "Signal"]];
  for (let row = 0; row < 8; row++) {
    for (let column = 1; column <= 12; column++) rows.push(["sample", `${String.fromCharCode(65 + row)}${column}`, row * 12 + column]);
  }
  const parsed = parsePlateRows(rows, "long-form.csv");
  assert.equal(parsed?.detection.layout, "long_form");
  assert.equal(parsed?.stats.well_count, 96);
});

test("uses an explicit manual selection for an otherwise sparse plate", () => {
  const rows = Array.from({ length: 10 }, () => Array(15).fill(""));
  rows[2][3] = "1.5";
  rows[9][14] = "2.5";
  assert.equal(parsePlateRows(rows, "sparse.csv"), null);
  const parsed = parsePlateRows(rows, "sparse.csv", { start_row: 2, start_column: 3 });
  assert.equal(parsed?.detection.mode, "manual");
  assert.equal(parsed?.stats.well_count, 2);
});

test("parses quoted CSV values without splitting embedded commas", () => {
  assert.deepEqual(parseDelimitedRows('Well,Signal,Note\nA1,1.2,"first, replicate"\n', "plate.csv"), [
    ["Well", "Signal", "Note"],
    ["A1", "1.2", "first, replicate"],
  ]);
});

test("bundled demo plate remains complete and exposes CV percent", () => {
  const filename = "demo-dose-response-plate.csv";
  const content = readFileSync(new URL(`../../../../examples/${filename}`, import.meta.url), "utf-8");
  const parsed = parsePlateRows(parseDelimitedRows(content, filename), filename);
  assert.equal(parsed?.stats.well_count, 96);
  assert.equal(typeof parsed?.stats.cv_pct, "number");
  assert.equal(parsed?.detection.mode, "automatic");
});
