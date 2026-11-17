import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { lazy, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useNavigate } from "react-router";
import { Toaster } from "sonner";
import { AppShell } from "./components/AppShell";
import { api, ApiError } from "./lib/api";
import { keys } from "./lib/queries";
import { Login } from "./pages/Login";

// one chunk per page; the chart library only loads with the pages that draw charts
const Overview = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
const Nodes = lazy(() => import("./pages/Nodes").then((m) => ({ default: m.Nodes })));
const NodeDetail = lazy(() => import("./pages/NodeDetail").then((m) => ({ default: m.NodeDetail })));
const Jobs = lazy(() => import("./pages/Jobs").then((m) => ({ default: m.Jobs })));
const Accounts = lazy(() => import("./pages/Accounts").then((m) => ({ default: m.Accounts })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

function RequireAuth() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: keys.me, queryFn: () => api("/api/auth/me"), retry: false, staleTime: Number.POSITIVE_INFINITY });
  useEffect(() => {
    const out = () => {
      queryClient.clear();
      navigate("/login");
    };
    window.addEventListener("pf-fleet:signed-out", out);
    return () => window.removeEventListener("pf-fleet:signed-out", out);
  }, [navigate]);
  if (me.isPending) return null;
  if (me.isError) return <Navigate to="/login" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Overview /> },
          { path: "nodes", element: <Nodes /> },
          { path: "nodes/:id", element: <NodeDetail /> },
          { path: "jobs", element: <Jobs /> },
          { path: "accounts", element: <Accounts /> },
          { path: "settings", element: <Settings /> },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster theme="system" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
