import { useState } from "react";
import { useParams, Link } from "wouter";
import { apiFetch } from "@/lib/apiFetch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { FolderKanban, FlaskConical, Calendar, Microscope, Plus, Pencil, Trash2, Loader2, ArrowLeft, X, FileText, Upload, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Label } from "@/components/ui/label";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ProjectChat } from "@/components/chat/ProjectChat";
import { LabConversation, LabPageHeader, LabPanel, LabSectionHeader } from "@/components/lab/LivingLab";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";

interface ExperimentRef {
  id: number;
  name: string;
  date: string;
  assay_type: string;
  instrument: string;
  status: string;
}

interface ProjectDetailData {
  id: number;
  name: string;
  goal: string | null;
  status: string;
  ai_summary: string | null;
  ai_summary_request_id: string | null;
  experiments: ExperimentRef[];
}

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addExpId, setAddExpId] = useState("");
  const [docOpen, setDocOpen] = useState(false);
  const [docName, setDocName] = useState("");
  const [docContent, setDocContent] = useState("");

  const { data: project, isLoading } = useQuery<ProjectDetailData>({
    queryKey: ["project", projectId],
    queryFn: () => apiFetch(`/api/projects/${projectId}`).then((r) => r.json()),
    enabled: !!projectId,
  });

  // All of the user's experiments, to offer the ones not yet in this project.
  const { data: allExperiments } = useQuery<ExperimentRef[]>({
    queryKey: ["experiments-for-project"],
    queryFn: () => apiFetch("/api/experiments").then((r) => r.json()),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const synthesizeMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}/synthesize`, { method: "POST" }).then(async (r) => {
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error((e as { error?: string }).error || "Synthesis failed");
        }
        return r.json();
      }),
    onSuccess: () => { invalidate(); toast({ title: "Project synthesized" }); },
    onError: (e: unknown) =>
      toast({ title: "Couldn't synthesize", description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
  });

  const assignMutation = useMutation({
    mutationFn: ({ expId, project_id }: { expId: number; project_id: number | null }) =>
      apiFetch(`/api/experiments/${expId}/project`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id }),
      }).then((r) => r.json()),
    onSuccess: () => { invalidate(); setAddExpId(""); },
    onError: () => toast({ title: "Error", description: "Failed to update experiment.", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; goal: string }) =>
      apiFetch(`/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => { invalidate(); setEditOpen(false); toast({ title: "Project updated" }); },
    onError: () => toast({ title: "Error", description: "Failed to update project.", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: "Project deleted", description: "Its experiments are now ungrouped." });
      window.history.length > 1 ? window.history.back() : (window.location.href = "/projects");
    },
    onError: () => toast({ title: "Error", description: "Failed to delete project.", variant: "destructive" }),
  });

  const { data: documents } = useQuery<{ id: number; name: string; chars: number; created_at: string }[]>({
    queryKey: ["project-docs", projectId],
    queryFn: () => apiFetch(`/api/projects/${projectId}/documents`).then((r) => r.json()),
    enabled: !!projectId,
  });

  const addDocMutation = useMutation({
    mutationFn: (data: { name: string; content: string }) =>
      apiFetch(`/api/projects/${projectId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => { if (!r.ok) throw new Error("add failed"); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-docs", projectId] });
      setDocOpen(false); setDocName(""); setDocContent("");
      toast({ title: "Context added", description: "The project copilot will use it." });
    },
    onError: () => toast({ title: "Error", description: "Failed to add context.", variant: "destructive" }),
  });

  const deleteDocMutation = useMutation({
    mutationFn: (docId: number) => apiFetch(`/api/project-documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-docs", projectId] }),
    onError: () => toast({ title: "Error", description: "Failed to delete.", variant: "destructive" }),
  });

  const readFile = (file: File) => {
    if (!/\.(txt|md|markdown|csv|tsv|json|log|tab|text)$/i.test(file.name)) {
      toast({
        title: "Text files only (for now)",
        description: "Upload .txt, .md, .csv, .tsv or .json — or paste text. PDF/image support is coming.",
        variant: "destructive",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDocContent(String(reader.result ?? ""));
      setDocName((n) => (n.trim() ? n : file.name));
    };
    reader.readAsText(file);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-5xl mx-auto">
        <div className="h-10 w-64 bg-muted animate-pulse rounded" />
        <div className="h-40 bg-muted animate-pulse rounded-xl" />
      </div>
    );
  }

  if (!project) {
    return <div className="text-center py-12 font-mono">Project not found</div>;
  }

  const inProjectIds = new Set(project.experiments.map((e) => e.id));
  const assignable = (allExperiments ?? []).filter((e) => !inProjectIds.has(e.id));

  return (
    <div className="lab-page space-y-7 pb-12" data-accent="violet">
      <LabPageHeader
        eyebrow="Project mission control"
        title={project.name}
        description={project.goal ?? "This constellation needs a clear goal. Add one so every experiment and AI synthesis can point toward the same scientific question."}
        icon={FolderKanban}
        accent="violet"
        status={`${project.experiments.length} connected experiment${project.experiments.length === 1 ? "" : "s"}`}
        actions={<>
          <Link href="/projects">
            <Button variant="ghost" className="gap-2"><ArrowLeft className="h-4 w-4" /> All projects</Button>
          </Link>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => { setEditName(project.name); setEditGoal(project.goal ?? ""); setEditOpen(true); }}
          >
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </>}
        aside={
          <div className="relative grid h-48 w-48 place-items-center" aria-hidden="true">
            {[0, 1, 2].map((ring) => (
              <motion.span
                key={ring}
                className="absolute rounded-full border border-primary/20"
                style={{ inset: 12 + ring * 22 }}
                animate={{ rotate: ring % 2 ? -360 : 360 }}
                transition={{ duration: 18 + ring * 6, repeat: Infinity, ease: "linear" }}
              />
            ))}
            <FolderKanban className="h-10 w-10 text-primary" />
            <span className="absolute left-3 top-1/2 h-2 w-2 rounded-full bg-primary shadow-[0_0_18px_hsl(var(--primary))]" />
            <span className="absolute right-8 top-8 h-2 w-2 rounded-full bg-emerald-400" />
          </div>
        }
      />

      <LabConversation accent="violet">
        {project.ai_summary
          ? "I have a cross-experiment synthesis for this project. As the evidence changes, re-run it to keep the project’s working theory current."
          : project.experiments.length
            ? "The experiments are connected. I’m ready to synthesize what is established, what conflicts, and which next run has the highest information value."
            : "This mission has a goal but no evidence trail yet. Connect the first experiment below and I’ll start building the project memory."}
      </LabConversation>

      {/* Project synthesis */}
      <Card className="lab-panel overflow-hidden rounded-[1.8rem] border-primary/20">
        <CardHeader className="py-4 border-b">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Project synthesis
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={synthesizeMutation.isPending || project.experiments.length === 0}
              onClick={() => synthesizeMutation.mutate()}
            >
              {synthesizeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {synthesizeMutation.isPending ? "Bioalyzing…" : project.ai_summary ? "Re-Bioalyze project" : "Bioalyze project"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {project.ai_summary ? (
            <div className="space-y-4">
              <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{project.ai_summary}</ReactMarkdown>
              </div>
              <ImproveAiDialog requestId={project.ai_summary_request_id} output={project.ai_summary} taskLabel="project synthesis" compact />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {project.experiments.length === 0
                ? "Add experiments, then synthesize to get an AI “state of the project” across all of them."
                : "Generate an AI synthesis across this project’s experiments and context — what’s established, the patterns between runs, and the best next experiments."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Add experiment */}
      <LabPanel accent="violet" className="flex flex-wrap items-center gap-3 p-4">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.17em] text-primary">Connect evidence</span>
        <Select value={addExpId} onValueChange={setAddExpId}>
          <SelectTrigger className="w-72 h-9">
            <SelectValue placeholder={assignable.length ? "Choose an experiment…" : "No ungrouped experiments"} />
          </SelectTrigger>
          <SelectContent>
            {assignable.map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={!addExpId || assignMutation.isPending}
          onClick={() => assignMutation.mutate({ expId: parseInt(addExpId, 10), project_id: projectId })}
        >
          {assignMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add
        </Button>
      </LabPanel>

      {/* Experiments in this project */}
      {project.experiments.length === 0 ? (
        <div className="lab-panel flex flex-col items-center justify-center rounded-[1.8rem] border-dashed py-16 text-center text-muted-foreground">
          <FlaskConical className="h-10 w-10 opacity-30 mb-3" />
          <p className="text-sm">No experiments in this project yet. Add one above.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {project.experiments.map((e, idx) => (
            <motion.div key={e.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: idx * 0.04 }}>
              <Card className="lab-panel rounded-2xl transition-all hover:-translate-y-0.5 hover:border-primary/45">
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/experiments/${e.id}`}>
                        <CardTitle className="text-base leading-tight hover:text-primary transition-colors cursor-pointer truncate">{e.name}</CardTitle>
                      </Link>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono mt-1.5">
                        <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{(() => { try { return format(parseISO(e.date), "MMM d, yyyy"); } catch { return e.date; } })()}</span>
                        <span className="flex items-center gap-1"><FlaskConical className="h-3 w-3" />{e.assay_type}</span>
                        <span className="flex items-center gap-1"><Microscope className="h-3 w-3" />{e.instrument}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <StatusBadge status={e.status} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        title="Remove from project"
                        onClick={() => assignMutation.mutate({ expId: e.id, project_id: null })}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Context & notes */}
      <div className="space-y-4 pt-2">
        <LabSectionHeader eyebrow="Context fabric" title="Give the project a memory." description="Notebook entries, protocols, and observations stay available to the project copilot alongside the experimental record." />
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" /> Context &amp; notes
          </h2>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDocOpen(true)}>
            <Upload className="h-3.5 w-3.5" /> Add context
          </Button>
        </div>
        {!documents || documents.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Add lab-notebook entries, protocols, or notes — the project copilot reads them as context.
          </p>
        ) : (
          <div className="grid gap-2">
            {documents.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <FileText className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                  <span className="truncate">{d.name}</span>
                  <span className="text-xs text-muted-foreground font-mono flex-shrink-0">{d.chars.toLocaleString()} chars</span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive flex-shrink-0"
                  title="Remove"
                  onClick={() => deleteDocMutation.mutate(d.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Project copilot */}
      <div className="pt-2">
        <ProjectChat projectId={project.id} />
      </div>

      {/* Add context dialog */}
      <Dialog open={docOpen} onOpenChange={(v) => { if (!v) setDocOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add project context</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="e.g., Lab notebook — week 3" />
            </div>
            <div className="space-y-1.5">
              <Label>Content</Label>
              <Textarea
                value={docContent}
                onChange={(e) => setDocContent(e.target.value)}
                rows={8}
                placeholder="Paste notes, a protocol, observations… or upload a text file below."
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-primary cursor-pointer hover:underline w-fit">
              <Upload className="h-4 w-4" />
              Upload a text file (.txt, .md, .csv, .json)
              <input
                type="file"
                accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.tab,.text"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocOpen(false)}>Cancel</Button>
            <Button
              disabled={!docName.trim() || !docContent.trim() || addDocMutation.isPending}
              onClick={() => addDocMutation.mutate({ name: docName.trim(), content: docContent })}
            >
              {addDocMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add context
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Goal / brief</Label>
              <Textarea value={editGoal} onChange={(e) => setEditGoal(e.target.value)} rows={5} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              disabled={!editName.trim() || updateMutation.isPending}
              onClick={() => updateMutation.mutate({ name: editName.trim(), goal: editGoal.trim() })}
            >
              {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              "{project.name}" will be removed. Its {project.experiments.length} experiment{project.experiments.length === 1 ? "" : "s"} will NOT be deleted — they just become ungrouped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
