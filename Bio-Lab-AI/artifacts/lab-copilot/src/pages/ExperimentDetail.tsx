import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import {
  useGetExperiment,
  getGetExperimentQueryKey,
  useAnalyzeExperiment,
  useUpdateExperiment,
  type UpdateExperimentMutationBody,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { format, parseISO } from "date-fns";
import {
  BrainCircuit, FlaskConical, FileText,
  CheckCircle2, AlertTriangle, Pencil, MessageSquare, CheckSquare, FileDown,
  Download, Image, Loader2, Activity, Waves,
} from "lucide-react";
import { toPng } from "html-to-image";
import { CopilotChat } from "@/components/chat/CopilotChat";
import { PlateHeatmap } from "@/components/PlateHeatmap";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AttachDataCard } from "@/components/experiment/AttachDataCard";
import { ProtocolCard } from "@/components/experiment/ProtocolCard";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";
import { CommentsPanel } from "@/components/experiment/CommentsPanel";
import { ExperimentTasksPanel } from "@/components/experiment/ExperimentTasksPanel";
import { RecommendationActions } from "@/components/experiment/RecommendationActions";
import { printExperimentReport } from "@/lib/printExperimentReport";
import { readPlateResults, calculatePlateResults } from "@workspace/plate-analysis";
import { PlateRunResults } from "@/components/PlateRunResults";
import { ConfirmPlateLayout } from "@/components/experiment/ConfirmPlateLayout";
import { PlateQuestions } from "@/components/experiment/PlateQuestions";
import { isEnabled } from "@/lib/features";
import { apiFetch } from "@/lib/apiFetch";
import { downloadBlob } from "@/lib/downloadBlob";
import { LabConversation, LabPageHeader, LabPanel, LabSectionHeader, type LabAccent } from "@/components/lab/LivingLab";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";


const MotionButton = motion.create(Button);

type TabKey = "suggestions" | "tasks" | "comments";

export function ExperimentDetail() {
  const { id } = useParams<{ id: string }>();
  const expId = parseInt(id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("suggestions");
  // Pass/fail threshold — user-defined cutoff that flags wells in the heatmap.
  // Persisted per-experiment in localStorage (client-side; no schema change).
  const [passThreshold, setPassThreshold] = useState<number | null>(null);
  const [passDirection, setPassDirection] = useState<"above" | "below">("above");
  const skipPersistRef = useRef(true);
  const { data: experiment, isLoading } = useGetExperiment(expId, {
    query: { enabled: !!expId, queryKey: getGetExperimentQueryKey(expId) }
  });

  const analyzeMutation = useAnalyzeExperiment({
    mutation: {
      onSuccess: () => {
        toast({ title: "Analysis complete", description: "AI suggestions have been generated." });
        queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(expId) });
      },
      onError: () => {
        toast({
          title: "AI is unavailable right now",
          description: "Your heatmap, CV%, Z′, dose-response, and IC50 tools still work. Try the narrative analysis again after the daily reset.",
          variant: "destructive",
        });
      }
    }
  });

  const updateMutation = useUpdateExperiment({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(expId) });
      }
    }
  });

  // Analysis only runs when the scientist explicitly clicks "Bioalyze" below —
  // it used to auto-fire the moment data was uploaded, with zero input, which
  // is exactly the "guessing without asking" behavior this app now avoids
  // everywhere else (see the Data Analysis page's focus pop-up).
  const heatmapRef = useRef<HTMLDivElement>(null);

  // Load this experiment's saved pass/fail threshold.
  useEffect(() => {
    skipPersistRef.current = true;
    let t: number | null = null;
    let d: "above" | "below" = "above";
    try {
      const raw = expId ? localStorage.getItem(`passfail:${expId}`) : null;
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.threshold === "number") t = s.threshold;
        if (s.direction === "below") d = "below";
      }
    } catch { /* ignore */ }
    setPassThreshold(t);
    setPassDirection(d);
  }, [expId]);

  // Persist on user change (skip the write caused by the load above).
  useEffect(() => {
    if (skipPersistRef.current) { skipPersistRef.current = false; return; }
    if (!expId) return;
    try {
      if (passThreshold === null) localStorage.removeItem(`passfail:${expId}`);
      else localStorage.setItem(`passfail:${expId}`, JSON.stringify({ threshold: passThreshold, direction: passDirection }));
    } catch { /* ignore */ }
  }, [expId, passThreshold, passDirection]);

  const downloadCsv = () => {
    if (!experiment || !rawData?.wells) return;
    const t = passThreshold;
    const active = t !== null && !Number.isNaN(t);
    const meta = [
      `# Experiment: ${experiment.name}`,
      `# Date: ${experiment.date}`,
      `# Assay: ${experiment.assay_type}`,
      `# Instrument: ${experiment.instrument}`,
      `# Wavelength: ${rawData.metadata?.wavelength ?? "–"} nm`,
      `# Protocol: ${rawData.metadata?.protocol ?? "–"}`,
      ...(active ? [`# Pass/fail cutoff: value ${passDirection === "below" ? "≤" : "≥"} ${t}`] : []),
      "#",
      active ? "Well,Row,Col,Value,Status,CV_pct,PassFail" : "Well,Row,Col,Value,Status,CV_pct",
    ].join("\n");
    const rows = [...rawData.wells]
      .sort((a: { well: string }, b: { well: string }) => a.well.localeCompare(b.well))
      .map((w: { well: string; row: string; col: number; value: number | null; status: string; cv_pct: number | null }) => {
        const base = `${w.well},${w.row},${w.col},${w.value ?? ""},${w.status},${w.cv_pct ?? ""}`;
        if (!active) return base;
        let pf = "";
        if (w.value !== null) {
          const pass = passDirection === "below" ? w.value <= (t as number) : w.value >= (t as number);
          pf = pass ? "PASS" : "FAIL";
        }
        return `${base},${pf}`;
      })
      .join("\n");
    const blob = new Blob([`${meta}\n${rows}`], { type: "text/csv" });
    downloadBlob(blob, `${experiment.name.replace(/\s+/g, "_")}_${experiment.date}_plate.csv`);
  };

  const downloadPng = async () => {
    if (!heatmapRef.current || !experiment) return;
    try {
      // Match the current theme so the well labels stay readable in the export
      // (dark labels on a dark bg, or vice-versa, would be invisible on slides).
      const isDark = document.documentElement.classList.contains("dark");
      const dataUrl = await toPng(heatmapRef.current, {
        backgroundColor: isDark ? "#0c1520" : "#ffffff",
        pixelRatio: 2,
      });
      const a = document.createElement("a");
      a.download = `${experiment.name.replace(/\s+/g, "_")}_heatmap.png`;
      a.href = dataUrl;
      a.click();
    } catch {
      // silently ignore if the element isn't rendered
    }
  };

  // Experiments created before chat-on-create shipped have no conversation yet —
  // let the user start one on demand instead of forcing them through /analyze.
  const [startingChat, setStartingChat] = useState(false);
  const startChat = async () => {
    if (!experiment) return;
    setStartingChat(true);
    try {
      const resp = await apiFetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Copilot: ${experiment.name}`, experimentId: expId }),
      });
      if (!resp.ok) throw new Error("Failed to start chat");
      queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(expId) });
    } catch {
      toast({ title: "Couldn't start chat", description: "Please try again.", variant: "destructive" });
    } finally {
      setStartingChat(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-[300px]" />
        <div className="grid md:grid-cols-3 gap-6">
          <Skeleton className="h-[200px] md:col-span-2" />
          <Skeleton className="h-[200px]" />
        </div>
      </div>
    );
  }

  if (!experiment) {
    return <div className="text-center py-12 font-mono">Experiment not found</div>;
  }

  const rawData = experiment.raw_data_json
    ? (() => { try { return JSON.parse(experiment.raw_data_json!); } catch { return null; } })()
    : null;
  const isPlate96 = rawData?._type === "plate96";

  const savedPlateResults = readPlateResults(experiment.plate_results_json);
  const plateResults = savedPlateResults ?? (isPlate96 && Array.isArray(rawData.wells) ? calculatePlateResults(rawData.wells, null) : null);
  const plateRoles = savedPlateResults?.layout?.roles;
  const aiSummary = isPlate96 && !savedPlateResults ? null : experiment.ai_summary;

  // Wells that carry a real reading (exclude blanks/empties) — the pass/fail denominator.
  const scorableWells: { value: number | null; status: string }[] =
    isPlate96 && Array.isArray(rawData?.wells)
      ? rawData.wells.filter((w: { value: number | null; status: string }) => w.value !== null)
      : [];
  const thresholdActive = passThreshold !== null && !Number.isNaN(passThreshold);
  const passCount = thresholdActive
    ? scorableWells.filter((w) =>
        passDirection === "below" ? (w.value as number) <= passThreshold! : (w.value as number) >= passThreshold!,
      ).length
    : 0;
  // Standard error of the mean across scorable wells (SD / √n) — precision of the plate mean.
  const sem: number | null =
    rawData?.stats?.sd != null && scorableWells.length > 0
      ? rawData.stats.sd / Math.sqrt(scorableWells.length)
      : null;

  const analyzeData = {};
  const suggestions: {
    title: string;
    variable_to_change: string;
    rationale: string;
    expected_outcome: string;
    confidence: string;
  }[] = experiment.ai_next_experiments_json && (!isPlate96 || savedPlateResults)
    ? (() => { try { return JSON.parse(experiment.ai_next_experiments_json!) ?? []; } catch { return []; } })()
    : [];

  const SIDE_TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: "suggestions", label: "Next Steps", icon: AlertTriangle },
    { key: "tasks", label: "Tasks", icon: CheckSquare },
    ...(isEnabled("comments") ? [{ key: "comments" as TabKey, label: "Comments", icon: MessageSquare }] : []),
  ];

  const recordAccent: LabAccent =
    experiment.status === "success"
      ? "emerald"
      : experiment.status === "running"
        ? "amber"
        : experiment.status === "failed"
          ? "rose"
          : "violet";

  return (
    <div className="lab-page space-y-7 pb-12" data-accent={recordAccent}>
      <LabPageHeader
        eyebrow="Living experiment record"
        title={experiment.name}
        description={`${format(parseISO(experiment.date), "MMMM d, yyyy")} · ${experiment.assay_type} · ${experiment.instrument}. Every protocol decision, result, conversation, and next action stays connected here.`}
        icon={FlaskConical}
        accent={recordAccent}
        status={rawData ? "Evidence attached" : "Awaiting evidence"}
        actions={<>
          <StatusBadge status={experiment.status} />
          <Select
            value={experiment.status}
            onValueChange={(v) =>
              updateMutation.mutate({ id: expId, data: { status: v as UpdateExperimentMutationBody["status"] } })
            }
          >
            <SelectTrigger
              className="h-9 w-[130px] text-xs"
              title="Experiment stage"
              data-feedback="save"
              data-feedback-message="Updating the experiment stage"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="designing">Designing</SelectItem>
              <SelectItem value="ready">Ready to run</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              {!["designing", "ready", "running"].includes(experiment.status) && (
                <SelectItem value={experiment.status}>{experiment.status}</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Link href={`/experiments/${expId}/edit`} data-feedback="navigate" data-feedback-message="Opening this experiment for editing">
            <MotionButton variant="outline" className="gap-2" whileTap={{ scale: 0.97 }}>
              <Pencil className="h-4 w-4" />
              Edit
            </MotionButton>
          </Link>
          <MotionButton
            variant="outline"
            className="gap-2"
            onClick={() => printExperimentReport({ experiment: { ...experiment, ai_summary: aiSummary }, rawData, suggestions, plateResults })}
            whileTap={{ scale: 0.97 }}
            data-feedback="export"
            data-feedback-message="Preparing a traceable experiment report"
          >
            <FileDown className="h-4 w-4" />
            Export PDF
          </MotionButton>
          <MotionButton
            onClick={() => analyzeMutation.mutate({ id: expId, data: analyzeData as never })}
            disabled={analyzeMutation.isPending || Boolean(isPlate96 && !savedPlateResults)}
            className="gap-2 relative overflow-hidden"
            whileTap={{ scale: 0.97 }}
            data-feedback="analyze"
            data-feedback-message="Bioalyzing this experiment in context"
          >
            {analyzeMutation.isPending && (
              <motion.div
                className="absolute inset-0 bg-primary/20"
                animate={{ x: ["-100%", "100%"] }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              />
            )}
            <BrainCircuit className={`h-4 w-4 ${analyzeMutation.isPending ? "animate-pulse" : ""}`} />
            {analyzeMutation.isPending ? "Bioalyzing…" : "Bioalyze"}
          </MotionButton>
        </>}
        aside={
          <div className="relative flex h-[190px] w-[190px] items-center justify-center" aria-hidden="true">
            <motion.span
              className="absolute inset-2 rounded-full border border-[var(--lab-accent)]/25"
              animate={{ rotate: 360 }}
              transition={{ duration: 22, repeat: Infinity, ease: "linear" }}
            />
            <motion.span
              className="absolute inset-8 rounded-full border border-dashed border-foreground/15"
              animate={{ rotate: -360 }}
              transition={{ duration: 16, repeat: Infinity, ease: "linear" }}
            />
            <div className="relative grid h-24 w-24 place-items-center rounded-[2rem] border border-[var(--lab-accent)]/30 bg-[var(--lab-accent-soft)] shadow-[0_0_50px_var(--lab-accent-soft)]">
              {rawData ? <Waves className="h-9 w-9 text-[var(--lab-accent)]" /> : <FlaskConical className="h-9 w-9 text-[var(--lab-accent)]" />}
              <span className="absolute -bottom-7 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                {rawData ? `${scorableWells.length} signals` : "design state"}
              </span>
            </div>
          </div>
        }
      />

      <LabConversation accent={recordAccent}>
        {rawData
          ? aiSummary
            ? "The record has evidence and an analysis. I’m keeping the plate, quality signals, recommendations, and discussion synchronized below."
            : "The evidence is attached. Define any missing controls, inspect the quality signals, then ask me to Bioalyze when you are ready."
          : experiment.status === "designing"
            ? "This record is still being designed. Shape the protocol and context first; I’ll wait for you before interpreting any results."
            : "The protocol is ready for evidence. Attach the instrument output to turn this record into a live analysis workspace."}
      </LabConversation>

      <div className="grid grid-cols-1 gap-7 xl:grid-cols-[minmax(0,1fr)_370px]">
        {/* Main column */}
        <div className="min-w-0 space-y-7">
          <LabSectionHeader
            eyebrow="Experiment timeline"
            title="One record, no lost context."
            description="The design, evidence, quantitative readout, and AI interpretation unfold in the order the science actually happens."
          />
          {isPlate96 && (
            <>
              <ConfirmPlateLayout
                key={`${expId}:${experiment.file_name}:${experiment.plate_results_json ?? "unconfirmed"}`}
                id={expId}
                updatedAt={experiment.updated_at}
                saved={savedPlateResults?.layout ?? null}
                plate={{ wells: rawData.wells, stats: rawData.stats, wavelength: rawData.metadata?.wavelength }}
                onSave={() => queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(expId) })}
              />
              <PlateRunResults results={plateResults} />
            </>
          )}
          <AnimatePresence>
            {experiment.notes && (
              <motion.div key="context" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
                <Card className="lab-panel rounded-[1.6rem] border-[var(--lab-accent)]/20">
                  <CardHeader className="py-4">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      Context for the AI
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="whitespace-pre-wrap text-sm font-mono text-muted-foreground">{experiment.notes}</p>
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {isEnabled("protocolDesigner") && (
              <motion.div key="protocol" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.12 }}>
                <ProtocolCard
                  experimentId={expId}
                  protocolJson={experiment.protocol_json ?? null}
                  protocolRequestId={experiment.protocol_ai_request_id}
                  onUpdated={() => queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(expId) })}
                />
              </motion.div>
            )}

            {!experiment.raw_data_json && (
              <motion.div key="attach-data" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15 }}>
                <AttachDataCard
                  experimentId={expId}
                  onAttached={() => queryClient.invalidateQueries({ queryKey: getGetExperimentQueryKey(expId) })}
                />
              </motion.div>
            )}

            {rawData && isPlate96 && (
              <motion.div key="plate-heatmap" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 }}>
                <Card className="lab-panel overflow-hidden rounded-[1.6rem] border-[var(--lab-accent)]/20">
                  <CardHeader className="py-4 border-b">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-lg flex items-center gap-2">
                          <FlaskConical className="h-5 w-5 text-primary" />
                          96-Well Plate Heatmap
                        </CardTitle>
                        {experiment.file_name && (
                          <CardDescription className="font-mono mt-1">{experiment.file_name}</CardDescription>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 justify-end items-center">
                        {rawData.metadata?.wavelength && (
                          <Badge variant="secondary" className="font-mono text-xs">λ {rawData.metadata.wavelength} nm</Badge>
                        )}
                        {rawData.metadata?.protocol && (
                          <Badge variant="outline" className="text-xs">{rawData.metadata.protocol}</Badge>
                        )}
                        {rawData.stats?.cv_pct != null && (
                          <Badge
                            variant="outline"
                            className={`text-xs font-mono ${
                              rawData.stats.cv_pct > 20
                                ? "border-destructive text-destructive"
                                : rawData.stats.cv_pct > 10
                                ? "border-yellow-500 text-yellow-600"
                                : "border-emerald-500 text-emerald-600"
                            }`}
                          >
                            CV: {rawData.stats.cv_pct.toFixed(1)}%
                          </Badge>
                        )}
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Export CSV" onClick={downloadCsv}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Export PNG" onClick={downloadPng}>
                          <Image className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4">
                    {/* Pass/fail threshold control */}
                    <div className="flex flex-wrap items-center gap-2 mb-4">
                      <span className="text-xs font-bold text-muted-foreground">Pass / fail</span>
                      <div className="inline-flex rounded-md border border-border overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setPassDirection("above")}
                          className={`px-2 py-1 text-xs font-mono transition-colors ${passDirection === "above" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                        >
                          ≥ pass
                        </button>
                        <button
                          type="button"
                          onClick={() => setPassDirection("below")}
                          className={`px-2 py-1 text-xs font-mono transition-colors ${passDirection === "below" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                        >
                          ≤ pass
                        </button>
                      </div>
                      <Input
                        type="number"
                        inputMode="decimal"
                        placeholder="cutoff value"
                        value={passThreshold ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPassThreshold(v === "" ? null : Number(v));
                        }}
                        className="h-8 w-32 font-mono text-sm"
                      />
                      {rawData.stats?.mean != null && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-2 text-xs font-mono"
                          title="Set the cutoff to the plate mean"
                          onClick={() => {
                            const m = rawData.stats?.mean;
                            if (m != null) setPassThreshold(Number(m.toFixed(3)));
                          }}
                        >
                          use mean
                        </Button>
                      )}
                      {thresholdActive && (
                        <>
                          <span className="text-xs font-mono px-2 py-1 rounded-md bg-muted">
                            <span className="text-emerald-500 font-semibold">{passCount}</span>
                            <span className="text-muted-foreground"> / {scorableWells.length} pass</span>
                          </span>
                          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setPassThreshold(null)}>
                            Clear
                          </Button>
                        </>
                      )}
                    </div>

                    <PlateHeatmap
                      ref={heatmapRef}
                      wells={rawData.wells}
                      stats={rawData.stats}
                      wavelength={rawData.metadata?.wavelength}
                      passThreshold={passThreshold}
                      passDirection={passDirection}
                      roles={plateRoles}
                    />
                    {rawData.stats && (
                      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                        {[
                          { label: "Mean", value: rawData.stats.mean },
                          { label: "Std Dev", value: rawData.stats.sd },
                          { label: "Plate CV%", value: !savedPlateResults?.layout?.series && rawData.stats.cv_pct != null ? `${Number(rawData.stats.cv_pct).toFixed(1)}%` : "–" },
                          { label: "SEM", value: sem != null ? Number(sem.toFixed(3)) : null },
                          { label: "Min", value: rawData.stats.min },
                          { label: "Max", value: rawData.stats.max },
                        ].map(({ label, value }) => (
                          <div key={label} className="bg-muted rounded-lg p-3 border border-transparent hover:border-primary/50 transition-colors">
                            <div className="text-xs text-muted-foreground mb-1 font-bold">{label}</div>
                            <div className="text-base font-mono font-medium text-primary">{value ?? "–"}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {rawData && isPlate96 && (
              <PlateQuestions key={experiment.plate_results_json ?? "unconfirmed"} id={expId} />
            )}

            {rawData && !isPlate96 && (
              <motion.div key="generic-data" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 }}>
                <Card className="lab-panel rounded-[1.6rem] border-[var(--lab-accent)]/20">
                  <CardHeader className="py-4 border-b">
                    <CardTitle className="text-lg">Uploaded Data Summary</CardTitle>
                    {experiment.file_name && (
                      <CardDescription className="font-mono">{experiment.file_name}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                      <div className="bg-muted rounded-lg p-3 border border-transparent hover:border-primary/50 transition-colors">
                        <div className="text-xs text-muted-foreground mb-1 font-bold">Rows</div>
                        <div className="text-lg font-mono font-medium text-primary">{rawData.rows || rawData.total_rows || "N/A"}</div>
                      </div>
                      <div className="bg-muted rounded-lg p-3 border border-transparent hover:border-primary/50 transition-colors">
                        <div className="text-xs text-muted-foreground mb-1 font-bold">Columns</div>
                        <div className="text-lg font-mono font-medium text-primary">{rawData.columns?.length || "N/A"}</div>
                      </div>
                    </div>
                    {rawData.columns && (
                      <div>
                        <h4 className="text-sm font-medium mb-2">Detected Columns</h4>
                        <div className="flex flex-wrap gap-2">
                          {rawData.columns.map((col: string) => (
                            <Badge key={col} variant="secondary" className="font-mono text-xs hover:bg-primary/20 transition-colors">{col}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {experiment.raw_data_json && !rawData && (
              <motion.div key="unreadable-data" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
                <Card className="lab-panel rounded-[1.6rem] border-yellow-500/30 bg-yellow-500/5">
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">Uploaded data couldn't be displayed</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          The stored results for this experiment are unreadable. Re-upload the plate file by editing this experiment, or create a new one from a fresh Gen5 export.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {aiSummary && (
              <motion.div key="ai-summary" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.3 }}>
                <Card className="lab-panel overflow-hidden rounded-[1.6rem] border-primary/30 bg-primary/5">
                  <CardHeader className="py-4 border-b border-primary/20">
                    <CardTitle className="text-lg flex items-center gap-2 text-primary">
                      <BrainCircuit className="h-5 w-5" />
                      {experiment.ai_summary_request_id ? "AI reading of calculated results" : "Plate reading"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {aiSummary.replace(/(?:\\r)?\\n/g, "\n")}
                      </ReactMarkdown>
                    </div>
                    {!isPlate96 && <div className="mt-4">
                      <ImproveAiDialog requestId={experiment.ai_summary_request_id} output={aiSummary} taskLabel="experiment analysis" compact />
                    </div>}
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          {!isPlate96 && <motion.div className="space-y-4" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            <LabSectionHeader
              eyebrow="Conversation layer"
              title="Think beside your copilot."
              description="Ask about the protocol, interrogate the evidence, or turn a recommendation into the next experiment."
            />
            {experiment.conversation_id ? (
              <CopilotChat conversationId={experiment.conversation_id} />
            ) : (
              <Card className="lab-panel rounded-[1.6rem] border-dashed bg-muted/10 hover:bg-muted/20 transition-colors">
                <CardContent className="flex flex-col items-center justify-center p-8 text-center h-48">
                  <BrainCircuit className="h-12 w-12 text-primary/50 mb-4" />
                  <p className="text-muted-foreground font-medium font-mono">No active conversation</p>
                  <p className="text-sm text-muted-foreground mt-1 mb-4">
                    This experiment predates chat-on-create — start one to design the protocol or ask anything.
                  </p>
                  <Button size="sm" disabled={startingChat} onClick={startChat} className="gap-2">
                    {startingChat && <Loader2 className="h-4 w-4 animate-spin" />}
                    Start chat
                  </Button>
                </CardContent>
              </Card>
            )}
          </motion.div>}

          <div className="flex flex-wrap gap-2 pt-1">
            <Badge variant="outline" className="text-xs">Screen reader ready</Badge>
            <Badge variant="outline" className="text-xs">High contrast</Badge>
            <Badge variant="outline" className="text-xs">Reduced motion friendly</Badge>
          </div>
        </div>

        {/* Side panel with tabs */}
        <motion.div className="space-y-4 xl:sticky xl:top-24 xl:self-start" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }}>
          <LabPanel accent={recordAccent} className="p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--lab-accent)]">Decision rail</p>
              <h2 className="mt-1 text-xl font-semibold tracking-[-0.04em]">What happens next</h2>
            </div>
            <Activity className="h-5 w-5 text-[var(--lab-accent)]" />
          </div>
          {/* Tab bar */}
          <div className="flex overflow-hidden rounded-xl border border-border/60 bg-background/35 p-1">
            {SIDE_TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-medium transition-colors ${
                  activeTab === key
                    ? "rounded-lg bg-[var(--lab-accent)] text-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {activeTab === "suggestions" && (
              <motion.div
                key="suggestions"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <Card className="mt-4 border-0 bg-transparent shadow-none">
                  <CardHeader className="py-4 border-b">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-primary" />
                      Next Step Suggestions
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    {suggestions.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground text-sm font-mono">
                        Click "Bioalyze" to get AI-driven suggestions for your next experiment.
                      </div>
                    ) : (
                      <RecommendationActions experimentId={expId} suggestions={suggestions} />
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {activeTab === "tasks" && (
              <motion.div
                key="tasks"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <ExperimentTasksPanel experimentId={expId} />
              </motion.div>
            )}

            {activeTab === "comments" && (
              <motion.div
                key="comments"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <CommentsPanel experimentId={expId} />
              </motion.div>
            )}
          </AnimatePresence>
          </LabPanel>
        </motion.div>
      </div>
    </div>
  );
}
