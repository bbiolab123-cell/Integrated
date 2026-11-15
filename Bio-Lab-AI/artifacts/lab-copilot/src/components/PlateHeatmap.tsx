import { useState, forwardRef } from "react";
import { ROLE_COLOR, ROLE_SHORT, percentOfControl, type WellRole } from "@/lib/plateMetrics";

interface WellData {
  well: string;
  row: string;
  col: number;
  value: number | null;
  status: "ok" | "blank" | "high" | "low";
  cv_pct: number | null;
}

interface PlateStats {
  mean: number | null;
  sd: number | null;
  cv_pct: number | null;
  min: number | null;
  max: number | null;
  blank_count: number;
  well_count: number;
}

interface PlateHeatmapProps {
  wells: WellData[];
  stats: PlateStats;
  wavelength?: string | null;
  compact?: boolean;
  /** When set, wells are colored binary pass/fail against this cutoff instead of the gradient. */
  passThreshold?: number | null;
  /** "above" = pass when value >= cutoff; "below" = pass when value <= cutoff. */
  passDirection?: "above" | "below";
  /** Per-well role assignments (plate layout). Shown as colored rings + letters. */
  roles?: Record<string, WellRole>;
  /** In edit mode, clicking a well / row label / column header assigns the active role. */
  editMode?: boolean;
  onAssignWell?: (well: string) => void;
  onAssignRow?: (row: string) => void;
  onAssignCol?: (col: number) => void;
  /** Color wells by % of control (needs meanPos/meanNeg from the marked controls). */
  normalizeToControl?: boolean;
  meanPos?: number | null;
  meanNeg?: number | null;
}

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function interpolateColor(t: number): string {
  const stops = [
    { t: 0.0, r: 59, g: 130, b: 246 },
    { t: 0.33, r: 34, g: 197, b: 94 },
    { t: 0.66, r: 234, g: 179, b: 8 },
    { t: 1.0, r: 239, g: 68, b: 68 },
  ];

  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }

  const range = hi.t - lo.t;
  const f = range === 0 ? 0 : (t - lo.t) / range;
  const r = Math.round(lo.r + f * (hi.r - lo.r));
  const g = Math.round(lo.g + f * (hi.g - lo.g));
  const b = Math.round(lo.b + f * (hi.b - lo.b));
  return `rgb(${r},${g},${b})`;
}

// % -of-control scale: 0% (negative control / dead) red → 50% yellow → 100% (positive / viable) green.
function normColor(pct: number): string {
  const t = Math.max(0, Math.min(1, pct / 100));
  const stops: [number, number, number][] = [[239, 68, 68], [234, 179, 8], [34, 197, 94]];
  const seg = t * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

export const PlateHeatmap = forwardRef<HTMLDivElement, PlateHeatmapProps>(function PlateHeatmap({ wells, stats, wavelength, compact = false, passThreshold = null, passDirection = "above", roles, editMode = false, onAssignWell, onAssignRow, onAssignCol, normalizeToControl = false, meanPos = null, meanNeg = null }, ref) {
  const [tooltip, setTooltip] = useState<{
    well: string;
    value: number | null;
    status: string;
    x: number;
    y: number;
  } | null>(null);

  const wellMap = new Map<string, WellData>();
  for (const w of wells) wellMap.set(w.well, w);

  const { min, max } = stats;
  const range = (min !== null && max !== null && max > min) ? max - min : 1;

  const getNorm = (value: number | null): number => {
    if (value === null || min === null) return 0;
    return Math.max(0, Math.min(1, (value - min) / range));
  };

  const thresholdActive = passThreshold !== null && passThreshold !== undefined && !Number.isNaN(passThreshold);
  const isPass = (value: number) =>
    passDirection === "below" ? value <= (passThreshold as number) : value >= (passThreshold as number);

  const normActive = normalizeToControl && meanPos != null && meanNeg != null && meanPos !== meanNeg;
  const pctOf = (value: number) => percentOfControl(value, meanPos, meanNeg);

  const getWellStyle = (w: WellData): React.CSSProperties => {
    const role = roles?.[w.well];
    const roleBorder = role ? `2px solid ${ROLE_COLOR[role]}` : null;
    if (w.value === null) {
      return {
        backgroundColor: "hsl(var(--muted))",
        opacity: 0.4,
        border: roleBorder ?? "1px solid hsl(var(--border))",
      };
    }
    if (thresholdActive) {
      const pass = isPass(w.value);
      return {
        backgroundColor: pass ? "rgb(34,197,94)" : "rgb(239,68,68)",
        border: roleBorder ?? "1px solid transparent",
        opacity: pass ? 1 : 0.9,
      };
    }
    if (normActive) {
      const pct = pctOf(w.value);
      return {
        backgroundColor: pct == null ? interpolateColor(getNorm(w.value)) : normColor(pct),
        border: roleBorder ?? "1px solid transparent",
      };
    }
    const t = getNorm(w.value);
    return {
      backgroundColor: interpolateColor(t),
      border: roleBorder ?? (w.status === "high" || w.status === "low"
        ? "2px solid hsl(var(--destructive))"
        : "1px solid transparent"),
    };
  };

  const Cell = editMode ? "button" : "div";
  const cellSize = compact ? "w-7 h-7 text-[9px]" : "w-8 h-8 text-[10px]";
  const labelSize = compact ? "text-[9px]" : "text-[10px]";

  return (
    <div ref={ref} className="select-none">
      <div className="overflow-x-auto">
        <div className="inline-block">
          <div className="flex items-center gap-0.5 mb-1 ml-6">
            {COLS.map((c) => (
              <Cell
                key={c}
                type={editMode ? "button" : undefined}
                aria-label={editMode ? `Column ${c}` : undefined}
                onClick={editMode ? () => onAssignCol?.(c) : undefined}
                className={`${compact ? "w-7" : "w-8"} text-center font-mono ${labelSize} text-muted-foreground ${editMode ? "cursor-pointer rounded hover:text-primary hover:bg-primary/10" : ""}`}
              >
                {c}
              </Cell>
            ))}
          </div>

          {ROWS.map((r) => (
            <div key={r} className="flex items-center gap-0.5 mb-0.5">
              <Cell
                type={editMode ? "button" : undefined}
                aria-label={editMode ? `Row ${r}` : undefined}
                onClick={editMode ? () => onAssignRow?.(r) : undefined}
                className={`w-5 text-right font-mono ${labelSize} text-muted-foreground mr-1 flex-shrink-0 ${editMode ? "cursor-pointer rounded hover:text-primary hover:bg-primary/10" : ""}`}
              >
                {r}
              </Cell>
              {COLS.map((c) => {
                const wellId = `${r}${c}`;
                const well = wellMap.get(wellId);
                if (!well) {
                  return (
                    <div
                      key={wellId}
                      className={`${cellSize} rounded-full bg-muted/30 flex-shrink-0`}
                    />
                  );
                }
                const role = roles?.[wellId];
                return (
                  <Cell
                    key={wellId}
                    type={editMode ? "button" : undefined}
                    aria-label={editMode ? `Well ${wellId}` : undefined}
                    className={`${cellSize} rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer transition-transform hover:scale-110 hover:z-10 relative`}
                    style={getWellStyle(well)}
                    onClick={editMode ? () => onAssignWell?.(wellId) : undefined}
                    onMouseEnter={(e) => {
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setTooltip({
                        well: wellId,
                        value: well.value,
                        status: well.status,
                        x: rect.left + rect.width / 2,
                        y: rect.top - 8,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    {role && (
                      <span
                        className="font-bold leading-none pointer-events-none"
                        style={{ color: "#fff", textShadow: "0 0 2px rgba(0,0,0,0.7)" }}
                      >
                        {ROLE_SHORT[role]}
                      </span>
                    )}
                  </Cell>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y, transform: "translate(-50%,-100%)" }}
        >
          <div className="bg-popover border border-border rounded-md shadow-lg px-2.5 py-1.5 text-xs font-mono">
            <div className="font-semibold text-foreground">{tooltip.well}</div>
            <div className="text-muted-foreground">
              {tooltip.value !== null ? tooltip.value.toFixed(4) : "N/A"}
              {wavelength ? ` @ ${wavelength}` : ""}
            </div>
            <div
              className={
                tooltip.status === "blank"
                  ? "text-muted-foreground"
                  : tooltip.status === "high" || tooltip.status === "low"
                  ? "text-destructive"
                  : "text-emerald-500"
              }
            >
              {tooltip.status === "blank"
                ? "Blank / No signal"
                : tooltip.status === "high"
                ? "⚠ High outlier"
                : tooltip.status === "low"
                ? "⚠ Low outlier"
                : "OK"}
            </div>
            {thresholdActive && tooltip.value !== null && tooltip.status !== "blank" && (
              <div className={isPass(tooltip.value) ? "text-emerald-500" : "text-destructive"}>
                {isPass(tooltip.value) ? "✓ Pass" : "✗ Fail"} ({passDirection === "below" ? "≤" : "≥"} {passThreshold})
              </div>
            )}
            {normActive && tooltip.value !== null && tooltip.status !== "blank" && pctOf(tooltip.value) != null && (
              <div className="text-foreground">{pctOf(tooltip.value)!.toFixed(0)}% of control</div>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3 flex-wrap">
        {normActive ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>% of control</span>
            <div className="flex gap-0.5">
              {[0, 25, 50, 75, 100].map((p) => (
                <div key={p} className="w-4 h-3 rounded-sm" style={{ backgroundColor: normColor(p) }} />
              ))}
            </div>
            <span className="font-mono">0% – 100%</span>
          </div>
        ) : thresholdActive ? (
          <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgb(34,197,94)" }} /> Pass
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgb(239,68,68)" }} /> Fail
            </span>
            <span className="font-mono">
              cutoff {passDirection === "below" ? "≤" : "≥"} {passThreshold}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className="flex gap-0.5">
              {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                <div
                  key={t}
                  className="w-4 h-3 rounded-sm"
                  style={{ backgroundColor: interpolateColor(t) }}
                />
              ))}
            </div>
            <span className="font-mono">
              {min?.toFixed(3)} – {max?.toFixed(3)}
            </span>
            {wavelength && <span>nm: {wavelength}</span>}
          </div>
        )}

        <div className="flex gap-3 text-xs font-mono text-muted-foreground ml-auto">
          {stats.mean !== null && <span>Mean: {stats.mean}</span>}
          {stats.sd !== null && <span>SD: {stats.sd}</span>}
          {stats.cv_pct !== null && (
            <span className={stats.cv_pct > 20 ? "text-destructive" : stats.cv_pct > 10 ? "text-yellow-500" : "text-emerald-500"}>
              CV: {stats.cv_pct.toFixed(1)}%
            </span>
          )}
          {stats.blank_count > 0 && (
            <span className="text-muted-foreground">{stats.blank_count} blank</span>
          )}
        </div>
      </div>
    </div>
  );
});
