import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getListExperimentsQueryKey, useCreateExperiment } from "@workspace/api-client-react";
import {
  ArrowLeft,
  ArrowRight,
  Beaker,
  BookTemplate,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleDot,
  FlaskConical,
  Gauge,
  Lightbulb,
  Loader2,
  Microscope,
  NotebookPen,
  Orbit,
  Sparkles,
  Target,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  LabConversation,
  LabPageHeader,
  LabPanel,
  LabSectionHeader,
  type LabAccent,
} from "@/components/lab/LivingLab";

interface Template {
  id: number;
  name: string;
  assay_type: string;
  instrument: string;
  default_notes: string | null;
  expected_status_default: string;
  description: string | null;
}

const CREATE_STATUSES = ["designing", "ready", "running"] as const;
type CreateStatus = (typeof CREATE_STATUSES)[number];

function normalizeTemplateStatus(value: string | null | undefined): CreateStatus {
  return (CREATE_STATUSES as readonly string[]).includes(value ?? "") ? value as CreateStatus : "designing";
}

const formSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  date: z.string(),
  assay_type: z.string(),
  instrument: z.string().default("Generic"),
  notes: z.string().optional(),
  status: z.enum(CREATE_STATUSES).default("designing"),
});

const workflowSteps = [
  { title: "Frame the run", copy: "Name the question and experimental setup.", icon: Target, accent: "cyan" as LabAccent },
  { title: "Verify the record", copy: "Read the manifest before it becomes memory.", icon: CheckCircle2, accent: "emerald" as LabAccent },
];

export function ExperimentForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [step, setStep] = useState(0);

  const { data: templates } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => apiFetch("/api/templates").then((response) => response.json()),
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      date: format(new Date(), "yyyy-MM-dd"),
      assay_type: "",
      instrument: "Generic",
      notes: "",
      status: "designing",
    },
  });

  const createMutation = useCreateExperiment({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Experiment created", description: "The record is alive. Add the protocol or attach the first signal." });
        queryClient.invalidateQueries({ queryKey: getListExperimentsQueryKey() });
        setLocation(`/experiments/${data.id}`);
      },
      onError: (error) => {
        const message = "error" in error && error.error
          ? String((error as { error?: { error?: string } }).error?.error ?? "Unknown error occurred")
          : "Unknown error occurred";
        toast({ title: "Couldn’t create experiment", description: message, variant: "destructive" });
      },
    },
  });

  const values = form.watch();
  const completeness = [values.name?.length >= 2, values.assay_type?.length >= 2, Boolean(values.date), Boolean(values.instrument), Boolean(values.notes)].filter(Boolean).length;
  const canProceed = values.name?.trim().length >= 2;

  function applyTemplate(id: string) {
    const template = templates?.find((item) => String(item.id) === id);
    if (!template) return;
    setSelectedTemplateId(id);
    form.setValue("assay_type", template.assay_type);
    form.setValue("instrument", template.instrument);
    if (template.default_notes) form.setValue("notes", template.default_notes);
    form.setValue("status", normalizeTemplateStatus(template.expected_status_default));
    toast({ title: `Template applied: ${template.name}`, description: "The starting structure is ready for your judgment." });
  }

  return (
    <div className="lab-page">
      <LabPageHeader
        eyebrow="Experiment composer"
        title="Design the record before the data decides the story."
        description="A clean experiment begins with a clear question. Frame the run now, then Bioalyzer will keep the protocol, source data, analysis, and follow-up decisions attached to it."
        icon={FlaskConical}
        accent="cyan"
        status={`Step ${step + 1} of 2`}
        actions={
          <Button variant="outline" size="lg" className="h-11 gap-2 rounded-xl" onClick={() => setLocation("/experiments")} data-feedback="navigate" data-feedback-message="Returning to the experiment archive">
            <ArrowLeft className="h-4 w-4" /> Back to the archive
          </Button>
        }
        aside={
          <div className="w-full space-y-4">
            <div className="flex items-center justify-between">
              <p className="lab-kicker"><span className="lab-kicker-pulse" />Record quality</p>
              <span className="font-mono text-xs text-primary">{completeness}/5</span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {Array.from({ length: 5 }, (_, index) => <motion.span key={index} className={`h-16 rounded-lg border ${index < completeness ? "border-primary/35 bg-primary/25" : "border-border/60 bg-background/35"}`} animate={{ opacity: index < completeness ? 1 : 0.45 }} />)}
            </div>
            <p className="text-[10px] leading-4 text-muted-foreground">Context becomes more useful as the record gets more specific.</p>
          </div>
        }
      />

      <LabConversation accent={step === 0 ? "cyan" : "emerald"}>
        {step === 0
          ? values.name
            ? `“${values.name}” has a name. Now make the scientific goal precise enough that your future self can understand why this run existed.`
            : "Start with the question, not the file. A specific name and goal make every later analysis more grounded."
          : "Read this like a lab notebook entry written by someone else. If the intent is obvious, the record is ready to become memory."}
      </LabConversation>

      <div className="grid items-start gap-5 xl:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-4">
          <LabPanel className="p-4" accent="cyan">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Composition sequence</p>
            <div className="mt-5 space-y-2">
              {workflowSteps.map((item, index) => {
                const Icon = item.icon;
                const active = step === index;
                const complete = step > index;
                return (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => index <= step && setStep(index)}
                    disabled={index > step}
                    data-accent={item.accent}
                    data-feedback="navigate"
                    data-feedback-message={`Moving to ${item.title.toLowerCase()}`}
                    className={`relative flex w-full gap-3 overflow-hidden rounded-xl border p-3 text-left transition ${active ? "border-[var(--lab-accent)]/30 bg-[var(--lab-accent-soft)]" : "border-transparent hover:border-border/60 hover:bg-background/35"}`}
                  >
                    {active && <motion.span layoutId="composer-step" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--lab-accent)]" />}
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${active || complete ? "border-[var(--lab-accent)]/25 bg-[var(--lab-accent-soft)] text-[var(--lab-accent)]" : "border-border text-muted-foreground"}`}>
                      {complete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                    </span>
                    <span>
                      <span className="block text-xs font-semibold">{item.title}</span>
                      <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{item.copy}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </LabPanel>

          {templates && templates.length > 0 && (
            <LabPanel className="p-4" accent="violet">
              <div className="flex items-center gap-2 text-violet-200"><BookTemplate className="h-4 w-4" /><p className="text-xs font-semibold">Borrow a proven structure</p></div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Templates fill the setup. You still own the scientific judgment.</p>
              <div className="mt-4 space-y-2">
                {templates.slice(0, 5).map((template) => {
                  const active = selectedTemplateId === String(template.id);
                  return (
                    <button key={template.id} type="button" onClick={() => applyTemplate(String(template.id))} data-feedback="create" data-feedback-message={`Applying the ${template.name} starting structure`} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[10px] transition ${active ? "border-violet-300/35 bg-violet-300/10 text-violet-100" : "border-border/60 text-muted-foreground hover:border-violet-300/25 hover:text-foreground"}`}>
                      <CircleDot className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{template.name}</span>{active && <Check className="ml-auto h-3.5 w-3.5" />}
                    </button>
                  );
                })}
              </div>
            </LabPanel>
          )}

          <LabPanel className="p-4" accent="amber">
            <div className="flex gap-3"><Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><p className="text-[10px] leading-5 text-muted-foreground">The protocol and raw data come after this record is created. This step captures the intent they need to be interpreted correctly.</p></div>
          </LabPanel>
        </aside>

        <Form {...form}>
          <form onSubmit={form.handleSubmit((submitted) => createMutation.mutate({ data: { ...submitted, assay_type: submitted.assay_type.trim() || "Plate-reader assay" } }))} data-feedback-message="Saving the experiment into your lab memory">
            <AnimatePresence mode="wait">
              {step === 0 ? (
                <motion.div key="compose" initial={{ opacity: 0, x: 20, filter: "blur(5px)" }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }} exit={{ opacity: 0, x: -14, filter: "blur(4px)" }} transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}>
                  <LabPanel className="p-5 sm:p-7 lg:p-8" accent="cyan">
                    <LabSectionHeader eyebrow="01 · Frame the run" title="Write the experiment’s identity" description="Use language that will still make sense when this run is one of fifty." />
                    <div className="mt-8 grid gap-6 md:grid-cols-2">
                      <FormField control={form.control} name="name" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-2"><NotebookPen className="h-3.5 w-3.5 text-primary" /> Experiment name <span className="text-destructive">*</span></FormLabel>
                          <FormControl><Input className="h-11 rounded-xl" placeholder="Compound-X · MTT dose response" {...field} autoFocus /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="date" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-2"><CalendarDays className="h-3.5 w-3.5 text-primary" /> Run date</FormLabel>
                          <FormControl><Input className="h-11 rounded-xl" type="date" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="assay_type" render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <FormLabel className="flex items-center gap-2"><Target className="h-3.5 w-3.5 text-primary" /> Scientific goal (optional)</FormLabel>
                          <FormControl><Textarea className="min-h-24 rounded-xl" placeholder="Estimate Compound-X IC50 in the MTT viability assay and identify the concentration range worth repeating." {...field} /></FormControl>
                          <p className="text-[10px] leading-4 text-muted-foreground">State what you want to learn—not only the assay name.</p>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="instrument" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-2"><Microscope className="h-3.5 w-3.5 text-primary" /> Instrument</FormLabel>
                          <FormControl><Input className="h-11 rounded-xl" placeholder="BioTek Synergy H1" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="status" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-2"><Gauge className="h-3.5 w-3.5 text-primary" /> Lifecycle stage</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent><SelectItem value="designing">Designing</SelectItem><SelectItem value="ready">Ready to run</SelectItem><SelectItem value="running">Running</SelectItem></SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="notes" render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <FormLabel className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-violet-300" /> Context the copilot should inherit</FormLabel>
                          <FormControl><Textarea className="min-h-36 rounded-xl" placeholder="Cell line, compound constraints, control strategy, what you already know, and what would make this run useful…" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border/65 pt-5 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-[10px] text-muted-foreground">Required: experiment name</p>
                      <Button type="button" size="lg" className="gap-2 rounded-xl" disabled={!canProceed} onClick={() => setStep(1)} data-feedback="navigate" data-feedback-message="Reviewing the experiment before it becomes memory">
                        Review the record <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </LabPanel>
                </motion.div>
              ) : (
                <motion.div key="review" initial={{ opacity: 0, x: 20, filter: "blur(5px)" }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}>
                  <LabPanel className="p-5 sm:p-7 lg:p-8" accent="emerald">
                    <LabSectionHeader eyebrow="02 · Verify the record" title="This is what the workspace will remember" description="Read the manifest once more. Precise context now means better analysis later." />
                    <div className="mt-8 grid gap-3 sm:grid-cols-2">
                      {[
                        ["Experiment identity", values.name, Beaker],
                        ["Run date", values.date, CalendarDays],
                        ["Scientific goal", values.assay_type, Target],
                        ["Instrument", values.instrument, Microscope],
                        ["Lifecycle", values.status.replace(/_/g, " "), Orbit],
                      ].map(([label, value, IconValue], index) => {
                        const Icon = IconValue as typeof Beaker;
                        return (
                          <motion.div key={String(label)} className={`${index === 2 ? "sm:col-span-2" : ""} rounded-2xl border border-border/65 bg-background/35 p-4`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + index * 0.04 }}>
                            <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><Icon className="h-3.5 w-3.5 text-emerald-300" />{String(label)}</div>
                            <p className="mt-3 text-sm font-medium leading-6 capitalize">{String(value || "Not provided")}</p>
                          </motion.div>
                        );
                      })}
                    </div>
                    <div className="mt-3 rounded-2xl border border-violet-300/15 bg-violet-300/[0.04] p-4 sm:p-5">
                      <p className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-wider text-violet-200"><Sparkles className="h-3.5 w-3.5" />Inherited copilot context</p>
                      <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{values.notes || "No additional context provided. You can add notes and documents from the living experiment record."}</p>
                    </div>
                    <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border/65 pt-5 sm:flex-row sm:items-center sm:justify-between">
                      <Button type="button" variant="outline" className="gap-2 rounded-xl" onClick={() => setStep(0)} data-feedback="navigate" data-feedback-message="Returning to edit the experiment brief"><ArrowLeft className="h-4 w-4" /> Edit the brief</Button>
                      <Button type="submit" size="lg" className="gap-2 rounded-xl" disabled={createMutation.isPending} data-feedback="save" data-feedback-message="Saving the experiment into your lab memory">
                        {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Make this record live
                      </Button>
                    </div>
                  </LabPanel>
                </motion.div>
              )}
            </AnimatePresence>
          </form>
        </Form>
      </div>
    </div>
  );
}
