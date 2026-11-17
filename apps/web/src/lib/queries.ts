import type { LogLine } from "@pf-fleet/protocol";
import type { AccountView, DailyRow, JobView, NodeView, SettingsView, Summary, Throughput } from "@pf-fleet/protocol/api";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const keys = {
  me: ["me"] as const,
  nodes: ["nodes"] as const,
  node: (id: string) => ["nodes", id] as const,
  accounts: ["accounts"] as const,
  summary: ["summary"] as const,
  throughput: (hours: number) => ["throughput", hours] as const,
  daily: (days: number) => ["daily", days] as const,
  jobs: (q: JobsQuery) => ["jobs", q] as const,
  logs: (nodeId: string, lane: string) => ["logs", nodeId, lane] as const,
  settings: ["settings"] as const,
};

export interface JobsQuery {
  nodeId?: string;
  result?: string;
  repo?: string;
  limit?: number;
  offset?: number;
}

export const useNodes = () => useQuery({ queryKey: keys.nodes, queryFn: () => api<NodeView[]>("/api/nodes") });

export const useNode = (id: string) => useQuery({ queryKey: keys.node(id), queryFn: () => api<NodeView>(`/api/nodes/${id}`) });

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api<SettingsView>("/api/settings") });

export const useAccounts = () => useQuery({ queryKey: keys.accounts, queryFn: () => api<AccountView[]>("/api/accounts") });

export const useSummary = () =>
  useQuery({ queryKey: keys.summary, queryFn: () => api<Summary>("/api/stats/summary"), refetchInterval: 15_000 });

export const useThroughput = (hours: number) =>
  useQuery({
    queryKey: keys.throughput(hours),
    queryFn: () => api<Throughput>(`/api/stats/throughput?hours=${hours}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

export const useDaily = (days: number) =>
  useQuery({ queryKey: keys.daily(days), queryFn: () => api<DailyRow[]>(`/api/stats/daily?days=${days}`), refetchInterval: 300_000 });

export const useJobs = (q: JobsQuery) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  return useQuery({
    queryKey: keys.jobs(q),
    queryFn: () => api<{ rows: JobView[]; total: number }>(`/api/jobs?${params}`),
    placeholderData: keepPreviousData,
  });
};

export const useLogs = (nodeId: string, lane: string) =>
  useQuery({
    queryKey: keys.logs(nodeId, lane),
    queryFn: () => api<LogLine[]>(`/api/nodes/${nodeId}/lanes/${encodeURIComponent(lane)}/logs`),
    staleTime: Number.POSITIVE_INFINITY, // live events append to it
    enabled: !!lane,
  });
