import { formatPlateNumber, potencyAnswer, type PlateResults } from "@workspace/plate-analysis";

// printExperimentReport.ts
//
// Dependency-free client-side PDF export for an experiment.
// Builds a clean, print-optimized HTML report in a hidden iframe and triggers
// the browser's native "Save as PDF" dialog. No backend, no new packages.

interface PlateStats {
  mean: number | null;
  sd: number | null;
  cv_pct: number | null;
  min: number | null;
  max: number | null;
  blank_count: number;
  well_count: number;
}

interface PlateMetadata {
  plate_name?: string | null;
  date?: string | null;
  protocol?: string | null;
  wavelength?: string | null;
  instrument?: string | null;
  read_type?: string | null;
}

interface PlateData {
  _type?: string;
  metadata?: PlateMetadata;
  stats?: PlateStats;
  read_matrix?: (number | null)[][];
}

interface Suggestion {
  title: string;
  variable_to_change: string;
  rationale: string;
  expected_outcome: string;
  confidence: string;
}

interface ReportExperiment {
  name: string;
  date: string;
  assay_type: string;
  instrument: string;
  status: string;
  notes?: string | null;
  ai_summary?: string | null;
}

const ROWS_ALPHA = ["A", "B", "C", "D", "E", "F", "G", "H"];

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d: string): string {
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return esc(d);
    return dt.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return esc(d);
  }
}

// Tiny markdown-lite -> HTML. Handles headings, bold, and bullet lists while
// preserving line breaks. Good enough for AI summaries; never executes input.
function mdLite(raw: string): string {
  const lines = esc(raw).split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    const bullet = /^(\*|-)\s+(.*)$/.exec(t);
    if (bullet) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inlineMd(bullet[2])}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const lvl = Math.min(h[1].length + 2, 6);
      html += `<h${lvl}>${inlineMd(h[2])}</h${lvl}>`;
    } else if (t === "") {
      html += "<br/>";
    } else {
      html += `<p>${inlineMd(t)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function inlineMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// Viridis-ish 5-stop gradient for the plate heatmap.
const STOPS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 144, 141],
  [93, 200, 99],
  [253, 231, 37],
];

function heatColor(t: number): { bg: string; fg: string } {
  const clamped = Math.max(0, Math.min(1, t));
  const seg = clamped * (STOPS.length - 1);
  const i = Math.min(Math.floor(seg), STOPS.length - 2);
  const f = seg - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  const lum = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
  return { bg: `rgb(${r},${g},${bl})`, fg: lum > 0.55 ? "#0a0a0a" : "#ffffff" };
}

function buildHeatmap(matrix: (number | null)[][], stats?: PlateStats): string {
  const min = stats?.min ?? null;
  const max = stats?.max ?? null;
  const span = min !== null && max !== null && max > min ? max - min : 1;

  let head = '<tr><th class="corner"></th>';
  for (let c = 1; c <= 12; c++) head += `<th>${c}</th>`;
  head += "</tr>";

  let body = "";
  for (let r = 0; r < 8; r++) {
    body += `<tr><th class="rowlabel">${ROWS_ALPHA[r]}</th>`;
    for (let c = 0; c < 12; c++) {
      const val = matrix[r]?.[c] ?? null;
      if (val === null) {
        body += '<td class="well empty">·</td>';
      } else {
        const t = min !== null ? (val - min) / span : 0.5;
        const { bg, fg } = heatColor(t);
        body += `<td class="well" style="background:${bg};color:${fg}">${val.toFixed(2)}</td>`;
      }
    }
    body += "</tr>";
  }
  return `<table class="plate">${head}${body}</table>`;
}

function statCard(label: string, value: string): string {
  return `<div class="stat"><div class="stat-v">${esc(value)}</div><div class="stat-l">${esc(
    label,
  )}</div></div>`;
}

export function printExperimentReport(args: {
  experiment: ReportExperiment;
  rawData: PlateData | null;
  suggestions: Suggestion[];
  /** The full markdown Data Analysis report (from POST /:id/data-analysis), distinct
   *  from the shorter experiment.ai_summary — included as its own section when present. */
  detailedReport?: string;
  plateResults?: PlateResults | null;
}): void {
  const { experiment, rawData, suggestions, detailedReport, plateResults } = args;
  const isPlate = rawData?._type === "plate96" && Array.isArray(rawData?.read_matrix);
  const stats = rawData?.stats;
  const meta = rawData?.metadata;
  const generated = new Date().toLocaleString();

  const metaRows: string[] = [];
  if (meta?.plate_name) metaRows.push(`<tr><td>Plate</td><td>${esc(meta.plate_name)}</td></tr>`);
  if (meta?.protocol) metaRows.push(`<tr><td>Protocol</td><td>${esc(meta.protocol)}</td></tr>`);
  if (meta?.wavelength) metaRows.push(`<tr><td>Wavelength</td><td>${esc(meta.wavelength)}</td></tr>`);
  if (meta?.read_type) metaRows.push(`<tr><td>Read type</td><td>${esc(meta.read_type)}</td></tr>`);

  const statsHtml =
    isPlate && stats
      ? `<div class="stats">
          ${statCard("Mean", stats.mean !== null ? stats.mean.toFixed(3) : "—")}
          ${statCard("SD", stats.sd !== null ? stats.sd.toFixed(3) : "—")}
          ${plateResults?.layout?.series ? "" : statCard("Plate CV %", stats.cv_pct !== null ? stats.cv_pct.toFixed(1) : "—")}
          ${statCard("Min", stats.min !== null ? stats.min.toFixed(3) : "—")}
          ${statCard("Max", stats.max !== null ? stats.max.toFixed(3) : "—")}
          ${statCard("Wells read", String(stats.well_count))}
        </div>`
      : "";

  const suggestionsHtml = suggestions.length
    ? `<section class="block">
        <h2>AI-suggested next steps</h2>
        ${suggestions
          .map(
            (s) => `<div class="suggestion">
              <div class="s-head"><strong>${esc(s.title)}</strong><span class="conf">${esc(
              s.confidence,
            )} confidence</span></div>
              <div class="s-row"><em>Change:</em> ${esc(s.variable_to_change)}</div>
              <div class="s-row"><em>Rationale:</em> ${esc(s.rationale)}</div>
              <div class="s-row"><em>Expected:</em> ${esc(s.expected_outcome)}</div>
            </div>`,
          )
          .join("")}
      </section>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>${esc(experiment.name)} — Lab Report</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #111; font-size: 12px; line-height: 1.5; }
  .page { max-width: 760px; margin: 0 auto; padding: 32px 28px; }
  .brand { font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
           color: #0891b2; font-weight: 700; }
  h1 { font-size: 22px; margin: 4px 0 6px; }
  h2 { font-size: 14px; margin: 0 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  .sub { color: #475569; font-size: 12px; }
  .sub span { margin-right: 14px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 999px;
            font-size: 11px; font-weight: 600; text-transform: capitalize;
            border: 1px solid #cbd5e1; }
  .block { margin-top: 22px; page-break-inside: avoid; }
  .meta { border-collapse: collapse; font-size: 12px; }
  .meta td { padding: 2px 14px 2px 0; }
  .meta td:first-child { color: #64748b; }
  .stats { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
  .stat { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; min-width: 84px; }
  .stat-v { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-l { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
  table.plate { border-collapse: collapse; margin-top: 10px; }
  table.plate th { font-size: 10px; color: #64748b; font-weight: 600; padding: 2px; }
  table.plate th.rowlabel { padding-right: 6px; }
  td.well { width: 40px; height: 26px; text-align: center; font-size: 9px;
            font-variant-numeric: tabular-nums; border: 1px solid #fff;
            border-radius: 3px; }
  td.well.empty { background: #f1f5f9; color: #cbd5e1; }
  .legend { font-size: 10px; color: #64748b; margin-top: 6px; }
  .prose p { margin: 0 0 6px; }
  .prose ul { margin: 4px 0 8px; padding-left: 18px; }
  .prose h3, .prose h4 { font-size: 13px; margin: 8px 0 4px; }
  .notes { white-space: pre-wrap; font-family: ui-monospace, "SF Mono", Menlo, monospace;
           font-size: 11px; background: #f8fafc; border: 1px solid #e2e8f0;
           border-radius: 8px; padding: 12px; }
  .suggestion { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .s-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .conf { font-size: 10px; color: #0891b2; text-transform: uppercase; letter-spacing: .04em; }
  .s-row { font-size: 11px; margin: 2px 0; }
  .s-row em { color: #64748b; font-style: normal; font-weight: 600; }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e2e8f0;
           font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 0; max-width: 100%; }
    @page { margin: 14mm; }
  }
</style></head>
<body><div class="page">
  <div class="brand">Bioalyzer · Experiment Report</div>
  <h1>${esc(experiment.name)}</h1>
  <div class="sub">
    <span>${fmtDate(experiment.date)}</span>
    <span>${esc(experiment.assay_type)}</span>
    <span>${esc(experiment.instrument)}</span>
    <span class="status">${esc(experiment.status)}</span>
  </div>

  ${
    metaRows.length
      ? `<section class="block"><h2>Run details</h2><table class="meta">${metaRows.join("")}</table></section>`
      : ""
  }

  ${
    isPlate && rawData?.read_matrix
      ? `<section class="block">
          <h2>Plate data — 96-well heatmap</h2>
          ${statsHtml}
          ${buildHeatmap(rawData.read_matrix, stats)}
          <div class="legend">Color scale: low (purple) → high (yellow). ${
            stats?.blank_count ? `${stats.blank_count} well(s) flagged as blank/low.` : ""
          }</div>
        </section>`
      : ""
  }

  ${isPlate ? `<section class="block">
    <h2>Calculated plate results</h2>
    <p>${esc(potencyAnswer(plateResults ?? null))}</p>
    ${plateResults?.layout ? `<p>Confirmed layout: vehicle ${esc(plateResults.qc.vehicle.wells.join(", ") || "none")};
      blank ${esc(plateResults.qc.blank.wells.join(", ") || "none")};
      kill control ${esc(plateResults.qc.kill.wells.join(", ") || "none")}.</p>` : ""}
    ${plateResults?.fit ? `<p>Response = 100 × (well − mean blank) / (mean vehicle − mean blank).
      The four-parameter logistic uses the mean response at each concentration.
      R² ${esc(formatPlateNumber(plateResults.fit.r2))}.
      Hill slope magnitude ${esc(formatPlateNumber(plateResults.fit.hill))}.</p>` : ""}
    <p>${plateResults?.qc.zPrime == null ? "Z′ needs replicate vehicle and kill controls."
      : `Z′ ${esc(formatPlateNumber(plateResults.qc.zPrime))}. Controls: n=${plateResults.qc.vehicle.count} vehicle, n=${plateResults.qc.kill.count} kill.`}</p>
    <p>Z′ = 1 − 3 × (vehicle SD + kill-control SD) / |mean vehicle − mean kill control|.</p>
  </section>` : ""}
  ${
    isPlate && !plateResults?.layout ? "" : detailedReport
      ? `<section class="block"><h2>Detailed Data Analysis Report</h2><div class="prose">${mdLite(
          detailedReport,
        )}</div></section>`
      : experiment.ai_summary
      ? `<section class="block"><h2>AI summary</h2><div class="prose">${mdLite(
          experiment.ai_summary,
        )}</div></section>`
      : ""
  }

  ${suggestionsHtml}

  ${
    experiment.notes
      ? `<section class="block"><h2>Notes</h2><div class="notes">${esc(experiment.notes)}</div></section>`
      : ""
  }

  <footer>
    <span>Generated by Bioalyzer</span>
    <span>${esc(generated)}</span>
  </footer>
</div></body></html>`;

  // Render into a hidden iframe and invoke the print dialog. Iframes avoid the
  // popup blocker that window.open() trips, and isolate report styles from the app.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  const cleanup = () => {
    // Delay removal so the print dialog can read the document first.
    setTimeout(() => iframe.remove(), 1000);
  };

  const win = iframe.contentWindow;
  if (win) {
    win.onafterprint = cleanup;
    // Give layout a tick to settle before printing.
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        iframe.remove();
      }
    }, 250);
  } else {
    cleanup();
  }
}
