import { useState, useRef, useEffect } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { useQueryClient } from "@tanstack/react-query";
import { useListExperiments, useGetExperiment, getListExperimentsQueryKey, getGetExperimentQueryKey, getListGeminiMessagesQueryKey } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart3,
  BrainCircuit,
  Calendar,
  FlaskConical,
  Microscope,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  RotateCcw,
  Loader2,
  FileBarChart,
  GitCompare,
  Sparkles,
  FileDown,
  MessageSquare,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine, ComposedChart, Line, Scatter, CartesianGrid } from "recharts";
import { fit4PL, serialDilution } from "@/lib/doseResponse";
import { PlateHeatmap } from "@/components/PlateHeatmap";
import { CopilotChat } from "@/components/chat/CopilotChat";
import { AttachDataCard } from "@/components/experiment/AttachDataCard";
import { buildControlSummary, type WellRole } from "@/lib/plateMetrics";
import { printExperimentReport } from "@/lib/printExperimentReport";
import { LabConversation, LabPageHeader, LabPanel, LabSectionHeader } from "@/components/lab/LivingLab";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";

// The parser emits one of two shapes into experiments.raw_data_json:
//  1. A 96-well plate ("_type":"plate96") with { stats, wells, metadata }
//  2. A generic CSV/TSV summary with { total_rows, columns, signal_stats, condition_groups }
// This page understands both and degrades to a clear message when neither is present.

interface PlateWell {
  well: string;
  row: string;
  col: number;
  value: number | null;
  status: "ok" | "blank" | "high" | "low";
  cv_pct: number | null;
}

interface Plate96Summary {
  _type: "plate96";
  metadata?: { wavelength?: string | null; protocol?: string | null };
  stats?: {
    mean: number | null;
    sd: number | null;
    cv_pct: number | null;
    min: number | null;
    max: number | null;
    blank_count: number;
    well_count: number;
  };
  wells?: PlateWell[];
  // Present in the backend's plate96 payload — declared here so it survives
  // through to printExperimentReport's PDF heatmap render.
  read_matrix?: (number | null)[][];
}

interface CsvSummary {
  filename?: string;
  total_rows?: number;
  columns?: string[];
  signal_stats?: { mean?: string; sd?: string; n?: number };
  condition_groups?: Array<{ condition: string; n: number; mean: string | null }>;
}

type ParsedSummary =
  | ({ kind: "plate96" } & Plate96Summary)
  | ({ kind: "csv" } & CsvSummary)
  | null;

function parseSummary(raw: string | null | undefined): ParsedSummary {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed._type === "plate96") return { kind: "plate96", ...parsed };
    if (Array.isArray(parsed.columns) || parsed.signal_stats || parsed.condition_groups) {
      return { kind: "csv", ...parsed };
    }
    return null;
  } catch {
    return null;
  }
}

function hasGraphableData(summary: ParsedSummary): boolean {
  if (!summary) return false;
  if (summary.kind === "plate96") {
    return Array.isArray(summary.wells) && summary.wells.some((w) => w.value !== null);
  }
  return !!summary.signal_stats || (Array.isArray(summary.condition_groups) && summary.condition_groups.length > 0);
}

// Mean signal per plate column (1–12) — a quick way to spot dose gradients or
// edge effects (columns 1/12 drifting from the interior).
function columnMeans(wells: PlateWell[]): { col: string; mean: number }[] {
  const sums = new Map<number, { total: number; n: number }>();
  for (const w of wells) {
    if (w.value === null || w.status === "blank") continue;
    const acc = sums.get(w.col) ?? { total: 0, n: 0 };
    acc.total += w.value;
    acc.n += 1;
    sums.set(w.col, acc);
  }
  const out: { col: string; mean: number }[] = [];
  for (let c = 1; c <= 12; c++) {
    const acc = sums.get(c);
    if (acc && acc.n > 0) out.push({ col: String(c), mean: acc.total / acc.n });
  }
  return out;
}

// Mean signal per plate row (A–H) — mirrors columnMeans for row-wise gradients.
function rowMeans(wells: PlateWell[]): { row: string; mean: number }[] {
  const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const sums = new Map<string, { total: number; n: number }>();
  for (const w of wells) {
    if (w.value === null || w.status === "blank") continue;
    const acc = sums.get(w.row) ?? { total: 0, n: 0 };
    acc.total += w.value;
    acc.n += 1;
    sums.set(w.row, acc);
  }
  const out: { row: string; mean: number }[] = [];
  for (const r of ROWS) {
    const acc = sums.get(r);
    if (acc && acc.n > 0) out.push({ row: r, mean: acc.total / acc.n });
  }
  return out;
}

// Every well's raw value in plate order — a general distribution/outlier view.
function wellScatter(wells: PlateWell[]): { well: string; value: number }[] {
  return wells
    .filter((w) => w.value !== null && w.status !== "blank")
    .map((w) => ({ well: w.well, value: w.value as number }));
}

function ExperimentMetaCard({ id }: { id: number }) {
  const { data, isLoading } = useGetExperiment(id, {
    query: { enabled: !!id, queryKey: getGetExperimentQueryKey(id) },
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <Card className="border-primary/20 dark:bg-card/80">
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base text-primary leading-tight">{data.name}</CardTitle>
            <StatusBadge status={data.status} />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1">
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {format(parseISO(data.date), "MMM d, yyyy")}
            </span>
            <span className="flex items-center gap-1">
              <FlaskConical className="h-3 w-3" />
              {data.assay_type}
            </span>
            <span className="flex items-center gap-1">
              <Microscope className="h-3 w-3" />
              {data.instrument}
            </span>
          </div>
        </CardHeader>
        {data.notes && (
          <CardContent className="pt-3">
            <p className="text-sm text-muted-foreground font-mono leading-relaxed">{data.notes}</p>
          </CardContent>
        )}
      </Card>
    </motion.div>
  );
}

function StatGrid({ items }: { items: { label: string; value: string; highlight?: "warn" | "ok" }[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-muted/30 p-3 text-center">
          <div className={`text-lg font-bold font-mono ${item.highlight === "warn" ? "text-yellow-500" : item.highlight === "ok" ? "text-emerald-500" : "text-foreground"}`}>
            {item.value}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function Plate96Panel({ summary }: { summary: { kind: "plate96" } & Plate96Summary }) {
  const stats = summary.stats;
  const wells = summary.wells ?? [];
  const outliers = wells.filter((w) => w.status === "high" || w.status === "low");
  const colMeans = columnMeans(wells);
  const cv = stats?.cv_pct ?? null;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.1 }} className="space-y-4">
      {stats && (
        <Card className="border-primary/20 dark:bg-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Plate Statistics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <StatGrid
              items={[
                { label: "Mean", value: stats.mean != null ? stats.mean.toFixed(3) : "—" },
                { label: "SD", value: stats.sd != null ? stats.sd.toFixed(3) : "—" },
                { label: "CV%", value: cv != null ? `${cv.toFixed(1)}%` : "—", highlight: cv != null ? (cv > 20 ? "warn" : "ok") : undefined },
                { label: "Wells (n)", value: String(stats.well_count ?? "—") },
                { label: "Min", value: stats.min != null ? stats.min.toFixed(3) : "—" },
                { label: "Max", value: stats.max != null ? stats.max.toFixed(3) : "—" },
                { label: "Blanks", value: String(stats.blank_count ?? 0) },
                { label: "Outliers", value: String(outliers.length) },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {colMeans.length > 1 && (
        <Card className="border-primary/20 dark:bg-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Mean Signal by Column
            </CardTitle>
            <CardDescription>Flat bars = uniform plate. A gradient across columns can signal a dose series or an edge/evaporation effect.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={colMeans} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                  <XAxis dataKey="col" tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" width={48} domain={["auto", "auto"]} />
                  <Tooltip
                    formatter={(v: number) => [v.toFixed(3), "mean"]}
                    labelFormatter={(l) => `Column ${l}`}
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                  />
                  {stats?.mean != null && <ReferenceLine y={stats.mean} stroke="hsl(var(--primary))" strokeDasharray="3 3" />}
                  <Bar dataKey="mean" radius={[3, 3, 0, 0]}>
                    {colMeans.map((entry) => (
                      <Cell key={entry.col} fill="hsl(var(--primary))" fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {outliers.length > 0 && (
        <Card className="border-yellow-500/20 bg-yellow-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-4 w-4" />
              Outlier Wells ({outliers.length})
            </CardTitle>
            <CardDescription>Wells &gt; 2 SD from the plate mean — candidates for pipetting errors, bubbles, or edge effects.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {outliers.map((w) => (
                <Badge key={w.well} variant="outline" className="font-mono text-yellow-600 border-yellow-500/40">
                  {w.well} ({w.status}{w.value != null ? ` · ${w.value.toFixed(2)}` : ""})
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}

function CsvPanel({ summary }: { summary: { kind: "csv" } & CsvSummary }) {
  const sig = summary.signal_stats;
  const groups = summary.condition_groups ?? [];
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.1 }} className="space-y-4">
      <Card className="border-primary/20 dark:bg-card/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            Tabular Data Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <StatGrid
            items={[
              { label: "Rows", value: String(summary.total_rows ?? "—") },
              { label: "Columns", value: String(summary.columns?.length ?? "—") },
              { label: "Signal Mean", value: sig?.mean ?? "—" },
              { label: "Signal SD", value: sig?.sd ?? "—" },
            ]}
          />
        </CardContent>
      </Card>

      {groups.length > 0 && (
        <Card className="border-primary/20 dark:bg-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Condition Groups
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left pb-2 font-medium">Condition</th>
                    <th className="text-right pb-2 font-medium">n</th>
                    <th className="text-right pb-2 font-medium">Mean</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {groups.map((g, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0">
                      <td className="py-2 text-left text-primary">{g.condition}</td>
                      <td className="py-2 text-right text-muted-foreground">{g.n}</td>
                      <td className="py-2 text-right">{g.mean ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}

function QuantitativeSummaryPanel({ id }: { id: number }) {
  const { data, isLoading } = useGetExperiment(id, {
    query: { enabled: !!id, queryKey: getGetExperimentQueryKey(id) },
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  const summary = parseSummary(data.raw_data_json);

  if (!summary || !hasGraphableData(summary)) {
    return (
      <Card className="border-yellow-500/20 bg-yellow-500/5">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">No quantitative summary available</p>
              <p className="text-sm text-muted-foreground mt-1">
                This experiment has no parsed plate or tabular data. Create a new experiment and upload a Synergy H1 / Gen5 Excel export (or a CSV/TSV) to see numeric metrics here.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return summary.kind === "plate96"
    ? <Plate96Panel summary={summary} />
    : <CsvPanel summary={summary} />;
}

interface QuantifyChartSpec {
  type: "column_means" | "row_means" | "well_scatter" | "dose_response";
  title: string;
  dose_response_config?: {
    orientation: "row" | "column";
    index: string;
    top_concentration: number;
    unit: string;
    dilution_factor: number;
    reverse: boolean;
  };
}

function fmtConc(x: number): string {
  if (x >= 100) return x.toFixed(0);
  if (x >= 1) return x.toFixed(1);
  if (x >= 0.01) return x.toFixed(2);
  return x.toExponential(1);
}

// Renders the chart the AI picked — but the AI only ever chose the TYPE (and,
// for dose-response, config it read from the scientist's own question). Every
// number plotted here is computed from the real wells, never from the AI's
// response text.
function QuantifyChart({ spec, wells }: { spec: QuantifyChartSpec; wells: PlateWell[] }) {
  const tooltipStyle = {
    contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 },
    itemStyle: { color: "hsl(var(--popover-foreground))" },
    labelStyle: { color: "hsl(var(--popover-foreground))" },
  };

  if (spec.type === "column_means" || spec.type === "row_means") {
    const isCol = spec.type === "column_means";
    const data = isCol ? columnMeans(wells) : rowMeans(wells);
    if (data.length === 0) return <p className="text-xs text-muted-foreground">Not enough data to plot.</p>;
    return (
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <XAxis dataKey={isCol ? "col" : "row"} tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" />
            <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" width={44} domain={["auto", "auto"]} />
            <Tooltip
              formatter={(v: number) => [v.toFixed(3), "mean"]}
              labelFormatter={(l) => isCol ? `Column ${l}` : `Row ${l}`}
              {...tooltipStyle}
            />
            <Bar dataKey="mean" radius={[3, 3, 0, 0]} fill="hsl(var(--primary))" fillOpacity={0.8} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (spec.type === "well_scatter") {
    const data = wellScatter(wells);
    if (data.length === 0) return <p className="text-xs text-muted-foreground">Not enough data to plot.</p>;
    return (
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="well" tick={{ fontSize: 9 }} stroke="currentColor" className="text-muted-foreground" interval={Math.ceil(data.length / 16)} />
            <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" width={44} domain={["auto", "auto"]} />
            <Tooltip formatter={(v: number) => [v.toFixed(3), "value"]} {...tooltipStyle} />
            <Scatter dataKey="value" fill="hsl(var(--primary))" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // dose_response
  const cfg = spec.dose_response_config;
  if (!cfg) return <p className="text-xs text-muted-foreground">Missing dose configuration — try specifying the column/row, top concentration, and dilution factor.</p>;

  const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const wellMap = new Map(wells.map((w) => [w.well, w]));
  let series = cfg.orientation === "column"
    ? ROWS.map((r) => wellMap.get(`${r}${cfg.index}`)).filter((w): w is PlateWell => !!w)
    : COLS.map((c) => wellMap.get(`${cfg.index}${c}`)).filter((w): w is PlateWell => !!w);
  series = series.filter((w) => w.value !== null && w.status !== "blank");
  if (cfg.reverse) series = [...series].reverse();

  if (series.length < 4) {
    return <p className="text-xs text-muted-foreground">Not enough wells along that {cfg.orientation} to fit a curve (need at least 4).</p>;
  }
  const doses = serialDilution(cfg.top_concentration, cfg.dilution_factor > 1 ? cfg.dilution_factor : 2, series.length);
  const points = series.map((w, i) => ({ dose: doses[i], response: w.value as number, well: w.well }));
  const fit = fit4PL(points);
  if (!fit) return <p className="text-xs text-muted-foreground">Couldn't fit a dose-response curve to this data.</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono">
        <span><span className="text-muted-foreground">IC50/EC50: </span><span className="font-semibold text-primary">{fmtConc(fit.ic50)} {cfg.unit}</span>{!fit.ic50InRange && <span className="text-yellow-600"> (outside tested range)</span>}</span>
        <span><span className="text-muted-foreground">Hill: </span>{fit.hill.toFixed(2)}</span>
        <span className={fit.r2 >= 0.95 ? "text-emerald-500" : fit.r2 >= 0.8 ? "text-yellow-500" : "text-destructive"}>R² = {fit.r2.toFixed(3)}</span>
      </div>
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              type="number"
              dataKey="dose"
              scale="log"
              domain={[fit.curve[0].dose, fit.curve[fit.curve.length - 1].dose]}
              allowDataOverflow
              tickFormatter={fmtConc}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
            />
            <YAxis type="number" dataKey="response" tick={{ fontSize: 10 }} stroke="currentColor" className="text-muted-foreground" width={44} />
            <Tooltip
              formatter={(v: number) => [typeof v === "number" ? v.toFixed(2) : v, "signal"]}
              labelFormatter={(l: number) => `${fmtConc(l)} ${cfg.unit}`}
              {...tooltipStyle}
            />
            <Line data={fit.curve} dataKey="response" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} isAnimationActive={false} />
            <Scatter data={points} dataKey="response" fill="hsl(var(--primary))" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Focused "ask for a computed answer" box — e.g. dose-response/IC50 questions
 * that used to require a dedicated curve-fitting widget with manual row/column/
 * concentration config. Uses a dedicated non-streaming endpoint (not the
 * general chat) so the AI can return a chart TYPE + config alongside its
 * answer — but it persists into the SAME conversation as the "Ask about this
 * data" chat below, so both surfaces show one continuous history. The AI never
 * invents chart data: every plotted number is computed here from the real wells.
 */
function QuantifyBox({ experimentId, conversationId, wells }: { experimentId: number; conversationId: number; wells: PlateWell[] }) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const [askedQuestion, setAskedQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [chart, setChart] = useState<QuantifyChartSpec | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || isAsking) return;

    setIsAsking(true);
    setAskedQuestion(q);
    setAnswer("");
    setChart(null);
    setAskError(null);
    setQuestion("");

    try {
      const response = await apiFetch(`/api/experiments/${experimentId}/quantify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error ?? "Request failed");
      }
      const data = await response.json();
      setAnswer(data.answer ?? "");
      setChart(data.chart ?? null);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Couldn't reach the AI. Try again.");
    } finally {
      setIsAsking(false);
      queryClient.invalidateQueries({ queryKey: getListGeminiMessagesQueryKey(conversationId) });
    }
  };

  return (
    <Card className="lab-panel rounded-[1.6rem] border-primary/20 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          Quantify anything
        </CardTitle>
        <CardDescription>
          Ask for a specific computed answer or chart — e.g. "what's the IC50 for this dose series in column 1, top conc 100µM, 3-fold dilution?" or "show me the mean signal by row." Grounded in this experiment's protocol and data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={ask} className="flex gap-2">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. what's the IC50 for this run?"
            rows={1}
            className="text-sm min-h-9 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(e as unknown as React.FormEvent);
              }
            }}
          />
          <Button type="submit" size="sm" disabled={isAsking || !question.trim()} className="gap-1.5 flex-shrink-0">
            {isAsking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
            Ask
          </Button>
        </form>

        {askError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            {askError}
          </div>
        )}

        {isAsking && !answer && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Working it out…
          </div>
        )}

        {answer && (
          <div className="rounded-lg border border-border bg-background/60 p-3 space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">{askedQuestion}</div>
              <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
              </div>
            </div>
            {chart && (
              <div className="pt-2 border-t border-border">
                <div className="text-xs font-medium text-muted-foreground mb-2">{chart.title}</div>
                <QuantifyChart spec={chart} wells={wells} />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DataAnalysisPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [report, setReport] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasReport, setHasReport] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [reportRequestId, setReportRequestId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Two distinct fields, collected via a pop-up the moment an experiment is
  // selected (not gated on data existing — the AI already has protocol/notes
  // context from the experiment tab; these steer THIS analysis specifically):
  // "notes" = extra context beyond the protocol; "quantifyRequest" = what to
  // actually compute. refineNote is a smaller follow-up once a report exists
  // (mirrors the Protocol refine pattern).
  const [notes, setNotes] = useState("");
  const [quantifyRequest, setQuantifyRequest] = useState("");
  const [refineNote, setRefineNote] = useState("");
  const [showFocusModal, setShowFocusModal] = useState(false);
  // Tracks which experiment id we've already prompted for (submitted OR skipped),
  // so re-renders don't keep re-popping the modal for the same selection.
  const promptedForId = useRef<number | null>(null);

  // Compare mode — lives here instead of a separate nav page. Pick a second
  // experiment and stream an AI comparison against the selected one.
  const [compareId, setCompareId] = useState<number | null>(null);
  const [compareReport, setCompareReport] = useState("");
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareRequestId, setCompareRequestId] = useState<string | null>(null);
  const compareAbortRef = useRef<AbortController | null>(null);

  const { data: allExperiments, isLoading: listLoading } = useListExperiments(undefined, {
    query: { queryKey: getListExperimentsQueryKey() },
  });

  const { data: selectedExp } = useGetExperiment(selectedId ?? 0, {
    query: { enabled: !!selectedId, queryKey: getGetExperimentQueryKey(selectedId ?? 0) },
  });

  const parsedSelectedSummary = parseSummary(selectedExp?.raw_data_json);
  const hasPlateSummary = hasGraphableData(parsedSelectedSummary);
  const isPlate96 = parsedSelectedSummary?.kind === "plate96";

  // Read-only: the same control-well markings the scientist made on the
  // experiment page (localStorage key `layout:${id}`), so the heatmap/dose-
  // response here stay visually consistent without a second editor to maintain.
  const [wellRoles, setWellRoles] = useState<Record<string, WellRole>>({});
  useEffect(() => {
    if (!selectedId) { setWellRoles({}); return; }
    try {
      const raw = localStorage.getItem(`layout:${selectedId}`);
      setWellRoles(raw ? JSON.parse(raw) || {} : {});
    } catch {
      setWellRoles({});
    }
  }, [selectedId]);
  const controlSummary = isPlate96 && parsedSelectedSummary && "wells" in parsedSelectedSummary && Array.isArray(parsedSelectedSummary.wells)
    ? buildControlSummary(parsedSelectedSummary.wells, wellRoles)
    : undefined;

  // A previously-generated report is persisted server-side — show it immediately
  // on selecting an experiment rather than requiring the user to regenerate.
  // Guarded by ID so it seeds once per experiment and never clobbers an
  // in-progress stream for the SAME experiment.
  const seededForId = useRef<number | null>(null);
  useEffect(() => {
    if (!selectedId || !selectedExp) return;
    if (seededForId.current === selectedId) return;
    seededForId.current = selectedId;
    if (selectedExp.data_analysis_report) {
      setReport(selectedExp.data_analysis_report);
      setHasReport(true);
      setReportRequestId(selectedExp.data_analysis_request_id ?? null);
    }
  }, [selectedId, selectedExp]);

  // Pop up the notes/quantify prompt the moment an unanalyzed experiment is
  // selected — NOT gated on data existing. The AI already has protocol/notes
  // context from the experiment tab; you can describe what you want quantified
  // before or after uploading data. Only "Bioalyze" itself requires real data.
  useEffect(() => {
    if (!selectedId || !selectedExp) return;
    if (promptedForId.current === selectedId) return;
    if (!selectedExp.data_analysis_report) {
      promptedForId.current = selectedId;
      setShowFocusModal(true);
    }
  }, [selectedId, selectedExp]);

  const generateReport = async () => {
    if (!selectedId) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setReport("");
    setHasReport(false);
    setStreamError(null);
    setReportRequestId(null);

    try {
      const response = await apiFetch(`/api/experiments/${selectedId}/data-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(quantifyRequest.trim() ? { quantify_request: quantifyRequest.trim() } : {}),
          ...(hasReport && refineNote.trim() ? { refine_note: refineNote.trim() } : {}),
          ...(controlSummary ? { control_summary: controlSummary } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error ?? "Request failed");
      }

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) setReport((prev) => prev + data.content);
              if (data.error) setStreamError("The AI analysis could not be generated. Please check your API configuration or try again.");
              if (data.done) setHasReport(true);
              if (data.request_id) setReportRequestId(data.request_id);
            } catch {}
          }
        }
      }
      // The report is persisted server-side on success — refetch so the
      // experiment record (and anything else reading it, e.g. chat grounding)
      // reflects the new report immediately.
      queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(selectedId) });
      setRefineNote("");
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setStreamError("The AI analysis could not be generated. Please check your API configuration or try again.");
      }
    } finally {
      setIsStreaming(false);
      setHasReport(true);
    }
  };

  const reset = () => {
    if (abortRef.current) abortRef.current.abort();
    setReport("");
    setHasReport(false);
    setStreamError(null);
    setIsStreaming(false);
    setNotes("");
    setQuantifyRequest("");
    setRefineNote("");
    setReportRequestId(null);
    if (compareAbortRef.current) compareAbortRef.current.abort();
    setCompareId(null);
    setCompareReport("");
    setComparing(false);
    setCompareError(null);
    setCompareRequestId(null);
  };

  const runCompare = async () => {
    if (!selectedId || !compareId) return;
    if (compareAbortRef.current) compareAbortRef.current.abort();
    const controller = new AbortController();
    compareAbortRef.current = controller;

    setComparing(true);
    setCompareReport("");
    setCompareError(null);
    setCompareRequestId(null);

    try {
      const response = await apiFetch(`/api/experiments/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experiment_a_id: selectedId, experiment_b_id: compareId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error ?? "Request failed");
      }
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) setCompareReport((prev) => prev + data.content);
              if (data.error) setCompareError("The comparison could not be generated. Please try again.");
              if (data.request_id) setCompareRequestId(data.request_id);
            } catch {}
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setCompareError("The comparison could not be generated. Please try again.");
      }
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="lab-page space-y-7 pb-12" data-accent="cyan">
      <LabPageHeader
        eyebrow="Quantitative signal studio"
        title="Make the evidence speak."
        description="Move from instrument output to visible patterns, defensible statistics, and an AI report you can question—without separating the numbers from their experimental context."
        icon={BarChart3}
        accent="cyan"
        status={selectedExp ? `${selectedExp.assay_type} loaded` : `${allExperiments?.length ?? 0} records available`}
        aside={
          <div className="flex h-40 w-60 items-end justify-center gap-2 rounded-[2rem] border border-primary/20 bg-background/30 p-7" aria-hidden="true">
            {[38, 72, 48, 104, 82, 124, 64, 94].map((height, index) => (
              <motion.span
                key={height + index}
                className="w-3 rounded-full bg-primary/75 shadow-[0_0_18px_hsl(var(--primary)/0.25)]"
                initial={{ height: 8 }}
                animate={{ height: [height * 0.72, height, height * 0.82] }}
                transition={{ duration: 2.4 + index * 0.13, repeat: Infinity, ease: "easeInOut" }}
              />
            ))}
          </div>
        }
      />

      <LabConversation accent="cyan">
        {selectedExp
          ? hasPlateSummary
            ? `I found graphable evidence in ${selectedExp.name}. The quantitative layer is live; tell me what matters before I form an interpretation.`
            : `${selectedExp.name} is selected, but it still needs readable evidence. Attach the instrument output and I’ll build the analysis surface immediately.`
          : "Choose one experiment and I’ll assemble its quality metrics, plate pattern, report, discussion, and comparison tools into a single evidence trail."}
      </LabConversation>

      <LabPanel accent="cyan" className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)] md:p-6">
        <div className="space-y-3">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-primary">Evidence input</p>
            <label className="mt-1 block text-lg font-semibold tracking-[-0.03em]">Which record should enter the instrument?</label>
          </div>
          {listLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              value={selectedId?.toString() ?? ""}
              onValueChange={(v) => {
                setSelectedId(parseInt(v));
                reset();
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose an experiment…" />
              </SelectTrigger>
              <SelectContent>
                {(allExperiments ?? []).map((exp) => (
                  <SelectItem key={exp.id} value={exp.id.toString()}>
                    <span className="flex items-center gap-2">
                      <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
                      {exp.name}
                      <span className="text-xs text-muted-foreground ml-1">({exp.assay_type})</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {selectedId && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
            <ExperimentMetaCard id={selectedId} />
          </motion.div>
        )}
      </LabPanel>

      <AnimatePresence mode="wait">
        {selectedId && (
          <motion.div
            key={selectedId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
            className="space-y-4"
          >
            <LabSectionHeader
              eyebrow="Quantitative layer"
              title="Pattern before interpretation."
              description="Inspect the measured signal and assay quality first. The report is downstream of the evidence—not the other way around."
            />

            {selectedExp && !selectedExp.raw_data_json ? (
              <AttachDataCard
                experimentId={selectedId}
                onAttached={() => queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(selectedId) })}
              />
            ) : (
              <>
                <QuantitativeSummaryPanel id={selectedId} />

                {isPlate96 && parsedSelectedSummary && "wells" in parsedSelectedSummary && Array.isArray(parsedSelectedSummary.wells) && (
                  <Card className="lab-panel overflow-hidden rounded-[1.6rem] border-primary/20 dark:bg-card/80">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <FlaskConical className="h-4 w-4 text-primary" />
                        96-Well Plate Heatmap
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <PlateHeatmap
                        wells={parsedSelectedSummary.wells}
                        stats={parsedSelectedSummary.stats ?? { mean: null, sd: null, cv_pct: null, min: null, max: null, blank_count: 0, well_count: 0 }}
                        wavelength={parsedSelectedSummary.metadata?.wavelength}
                        roles={wellRoles}
                      />
                    </CardContent>
                  </Card>
                )}

                {selectedId && selectedExp?.conversation_id && parsedSelectedSummary && "wells" in parsedSelectedSummary && Array.isArray(parsedSelectedSummary.wells) && (
                  <QuantifyBox
                    experimentId={selectedId}
                    conversationId={selectedExp.conversation_id}
                    wells={parsedSelectedSummary.wells}
                  />
                )}
              </>
            )}

            {selectedExp?.raw_data_json && (
            <div className="pt-2">
              <Card className="lab-panel overflow-hidden rounded-[1.8rem] border-primary/25 dark:bg-card/80">
                <CardHeader className="pb-3 border-b border-border">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <BrainCircuit className="h-5 w-5 text-primary" />
                        AI Analysis Report
                      </CardTitle>
                      <CardDescription className="mt-1">
                        Bio-Lab AI can generate graphs, summaries, and a structured report from uploaded experiment data.
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      {hasReport && !isStreaming && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => selectedExp && printExperimentReport({
                              experiment: selectedExp,
                              rawData: parsedSelectedSummary?.kind === "plate96" ? parsedSelectedSummary : null,
                              suggestions: [],
                              detailedReport: report,
                            })}
                            data-feedback="export"
                            data-feedback-message="Preparing the AI analysis report"
                          >
                            <FileDown className="h-3.5 w-3.5" />
                            Export PDF
                          </Button>
                          <Button variant="outline" size="sm" onClick={reset} className="gap-1.5" data-feedback="filter" data-feedback-message="Clearing the current analysis">
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reset
                          </Button>
                        </>
                      )}
                      {!isStreaming && (
                        <Button variant="outline" size="sm" onClick={() => setShowFocusModal(true)} className="gap-1.5" data-feedback="analyze" data-feedback-message="Listening for what matters most in this analysis">
                          <Sparkles className="h-3.5 w-3.5" />
                          {notes.trim() || quantifyRequest.trim() ? "Change request" : "Set request"}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={generateReport}
                        disabled={isStreaming || !selectedId}
                        className="gap-1.5"
                        data-feedback="analyze"
                        data-feedback-message="Reading this plate and its experimental context"
                      >
                        {isStreaming ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Bioalyzing…
                          </>
                        ) : hasReport ? (
                          <>
                            <RotateCcw className="h-3.5 w-3.5" />
                            Re-Bioalyze
                          </>
                        ) : (
                          <>
                            <BrainCircuit className="h-3.5 w-3.5" />
                            Bioalyze this plate
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  {!isStreaming && (notes.trim() || quantifyRequest.trim()) && (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground space-y-1">
                      {quantifyRequest.trim() && (
                        <div><span className="font-medium text-primary">Quantify: </span>{quantifyRequest}</div>
                      )}
                      {notes.trim() && (
                        <div><span className="font-medium text-primary">Notes: </span>{notes}</div>
                      )}
                    </div>
                  )}
                  {!isStreaming && hasReport && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <RotateCcw className="h-3.5 w-3.5 text-primary" />
                        Anything specific to change in this refinement? (optional)
                      </label>
                      <Textarea
                        value={refineNote}
                        onChange={(e) => setRefineNote(e.target.value)}
                        placeholder="e.g. 'go deeper on why the Z-factor dropped' or 're-check for pseudoreplication'"
                        rows={2}
                        className="text-sm bg-background"
                      />
                    </div>
                  )}

                  {streamError && (
                    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                      <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-destructive">{streamError}</p>
                    </div>
                  )}

                  {!report && !isStreaming && !streamError && (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                      <BrainCircuit className="h-10 w-10 mb-3 opacity-30" />
                      <p className="text-sm">
                      {!hasPlateSummary
                          ? "No graphable experiment data is available yet. Upload a Synergy H1 / Gen5 export above so the AI can make graphs and analyze the experiment."
                          : "Click \"Bioalyze this plate\" to produce graphs and a structured report from your plate data."}
                      </p>
                    </div>
                  )}

                  {(report || isStreaming) && (
                    <div className="space-y-4">
                      <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
                        {isStreaming && (
                          <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 rounded-sm" />
                        )}
                      </div>
                      {!isStreaming && <ImproveAiDialog requestId={reportRequestId} output={report} taskLabel="data-analysis report" compact />}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
            )}

            {/* Chat — same per-experiment conversation as the experiment page, so
                design/run discussion and follow-up questions about this report
                live in one continuous thread. */}
            {selectedExp?.conversation_id && (
              <div className="space-y-4 pt-4">
                <LabSectionHeader
                  eyebrow="Interrogate the evidence"
                  title="Ask the data a better question."
                  description="This is the same conversation as the experiment record, so interpretation never loses the design decisions behind it."
                />
                <CopilotChat conversationId={selectedExp.conversation_id} />
              </div>
            )}

            {/* Compare — pick a second experiment and stream an AI comparison. */}
            <div className="pt-2">
              <Card className="lab-panel overflow-hidden rounded-[1.8rem] border-primary/20 dark:bg-card/80">
                <CardHeader className="pb-3 border-b border-border">
                  <CardTitle className="text-base flex items-center gap-2">
                    <GitCompare className="h-5 w-5 text-primary" />
                    Compare with another experiment
                  </CardTitle>
                  <CardDescription className="mt-1">
                    See what changed between two runs and why one worked and the other didn’t.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <Select
                      value={compareId?.toString() ?? ""}
                      onValueChange={(v) => { setCompareId(parseInt(v)); setCompareReport(""); setCompareError(null); }}
                    >
                      <SelectTrigger className="w-full sm:max-w-xs">
                        <SelectValue placeholder="Choose an experiment to compare…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(allExperiments ?? []).filter((e) => e.id !== selectedId).map((exp) => (
                          <SelectItem key={exp.id} value={exp.id.toString()}>
                            <span className="flex items-center gap-2">
                              <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
                              {exp.name}
                              <span className="text-xs text-muted-foreground ml-1">({exp.assay_type})</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={runCompare}
                      disabled={!compareId || comparing}
                      className="gap-1.5"
                      data-feedback="analyze"
                      data-feedback-message="Lining up both experiments and their evidence"
                    >
                      {comparing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompare className="h-3.5 w-3.5" />}
                      {comparing ? "Comparing…" : "Compare"}
                    </Button>
                  </div>

                  {compareError && (
                    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                      <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-destructive">{compareError}</p>
                    </div>
                  )}

                  {(compareReport || comparing) && (
                    <div className="space-y-4">
                      <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{compareReport}</ReactMarkdown>
                        {comparing && <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 rounded-sm" />}
                      </div>
                      {!comparing && <ImproveAiDialog requestId={compareRequestId} output={compareReport} taskLabel="experiment comparison" compact />}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </motion.div>
        )}

        {!selectedId && !listLoading && (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="lab-panel relative flex min-h-[430px] flex-col items-center justify-center overflow-hidden rounded-[2rem] px-6 py-20 text-center text-muted-foreground"
          >
            <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] [background-size:32px_32px]" aria-hidden="true" />
            <motion.div
              className="relative mb-6 grid h-24 w-24 place-items-center rounded-[2rem] border border-primary/25 bg-primary/10 text-primary"
              animate={{ y: [0, -6, 0], boxShadow: ["0 0 0 hsl(var(--primary)/0)", "0 0 50px hsl(var(--primary)/0.18)", "0 0 0 hsl(var(--primary)/0)"] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            >
              <FileBarChart className="h-10 w-10" />
            </motion.div>
            <p className="relative text-3xl font-semibold tracking-[-0.05em] text-foreground">The instrument is listening.</p>
            <p className="relative mt-3 max-w-lg text-sm leading-6">
              Choose an experiment above. Its numbers, plate geography, analysis history, and comparison context will assemble here as one responsive evidence surface.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={showFocusModal} onOpenChange={setShowFocusModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              What are we analyzing?
            </DialogTitle>
            <DialogDescription>
              The AI already has the protocol and everything else on this experiment's page — this is just for what's specific to this analysis. Both are optional and you can change them anytime with "Set request" above.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">What do you want quantified?</label>
              <Textarea
                autoFocus
                value={quantifyRequest}
                onChange={(e) => setQuantifyRequest(e.target.value)}
                placeholder="e.g. 'IC50 for this dose series' or 'just flag anything unusual in the heatmap'"
                rows={2}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Anything else the AI should know?</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. 'ran 30 min longer than usual' or 'compound was slightly cloudy at the top dose'"
                rows={2}
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            {selectedExp?.raw_data_json ? (
              <>
                <Button variant="outline" onClick={() => setShowFocusModal(false)}>
                  Just save
                </Button>
                <Button onClick={() => { setShowFocusModal(false); generateReport(); }} className="gap-1.5">
                  <BrainCircuit className="h-3.5 w-3.5" />
                  Save & Bioalyze now
                </Button>
              </>
            ) : (
              <Button onClick={() => setShowFocusModal(false)} className="gap-1.5">
                Continue
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
