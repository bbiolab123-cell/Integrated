import { Link, useLocation } from "wouter";
import {
  Activity,
  Atom,
  BarChart3,
  Beaker,
  BookTemplate,
  ChevronRight,
  ClipboardList,
  FolderKanban,
  GitCompare,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plus,
  Sun,
  User,
} from "lucide-react";
import { useListExperiments, getListExperimentsQueryKey } from "@workspace/api-client-react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTheme } from "next-themes";
import { motion } from "framer-motion";
import { useMemo, useRef, useState, type UIEvent } from "react";
import { Progress } from "@/components/ui/progress";
import { CommandPaletteTrigger } from "@/components/CommandPalette";
import { useAppUser } from "@/contexts/UserContext";
import { isEnabled } from "@/lib/features";
import { AmbientBackdrop } from "@/components/layout/AmbientBackdrop";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  shortcut?: string;
  active: boolean;
  count?: number | null;
  show: boolean;
};

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: experiments } = useListExperiments(undefined, {
    query: { queryKey: getListExperimentsQueryKey() },
  });
  const { theme, setTheme } = useTheme();
  const resolvedTheme = theme ?? "dark";
  const [scrollProgress, setScrollProgress] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { displayName, initials, email, isAdmin, isLoaded, signOut } = useAppUser();

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const navItems: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "G D", active: location === "/dashboard" || location === "/", show: true },
    { href: "/experiments", label: "Experiments", icon: Beaker, shortcut: "G E", active: location.startsWith("/experiments") && location !== "/experiments/new" && location !== "/experiments/compare", count: Array.isArray(experiments) ? experiments.length : null, show: true },
    { href: "/projects", label: "Projects", icon: FolderKanban, shortcut: "G P", active: location.startsWith("/projects"), show: true },
    { href: "/experiments/compare", label: "Compare", icon: GitCompare, shortcut: "G C", active: location === "/experiments/compare", show: isEnabled("compare") },
    { href: "/data-analysis", label: "Data Analysis", icon: BarChart3, shortcut: "G A", active: location === "/data-analysis", show: isEnabled("dataAnalysis") },
    { href: "/templates", label: "Templates", icon: BookTemplate, shortcut: "G T", active: location === "/templates", show: isEnabled("templates") },
    { href: "/tasks", label: "Tasks", icon: ClipboardList, shortcut: "G K", active: location === "/tasks", show: isEnabled("tasks") },
    { href: "/admin", label: "Admin", icon: User, active: location === "/admin", show: isAdmin },
  ];

  const onContentScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const max = target.scrollHeight - target.clientHeight;
    setScrollProgress(max > 0 ? Math.max(0, Math.min(100, (target.scrollTop / max) * 100)) : 0);
  };

  const routeLabel = location
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/-/g, " "))
    .join(" / ") || "dashboard";

  const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");

  const SidebarContent = ({ mobile = false }: { mobile?: boolean }) => (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_0%,rgba(18,170,178,.13),transparent_34%),linear-gradient(180deg,rgba(255,255,255,.7),transparent_28%,rgba(69,126,140,.06))] dark:bg-[radial-gradient(circle_at_10%_0%,rgba(64,214,225,.11),transparent_32%),linear-gradient(180deg,rgba(255,255,255,.025),transparent_24%,rgba(0,0,0,.16))]" />
      <div className="pointer-events-none absolute inset-0 app-noise-fine opacity-30" />

      <div className="relative z-10 flex h-16 shrink-0 items-center justify-between border-b border-sidebar-border/80 px-4">
        <Link
          href="/dashboard"
          className="group flex items-center gap-3"
          onClick={() => mobile && setMobileNavOpen(false)}
          data-feedback="navigate"
          data-feedback-message="Returning to the lab overview"
        >
          <motion.span
            className="premium-ring flex h-9 w-9 items-center justify-center rounded-xl border border-sidebar-border bg-sidebar-accent/60"
            whileHover={{ rotate: 12, scale: 1.05 }}
            transition={{ type: "spring", stiffness: 320, damping: 20 }}
          >
            <Atom className="h-[18px] w-[18px] text-sidebar-primary" />
          </motion.span>
          <div>
            <span className="block text-[15px] font-semibold tracking-wide">Bioalyzer</span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/55 dark:text-sidebar-foreground/35">Lab intelligence</span>
          </div>
        </Link>
        <span className="signal-dot h-1.5 w-1.5 rounded-full bg-emerald-400 text-emerald-400" />
      </div>

      <div className="relative z-10 px-3 pb-2 pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="interactive-lift w-full rounded-xl border border-sidebar-border/90 bg-sidebar-accent/30 p-3 text-left hover:border-sidebar-primary/20 hover:bg-sidebar-accent/55"
              data-feedback="neutral"
              data-feedback-message="Opening your workspace profile"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sidebar-primary/25 bg-sidebar-primary/10 text-[10px] font-bold text-sidebar-primary shadow-[0_0_24px_rgba(40,190,205,.08)]">
                  {isLoaded ? initials : "?"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{isLoaded ? displayName : greeting}</div>
                  <div className="truncate text-[11px] text-sidebar-foreground/60 dark:text-sidebar-foreground/42">{email}</div>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/45 dark:text-sidebar-foreground/25" />
              </div>
              <div className="mt-3 flex items-center justify-between text-[10px] text-sidebar-foreground/55 dark:text-sidebar-foreground/38">
                <span>{Array.isArray(experiments) && experiments.length ? `${experiments.length} experiments` : "Workspace ready"}</span>
                <span className="font-mono">{Math.min(100, (Array.isArray(experiments) ? experiments.length : 0) * 10)}%</span>
              </div>
              <Progress value={Math.min(100, (Array.isArray(experiments) ? experiments.length : 0) * 10)} className="mt-2 h-1" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">{displayName}</p>
              <p className="truncate text-xs text-muted-foreground">{email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2" disabled>
              <User className="h-4 w-4" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 text-destructive focus:text-destructive"
              onClick={() => signOut()}
              data-feedback="danger"
              data-feedback-message="Signing out of this workspace"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="relative z-10 flex min-h-0 flex-1 flex-col gap-5 overflow-hidden py-3" aria-label="Workspace navigation">
        <div className="flex flex-col gap-1 px-3">
          <span className="mb-1 px-3 font-mono text-[9px] uppercase tracking-[0.2em] text-sidebar-foreground/50 dark:text-sidebar-foreground/28">Workspace</span>
          {navItems.filter((item) => item.show).map((item) => {
            const Icon = item.icon;
            return (
              <motion.div key={item.href} whileHover={{ x: 2 }} transition={{ type: "spring", stiffness: 400, damping: 28 }}>
                <Link
                  href={item.href}
                  onClick={() => mobile && setMobileNavOpen(false)}
                  data-feedback="navigate"
                  data-feedback-message={`Moving to ${item.label.toLowerCase()}`}
                  className={`group relative flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors ${
                    item.active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:text-sidebar-foreground dark:text-sidebar-foreground/62"
                  }`}
                >
                  {item.active && (
                    <motion.span
                      layoutId={mobile ? "mobile-sidebar-active" : "desktop-sidebar-active"}
                      className="absolute inset-0 rounded-lg border border-sidebar-primary/15 bg-sidebar-accent shadow-[inset_2px_0_hsl(var(--sidebar-primary)),0_8px_24px_rgba(0,0,0,.12)]"
                      transition={{ type: "spring", stiffness: 350, damping: 32 }}
                    />
                  )}
                  <Icon className={`relative z-10 h-4 w-4 ${item.active ? "text-sidebar-primary" : "text-sidebar-foreground/58 group-hover:text-sidebar-primary dark:text-sidebar-foreground/42"}`} />
                  <span className="relative z-10 flex-1">{item.label}</span>
                  {item.count !== undefined && item.count !== null && (
                    <span className="relative z-10 rounded-full border border-sidebar-border bg-sidebar/55 px-1.5 py-0.5 font-mono text-[9px] text-sidebar-foreground/60 dark:text-sidebar-foreground/45">{item.count}</span>
                  )}
                  {item.shortcut && (
                    <kbd className="relative z-10 hidden rounded border border-sidebar-border px-1 py-0.5 font-mono text-[8px] text-sidebar-foreground/50 group-hover:block dark:text-sidebar-foreground/25">{item.shortcut}</kbd>
                  )}
                </Link>
              </motion.div>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-3">
          <div className="mb-2 flex items-center justify-between px-3">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-sidebar-foreground/50 dark:text-sidebar-foreground/28">Recent runs</span>
            <Link
              href="/experiments/new"
              onClick={() => mobile && setMobileNavOpen(false)}
              className="rounded-md p-1 text-sidebar-foreground/55 transition hover:bg-sidebar-accent hover:text-sidebar-primary dark:text-sidebar-foreground/35"
              title="New Experiment"
              data-feedback="create"
              data-feedback-message="Opening a fresh experiment record"
            >
              <Plus className="h-3.5 w-3.5" />
            </Link>
          </div>
          <ScrollArea className="-mx-3 flex-1">
            <div className="flex flex-col gap-0.5 px-3">
              {Array.isArray(experiments) && experiments.slice(0, 10).map((experiment, index) => (
                <motion.div key={experiment.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12 + index * 0.035 }}>
                  <Link
                    href={`/experiments/${experiment.id}`}
                    onClick={() => mobile && setMobileNavOpen(false)}
                    data-feedback="navigate"
                    data-feedback-message={`Opening ${experiment.name}`}
                    className={`group flex items-center justify-between rounded-lg px-3 py-2 text-xs transition ${
                      location === `/experiments/${experiment.id}` ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/62 hover:bg-sidebar-accent/55 hover:text-sidebar-foreground dark:text-sidebar-foreground/46"
                    }`}
                  >
                    <span className="mr-2 truncate">{experiment.name}</span>
                    <span className="shrink-0 origin-right scale-[0.72]"><StatusBadge status={experiment.status} /></span>
                  </Link>
                </motion.div>
              ))}
              {(!Array.isArray(experiments) || experiments.length === 0) && (
                <div className="rounded-xl border border-dashed border-sidebar-border px-3 py-5 text-center">
                  <Activity className="mx-auto h-4 w-4 text-sidebar-foreground/45 dark:text-sidebar-foreground/25" />
                  <p className="mt-2 text-[10px] leading-4 text-sidebar-foreground/55 dark:text-sidebar-foreground/35">Your recent runs will appear here.</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </nav>

      <div className="relative z-10 mt-auto flex shrink-0 items-center justify-between border-t border-sidebar-border/80 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[10px] text-sidebar-foreground/55 dark:text-sidebar-foreground/35">
          <span className="signal-dot h-1.5 w-1.5 rounded-full bg-emerald-400 text-emerald-400" />
          Workspace online
        </div>
        <Link href="/privacy" className="text-[10px] text-sidebar-foreground/55 transition hover:text-sidebar-primary">Privacy</Link>
        <motion.button
          onClick={toggleTheme}
          className="rounded-lg border border-sidebar-border bg-sidebar-accent/35 p-2 text-sidebar-foreground/55 hover:text-sidebar-foreground"
          aria-label="Toggle theme"
          data-feedback="theme"
          data-feedback-message={`Switching to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
          whileTap={{ scale: 0.9 }}
        >
          <motion.span className="block" animate={{ rotate: resolvedTheme === "dark" ? 0 : 180 }} transition={{ duration: 0.35 }}>
            {resolvedTheme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </motion.span>
        </motion.button>
      </div>
    </div>
  );

  const mobileDockItems = navItems.filter((item) => ["/dashboard", "/experiments", "/projects"].includes(item.href));

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-background app-noise">
      <AmbientBackdrop />

      <aside className="relative z-30 hidden h-full w-[272px] shrink-0 border-r border-sidebar-border/80 shadow-[16px_0_50px_rgba(28,91,105,.10)] dark:shadow-[18px_0_70px_rgba(0,0,0,.16)] lg:block">
        <SidebarContent />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[288px] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-[288px]">
          <SheetHeader className="sr-only"><SheetTitle>Workspace navigation</SheetTitle></SheetHeader>
          <SidebarContent mobile />
        </SheetContent>
      </Sheet>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="relative z-30 flex h-16 shrink-0 items-center border-b border-border/65 bg-background/68 px-4 backdrop-blur-2xl sm:px-6">
          <motion.div className="absolute inset-x-0 bottom-0 h-px origin-left bg-gradient-to-r from-primary via-emerald-400 to-violet-400" animate={{ width: `${scrollProgress}%` }} transition={{ type: "spring", stiffness: 180, damping: 30 }} />
          <button
            onClick={() => setMobileNavOpen(true)}
            className="mr-3 rounded-lg border border-border/75 bg-card/50 p-2 text-muted-foreground transition hover:border-primary/25 hover:text-foreground lg:hidden"
            aria-label="Open navigation"
            data-feedback="neutral"
            data-feedback-message="Opening the workspace map"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
              <span className="hidden sm:inline">Workspace</span>
              <ChevronRight className="hidden h-3 w-3 sm:block" />
              <span className="truncate text-foreground/65">{routeLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:block"><CommandPaletteTrigger /></div>
            <div className="hidden items-center gap-2 rounded-lg border border-border/65 bg-card/45 px-3 py-2 md:flex">
              <span className="signal-dot h-1.5 w-1.5 rounded-full bg-emerald-400 text-emerald-400" />
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Live workspace</span>
            </div>
            <button
              onClick={toggleTheme}
              className="rounded-lg border border-border/75 bg-card/50 p-2 text-muted-foreground transition hover:border-primary/25 hover:text-foreground lg:hidden"
              aria-label="Toggle theme"
              data-feedback="theme"
              data-feedback-message={`Switching to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
            >
              {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <div ref={scrollContainerRef} data-workspace-scroll onScroll={onContentScroll} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <main className="relative mx-auto min-h-full w-full max-w-[1480px] px-4 pb-28 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-10 xl:px-10">
            {children}
          </main>
        </div>

        <nav className="glass-panel fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-2xl p-1.5 shadow-2xl lg:hidden" aria-label="Quick navigation">
          {mobileDockItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-feedback="navigate"
                data-feedback-message={`Moving to ${item.label.toLowerCase()}`}
                className={`relative flex min-w-16 flex-col items-center gap-1 rounded-xl px-3 py-2 text-[9px] font-medium transition ${item.active ? "text-primary" : "text-muted-foreground"}`}
              >
                {item.active && <motion.span layoutId="mobile-dock-active" className="absolute inset-0 rounded-xl border border-primary/15 bg-primary/[0.08]" />}
                <Icon className="relative z-10 h-4 w-4" />
                <span className="relative z-10">{item.label}</span>
              </Link>
            );
          })}
          <Link
            href="/experiments/new"
            className="soft-glow relative -mt-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg"
            aria-label="New experiment"
            data-feedback="create"
            data-feedback-message="Opening a fresh experiment record"
          >
            <Plus className="h-5 w-5" />
          </Link>
        </nav>
      </div>
    </div>
  );
}
