import test from "node:test";
import assert from "node:assert/strict";

import { parseSynergyH1Rows } from "./plateParser";

// A Gen5 export: a loose key/value preamble, then a numbered header row, then
// eight lettered rows of readings.
function plateRows(values: number[][], preamble: unknown[][] = []): unknown[][] {
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
  return [
    ...preamble,
    [],
    ["", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    ...values.map((row, i) => [letters[i], ...row]),
  ];
}

function uniformPlate(value: number): number[][] {
  return Array.from({ length: 8 }, () => Array(12).fill(value));
}

test("parses a full 96-well plate with its matrix, stats, and well ids", () => {
  const values = Array.from({ length: 8 }, (_, r) =>
    Array.from({ length: 12 }, (_, c) => r * 12 + c + 1),
  );
  const result = parseSynergyH1Rows(plateRows(values));

  assert.equal(result.wells.length, 96);
  assert.equal(result.stats.well_count, 96);
  assert.equal(result.wells[0].well, "A1");
  assert.equal(result.wells[95].well, "H12");
  assert.equal(result.read_matrix[0][0], 1);
  assert.equal(result.read_matrix[7][11], 96);
  // 1..96 → mean 48.5, min 1, max 96
  assert.equal(result.stats.mean, 48.5);
  assert.equal(result.stats.min, 1);
  assert.equal(result.stats.max, 96);
});

test("plate SD is the sample SD (n-1), matching Excel STDEV and the control metrics", () => {
  // Two distinct values, 48 wells each: sample SD of that set is exactly
  // sqrt(96*... ) — computed directly below rather than restating the formula.
  const values = Array.from({ length: 8 }, (_, r) =>
    Array(12).fill(r < 4 ? 10 : 20),
  );
  const result = parseSynergyH1Rows(plateRows(values));

  const all = values.flat();
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const sampleSd = Math.sqrt(
    all.reduce((a, b) => a + (b - mean) ** 2, 0) / (all.length - 1),
  );
  const populationSd = Math.sqrt(
    all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length,
  );

  assert.equal(result.stats.sd, parseFloat(sampleSd.toFixed(4)));
  assert.notEqual(result.stats.sd, parseFloat(populationSd.toFixed(4)));
});

test("a uniform plate has zero spread and no outliers", () => {
  const result = parseSynergyH1Rows(plateRows(uniformPlate(1.5)));
  assert.equal(result.stats.sd, 0);
  assert.equal(result.stats.cv_pct, 0);
  assert.equal(result.wells.every((w) => w.value === 1.5), true);
  assert.equal(result.wells.some((w) => w.status === "high" || w.status === "low"), false);
});

test("reads the plate even when Gen5 omits the numbered header row", () => {
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const rows: unknown[][] = letters.map((letter, r) => [
    letter,
    ...Array.from({ length: 12 }, (_, c) => r + c + 1),
  ]);
  const result = parseSynergyH1Rows(rows);

  assert.equal(result.stats.well_count, 96);
  assert.equal(result.read_matrix[0][0], 1);
});

test("missing wells stay null rather than shifting the plate", () => {
  const values = uniformPlate(2);
  const rows = plateRows(values);
  // Blow away C5 the way a Gen5 export with an unread well does.
  (rows[rows.length - 6] as unknown[])[5] = "";
  const result = parseSynergyH1Rows(rows);

  const c5 = result.wells.find((w) => w.well === "C5");
  assert.equal(c5?.value, null);
  assert.equal(c5?.status, "blank");
  assert.equal(result.stats.well_count, 95);
  // The rest of row C must not slide left into the gap.
  assert.equal(result.wells.find((w) => w.well === "C6")?.value, 2);
});

test("reads plate metadata from the preamble", () => {
  const result = parseSynergyH1Rows(
    plateRows(uniformPlate(1), [
      ["Plate", "Compound-X cytotoxicity"],
      ["Date", "2026-08-16"],
      ["Protocol", "MTT endpoint"],
      ["Wavelength", "570"],
      ["Reader Type", "Synergy H1"],
      ["Read Type", "Endpoint"],
    ]),
  );

  assert.equal(result.metadata.plate_name, "Compound-X cytotoxicity");
  assert.equal(result.metadata.date, "2026-08-16");
  assert.equal(result.metadata.protocol, "MTT endpoint");
  assert.equal(result.metadata.wavelength, "570");
  assert.equal(result.metadata.instrument, "Synergy H1");
  assert.equal(result.metadata.read_type, "Endpoint");
});

test("bookkeeping rows never masquerade as plate metadata", () => {
  // Every one of these contains the substring the old matcher keyed on, which
  // is how a file path ended up displayed as the protocol and a serial number
  // as the instrument.
  const result = parseSynergyH1Rows(
    plateRows(uniformPlate(1), [
      ["Software Version", "3.11.19"],
      ["Protocol File Path", "C:\\Gen5\\protocols\\mtt.prt"],
      ["Reader Serial Number", "21092112"],
      ["Date Last Saved", "2020-01-01"],
      ["Updated", "2019-05-05"],
      ["Plate Type", "96 WELL PLATE"],
    ]),
  );

  assert.equal(result.metadata.protocol, null);
  assert.equal(result.metadata.date, null);
  assert.equal(result.metadata.plate_name, null);
  // Falls back to the default rather than reporting a serial number as the reader.
  assert.equal(result.metadata.instrument, "Synergy H1");
});

test("the first real metadata value wins over later generic rows", () => {
  const result = parseSynergyH1Rows(
    plateRows(uniformPlate(1), [
      ["Date", "2026-08-16"],
      ["Date", "1999-01-01"],
    ]),
  );
  assert.equal(result.metadata.date, "2026-08-16");
});

test("an empty or dataless sheet degrades to nulls instead of throwing", () => {
  const result = parseSynergyH1Rows([]);
  assert.equal(result.stats.well_count, 0);
  assert.equal(result.stats.mean, null);
  assert.equal(result.stats.sd, null);
  assert.equal(result.wells.length, 96);
  assert.equal(result.wells.every((w) => w.value === null), true);
});

test("a real but low reading is 'low', not 'blank'", () => {
  // The killed end of a dose-response reads at background but is still data.
  // Calling it blank greyed it out and, worse, dropped it from the dose series
  // before the IC50 was fitted.
  const values = uniformPlate(1.0);
  for (let c = 0; c < 12; c++) values[0][c] = 0.05; // whole top row killed
  const result = parseSynergyH1Rows(plateRows(values));

  const a1 = result.wells.find((w) => w.well === "A1");
  assert.equal(a1?.value, 0.05);
  assert.notEqual(a1?.status, "blank");
  assert.equal(result.stats.blank_count, 0);
  // Every well was read, so all 96 count toward the plate statistics.
  assert.equal(result.stats.well_count, 96);
});

test("only an absent reading counts as blank", () => {
  const values = uniformPlate(1.0);
  const rows = plateRows(values);
  (rows[rows.length - 8] as unknown[])[1] = ""; // A1 never read
  const result = parseSynergyH1Rows(rows);

  assert.equal(result.wells.find((w) => w.well === "A1")?.status, "blank");
  assert.equal(result.stats.blank_count, 1);
});

test("high and low outliers are flagged against the 2-sigma band", () => {
  const values = uniformPlate(10);
  values[0][0] = 500; // unmistakable high outlier
  const result = parseSynergyH1Rows(plateRows(values));

  assert.equal(result.wells.find((w) => w.well === "A1")?.status, "high");
});
