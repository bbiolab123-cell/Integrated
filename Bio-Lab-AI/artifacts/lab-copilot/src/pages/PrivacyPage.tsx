import { ArrowLeft, Atom, Database, LockKeyhole, Server, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { AmbientBackdrop } from "@/components/layout/AmbientBackdrop";

const sections = [
  {
    icon: Database,
    title: "What Bioalyzer keeps",
    body: "Your account identity, experiment records, protocols, uploaded files after parsing, plate layouts, comments, tasks, chat messages, AI answers, and feedback. The service also keeps basic request logs such as timestamps, request IDs, status codes, and account IDs so failures and abuse can be investigated.",
  },
  {
    icon: Server,
    title: "Where your data goes",
    body: "Bioalyzer stores workspace data in its configured database. Clerk handles sign-in. When you deliberately use an AI feature, the relevant experiment context and your prompt are sent to Cloudflare Workers AI to generate the answer. Ordinary heatmaps, CV%, Z′, and IC50 calculations run without an AI call.",
  },
  {
    icon: ShieldCheck,
    title: "AI improvement data",
    body: "AI inputs, outputs, corrections, and ratings may be stored for review. They are not automatically released into a training set: an example must pass the app's approval and privacy checks before an administrator can export it for private model improvement. Do not enter patient identifiers, regulated health information, or secrets unless your deployment owner has explicitly approved that use.",
  },
  {
    icon: LockKeyhole,
    title: "Control and deletion",
    body: "Workspace records remain until they are deleted or the deployment operator removes them. Deleting an experiment removes that working record, but security logs and separately retained AI review records may remain for operational or audit needs. Ask the person or organization that gave you access to export or fully remove account-level data.",
  },
];

export function PrivacyPage() {
  const contact = (import.meta.env.VITE_PRIVACY_CONTACT as string | undefined)?.trim();
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05090f] text-white">
      <AmbientBackdrop intensity="hero" />
      <header className="relative z-10 border-b border-white/10 bg-[#05090f]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/[0.07]"><Atom className="h-4 w-4 text-cyan-200" /></span>
            Bioalyzer
          </Link>
          <Link href="/" className="flex items-center gap-2 text-sm text-white/60 transition hover:text-white"><ArrowLeft className="h-4 w-4" /> Back</Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl px-5 py-14 sm:px-8 sm:py-20">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-200">Privacy · plain English</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Your lab data is used to run your workspace.</h1>
        <p className="mt-6 max-w-3xl text-base leading-8 text-white/60">
          Bioalyzer is a scientific workspace, not a medical record system. This page explains the data flow in practical terms. It is not a promise of HIPAA, GDPR, GLP, or other regulatory compliance.
        </p>
        <p className="mt-3 font-mono text-xs text-white/35">Last updated August 31, 2026</p>

        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {sections.map(({ icon: Icon, title, body }) => (
            <section key={title} className="rounded-2xl border border-white/10 bg-white/[0.045] p-6 backdrop-blur-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-200/15 bg-cyan-200/[0.08]"><Icon className="h-4 w-4 text-cyan-200" /></span>
              <h2 className="mt-5 text-lg font-semibold">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-white/55">{body}</p>
            </section>
          ))}
        </div>

        <section className="mt-5 rounded-2xl border border-amber-200/15 bg-amber-200/[0.05] p-6">
          <h2 className="text-lg font-semibold text-amber-100">What the product does not do</h2>
          <p className="mt-3 text-sm leading-7 text-white/55">
            The application contains no advertising or built-in data-sale feature. It does not contact the AI provider when you upload a plate, view a heatmap, calculate CV% or Z′, or fit a local dose-response curve. AI calls happen only when you use an AI-labeled action.
          </p>
        </section>

        <section className="mt-10 border-t border-white/10 pt-8 text-sm leading-7 text-white/55">
          <h2 className="text-base font-semibold text-white">Questions or requests</h2>
          <p className="mt-2">
            {contact
              ? <>Contact the deployment operator at <a className="text-cyan-200 underline underline-offset-4" href={`mailto:${contact}`}>{contact}</a>.</>
              : "Contact the person or organization that invited you to this Bioalyzer deployment. They control the database, hosting accounts, retention settings, and account-removal process."}
          </p>
        </section>
      </main>
    </div>
  );
}
