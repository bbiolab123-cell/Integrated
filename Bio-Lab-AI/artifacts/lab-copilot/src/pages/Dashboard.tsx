import { AttachDataCard } from "@/components/experiment/AttachDataCard";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { format, parseISO } from "date-fns";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Beaker,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  FlaskConical,
  Microscope,
  Orbit,
  Plus,
  Sparkles,
  TrendingUp,
  Upload,
  Waves,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useGetDashboard, getGetDashboardQueryKey, getListExperimentsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { AskAnythingChat } from "@/components/dashboard/AskAnythingChat";
import { DashboardTasks } from "@/components/dashboard/DashboardTasks";
import { useAppUser } from "@/contexts/UserContext";
import {
  LabConversation,
  LabMetric,
  LabPageHeader,
  LabPanel,
  LabSectionHeader,
  LabTextLink,
  type LabAccent,
} from "@/components/lab/LivingLab";

const plateWells = Array.from({ length: 96 }, (_, index) => ({
  index,
  delay: (index % 12) * 0.018 + Math.floor(index / 12) * 0.026,
  active: [14, 15, 26, 27, 38, 39, 50, 51, 62, 63, 74, 75].includes(index),
  control: [9, 21, 33, 45, 57, 69, 81, 93].includes(index),
}));

function AnimatedCounter({ value }: { value: number }) {
  const motionValue = useMotionValue(0);
  const springValue = useSpring(motionValue, { stiffness: 110, damping: 28 });
  const displayValue = useTransform(springValue, (current) => Math.round(current));

  useEffect(() => {
    motionValue.set(value);
  }, [motionValue, value]);

  return <motion.span>{displayValue}</motion.span>;
}

function LivingPlate() {
  return (
    <div className="relative mx-auto w-full max-w-[520px]">
      <div className="absolute -inset-10 rounded-full bg-primary/[0.06] blur-3xl" />
      <LabPanel className="relative p-5 sm:p-6" accent="cyan">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="lab-kicker"><span className="lab-kicker-pulse" />Awaiting first signal</p>
            <p className="mt-2 text-sm font-semibold">Virtual plate · 96 wells</p>
          </div>
          <span className="rounded-full border border-primary/20 bg-primary/[0.07] px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-primary">armed</span>
        </div>
        <div className="grid grid-cols-12 gap-1.5 sm:gap-2" aria-hidden="true">
          {plateWells.map((well) => (
            <motion.span
              key={well.index}
              className={`aspect-square rounded-[28%] border ${
                well.active
                  ? "border-primary/50 bg-primary/35 shadow-[0_0_14px_hsl(var(--primary)/.18)]"
                  : well.control
                    ? "border-amber-300/45 bg-amber-300/25"
                    : "border-border/80 bg-background/55"
              }`}
              initial={{ opacity: 0, scale: 0.45 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.16 + well.delay, duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            />
          ))}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2">
          {[
            ["Source", "Unassigned"],
            ["Controls", "Ready"],
            ["Context", "Listening"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border/65 bg-background/40 p-2.5">
              <p className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 text-[11px] font-medium">{value}</p>
            </div>
          ))}
        </div>
      </LabPanel>
    </div>
  );
}

function OnboardingEmptyState({ firstName }: { firstName: string }) {
  const [, navigate] = useLocation();

  return (
    <div className="lab-page">
      <LabPageHeader
        eyebrow="Lab initialization"
        title={`${firstName}, give your lab its first memory.`}
        description="Bioalyzer becomes more useful with every run. Start one clean record and it will keep the data, protocol, decisions, and next move connected from here forward."
        icon={FlaskConical}
        status="No experiments yet"
        accent="cyan"
        actions={
          <>
            <Button
              size="lg"
              className="h-11 gap-2 rounded-xl px-5 font-semibold"
              onClick={() => navigate("/experiments/new")}
              data-feedback="create"
              data-feedback-message="Opening your first living experiment record"
            >
              <Plus className="h-4 w-4" /> Create the first experiment <ArrowRight className="h-4 w-4" />
            </Button>
            <Link href="/data-analysis">
              <Button variant="outline" size="lg" className="h-11 gap-2 rounded-xl px-5">
                <Waves className="h-4 w-4" /> Explore analysis
              </Button>
            </Link>
          </>
        }
      />

      <LabConversation accent="violet">
        I’m quiet because there is no experimental history yet. Give me one run and I’ll start connecting patterns, quality signals, and next actions for you.
      </LabConversation>

      <div className="grid items-center gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-4">
          <LabSectionHeader
            eyebrow="The first three moves"
            title="From blank workspace to useful memory."
            description="Each step creates something the next step can reason about. Nothing disappears into a disconnected tool."
          />
          {[
            {
              icon: Upload,
              title: "Name the scientific question",
              copy: "Create a record with the goal, instrument, date, and the context that would otherwise live in your head.",
              accent: "cyan" as LabAccent,
            },
            {
              icon: Microscope,
              title: "Attach the raw signal",
              copy: "Bring in a plate export, qPCR file, NanoDrop CSV, or instrument output and preserve its source trail.",
              accent: "violet" as LabAccent,
            },
            {
              icon: BrainCircuit,
              title: "Let the workspace answer back",
              copy: "Bioalyzer reviews quality, explains the result in context, and keeps the next experiment connected.",
              accent: "emerald" as LabAccent,
            },
          ].map((step, index) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + index * 0.08 }}
            >
              <LabPanel className="group flex gap-4 p-4 sm:p-5" accent={step.accent} interactive>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--lab-accent)_25%,transparent)] bg-[var(--lab-accent-soft)] text-[var(--lab-accent)]">
                  <step.icon className="h-5 w-5" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="lab-index-number">0{index + 1}</span>
                    <h3 className="text-sm font-semibold">{step.title}</h3>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{step.copy}</p>
                </div>
              </LabPanel>
            </motion.div>
          ))}
        </div>
        <LivingPlate />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {["Synergy H1 + plate readers", "qPCR + fluorescence", "NanoDrop + cell counting"].map((label, index) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-border/65 bg-card/45 p-3.5 text-xs text-muted-foreground">
            <span className="font-mono text-[9px] text-primary">0{index + 1}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  return (
    <>
      <div className="lab-page"><AttachDataCard onAttached={(id) => {
        void queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListExperimentsQueryKey() });
        navigate(`/experiments/${id}`);
      }} /></div>
      <DashboardOverview />
    </>
  );
}

function DashboardOverview() {
  const { data: dashboard, isLoading, refetch } = useGetDashboard({
    query: { queryKey: getGetDashboardQueryKey() },
  });
  const { displayName } = useAppUser();
  const firstName = displayName?.split(/\s+/)[0] || "Scientist";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  if (isLoading) {
    return (
      <div className="lab-page">
        <Skeleton className="h-[290px] rounded-[1.6rem]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-44 rounded-2xl" />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-[1.4fr_.6fr]">
          <Skeleton className="h-[380px] rounded-2xl" />
          <Skeleton className="h-[380px] rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="lab-page">
        <LabPageHeader
          eyebrow="Signal interrupted"
          title="The lab went quiet for a moment."
          description="Your records are still safe. The workspace could not reach the experiment service, so I’m holding this view until the signal returns."
          icon={AlertTriangle}
          accent="rose"
          status="Connection unavailable"
          actions={
            <Button variant="outline" onClick={() => refetch()} data-feedback="analyze" data-feedback-message="Checking the workspace signal again">
              <Activity className="h-4 w-4" /> Reconnect
            </Button>
          }
        />
        <LabConversation accent="rose">I’ll repopulate the dashboard as soon as the API responds. You do not need to recreate anything.</LabConversation>
      </div>
    );
  }

  if (dashboard.total_experiments === 0) {
    return <OnboardingEmptyState firstName={firstName} />;
  }

  const successCount = dashboard.by_status.success || 0;
  const failedCount = dashboard.by_status.failed || 0;
  const successRate = Math.round((successCount / dashboard.total_experiments) * 100);
  const activeRuns = (dashboard.by_status.in_progress || 0) + (dashboard.by_status.running || 0);
  const designingRuns = dashboard.by_status.designing || 0;
  const latestRun = dashboard.recent_experiments[0];
  const topAssay = [...dashboard.assay_type_breakdown].sort((a, b) => b.count - a.count)[0];

  return (
    <div className="lab-page">
      <LabPageHeader
        eyebrow="Live lab command"
        title={`${greeting}, ${firstName}. Your lab is speaking.`}
        description="Every signal below comes from the work already in your workspace—what is moving, what needs attention, and where your next decision has the most leverage."
        icon={Orbit}
        accent="cyan"
        status={`${dashboard.total_experiments} connected records`}
        actions={
          <>
            <Link href="/experiments/new" data-feedback="create" data-feedback-message="Opening a fresh experiment record">
              <Button size="lg" className="h-11 gap-2 rounded-xl px-5"><Plus className="h-4 w-4" /> New experiment</Button>
            </Link>
            <Link href="/data-analysis" data-feedback="analyze" data-feedback-message="Opening the analysis instrument">
              <Button size="lg" variant="outline" className="h-11 gap-2 rounded-xl px-5"><BarChart3 className="h-4 w-4" /> Read the data</Button>
            </Link>
          </>
        }
        aside={
          <div className="w-full space-y-3">
            <div className="lab-panel p-4" data-accent="cyan">
              <div className="flex items-center justify-between">
                <span className="lab-kicker"><span className="lab-kicker-pulse" />Live signal</span>
                <Waves className="h-4 w-4 text-primary" />
              </div>
              <div className="mt-6 flex h-20 items-end gap-1.5" aria-hidden="true">
                {[35, 62, 48, 82, 56, 91, 68, 45, 76, 58, 88, 70].map((height, index) => (
                  <motion.span
                    key={index}
                    className={`flex-1 rounded-t ${index === 5 ? "bg-amber-400" : "bg-primary"}`}
                    initial={{ height: 0 }}
                    animate={{ height: `${height}%` }}
                    transition={{ delay: 0.2 + index * 0.035, duration: 0.5 }}
                  />
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Latest: {latestRun?.name ?? "—"}</span>
                <span className="font-mono text-emerald-400">SYNCED</span>
              </div>
            </div>
          </div>
        }
      />

      <LabConversation accent={failedCount > 0 ? "amber" : "emerald"}>
        {failedCount > 0
          ? `${failedCount} ${failedCount === 1 ? "run needs" : "runs need"} your attention. I’d review those before committing the next protocol.`
          : activeRuns > 0
            ? `${activeRuns} ${activeRuns === 1 ? "run is" : "runs are"} active. I’ll keep the context warm while the data comes in.`
            : `The workspace is stable. ${successRate}% of recorded outcomes are successful, and your latest evidence is ready to revisit.`}
      </LabConversation>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <LabMetric label="Connected records" value={<AnimatedCounter value={dashboard.total_experiments} />} detail="Your complete experimental memory" icon={Activity} accent="cyan" index={0} />
        <LabMetric label="Evidence confidence" value={<><AnimatedCounter value={successRate} /><span className="text-lg text-muted-foreground">%</span></>} detail={`${successCount} successful outcomes`} icon={CheckCircle2} accent="emerald" index={1} />
        <LabMetric label="In motion" value={<AnimatedCounter value={activeRuns} />} detail={`${designingRuns} more in design`} icon={TrendingUp} accent="violet" index={2} />
        <LabMetric label="Needs review" value={<AnimatedCounter value={failedCount} />} detail={failedCount ? "Open the evidence before repeating" : "No failed outcomes waiting"} icon={AlertTriangle} accent={failedCount ? "rose" : "amber"} index={3} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_.6fr]">
        <LabPanel className="p-5 sm:p-6" accent="cyan">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="lab-kicker"><span className="lab-kicker-pulse" />Experiment velocity</p>
              <h2 className="mt-3 text-xl font-semibold tracking-[-0.03em]">How your lab memory is growing</h2>
              <p className="mt-1 text-xs text-muted-foreground">Recorded experiments over time</p>
            </div>
            <span className="rounded-full border border-border/70 bg-background/40 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">live history</span>
          </div>
          <div className="mt-6 h-[290px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dashboard.experiments_by_date} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="labVelocity" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.38} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 8" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="date" tickFormatter={(value) => format(parseISO(value), "MMM d")} tickLine={false} axisLine={false} fontSize={10} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
                <Tooltip
                  labelFormatter={(value) => format(parseISO(String(value)), "MMM d, yyyy")}
                  contentStyle={{ borderRadius: 14, border: "1px solid hsl(var(--border))", background: "hsl(var(--card) / .96)", fontSize: 12 }}
                />
                <Area type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#labVelocity)" activeDot={{ r: 5, fill: "hsl(var(--primary))" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </LabPanel>

        <LabPanel className="flex flex-col p-5 sm:p-6" accent="violet">
          <p className="lab-kicker"><span className="lab-kicker-pulse" />Context profile</p>
          <h2 className="mt-3 text-xl font-semibold tracking-[-0.03em]">What this workspace knows best</h2>
          <div className="mt-6 flex flex-1 flex-col justify-center">
            <div className="relative mx-auto flex h-40 w-40 items-center justify-center rounded-full border border-violet-300/20 bg-violet-300/[0.04]">
              <motion.span className="absolute inset-3 rounded-full border border-dashed border-violet-300/20" animate={{ rotate: 360 }} transition={{ duration: 24, repeat: Infinity, ease: "linear" }} />
              <div className="text-center">
                <p className="text-4xl font-semibold tracking-[-0.06em]">{topAssay?.count ?? 0}</p>
                <p className="mt-1 max-w-24 text-[10px] leading-4 text-muted-foreground">{topAssay?.assay_type ?? "No assay type"}</p>
              </div>
            </div>
            <div className="mt-6 space-y-2">
              {dashboard.assay_type_breakdown.slice(0, 4).map((assay, index) => (
                <div key={assay.assay_type} className="flex items-center gap-3 text-xs">
                  <span className={`h-1.5 w-1.5 rounded-full ${index === 0 ? "bg-violet-400" : "bg-primary/60"}`} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{assay.assay_type}</span>
                  <span className="font-mono">{assay.count}</span>
                </div>
              ))}
            </div>
          </div>
        </LabPanel>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
        <div className="space-y-4">
          <LabSectionHeader eyebrow="Fresh evidence" title="Recent experimental signals" description="Open a run where its source, decision trail, and next actions are still attached." />
          <div className="space-y-2.5">
            {dashboard.recent_experiments.slice(0, 6).map((experiment, index) => (
              <motion.div key={experiment.id} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12 + index * 0.05 }}>
                <Link href={`/experiments/${experiment.id}`} data-feedback="navigate" data-feedback-message={`Opening ${experiment.name}`}>
                  <LabPanel className="group grid items-center gap-4 p-4 sm:grid-cols-[auto_1fr_auto]" accent={experiment.status === "failed" ? "rose" : experiment.status === "success" ? "emerald" : "cyan"} interactive>
                    <span className="lab-index-number">0{index + 1}</span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold transition-colors group-hover:text-primary">{experiment.name}</h3>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                        <span>{format(parseISO(experiment.date), "MMM d, yyyy")}</span>
                        <span>{experiment.assay_type}</span>
                        <span>{experiment.instrument}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={experiment.status} />
                      <LabTextLink>Open</LabTextLink>
                    </div>
                  </LabPanel>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <LabSectionHeader eyebrow="Activity trace" title="The last five moves" description="A compact read of how work has been progressing." />
          <LabPanel className="p-5" accent="amber">
            <div className="relative space-y-5">
              <span className="absolute bottom-2 left-[7px] top-2 w-px bg-gradient-to-b from-amber-300/60 via-border to-transparent" />
              {dashboard.recent_experiments.slice(0, 5).map((experiment, index) => (
                <div key={experiment.id} className="relative flex gap-4">
                  <span className={`relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-card ${experiment.status === "success" ? "bg-emerald-400" : experiment.status === "failed" ? "bg-rose-400" : "bg-amber-400"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{experiment.name}</p>
                    <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      <span>{experiment.status.replace(/_/g, " ")}</span>
                      <span>{format(parseISO(experiment.date), "MMM d")}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </LabPanel>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="space-y-4">
          <LabSectionHeader eyebrow="Follow-through" title="Actions waiting on the science" />
          <LabPanel className="p-4 sm:p-5" accent="amber"><DashboardTasks /></LabPanel>
        </section>
        <section className="space-y-4">
          <LabSectionHeader eyebrow="Grounded copilot" title="Ask the memory, not a blank model" />
          <LabPanel className="p-4 sm:p-5" accent="violet"><AskAnythingChat /></LabPanel>
        </section>
      </div>
    </div>
  );
}
