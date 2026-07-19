import { useState, useRef } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { useListExperiments, useGetExperiment, getListExperimentsQueryKey, getGetExperimentQueryKey } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GitCompare,
  BrainCircuit,
  Send,
  RotateCcw,
  Calendar,
  FlaskConical,
  Microscope,
  FileText,
  AlertTriangle,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { LabConversation, LabPageHeader, LabPanel, LabSectionHeader } from "@/components/lab/LivingLab";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";


function ExperimentCard({ id }: { id: number }) {
  const { data, isLoading } = useGetExperiment(id, {
    query: { enabled: !!id, queryKey: getGetExperimentQueryKey(id) },
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Card className="lab-panel h-full rounded-[1.6rem] border-primary/20 dark:bg-card/80">
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base leading-tight text-primary">{data.name}</CardTitle>
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
        <CardContent className="pt-4 space-y-3">
          {data.notes && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notes</span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-foreground/80 font-mono leading-relaxed">
                {data.notes}
              </p>
            </div>
          )}
          {data.ai_summary && (
            <div className="rounded-lg bg-primary/5 border border-primary/15 p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <BrainCircuit className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-semibold text-primary uppercase tracking-wider">AI Summary</span>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none break-words text-foreground/80">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.ai_summary}</ReactMarkdown>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function ExperimentCompare() {
  const [expAId, setExpAId] = useState<number | null>(null);
  const [expBId, setExpBId] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [analysis, setAnalysis] = useState<string>("");
  const [hasResult, setHasResult] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: allExperiments } = useListExperiments(undefined, {
    query: { queryKey: getListExperimentsQueryKey() },
  });

  const canCompare = expAId !== null && expBId !== null && expAId !== expBId;

  const runComparison = async (customQuestion?: string) => {
    if (!canCompare) return;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setAnalysis("");
    setHasResult(false);
    setStreamError(null);
    setRequestId(null);

    try {
      const response = await apiFetch(`/api/experiments/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment_a_id: expAId,
          experiment_b_id: expBId,
          question: customQuestion || question || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Comparison failed.");
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
              if (data.content) setAnalysis((prev) => prev + data.content);
              if (data.done) setHasResult(true);
              if (data.request_id) setRequestId(data.request_id);
            } catch {}
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setStreamError("Comparison failed — the AI service may be unavailable. Try again.");
        setIsStreaming(false);
        return;
      }
    } finally {
      setIsStreaming(false);
      setHasResult(true);
    }
  };

  const reset = () => {
    if (abortRef.current) abortRef.current.abort();
    setAnalysis("");
    setHasResult(false);
    setStreamError(null);
    setQuestion("");
    setIsStreaming(false);
    setRequestId(null);
  };

  const PRESET_QUESTIONS = [
    "Why did one succeed and the other fail?",
    "What variables drove the difference in outcomes?",
    "What should I change for the next run?",
    "Are there any patterns I should be aware of?",
  ];

  return (
    <div className="lab-page space-y-7 pb-12" data-accent="rose">
      <LabPageHeader
        eyebrow="Counterfactual evidence lens"
        title="Put two truths in tension."
        description="Align two experimental records, expose the variables that moved, and ask why their outcomes converged—or refused to."
        icon={GitCompare}
        accent="rose"
        status={canCompare ? "Pair locked" : "Awaiting a pair"}
      />

      <LabConversation accent="rose">
        {canCompare
          ? "Both records are aligned. Choose the scientific question that matters and I’ll reason across their design context, evidence, and outcomes."
          : "Give me two different experiment records. I’ll keep them visually paired so the comparison always shows what each claim is grounded in."}
      </LabConversation>

      {/* Experiment selectors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(["A", "B"] as const).map((label) => {
          const isA = label === "A";
          const selectedId = isA ? expAId : expBId;
          const setSelected = isA ? setExpAId : setExpBId;
          const otherSelectedId = isA ? expBId : expAId;

          return (
            <LabPanel key={label} accent={isA ? "violet" : "rose"} className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="text-xs font-mono px-2 border-primary/40 text-primary"
                >
                  {label}
                </Badge>
                <span className="text-sm font-medium text-muted-foreground">
                  {isA ? "First experiment" : "Second experiment"}
                </span>
              </div>
              <Select
                value={selectedId?.toString() ?? ""}
                onValueChange={(v) => {
                  reset();
                  setSelected(parseInt(v));
                }}
              >
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder={`Select experiment ${label}…`} />
                </SelectTrigger>
                <SelectContent>
                  {allExperiments?.map((exp) => (
                    <SelectItem
                      key={exp.id}
                      value={exp.id.toString()}
                      disabled={exp.id === otherSelectedId}
                    >
                      <div className="flex items-center gap-2 max-w-[300px]">
                        <span className="truncate">{exp.name}</span>
                        <span className="text-xs text-muted-foreground font-mono shrink-0">
                          {exp.status}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedId && <ExperimentCard id={selectedId} />}
            </LabPanel>
          );
        })}
      </div>

      {/* AI comparison panel */}
      <AnimatePresence>
        {canCompare && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.3 }}
            className="space-y-4"
          >
            <LabPanel accent="rose" className="p-5 sm:p-7">
              <LabSectionHeader
                eyebrow="Comparative reasoning"
                title="Ask what changed—and why."
                description="Start broad or point the analysis at one variable, quality concern, or decision you need to make next."
              />

              {/* Preset questions */}
              {!hasResult && !isStreaming && (
                <div className="mb-4 mt-6 flex flex-wrap gap-2">
                  {PRESET_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        setQuestion(q);
                        runComparison(q);
                      }}
                      className="text-xs px-3 py-1.5 rounded-full border border-primary/30 text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors font-mono"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}

              {/* Custom question input */}
              {!isStreaming && !hasResult && (
                <div className="flex gap-2">
                  <Textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ask a specific question about the comparison, or leave blank for a full analysis…"
                    className="min-h-[60px] resize-none text-sm font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        runComparison();
                      }
                    }}
                  />
                  <Button
                    onClick={() => runComparison()}
                    disabled={!canCompare}
                    className="self-end gap-2 shrink-0"
                  >
                    <Send className="h-4 w-4" />
                    Compare
                  </Button>
                </div>
              )}

              {/* Error state */}
              {streamError && !isStreaming && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-destructive">{streamError}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => runComparison(question || undefined)} className="gap-1.5 shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              )}

              {/* Streaming result */}
              <AnimatePresence>
                {(isStreaming || hasResult) && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="relative"
                  >
                    <Card className="mt-5 rounded-[1.5rem] border-primary/20 dark:bg-card/60">
                      <CardContent className="pt-5">
                        <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {analysis}
                          </ReactMarkdown>
                          {isStreaming && (
                            <motion.span
                              className="inline-block w-2 h-4 bg-primary ml-0.5 align-middle"
                              animate={{ opacity: [1, 0] }}
                              transition={{ repeat: Infinity, duration: 0.6 }}
                            />
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {hasResult && !isStreaming && (
                      <div className="mt-4 space-y-3">
                        <ImproveAiDialog requestId={requestId} output={analysis} taskLabel="experiment comparison" compact />
                        <p className="text-xs text-muted-foreground font-mono">
                          Ask a follow-up question:
                        </p>
                        <div className="flex gap-2">
                          <Textarea
                            value={question}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="Ask another question about these two experiments…"
                            className="min-h-[60px] resize-none text-sm font-mono"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                runComparison();
                              }
                            }}
                          />
                          <div className="flex flex-col gap-2 shrink-0 self-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={reset}
                              className="gap-1.5"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Reset
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => runComparison()}
                              disabled={!question.trim()}
                              className="gap-1.5"
                            >
                              <Send className="h-3.5 w-3.5" />
                              Ask
                            </Button>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {PRESET_QUESTIONS.map((q) => (
                            <button
                              key={q}
                              onClick={() => {
                                setQuestion(q);
                                runComparison(q);
                              }}
                              className="text-xs px-3 py-1.5 rounded-full border border-primary/30 text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors font-mono"
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </LabPanel>
          </motion.div>
        )}
      </AnimatePresence>

      {!canCompare && (
        <div className="lab-panel flex min-h-[260px] flex-col items-center justify-center rounded-[2rem] border-dashed px-6 py-16 text-center text-muted-foreground">
          <GitCompare className="mb-4 h-14 w-14 text-primary/25" />
          <p className="text-xl font-semibold tracking-[-0.04em] text-foreground">The lens needs two records.</p>
          <p className="mt-2 max-w-md text-sm leading-6">
            Select a different experiment on each side. Their evidence and context will remain visible while the comparison speaks.
          </p>
        </div>
      )}
    </div>
  );
}
