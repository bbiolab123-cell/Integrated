const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const WELL_RE = /^([A-H])\s*0?([1-9]|1[0-2])$/i;

export type PlateSelection = {
  start_row: number;
  start_column: number;
  transpose?: boolean;
};

export type WellData = {
  well: string;
  row: string;
  col: number;
  value: number | null;
  status: "ok" | "blank" | "high" | "low";
  cv_pct: number | null;
};

export type PlateParseResult = {
  metadata: {
    plate_name: string | null;
    date: string | null;
    protocol: string | null;
    wavelength: string | null;
    instrument: string | null;
    read_type: string | null;
  };
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
  detection: {
    mode: "automatic" | "manual";
    layout: "matrix" | "transposed_matrix" | "long_form";
    start_row: number;
    start_column: number;
    confidence: number;
  };
};

type MatrixCandidate = {
  matrix: (number | null)[][];
  startRow: number;
  startColumn: number;
  transpose: boolean;
  numericCount: number;
  score: number;
};

function text(value: unknown): string {
  if (value == null) return "";
  return String(value).trim().slice(0, 500);
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let normalized = value.trim();
  if (!normalized || /^(?:na|n\/a|null|nan|inf|infinity|overflow|ovrflw|—|-)$/i.test(normalized)) return null;
  normalized = normalized.replace(/^['"]|['"]$/g, "").replace(/,/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function cell(rows: unknown[][], row: number, column: number): unknown {
  return row >= 0 && column >= 0 && row < rows.length ? rows[row]?.[column] : undefined;
}

function extractMatrix(rows: unknown[][], startRow: number, startColumn: number, transpose: boolean): (number | null)[][] {
  return Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 12 }, (_, column) =>
      transpose
        ? numeric(cell(rows, startRow + column, startColumn + row))
        : numeric(cell(rows, startRow + row, startColumn + column)),
    ),
  );
}

function sequentialColumns(rows: unknown[][], headerRow: number, startColumn: number): boolean {
  return Array.from({ length: 12 }, (_, column) => numeric(cell(rows, headerRow, startColumn + column)) === column + 1)
    .filter(Boolean).length >= 10;
}

function sequentialRows(rows: unknown[][], startRow: number, labelColumn: number): boolean {
  return ROW_LABELS.filter((label, row) => text(cell(rows, startRow + row, labelColumn)).toUpperCase() === label).length >= 6;
}

function scoreMatrix(rows: unknown[][], startRow: number, startColumn: number, transpose: boolean): MatrixCandidate {
  const matrix = extractMatrix(rows, startRow, startColumn, transpose);
  const numericCount = matrix.flat().filter((value) => value !== null).length;
  let score = numericCount;
  if (!transpose) {
    if (sequentialColumns(rows, startRow - 1, startColumn)) score += 30;
    if (sequentialRows(rows, startRow, startColumn - 1)) score += 30;
  } else {
    if (sequentialRows(rows, startRow - 1, startColumn)) score += 20;
    const labels = Array.from({ length: 12 }, (_, row) => numeric(cell(rows, startRow + row, startColumn - 1)) === row + 1)
      .filter(Boolean).length;
    if (labels >= 10) score += 30;
  }
  return { matrix, startRow, startColumn, transpose, numericCount, score };
}

function findBestMatrix(rows: unknown[][]): MatrixCandidate | null {
  const maxColumns = Math.min(64, Math.max(0, ...rows.map((row) => row.length)));
  let best: MatrixCandidate | null = null;

  for (let row = 0; row + 8 <= rows.length; row++) {
    for (let column = 0; column + 12 <= maxColumns; column++) {
      const candidate = scoreMatrix(rows, row, column, false);
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  for (let row = 0; row + 12 <= rows.length; row++) {
    for (let column = 0; column + 8 <= maxColumns; column++) {
      const candidate = scoreMatrix(rows, row, column, true);
      if (!best || candidate.score > best.score) best = candidate;
    }
  }

  // An unlabeled automatic match must contain at least 75% of a full plate.
  // Labeled exports may be intentionally sparse, but still need 12 readings.
  if (!best) return null;
  const labeled = best.score - best.numericCount >= 20;
  return best.numericCount >= (labeled ? 12 : 72) ? best : null;
}

function findLongForm(rows: unknown[][]): MatrixCandidate | null {
  for (let headerRow = 0; headerRow < Math.min(rows.length, 50); headerRow++) {
    const headers = (rows[headerRow] ?? []).map((value) => text(value).toLowerCase());
    const wellColumn = headers.findIndex((header) => /^(?:well|well id|well position|position)$/.test(header));
    const valueColumn = headers.findIndex((header) => /^(?:value|signal|result|od|absorbance|rfu|rlu|measurement|read)$/.test(header));
    if (wellColumn < 0 || valueColumn < 0) continue;

    const matrix: (number | null)[][] = Array.from({ length: 8 }, () => Array(12).fill(null));
    let count = 0;
    for (let row = headerRow + 1; row < rows.length; row++) {
      const match = text(cell(rows, row, wellColumn)).match(WELL_RE);
      const value = numeric(cell(rows, row, valueColumn));
      if (!match || value === null) continue;
      const plateRow = ROW_LABELS.indexOf(match[1].toUpperCase() as typeof ROW_LABELS[number]);
      const plateColumn = Number(match[2]) - 1;
      if (matrix[plateRow][plateColumn] === null) count += 1;
      matrix[plateRow][plateColumn] = value;
    }
    if (count >= 12) {
      return {
        matrix,
        startRow: headerRow + 1,
        startColumn: wellColumn,
        transpose: false,
        numericCount: count,
        score: count + 60,
      };
    }
  }
  return null;
}

function metadataFromRows(rows: unknown[][], filename: string) {
  const metadata = {
    plate_name: null as string | null,
    date: null as string | null,
    protocol: null as string | null,
    wavelength: null as string | null,
    instrument: null as string | null,
    read_type: null as string | null,
  };

  for (const row of rows.slice(0, 80)) {
    for (let column = 0; column < Math.min(row.length, 12); column++) {
      const key = text(row[column]).toLowerCase().replace(/:$/, "");
      const value = text(row[column + 1]);
      if (!value) continue;
      if (/^(?:plate|plate name|plate id)$/.test(key)) metadata.plate_name ??= value;
      else if (key.includes("date")) metadata.date ??= value;
      else if (key.includes("protocol")) metadata.protocol ??= value;
      else if (key.includes("wavelength") || key === "read") metadata.wavelength ??= value;
      else if (key.includes("instrument") || key.includes("reader")) metadata.instrument ??= value;
      else if (key.includes("read type") || key === "assay") metadata.read_type ??= value;
    }
  }

  if (!metadata.instrument) {
    const source = `${filename} ${rows.slice(0, 25).flat().map(text).join(" ")}`;
    if (/spectramax|softmax/i.test(source)) metadata.instrument = "SpectraMax plate reader";
    else if (/tecan|spark|infinite/i.test(source)) metadata.instrument = "Tecan plate reader";
    else if (/clariostar|bmg/i.test(source)) metadata.instrument = "BMG plate reader";
    else if (/envision|perkinelmer/i.test(source)) metadata.instrument = "EnVision plate reader";
    else if (/synergy|gen5|biotek/i.test(source)) metadata.instrument = "BioTek Synergy H1";
    else metadata.instrument = "Plate reader";
  }
  return metadata;
}

function summarize(matrix: (number | null)[][], metadata: PlateParseResult["metadata"], detection: PlateParseResult["detection"]): PlateParseResult {
  const values = matrix.flat().filter((value): value is number => value !== null);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const sd = mean === null ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const cv = mean !== null && mean !== 0 && sd !== null ? (sd / Math.abs(mean)) * 100 : null;
  const blankThreshold = min !== null && max !== null ? min + (max - min) * 0.05 : null;
  const highThreshold = mean !== null && sd !== null ? mean + 2 * sd : null;
  const lowThreshold = mean !== null && sd !== null ? mean - 2 * sd : null;

  const wells: WellData[] = [];
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 12; column++) {
      const value = matrix[row][column];
      let status: WellData["status"] = "ok";
      if (value === null || (blankThreshold !== null && value <= blankThreshold)) status = "blank";
      else if (highThreshold !== null && value > highThreshold) status = "high";
      else if (lowThreshold !== null && value < lowThreshold) status = "low";
      wells.push({
        well: `${ROW_LABELS[row]}${column + 1}`,
        row: ROW_LABELS[row],
        col: column + 1,
        value,
        status,
        cv_pct: null,
      });
    }
  }

  const round = (value: number | null, places: number) => value === null ? null : Number(value.toFixed(places));
  return {
    metadata,
    wells,
    stats: {
      mean: round(mean, 4),
      sd: round(sd, 4),
      cv_pct: round(cv, 2),
      min: round(min, 4),
      max: round(max, 4),
      blank_count: wells.filter((well) => well.status === "blank").length,
      well_count: values.length,
    },
    read_matrix: matrix,
    detection,
  };
}

export function parsePlateRows(rows: unknown[][], filename: string, selection?: PlateSelection): PlateParseResult | null {
  if (selection) {
    const rowCount = selection.transpose ? 12 : 8;
    const columnCount = selection.transpose ? 8 : 12;
    if (!Number.isInteger(selection.start_row) || !Number.isInteger(selection.start_column)
      || selection.start_row < 0 || selection.start_column < 0
      || selection.start_row + rowCount > rows.length
      || selection.start_column + columnCount > Math.max(0, ...rows.map((row) => row.length))) {
      return null;
    }
    const matrix = extractMatrix(rows, selection.start_row, selection.start_column, Boolean(selection.transpose));
    if (matrix.flat().filter((value) => value !== null).length === 0) return null;
    return summarize(matrix, metadataFromRows(rows, filename), {
      mode: "manual",
      layout: selection.transpose ? "transposed_matrix" : "matrix",
      start_row: selection.start_row,
      start_column: selection.start_column,
      confidence: 1,
    });
  }

  const longForm = findLongForm(rows);
  const matrix = findBestMatrix(rows);
  const best = longForm && (!matrix || longForm.score > matrix.score) ? longForm : matrix;
  if (!best) return null;
  const layout = best === longForm ? "long_form" : best.transpose ? "transposed_matrix" : "matrix";
  const confidence = Math.min(1, best.numericCount / 96 + Math.max(0, best.score - best.numericCount) / 120);
  return summarize(best.matrix, metadataFromRows(rows, filename), {
    mode: "automatic",
    layout,
    start_row: best.startRow,
    start_column: best.startColumn,
    confidence: Number(confidence.toFixed(2)),
  });
}

export function previewRows(rows: unknown[][], maxRows = 40, maxColumns = 30): string[][] {
  return rows.slice(0, maxRows).map((row) =>
    Array.from({ length: Math.min(maxColumns, Math.max(1, row.length)) }, (_, column) => text(row[column])),
  );
}

export function parseDelimitedRows(content: string, filename: string): string[][] {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const ext = filename.split(".").pop()?.toLowerCase();
  const delimiter = ext === "tsv"
    ? "\t"
    : ["\t", ",", ";"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(value); value = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some((cellValue) => cellValue.trim())) rows.push(row);
      row = [];
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cellValue) => cellValue.trim())) rows.push(row);
  return rows;
}
