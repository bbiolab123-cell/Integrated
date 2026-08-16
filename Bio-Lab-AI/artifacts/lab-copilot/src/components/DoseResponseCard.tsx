import { useState, useEffect, useRef, useMemo } from "react";
import { ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TrendingDown, ChevronDown, ChevronRight } from "lucide-react";
import { fit4PL, serialDilution, type DosePoint } from "@/lib/doseResponse";
import { percentOfControl, type WellRole } from "@/lib/plateMetrics";

interface Well {
  well: string;
  row: string;
  col: number;
  value: number | null;
  status: string;
}

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

interface DoseConfig {
  orientation: "row" | "column";
  index: string;       // row letter or column number (as string)
  topConc: number | null;
  unit: string;
  dilution: number;
  reverse: boolean;
}

const DEFAULT_CONFIG: DoseConfig = {
  orientation: "column",
  index: "1",
  topConc: null,
  unit: "µM",
  dilution: 3,
  reverse: false,
};

function fmtConc(x: number): string {
  if (x >= 100) return x.toFixed(0);
  if (x >= 1) return x.toFixed(1);
  if (x >= 0.01) return x.toFixed(2);
  return x.toExponential(1);
}

export function DoseResponseCard({
  expId,
  wells,
  meanPos,
  meanNeg,
  roles,
}: {
  expId: number;
  wells: Well[];
  meanPos: number | null;
  meanNeg: number | null;
  /** Plate layout. Wells the scientist marked as blanks are not part of the
   *  dilution series and are excluded from the fit. */
  roles?: Record<string, WellRole>;
}) {
  const [cfg, setCfg] = useState<DoseConfig>(DEFAULT_CONFIG);
  const [expanded, setExpanded] = useState(false);
  const skipRef = useRef(true);

  useEffect(() => {
    skipRef.current = true;
    try {
      const raw = expId ? localStorage.getItem(`dose:${expId}`) : null;
      setCfg(raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG);
    } catch { setCfg(DEFAULT_CONFIG); }
  }, [expId]);

  useEffect(() => {
    if (skipRef.current) { skipRef.current = false; return; }
    try { localStorage.setItem(`dose:${expId}`, JSON.stringify(cfg)); } catch { /* ignore */ }
  }, [expId, cfg]);

  const set = (patch: Partial<DoseConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const wellMap = useMemo(() => {
    const m = new Map<string, Well>();
    for (const w of wells) m.set(w.well, w);
    return m;
  }, [wells]);

  const normalize = meanPos != null && meanNeg != null && meanPos !== meanNeg;

  const { points, fit } = useMemo(() => {
    let series: Well[] = cfg.orientation === "column"
      ? ROWS.map((r) => wellMap.get(`${r}${cfg.index}`)).filter((w): w is Well => !!w)
      : COLS.map((c) => wellMap.get(`${cfg.index}${c}`)).filter((w): w is Well => !!w);
    if (cfg.reverse) series = [...series].reverse();

    if (cfg.topConc == null || cfg.topConc <= 0) {
      return { points: [] as (DosePoint & { well: string })[], fit: null };
    }

    // Dose comes from a well's POSITION in the dilution series, so doses are
    // assigned across the full row/column first and unusable wells are dropped
    // afterwards. Filtering before this shifted every later well onto its
    // neighbour's concentration — one unread well silently rewrote the curve.
    const doses = serialDilution(cfg.topConc, cfg.dilution > 1 ? cfg.dilution : 2, series.length);
    const pts = series
      .map((w, i) => ({ well: w, dose: doses[i] }))
      .filter(({ well }) => well.value !== null && roles?.[well.well] !== "blank")
      .map(({ well, dose }) => ({
        dose,
        response: normalize
          ? (percentOfControl(well.value as number, meanPos, meanNeg) ?? (well.value as number))
          : (well.value as number),
        well: well.well,
      }));

    if (pts.length < 4) {
      return { points: [] as (DosePoint & { well: string })[], fit: null };
    }
    return { points: pts, fit: fit4PL(pts) };
  }, [cfg, wellMap, normalize, meanPos, meanNeg, roles]);

  return (
    <Card>
      <CardHeader className="py-4 border-b cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingDown className="h-5 w-5 text-primary" />
            Dose-response (IC50)
            {!expanded && fit && (
              <span className="text-sm font-normal text-muted-foreground">· IC50 {fmtConc(fit.ic50)} {cfg.unit}</span>
            )}
          </CardTitle>
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </CardHeader>
      {expanded && (
      <CardContent className="pt-4 space-y-4">
        {/* Config */}
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Series</span>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {(["column", "row"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => set({ orientation: o, index: o === "column" ? "1" : "A" })}
                  className={`px-2.5 py-1 text-xs transition-colors ${cfg.orientation === o ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                >
                  {o === "column" ? "Column" : "Row"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{cfg.orientation === "column" ? "Which column" : "Which row"}</span>
            <select
              value={cfg.index}
              onChange={(e) => set({ index: e.target.value })}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              {(cfg.orientation === "column" ? COLS.map(String) : ROWS).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Top concentration</span>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                inputMode="decimal"
                placeholder="e.g. 100"
                value={cfg.topConc ?? ""}
                onChange={(e) => set({ topConc: e.target.value === "" ? null : Number(e.target.value) })}
                className="h-8 w-24 font-mono text-sm"
              />
              <Input
                value={cfg.unit}
                onChange={(e) => set({ unit: e.target.value })}
                className="h-8 w-16 text-sm"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Dilution</span>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">1/</span>
              <Input
                type="number"
                inputMode="decimal"
                value={cfg.dilution}
                onChange={(e) => set({ dilution: Number(e.target.value) || 2 })}
                className="h-8 w-16 font-mono text-sm"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => set({ reverse: !cfg.reverse })}
            className={`h-8 px-2.5 rounded-md border text-xs transition-colors ${cfg.reverse ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
            title="Flip which end of the series is the highest concentration"
          >
            Reverse
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          The selected {cfg.orientation} is read as a serial dilution from the top concentration.
          {normalize ? " Response is normalized to % of control." : " Response uses raw signal — mark controls to normalize."}
        </p>

        {/* Result */}
        {fit ? (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm font-mono">
              <span>
                <span className="text-muted-foreground">IC50/EC50: </span>
                <span className="font-semibold text-primary">{fmtConc(fit.ic50)} {cfg.unit}</span>
                {!fit.ic50InRange && <span className="text-yellow-600 text-xs"> (outside tested range)</span>}
              </span>
              <span><span className="text-muted-foreground">Hill: </span>{fit.hill.toFixed(2)}</span>
              <span className={fit.r2 >= 0.95 ? "text-emerald-500" : fit.r2 >= 0.8 ? "text-yellow-500" : "text-destructive"}>
                R² = {fit.r2.toFixed(3)}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  type="number"
                  dataKey="dose"
                  scale="log"
                  domain={[fit.curve[0].dose, fit.curve[fit.curve.length - 1].dose]}
                  allowDataOverflow
                  tickFormatter={fmtConc}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  label={{ value: `Concentration (${cfg.unit})`, position: "insideBottom", offset: -8, fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  type="number"
                  dataKey="response"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  label={{ value: normalize ? "% of control" : "Signal", angle: -90, position: "insideLeft", fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => [typeof v === "number" ? v.toFixed(1) : v, normalize ? "% of control" : "signal"]}
                  labelFormatter={(l: number) => `${fmtConc(l)} ${cfg.unit}`}
                />
                <Line data={fit.curve} dataKey="response" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Scatter data={points} dataKey="response" fill="hsl(var(--primary))" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Enter a top concentration and pick the dilution series (need ≥4 wells with data) to fit an IC50/EC50 curve.
          </p>
        )}
      </CardContent>
      )}
    </Card>
  );
}
