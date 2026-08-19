import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { Layout } from "@/components/layout/Layout";
import { LandingPage } from "@/pages/LandingPage";
import { motion, MotionConfig } from "framer-motion";
import { CommandPalette } from "@/components/CommandPalette";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DemoUserProvider, ClerkUserProvider } from "@/contexts/UserContext";
import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";
import { isEnabled } from "@/lib/features";
import { ShieldAlert } from "lucide-react";
import { AmbientBackdrop } from "@/components/layout/AmbientBackdrop";
import { InteractionFeedback } from "@/components/motion/InteractionFeedback";

const Dashboard = lazy(() => import("@/pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const ExperimentList = lazy(() => import("@/pages/ExperimentList").then((module) => ({ default: module.ExperimentList })));
const ExperimentDetail = lazy(() => import("@/pages/ExperimentDetail").then((module) => ({ default: module.ExperimentDetail })));
const ExperimentForm = lazy(() => import("@/pages/ExperimentForm").then((module) => ({ default: module.ExperimentForm })));
const ExperimentEdit = lazy(() => import("@/pages/ExperimentEdit").then((module) => ({ default: module.ExperimentEdit })));
const SharedExperiment = lazy(() => import("@/pages/SharedExperiment").then((module) => ({ default: module.SharedExperiment })));
const ExperimentCompare = lazy(() => import("@/pages/ExperimentCompare").then((module) => ({ default: module.ExperimentCompare })));
const DataAnalysisPage = lazy(() => import("@/pages/DataAnalysisPage").then((module) => ({ default: module.DataAnalysisPage })));
const AdminPage = lazy(() => import("@/pages/AdminPage").then((module) => ({ default: module.AdminPage })));
const TemplatesPage = lazy(() => import("@/pages/TemplatesPage").then((module) => ({ default: module.TemplatesPage })));
const TasksPage = lazy(() => import("@/pages/TasksPage").then((module) => ({ default: module.TasksPage })));
const ProjectsPage = lazy(() => import("@/pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const ProjectDetail = lazy(() => import("@/pages/ProjectDetail").then((module) => ({ default: module.ProjectDetail })));
const NotFound = lazy(() => import("@/pages/not-found"));

// ── API base URL ─────────────────────────────────────────────────────────────
// When frontend and API are on different origins (Vercel + Render),
// set VITE_API_URL to the Render service URL, e.g. https://lab-copilot-api.onrender.com
const apiUrl = import.meta.env.VITE_API_URL;
if (apiUrl) setBaseUrl(apiUrl);

// ── Auth mode ─────────────────────────────────────────────────────────────────
const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const DEMO_MODE =
  import.meta.env.DEV &&
  !clerkPubKey &&
  import.meta.env.VITE_ENABLE_DEMO_MODE === "true";
const AUTH_CONFIG_MISSING = !clerkPubKey && !DEMO_MODE;

// ── API auth token ────────────────────────────────────────────────────────────
// Cross-origin (Vercel frontend -> Render API) means the Clerk session cookie is
// NOT sent automatically, so the generated API client must attach a bearer token.
// Resolved per-request from the global Clerk instance (ready by the time any
// request fires). Skipped in demo mode (no Clerk / backend needs no auth).
if (!DEMO_MODE) {
  setAuthTokenGetter(async () => {
    try {
      const clerk = (window as unknown as { Clerk?: { session?: { getToken?: () => Promise<string | null> } } }).Clerk;
      return (await clerk?.session?.getToken?.()) ?? null;
    } catch {
      return null;
    }
  });
}

const basePath = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AnimatedRoute({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("[data-workspace-scroll]")?.scrollTo(0, 0);
  }, [location]);
  const routeKind = location === "/data-analysis"
    ? "analyze"
    : location.includes("/new")
      ? "create"
      : location.startsWith("/projects")
        ? "organize"
        : location.startsWith("/experiments/")
          ? "inspect"
          : "overview";

  const arrivals = {
    analyze: { opacity: 0, y: 4, clipPath: "inset(0 0 88% 0)", filter: "blur(4px)" },
    create: { opacity: 0, y: 18, scale: 0.975, filter: "blur(6px)" },
    organize: { opacity: 0, x: 18, scale: 0.992, filter: "blur(5px)" },
    inspect: { opacity: 0, x: 12, filter: "blur(5px)" },
    overview: { opacity: 0, y: 12, scale: 0.995, filter: "blur(5px)" },
  } as const;

  return (
    <motion.div
      className="route-scene"
      data-route-kind={routeKind}
      initial={arrivals[routeKind]}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, clipPath: "inset(0 0 0% 0)", filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -8, scale: 0.997, filter: "blur(3px)" }}
      transition={{ duration: routeKind === "analyze" ? 0.62 : 0.46, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="route-arrival-signal" aria-hidden="true" />
      {children}
    </motion.div>
  );
}

function RouteLoading() {
  return (
    <div className="flex min-h-[45vh] items-center justify-center" role="status" aria-label="Loading workspace">
      <div className="relative flex h-12 w-12 items-center justify-center">
        <motion.span className="absolute inset-0 rounded-full border border-primary/25" animate={{ scale: [0.75, 1.2], opacity: [0.8, 0] }} transition={{ duration: 1.5, repeat: Infinity }} />
        <motion.span className="h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_24px_hsl(var(--primary)/.7)]" animate={{ scale: [0.85, 1.12, 0.85] }} transition={{ duration: 1.2, repeat: Infinity }} />
      </div>
    </div>
  );
}

function ShortcutHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Press ⌘K / Ctrl+K to open search.</p>
      </DialogContent>
    </Dialog>
  );
}

function useGlobalKeyboardShortcuts(setHelpOpen: (open: boolean) => void) {
  const toastRef = useRef<HTMLDivElement | null>(null);
  const gPendingRef = useRef(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setHelpOpen]);
  return { toastRef, gPendingRef };
}

// ── Shared route tree (used by both demo and Clerk mode) ─────────────────────
function AppRoutes({ isAdmin }: { isAdmin: boolean }) {
  const [helpOpen, setHelpOpen] = useState(false);
  useGlobalKeyboardShortcuts(setHelpOpen);

  return (
    <>
      <ShortcutHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Suspense fallback={<RouteLoading />}><Switch>
        <Route path="/" component={() => <Redirect to="/dashboard" />} />
        <Route path="/shared/:token"><SharedExperiment /></Route>
        <Route path="/landing"><LandingPage /></Route>
        <Route path="/dashboard">
          <Layout><AnimatedRoute><Dashboard /></AnimatedRoute></Layout>
        </Route>
        <Route path="/experiments/compare">
          {isEnabled("compare")
            ? <Layout><AnimatedRoute><ExperimentCompare /></AnimatedRoute></Layout>
            : <Redirect to="/dashboard" />}
        </Route>
        <Route path="/experiments/new">
          <Layout><AnimatedRoute><ExperimentForm /></AnimatedRoute></Layout>
        </Route>
        <Route path="/experiments/:id/edit">
          <Layout><AnimatedRoute><ExperimentEdit /></AnimatedRoute></Layout>
        </Route>
        <Route path="/experiments/:id">
          <Layout><AnimatedRoute><ExperimentDetail /></AnimatedRoute></Layout>
        </Route>
        <Route path="/experiments">
          <Layout><AnimatedRoute><ExperimentList /></AnimatedRoute></Layout>
        </Route>
        <Route path="/projects/:id">
          <Layout><AnimatedRoute><ProjectDetail /></AnimatedRoute></Layout>
        </Route>
        <Route path="/projects">
          <Layout><AnimatedRoute><ProjectsPage /></AnimatedRoute></Layout>
        </Route>
        <Route path="/data-analysis">
          {isEnabled("dataAnalysis")
            ? <Layout><AnimatedRoute><DataAnalysisPage /></AnimatedRoute></Layout>
            : <Redirect to="/dashboard" />}
        </Route>
        <Route path="/templates">
          {isEnabled("templates")
            ? <Layout><AnimatedRoute><TemplatesPage /></AnimatedRoute></Layout>
            : <Redirect to="/dashboard" />}
        </Route>
        <Route path="/tasks">
          {isEnabled("tasks")
            ? <Layout><AnimatedRoute><TasksPage /></AnimatedRoute></Layout>
            : <Redirect to="/dashboard" />}
        </Route>
        <Route path="/admin">
          {isAdmin
            ? <Layout><AnimatedRoute><AdminPage /></AnimatedRoute></Layout>
            : <Redirect to="/dashboard" />}
        </Route>
        <Route component={NotFound} />
      </Switch></Suspense>
    </>
  );
}

// ── Demo mode (no Clerk) ──────────────────────────────────────────────────────
function DemoApp() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <QueryClientProvider client={queryClient}>
            <DemoUserProvider>
              <CommandPalette />
              <AppRoutes isAdmin={import.meta.env.VITE_ENABLE_DEMO_ADMIN === "true"} />
            </DemoUserProvider>
          </QueryClientProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function AuthConfigurationError() {
  return (
    <div className="dark relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-5 text-foreground">
      <AmbientBackdrop intensity="hero" />
      <motion.div
        initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        className="surface-panel premium-ring relative z-10 max-w-lg rounded-2xl p-8 text-center"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold">Authentication needs configuration</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This deployment is missing its Clerk publishable key. Bioalyzer will not fall back to an unauthenticated shared workspace.
        </p>
        <p className="mt-5 rounded-lg border border-border/70 bg-background/45 p-3 font-mono text-xs text-muted-foreground">
          Set VITE_CLERK_PUBLISHABLE_KEY and rebuild the frontend.
        </p>
      </motion.div>
    </div>
  );
}

// ── Clerk mode ────────────────────────────────────────────────────────────────
// All Clerk imports are isolated here — never imported when DEMO_MODE is true.
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { shadcn } from "@clerk/themes";
import { useAppUser } from "@/contexts/UserContext";

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#1f9aa8",
    colorForeground: "#d5e8f7",
    colorMutedForeground: "#658fb0",
    colorDanger: "#ef4444",
    colorBackground: "#0c1520",
    colorInput: "#111e2e",
    colorInputForeground: "#d5e8f7",
    colorNeutral: "#182233",
    fontFamily: "'Space Grotesk', system-ui, sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "rounded-2xl w-[440px] max-w-full overflow-hidden border border-[#182233] bg-[#0c1520] shadow-2xl shadow-black/50",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#d5e8f7] font-semibold",
    headerSubtitle: "text-[#658fb0]",
    socialButtonsBlockButtonText: "text-[#d5e8f7] font-medium",
    formFieldLabel: "text-[#658fb0] text-sm",
    footerActionLink: "text-[#1f9aa8] hover:text-[#1f9aa8]/80 font-medium",
  },
};

function ClerkQueryCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);
  return null;
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/dashboard`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/dashboard`} />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/dashboard" /></Show>
      <Show when="signed-out"><LandingPage /></Show>
    </>
  );
}

function ClerkAppRoutes() {
  const [helpOpen, setHelpOpen] = useState(false);
  useGlobalKeyboardShortcuts(setHelpOpen);
  const { isAdmin } = useAppUser();

  return (
    <>
      <ShortcutHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Suspense fallback={<RouteLoading />}><Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/shared/:token"><SharedExperiment /></Route>
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/dashboard">
          <Show when="signed-in"><Layout><AnimatedRoute><Dashboard /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/experiments/compare">
          <Show when="signed-in">
            {isEnabled("compare")
              ? <Layout><AnimatedRoute><ExperimentCompare /></AnimatedRoute></Layout>
              : <Redirect to="/dashboard" />}
          </Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/experiments/new">
          <Show when="signed-in"><Layout><AnimatedRoute><ExperimentForm /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/experiments/:id/edit">
          <Show when="signed-in"><Layout><AnimatedRoute><ExperimentEdit /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/experiments/:id">
          <Show when="signed-in"><Layout><AnimatedRoute><ExperimentDetail /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/experiments">
          <Show when="signed-in"><Layout><AnimatedRoute><ExperimentList /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/projects/:id">
          <Show when="signed-in"><Layout><AnimatedRoute><ProjectDetail /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/projects">
          <Show when="signed-in"><Layout><AnimatedRoute><ProjectsPage /></AnimatedRoute></Layout></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/data-analysis">
          <Show when="signed-in">
            {isEnabled("dataAnalysis")
              ? <Layout><AnimatedRoute><DataAnalysisPage /></AnimatedRoute></Layout>
              : <Redirect to="/dashboard" />}
          </Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/templates">
          <Show when="signed-in">
            {isEnabled("templates")
              ? <Layout><AnimatedRoute><TemplatesPage /></AnimatedRoute></Layout>
              : <Redirect to="/dashboard" />}
          </Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/tasks">
          <Show when="signed-in">
            {isEnabled("tasks")
              ? <Layout><AnimatedRoute><TasksPage /></AnimatedRoute></Layout>
              : <Redirect to="/dashboard" />}
          </Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </Route>
        <Route path="/admin">
          {isAdmin
            ? <Layout><AnimatedRoute><AdminPage /></AnimatedRoute></Layout>
            : <Redirect to="/dashboard" />}
        </Route>
        <Route component={NotFound} />
      </Switch></Suspense>
    </>
  );
}

function ClerkApp() {
  const [, setLocation] = useLocation();
  function stripBase(path: string): string {
    return basePath && path.startsWith(basePath)
      ? path.slice(basePath.length) || "/"
      : path;
  }
  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      signInFallbackRedirectUrl={`${basePath}/dashboard`}
      signUpFallbackRedirectUrl={`${basePath}/dashboard`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryCacheInvalidator />
        <ClerkUserProvider>
          <CommandPalette />
          <ClerkAppRoutes />
        </ClerkUserProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
function App() {
  return (
    <MotionConfig reducedMotion="user">
      <InteractionFeedback>
        {AUTH_CONFIG_MISSING ? (
          <AuthConfigurationError />
        ) : DEMO_MODE ? (
          <DemoApp />
        ) : (
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
            <TooltipProvider>
              <WouterRouter base={basePath}>
                <ClerkApp />
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </ThemeProvider>
        )}
      </InteractionFeedback>
    </MotionConfig>
  );
}

export default App;
