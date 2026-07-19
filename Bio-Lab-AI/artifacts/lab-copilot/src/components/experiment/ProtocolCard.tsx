import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  ClipboardList, Loader2, Sparkles, UploadCloud, FileText,
  Beaker, ShieldCheck, LayoutGrid, Target, BarChart3, Lightbulb, RotateCcw, History,
} from "lucide-react";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";

interface StructuredProtocol {
  objective: string;
  materials: string[];
  controls: string[];
  plate_layout: string;
  steps: string[];
  expected_readout: string;
  suggested_analysis: string;
  review_notes: string[];
  changes_summary?: string[];
  ai_request_id?: string;
}

function parseProtocol(raw: string | null): StructuredProtocol | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StructuredProtocol;
  } catch {
    return null;
  }
}

/**
 * Design-time protocol: shows a two-path chooser (upload an existing .docx SOP,
 * or generate one with AI) when no protocol exists yet, and a structured
 * step-by-step view (with AI suggestions and a refine action) once it does.
 * Both creation paths hit the same backend pipeline so rendering is identical
 * regardless of source. See POST /experiments/:id/protocol/generate and
 * POST /experiments/:id/protocol/upload.
 */
export function ProtocolCard({
  experimentId,
  protocolJson,
  protocolRequestId,
  onUpdated,
}: {
  experimentId: number;
  protocolJson: string | null;
  protocolRequestId?: string | null;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const protocol = parseProtocol(protocolJson);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refineNote, setRefineNote] = useState("");
  const [showRefine, setShowRefine] = useState(false);
  // What the AI actually changed on the last refine — a one-time diff, not
  // persisted with the protocol (see backend: stripped before saving), so the
  // scientist can tell whether their note took effect instead of re-reading the
  // whole protocol to spot it themselves.
  const [lastChanges, setLastChanges] = useState<string[] | null>(null);
  const [latestRequestId, setLatestRequestId] = useState<string | null>(protocolRequestId ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // MVP progress tracking: manual checkboxes per step, persisted locally. The
  // chat is grounded in the protocol content itself, so it can respond
  // intelligently to "we did step 2" even without parsing that free text —
  // this checklist is a lightweight, reliable companion, not a dependency.
  // Keyed by step INDEX, so a "Refine with AI" that reorders/changes step count
  // would otherwise misapply old checkmarks to unrelated new steps — store the
  // step text alongside the checked state and discard it if the steps changed.
  const storageKey = `protocol-steps:${experimentId}`;
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? (JSON.parse(raw) as { steps?: string[]; checked?: Record<number, boolean> }) : null;
      const stepsMatch = saved?.steps && protocol && saved.steps.join("\n") === protocol.steps.join("\n");
      setChecked(stepsMatch ? (saved!.checked ?? {}) : {});
    } catch {
      setChecked({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experimentId, protocolJson]);
  useEffect(() => setLatestRequestId(protocolRequestId ?? null), [protocolRequestId]);
  const toggleStep = (i: number) => {
    setChecked((prev) => {
      const next = { ...prev, [i]: !prev[i] };
      try {
        localStorage.setItem(storageKey, JSON.stringify({ steps: protocol?.steps ?? [], checked: next }));
      } catch { /* ignore */ }
      return next;
    });
  };

  const generate = async () => {
    // Capture BEFORE the request: only a refine (a protocol already existed) should
    // show a "what changed" box at all — a first-time draft has nothing to diff
    // against, so changes_summary is legitimately irrelevant there.
    const wasRefine = !!protocol;
    setGenerating(true);
    setLastChanges(null);
    try {
      const resp = await apiFetch(`/api/experiments/${experimentId}/protocol/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(refineNote.trim() ? { refine_note: refineNote.trim() } : {}),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Generation failed" }));
        throw new Error(err.error || "Generation failed");
      }
      const data = await resp.json().catch(() => null) as StructuredProtocol | null;
      // Always show SOMETHING after a refine — never silently show nothing, since
      // that's indistinguishable from the feature being broken. If the AI didn't
      // report specific changes, say that explicitly instead.
      if (wasRefine) {
        setLastChanges(data?.changes_summary ?? []);
      }
      setLatestRequestId(data?.ai_request_id ?? null);
      toast({ title: protocol ? "Protocol refined" : "Protocol generated", description: "Review the steps and AI suggestions below." });
      setRefineNote("");
      setShowRefine(false);
      onUpdated();
    } catch (err) {
      toast({
        title: "Couldn't generate protocol",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".docx")) {
      toast({ title: "Unsupported file type", description: "Upload your SOP as a Word (.docx) document.", variant: "destructive" });
      return;
    }
    setUploading(true);
    setLastChanges(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const resp = await apiFetch(`/api/experiments/${experimentId}/protocol/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_content_b64: b64, file_name: file.name }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }
      const data = await resp.json().catch(() => null) as StructuredProtocol | null;
      setLatestRequestId(data?.ai_request_id ?? null);
      toast({ title: "SOP imported", description: "Review the structured protocol and AI suggestions below." });
      onUpdated();
    } catch (err) {
      toast({
        title: "Couldn't read this document",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  if (!protocol) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="py-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            No protocol yet
          </CardTitle>
          <CardDescription>
            Upload an existing SOP, or chat with the copilot below and generate one — it'll ask about materials, ranges, and controls if it needs more detail.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            disabled={uploading || generating}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            {uploading ? "Reading document…" : "Upload SOP (.docx)"}
          </Button>
          <Button
            type="button"
            className="gap-2"
            disabled={generating || uploading}
            onClick={generate}
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? "Designing…" : "Generate with AI"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="py-4 border-b border-primary/20">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2 text-primary">
              <ClipboardList className="h-5 w-5" />
              Protocol
            </CardTitle>
            {protocol.objective && (
              <CardDescription className="mt-1.5 text-foreground/80">{protocol.objective}</CardDescription>
            )}
          </div>
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUpload(f);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs h-8"
              disabled={generating || uploading}
              onClick={() => setShowRefine((v) => !v)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Refine with AI
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {showRefine && (
          <div className="rounded-lg border border-primary/30 bg-background/60 p-3 space-y-2">
            <Textarea
              value={refineNote}
              onChange={(e) => setRefineNote(e.target.value)}
              placeholder="What should change? e.g. 'use 8-point dose response instead of 6' or 'add a vehicle control column'"
              rows={2}
              className="text-sm bg-background"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowRefine(false)} disabled={generating}>
                Cancel
              </Button>
              <Button type="button" size="sm" className="gap-1.5" onClick={generate} disabled={generating}>
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {generating ? "Refining…" : "Apply"}
              </Button>
            </div>
          </div>
        )}

        {lastChanges !== null && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1.5">
              <History className="h-3.5 w-3.5" /> What changed in this refinement
            </div>
            {lastChanges.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {lastChanges.map((c, i) => (
                  <li key={i} className="flex gap-2 text-emerald-700 dark:text-emerald-300/90">
                    <span>•</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-emerald-700 dark:text-emerald-300/90">
                The AI didn't report specific changes this time — try a more specific refinement note (e.g. "use 3 replicates instead of 2").
              </p>
            )}
          </div>
        )}

        {protocol.materials.length > 0 && (
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-bold text-muted-foreground mb-2 flex items-center gap-1.5">
              <Beaker className="h-3.5 w-3.5" /> Materials
            </div>
            <ul className="space-y-1 text-sm">
              {protocol.materials.map((m, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span className="text-muted-foreground">{m}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {protocol.controls.length > 0 && (
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-bold text-muted-foreground mb-2 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Controls
            </div>
            <ul className="space-y-1 text-sm">
              {protocol.controls.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span className="text-muted-foreground">{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {protocol.plate_layout && (
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-bold text-muted-foreground mb-2 flex items-center gap-1.5">
              <LayoutGrid className="h-3.5 w-3.5" /> Plate layout
            </div>
            <p className="text-sm text-muted-foreground">{protocol.plate_layout}</p>
          </div>
        )}

        {protocol.steps.length > 0 && (
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-bold text-muted-foreground mb-2">Steps</div>
            <ol className="space-y-2">
              {protocol.steps.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-sm">
                  <button
                    type="button"
                    onClick={() => toggleStep(i)}
                    className={`mt-0.5 flex-shrink-0 h-4 w-4 rounded border flex items-center justify-center text-[10px] transition-colors ${
                      checked[i] ? "bg-primary border-primary text-primary-foreground" : "border-border hover:border-primary"
                    }`}
                    aria-label={checked[i] ? `Mark step ${i + 1} incomplete` : `Mark step ${i + 1} complete`}
                  >
                    {checked[i] ? "✓" : ""}
                  </button>
                  <span className={checked[i] ? "text-muted-foreground line-through" : "text-foreground"}>
                    {s}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {protocol.expected_readout && (
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5" /> Expected readout
              </div>
              <p className="text-sm text-muted-foreground">{protocol.expected_readout}</p>
            </div>
          )}
          {protocol.suggested_analysis && (
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" /> Suggested analysis
              </div>
              <p className="text-sm text-muted-foreground">{protocol.suggested_analysis}</p>
            </div>
          )}
        </div>

        {protocol.review_notes.length > 0 && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
            <div className="text-xs font-bold text-yellow-600 dark:text-yellow-400 mb-2 flex items-center gap-1.5">
              <Lightbulb className="h-3.5 w-3.5" /> AI suggestions
            </div>
            <ul className="space-y-1 text-sm">
              {protocol.review_notes.map((n, i) => (
                <li key={i} className="flex gap-2 text-yellow-700 dark:text-yellow-300/90">
                  <span>•</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="pt-1 text-xs text-muted-foreground flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          Replace this protocol anytime with a new upload or another AI refinement above.
        </div>
        <ImproveAiDialog
          requestId={latestRequestId}
          output={JSON.stringify(protocol, null, 2)}
          taskLabel="protocol"
          compact
        />
      </CardContent>
    </Card>
  );
}
