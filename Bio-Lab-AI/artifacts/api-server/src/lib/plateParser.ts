// Synergy H1 / Gen5 plate-reader parsing.
//
// Extracted from routes/experiments.ts so it can be tested: that module imports
// the database at load time, so anything living inside it could never be
// exercised without a live DATABASE_URL. This is the first thing every
// experiment in the product passes through, so it earns real coverage.

export const MAX_CELL_CHARS = 500;

export function clampCellString(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_CELL_CHARS ? trimmed.slice(0, MAX_CELL_CHARS) : trimmed;
}

export interface WellData {
  well: string;
  row: string;
  col: number;
  value: number | null;
  status: "ok" | "blank" | "high" | "low";
  cv_pct: number | null;
}

export interface PlateMetadata {
  plate_name: string | null;
  date: string | null;
  protocol: string | null;
  wavelength: string | null;
  instrument: string | null;
  read_type: string | null;
}

export interface PlateParseResult {
  metadata: PlateMetadata;
  wells: WellData[];
  stats: {
    mean: number | null;
    sd: number | null;
    cv_pct: number | null;
    min: number | null;
    max: number | null;
    blank_count: number;
    well_count: number;
  };
  read_matrix: (number | null)[][];
}

const ROWS_ALPHA = ["A", "B", "C", "D", "E", "F", "G", "H"];
const COLS_NUM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// Gen5's preamble is loose key/value rows, and substring matching on them is a
// trap: "Date Last Saved" and "Updated" both contain "date", "Reader Serial
// Number" contains "reader", and "Protocol File Path" contains "protocol".
// Matching those blindly filled the metadata with serial numbers and file paths.
const META_DENY = /(path|version|serial|file name|last saved|updated?|plate type)/;

function matchMetadataField(rawKey: string): keyof PlateMetadata | null {
  const key = rawKey.trim().toLowerCase().replace(/[:\s]+$/, "");
  if (!key || META_DENY.test(key)) return null;
  // Most specific first — "read type" must not be claimed by the "read" rule.
  if (key === "read type" || key === "reading type" || key.startsWith("assay")) return "read_type";
  if (key.includes("wavelength") || key.includes("wave length") || key === "read") return "wavelength";
  if (key.includes("instrument") || key.includes("reader")) return "instrument";
  if (key.startsWith("protocol")) return "protocol";
  if (key === "test date" || key.startsWith("date")) return "date";
  if (key.startsWith("plate")) return "plate_name";
  return null;
}

/**
 * Parse the rows of a Gen5 worksheet into a 96-well plate result.
 *
 * Tolerates the two layouts Gen5 emits: a numbered column header row (1..12)
 * followed by lettered rows, or a bare lettered block with no header.
 */
export function parseSynergyH1Rows(rows: unknown[][]): PlateParseResult {
  const metadata: PlateMetadata = {
    plate_name: null,
    date: null,
    protocol: null,
    wavelength: null,
    instrument: null,
    read_type: null,
  };

  const strVal = (v: unknown): string => (v != null ? clampCellString(String(v)) : "");

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const val = strVal(row[1]);
    if (!val) continue;
    const field = matchMetadataField(strVal(row[0]));
    // First match wins: a later generic row must not clobber a real value.
    if (field && metadata[field] === null) metadata[field] = val;
  }

  if (!metadata.instrument) metadata.instrument = "Synergy H1";

  let plateStartRow = -1;
  let colOffset = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    // A row that opens with a well-row letter is plate data, not the column
    // header — even if its readings happen to fall in 1..12 and look like one.
    // Without this guard such a plate loses its entire first row: the row got
    // consumed as the header, and parsing started one row too late.
    if (ROWS_ALPHA.includes(strVal(row[0]).toUpperCase())) continue;
    let consecutiveNums = 0;
    let firstNumIdx = -1;
    for (let j = 0; j < row.length; j++) {
      const v = row[j];
      const n = typeof v === "number" ? v : parseInt(strVal(v), 10);
      if (!isNaN(n) && n >= 1 && n <= 12) {
        if (firstNumIdx === -1) firstNumIdx = j;
        consecutiveNums++;
      } else if (firstNumIdx !== -1) {
        break;
      }
    }
    if (consecutiveNums >= 8) {
      plateStartRow = i + 1;
      colOffset = firstNumIdx;
      break;
    }
  }

  if (plateStartRow === -1) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const firstCell = strVal(row[0]).toUpperCase();
      if (firstCell === "A") {
        let hasNumbers = false;
        for (let j = 1; j < Math.min(row.length, 14); j++) {
          const v = row[j];
          const n = typeof v === "number" ? v : parseFloat(strVal(v));
          if (!isNaN(n)) { hasNumbers = true; break; }
        }
        if (hasNumbers) {
          plateStartRow = i;
          colOffset = 1;
          break;
        }
      }
    }
  }

  const readMatrix: (number | null)[][] = Array.from({ length: 8 }, () =>
    Array(12).fill(null)
  );

  if (plateStartRow !== -1) {
    for (let r = 0; r < 8; r++) {
      const rowIdx = plateStartRow + r;
      if (rowIdx >= rows.length) break;
      const row = rows[rowIdx];
      if (!Array.isArray(row)) continue;
      const rowLabel = strVal(row[0]).toUpperCase();
      const rowAlphaIdx = ROWS_ALPHA.indexOf(rowLabel);
      const targetRow = rowAlphaIdx >= 0 ? rowAlphaIdx : r;

      for (let c = 0; c < 12; c++) {
        const cellIdx = colOffset + c;
        if (cellIdx >= row.length) continue;
        const raw = row[cellIdx];
        const n = typeof raw === "number" ? raw : parseFloat(strVal(raw));
        if (!isNaN(n)) readMatrix[targetRow][c] = n;
      }
    }
  }

  const allValues = readMatrix.flat().filter((v): v is number => v !== null);
  let mean: number | null = null;
  let sd: number | null = null;
  let cv_pct: number | null = null;
  let min: number | null = null;
  let max: number | null = null;

  if (allValues.length > 0) {
    mean = allValues.reduce((a, b) => a + b, 0) / allValues.length;
    // Sample standard deviation (n-1). This is what a scientist gets from
    // Excel's STDEV and what lib/plateMetrics.ts uses for the control-well
    // metrics — computing the plate SD with a different convention meant the
    // headline CV% and the Z'-factor disagreed about what "SD" meant.
    sd = allValues.length >= 2
      ? Math.sqrt(allValues.reduce((a, b) => a + (b - mean!) ** 2, 0) / (allValues.length - 1))
      : 0;
    cv_pct = mean !== 0 ? (sd / mean) * 100 : null;
    min = Math.min(...allValues);
    max = Math.max(...allValues);
  }

  const highThreshold = max !== null && mean !== null ? mean + 2 * (sd ?? 0) : Infinity;
  const lowThreshold = mean !== null ? mean - 2 * (sd ?? 0) : -Infinity;

  const wells: WellData[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 12; c++) {
      const val = readMatrix[r][c];
      const wellId = `${ROWS_ALPHA[r]}${COLS_NUM[c]}`;
      // Only an absent reading is blank. This used to also claim anything in
      // the bottom 5% of the plate's range, which on a real dose-response plate
      // meant the fully-killed high-dose wells — genuine data at background —
      // were reported as "no signal", greyed out on the heatmap, and dropped
      // from the dose series before the curve was fitted. A real but low
      // reading is "low", a status that already exists. Wells the scientist
      // marks as blanks in the plate layout remain the way to exclude
      // media-only wells.
      let status: WellData["status"] = "ok";
      if (val === null) status = "blank";
      else if (val > highThreshold) status = "high";
      else if (val < lowThreshold) status = "low";

      wells.push({
        well: wellId,
        row: ROWS_ALPHA[r],
        col: COLS_NUM[c],
        value: val,
        status,
        cv_pct: null,
      });
    }
  }

  return {
    metadata,
    wells,
    stats: {
      mean: mean !== null ? parseFloat(mean.toFixed(4)) : null,
      sd: sd !== null ? parseFloat(sd.toFixed(4)) : null,
      cv_pct: cv_pct !== null ? parseFloat(cv_pct.toFixed(2)) : null,
      min: min !== null ? parseFloat(min.toFixed(4)) : null,
      max: max !== null ? parseFloat(max.toFixed(4)) : null,
      blank_count: wells.filter((w) => w.status === "blank").length,
      well_count: allValues.length,
    },
    read_matrix: readMatrix,
  };
}
