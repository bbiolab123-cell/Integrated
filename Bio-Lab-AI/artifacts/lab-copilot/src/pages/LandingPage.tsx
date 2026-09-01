import { Link } from "wouter";
import { motion, useScroll, useSpring } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Atom,
  BarChart3,
  Beaker,
  Brain,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  FlaskConical,
  LockKeyhole,
  Network,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wand2,
} from "lucide-react";
import { AmbientBackdrop } from "@/components/layout/AmbientBackdrop";
import { HoverLift, Reveal, riseItem, staggerContainer } from "@/components/motion/MotionPrimitives";

const plateWells = Array.from({ length: 96 }, (_, index) => {
  const col = index % 12;
  const row = Math.floor(index / 12);
  const edge = row === 0 || row === 7 || col === 0 || col === 11;
  const active = [14, 15, 26, 27, 39, 51, 63, 74, 75, 86].includes(index);
  const warn = [21, 34, 58, 70].includes(index);
  return { index, edge, active, warn };
});

const signals = [42, 64, 38, 76, 51, 88, 57, 69, 45, 81, 62, 93];

const marqueeItems = [
  "Synergy H1 parsing",
  "Project-wide memory",
  "Plate quality control",
  "Dose-response analysis",
  "Protocol-aware AI",
  "Account-scoped data",
];

const features = [
  {
    icon: Beaker,
    eyebrow: "Experiment memory",
    title: "Every run stays connected.",
    copy: "Protocols, plate files, notes, decisions, and follow-ups live in one traceable scientific record.",
    accent: "from-cyan-400/20",
    className: "md:col-span-2",
  },
  {
    icon: Brain,
    eyebrow: "Grounded copilot",
    title: "Answers with lab context.",
    copy: "Ask across the work your team has already done—without making the model guess what happened.",
    accent: "from-violet-400/20",
    className: "md:col-span-1",
  },
  {
    icon: BarChart3,
    eyebrow: "Signal intelligence",
    title: "See quality before the next run.",
    copy: "Surface control drift, variability, outliers, dose response, and the experiments worth repeating.",
    accent: "from-emerald-400/20",
    className: "md:col-span-1",
  },
  {
    icon: Network,
    eyebrow: "Project synthesis",
    title: "Turn isolated runs into a coherent story.",
    copy: "Connect evidence across experiments and keep the next decision visible to the whole team.",
    accent: "from-amber-400/20",
    className: "md:col-span-2",
  },
];

const workflow = [
  {
    step: "01",
    icon: UploadCloud,
    title: "Bring the run in",
    copy: "Upload an instrument export or start from a protocol. Bioalyzer keeps the source trail intact.",
  },
  {
    step: "02",
    icon: Wand2,
    title: "Review with context",
    copy: "Quality signals and AI analysis arrive together, grounded in the experiment and project history.",
  },
  {
    step: "03",
    icon: CheckCircle2,
    title: "Commit the next move",
    copy: "Turn a finding into a task, a revised protocol, or the next experiment without losing rationale.",
  },
];

function AssayPreview() {
  return (
    <motion.div
      initial={{ opacity: 0, x: 30, rotateY: -4 }}
      animate={{ opacity: 1, x: 0, rotateY: 0 }}
      transition={{ delay: 0.28, duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      className="relative mx-auto w-full max-w-[590px] lg:ml-auto"
      style={{ perspective: 1200 }}
    >
      <motion.div
        className="absolute -left-5 top-16 z-20 hidden rounded-xl border border-emerald-300/20 bg-slate-950/85 p-3 shadow-2xl backdrop-blur-xl sm:block"
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 5.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="flex items-center gap-2 text-xs text-emerald-200">
          <span className="signal-dot h-2 w-2 rounded-full bg-emerald-300" />
          Controls within range
        </div>
      </motion.div>

      <motion.div
        className="absolute -bottom-7 -right-3 z-20 w-52 rounded-xl border border-cyan-300/20 bg-slate-950/90 p-4 shadow-2xl backdrop-blur-xl sm:w-60"
        animate={{ y: [0, 7, 0] }}
        transition={{ duration: 6.2, delay: 0.8, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-white/45">
          <span>AI observation</span>
          <Sparkles className="h-3.5 w-3.5 text-cyan-200" />
        </div>
        <p className="text-sm leading-5 text-white/85">Dose response holds. Repeat the mid-range wells before scale-up.</p>
      </motion.div>

      <div className="premium-ring surface-panel lab-scan rounded-2xl border-white/[0.12] bg-slate-950/[0.78] p-4 text-white shadow-[0_30px_120px_rgba(0,0,0,.52)] backdrop-blur-2xl sm:p-5">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/[0.42]">Live assay review</p>
            <p className="mt-1 font-semibold">H1 viability · Plate 08</p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
            <span className="signal-dot h-1.5 w-1.5 rounded-full bg-emerald-300" />
            Streaming
          </span>
        </div>

        <div className="grid grid-cols-12 gap-1 sm:gap-1.5">
          {plateWells.map((well) => (
            <motion.span
              key={well.index}
              className={`aspect-square rounded-[3px] shadow-[inset_0_1px_rgba(255,255,255,.12)] ${
                well.warn
                  ? "bg-amber-300"
                  : well.active
                    ? "bg-emerald-300"
                    : well.edge
                      ? "bg-cyan-300/[0.25]"
                      : "bg-cyan-300/55"
              }`}
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{
                opacity: well.active || well.warn ? [0.74, 1, 0.74] : 0.6,
                scale: well.active || well.warn ? [1, 1.07, 1] : 1,
              }}
              transition={{
                opacity: { delay: (well.index % 12) * 0.025, duration: 2.8, repeat: Infinity },
                scale: { delay: (well.index % 12) * 0.025, duration: 2.8, repeat: Infinity },
              }}
            />
          ))}
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3">
          {[
            ["Z prime", "0.61", "text-emerald-200"],
            ["CV", "8.4%", "text-cyan-100"],
            ["Flagged", "4 wells", "text-amber-200"],
          ].map(([label, value, color]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-white/[0.06] p-2.5 sm:p-3">
              <p className="text-[9px] uppercase tracking-wider text-white/[0.4] sm:text-[10px]">{label}</p>
              <p className={`mt-1 font-mono text-sm font-semibold sm:text-lg ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-lg border border-white/10 bg-black/[0.22] p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] text-white/45">Dose response signal</span>
            <FlaskConical className="h-4 w-4 text-cyan-200" />
          </div>
          <div className="flex h-20 items-end gap-1.5 sm:h-24 sm:gap-2">
            {signals.map((height, index) => (
              <motion.span
                key={index}
                className="flex-1 rounded-t-sm bg-gradient-to-t from-cyan-500/55 to-cyan-200"
                initial={{ height: "4%" }}
                animate={{ height: `${height}%` }}
                transition={{ delay: 0.5 + index * 0.055, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              />
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function LandingPage() {
  const { scrollYProgress } = useScroll();
  const smoothProgress = useSpring(scrollYProgress, { stiffness: 120, damping: 28, mass: 0.25 });

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#05090f] text-white">
      <motion.div
        className="fixed inset-x-0 top-0 z-[70] h-[2px] origin-left bg-gradient-to-r from-cyan-300 via-emerald-300 to-violet-400"
        style={{ scaleX: smoothProgress }}
      />

      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#05090f]/65 backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 md:px-8">
          <Link
            href="/"
            className="group flex items-center gap-2.5 text-white"
            data-feedback="navigate"
            data-feedback-message="Returning to the Bioalyzer overview"
          >
            <motion.span
              className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/[0.07] shadow-[inset_0_1px_rgba(255,255,255,.08)]"
              whileHover={{ rotate: 12, scale: 1.06 }}
              transition={{ type: "spring", stiffness: 300, damping: 18 }}
            >
              <Atom className="h-[18px] w-[18px] text-cyan-200" />
              <span className="signal-dot absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-300" />
            </motion.span>
            <span className="font-semibold tracking-wide">Bioalyzer</span>
          </Link>

          <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary navigation">
            <a href="#workflow" className="animated-underline hidden px-3 py-2 text-sm text-white/60 hover:text-white md:block">
              Workflow
            </a>
            <a
              href="#capabilities"
              className="animated-underline hidden px-3 py-2 text-sm text-white/60 hover:text-white md:block"
              data-feedback="navigate"
              data-feedback-message="Showing what the workspace can do"
            >
              Capabilities
            </a>
            <Link
              href="/sign-in"
              className="rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/[0.07] hover:text-white"
              data-feedback="navigate"
              data-feedback-message="Opening your secure sign in"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="interactive-lift inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-black/20 hover:bg-cyan-50"
              data-feedback="create"
              data-feedback-message="Starting your protected workspace"
            >
              Start free
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="relative flex min-h-[94svh] items-center overflow-hidden pb-20 pt-28">
          <img src="/lab-hero.png" alt="" className="absolute inset-0 h-full w-full scale-105 object-cover opacity-40" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,9,15,.98)_0%,rgba(5,9,15,.84)_48%,rgba(5,9,15,.42)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_55%,#05090f_100%)]" />
          <AmbientBackdrop intensity="hero" />

          <div className="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-16 px-5 md:px-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(420px,0.75fr)]">
            <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="max-w-3xl">
              <motion.div variants={riseItem} className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-200/15 bg-cyan-200/[0.07] px-3.5 py-2 text-xs font-medium text-cyan-100 shadow-lg shadow-black/10 backdrop-blur-md sm:text-sm">
                <Sparkles className="h-3.5 w-3.5 text-emerald-200" />
                The experiment workspace that remembers why
              </motion.div>

              <motion.h1 variants={riseItem} className="text-balance text-[clamp(3.35rem,7vw,6.85rem)] font-semibold leading-[0.91] tracking-[-0.055em]">
                From raw signal to
                <span className="block bg-gradient-to-r from-cyan-200 via-white to-emerald-200 bg-clip-text pb-2 text-transparent">
                  confident science.
                </span>
              </motion.h1>

              <motion.p variants={riseItem} className="text-pretty mt-6 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8">
                Bioalyzer connects your protocols, instrument data, analysis, and team decisions—then gives you an AI copilot grounded in the work your lab actually did.
              </motion.p>

              <motion.div variants={riseItem} className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/sign-up"
                  className="interactive-lift soft-glow group inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3.5 text-sm font-bold text-slate-950 hover:bg-cyan-200"
                  data-feedback="create"
                  data-feedback-message="Opening a workspace built around your science"
                >
                  Open your workspace
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                </Link>
                <a href="#workflow" className="interactive-lift inline-flex items-center gap-2 rounded-xl border border-white/[0.14] bg-white/[0.06] px-5 py-3.5 text-sm font-semibold text-white backdrop-blur-md hover:border-white/25 hover:bg-white/[0.1]">
                  See how it works
                </a>
              </motion.div>

              <motion.div variants={riseItem} className="mt-9 flex flex-wrap gap-x-5 gap-y-3 text-xs text-slate-300 sm:text-sm">
                {["No credit card", "Clerk-ready auth", "Built for plate assays"].map((item) => (
                  <span key={item} className="inline-flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    {item}
                  </span>
                ))}
              </motion.div>
            </motion.div>

            <AssayPreview />
          </div>
        </section>

        <section className="relative z-10 -mt-10 border-y border-white/[0.07] bg-white/[0.025] py-4 backdrop-blur-xl">
          <div className="mask-fade-x overflow-hidden">
            <div className="marquee-track flex items-center">
              {[...marqueeItems, ...marqueeItems].map((item, index) => (
                <div key={`${item}-${index}`} className="flex items-center gap-3 px-6 text-xs font-medium uppercase tracking-[0.16em] text-white/45 sm:px-9">
                  <span className="h-1 w-1 rounded-full bg-cyan-300" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="capabilities" className="relative px-5 py-28 md:px-8 md:py-36">
          <AmbientBackdrop />
          <div className="relative z-10 mx-auto max-w-7xl">
            <Reveal className="mb-12 max-w-3xl">
              <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-cyan-300">One scientific thread</p>
              <h2 className="text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl md:text-6xl">
                Your best decisions should not disappear into disconnected tools.
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-7 text-white/55 sm:text-lg">
                Bioalyzer keeps experimental context close enough to act on—before the next run starts.
              </p>
            </Reveal>

            <div className="grid gap-4 md:grid-cols-3">
              {features.map((feature, index) => (
                <Reveal key={feature.title} delay={index * 0.06} className={feature.className}>
                  <HoverLift className="h-full">
                    <article className="surface-panel surface-panel-interactive group h-full min-h-72 rounded-2xl p-6 sm:p-8">
                      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${feature.accent} via-transparent to-transparent opacity-55 transition-opacity duration-500 group-hover:opacity-85`} />
                      <div className="relative z-10 flex h-full flex-col">
                        <div className="mb-12 flex items-start justify-between">
                          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] text-cyan-200">
                            <feature.icon className="h-5 w-5" />
                          </span>
                          <ArrowUpRight className="h-5 w-5 text-white/20 transition-all duration-300 group-hover:translate-x-1 group-hover:-translate-y-1 group-hover:text-white/70" />
                        </div>
                        <p className="font-mono text-[11px] uppercase tracking-[0.17em] text-white/38">{feature.eyebrow}</p>
                        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.025em]">{feature.title}</h3>
                        <p className="mt-3 max-w-xl text-sm leading-6 text-white/52 sm:text-base sm:leading-7">{feature.copy}</p>
                      </div>
                    </article>
                  </HoverLift>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="workflow" className="relative border-y border-white/[0.07] bg-white/[0.02] px-5 py-28 md:px-8 md:py-36">
          <div className="mx-auto max-w-7xl">
            <Reveal className="mx-auto mb-16 max-w-3xl text-center">
              <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">A cleaner scientific loop</p>
              <h2 className="text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl md:text-6xl">Move from evidence to action without losing the thread.</h2>
            </Reveal>

            <div className="relative grid gap-5 lg:grid-cols-3">
              <motion.div
                className="absolute left-[16.66%] right-[16.66%] top-8 hidden h-px origin-left bg-gradient-to-r from-cyan-300/50 via-emerald-300/50 to-violet-300/50 lg:block"
                initial={{ scaleX: 0 }}
                whileInView={{ scaleX: 1 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
              />
              {workflow.map((item, index) => (
                <Reveal key={item.step} delay={index * 0.12} className="relative">
                  <article className="group h-full rounded-2xl border border-white/[0.09] bg-white/[0.035] p-6 transition duration-500 hover:-translate-y-1 hover:border-cyan-200/20 hover:bg-white/[0.055] sm:p-8">
                    <div className="mb-10 flex items-center justify-between">
                      <span className="premium-ring flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-[#07111a] text-cyan-200 shadow-xl">
                        <item.icon className="h-6 w-6" />
                      </span>
                      <span className="font-mono text-sm text-white/25">{item.step}</span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-[-0.025em]">{item.title}</h3>
                    <p className="mt-3 text-base leading-7 text-white/50">{item.copy}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="relative px-5 py-28 md:px-8 md:py-36">
          <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[0.82fr_1.18fr]">
            <Reveal>
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/[0.06] px-3 py-1.5 text-xs text-emerald-200">
                <ShieldCheck className="h-3.5 w-3.5" />
                Security-aware by design
              </div>
              <h2 className="text-balance mt-5 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">Your research context stays attached to the right account.</h2>
              <p className="mt-5 max-w-xl text-base leading-7 text-white/52 sm:text-lg">
                Authenticated sessions, account-scoped records, and API-side ownership checks help keep each scientist’s workspace separated.
              </p>
              <Link
                href="/sign-up"
                className="animated-underline mt-7 inline-flex items-center gap-2 text-sm font-semibold text-cyan-200"
                data-feedback="create"
                data-feedback-message="Starting a protected workspace"
              >
                Start a protected workspace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Reveal>

            <Reveal delay={0.1}>
              <div className="glass-panel premium-ring grid gap-3 rounded-3xl p-4 sm:grid-cols-3 sm:p-5">
                {[
                  { icon: LockKeyhole, label: "Session auth", copy: "Clerk-backed identity" },
                  { icon: Database, label: "Scoped records", copy: "User-owned experiments" },
                  { icon: FileSpreadsheet, label: "Traceable inputs", copy: "Source data retained" },
                ].map((item, index) => (
                  <motion.div
                    key={item.label}
                    className="rounded-2xl border border-white/[0.08] bg-black/20 p-5"
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.18 + index * 0.08 }}
                    whileHover={{ y: -4, backgroundColor: "rgba(255,255,255,.055)" }}
                  >
                    <item.icon className="h-5 w-5 text-emerald-200" />
                    <h3 className="mt-8 text-sm font-semibold">{item.label}</h3>
                    <p className="mt-1 text-xs leading-5 text-white/40">{item.copy}</p>
                  </motion.div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section className="px-5 pb-20 md:px-8">
          <Reveal className="relative mx-auto max-w-7xl overflow-hidden rounded-3xl border border-cyan-200/15 bg-cyan-200/[0.06] px-6 py-16 text-center shadow-[0_30px_120px_rgba(0,0,0,.28)] sm:px-10 sm:py-20">
            <AmbientBackdrop />
            <div className="relative z-10 mx-auto max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-200">Ready for the next run</p>
              <h2 className="text-balance mt-5 text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">Make your lab’s context compound.</h2>
              <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-white/55">Start with one experiment. Keep every useful observation connected from there.</p>
              <Link
                href="/sign-up"
                className="interactive-lift soft-glow group mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-950 hover:bg-cyan-50"
                data-feedback="create"
                data-feedback-message="Building your connected lab workspace"
              >
                Build your workspace
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-white/[0.07] px-5 py-8 text-sm text-white/35 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-white/65">
            <Atom className="h-4 w-4 text-cyan-200" />
            <span className="font-semibold">Bioalyzer</span>
          </div>
          <div className="flex flex-col gap-2 text-right sm:items-end">
            <p>Built for scientists who would rather learn from the last run than lose it.</p>
            <Link href="/privacy" className="text-white/55 underline-offset-4 transition hover:text-white hover:underline">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
