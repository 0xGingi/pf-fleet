import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Suspense } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { post } from "@/lib/api";
import { useLive } from "@/lib/live";
import { useSettings } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LIVE_LABEL = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" } as const;

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/nodes", label: "Nodes" },
  { to: "/jobs", label: "Jobs" },
  { to: "/accounts", label: "Accounts" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  const live = useLive(true);
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 px-4 md:h-16 md:flex-nowrap md:px-8">
          <Link to="/" aria-label="Overview" className="flex shrink-0 items-center gap-2.5 py-3 md:py-0">
            <img src="/logo.png" alt="" className="size-9" />
            <span className="font-display text-[1.65rem] leading-none">Fleet</span>
          </Link>
          <nav className="order-last -mx-2 -mb-px flex h-11 w-full min-w-0 gap-1 overflow-x-auto md:order-none md:mx-0 md:h-full md:w-auto md:flex-1" aria-label="Main">
            {NAV.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center border-b-2 px-2.5 text-[15px] font-semibold whitespace-nowrap transition-colors",
                    isActive ? "border-brand text-text" : "border-transparent text-text-2 hover:text-text",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
            <span className="flex items-center gap-2 px-2 text-xs text-text-3" title={`Live updates: ${LIVE_LABEL[live]}`}>
              <span className={cn("size-2 rounded-full", live === "live" ? "bg-good" : "animate-pulse bg-warning")} aria-hidden />
              <span className="hidden lg:inline">{LIVE_LABEL[live]}</span>
            </span>
            {settings && <span className="hidden px-2 font-mono text-xs text-text-3 xl:inline">v{settings.dashboardVersion}</span>}
            <button
              type="button"
              title="Sign out"
              className="flex size-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text"
              onClick={async () => {
                await post("/api/auth/logout").catch(() => {});
                qc.clear();
                navigate("/login");
              }}
            >
              <LogOut className="size-4" aria-hidden />
              <span className="sr-only">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 px-4 py-8 md:px-8">
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-[15px] text-text-3">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
