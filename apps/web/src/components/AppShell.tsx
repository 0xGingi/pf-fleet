import { useQueryClient } from "@tanstack/react-query";
import { Activity, LayoutDashboard, ListChecks, LogOut, Server, Settings, Users } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { post } from "@/lib/api";
import { useLive } from "@/lib/live";
import { useSettings } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LIVE_LABEL = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" } as const;

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/nodes", label: "Nodes", icon: Server },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  { to: "/accounts", label: "Accounts", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const live = useLive(true);
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-row items-center gap-1 border-b border-border bg-surface px-3 py-2 md:w-56 md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-5">
        <div className="mr-2 flex items-center gap-2 px-2 md:mb-6">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="text-sm font-semibold tracking-tight">pf-fleet</span>
        </div>
        <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap",
                  isActive ? "bg-surface-2 font-medium text-text" : "text-text-2 hover:bg-surface-2 hover:text-text",
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1 md:flex-col md:items-stretch">
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-3" title="Live updates from the dashboard">
            <Activity className={cn("size-3.5", live === "live" ? "text-good" : "text-warning")} aria-hidden />
            <span className="hidden md:inline">{LIVE_LABEL[live]}</span>
          </div>
          <button
            type="button"
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-text-2 hover:bg-surface-2 hover:text-text"
            onClick={async () => {
              await post("/api/auth/logout").catch(() => {});
              qc.clear();
              navigate("/login");
            }}
          >
            <LogOut className="size-4" aria-hidden />
            <span className="hidden md:inline">Sign out</span>
          </button>
          {settings && <span className="hidden px-2.5 pt-2 text-[11px] text-text-3 md:block">pf-fleet {settings.dashboardVersion}</span>}
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
        <div className="mx-auto max-w-7xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-sm text-text-3">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
