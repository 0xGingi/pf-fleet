/** Dashboard REST/SSE shapes shared by the server and the web app. */
import type { JobResult, LaneConfig, LaneStatus, LogLine, SystemStats } from "./index";

export interface NodeLive {
  connected: boolean;
  connectedAt: number | null;
  ts: number | null;
  system: SystemStats | null;
  uvx: string | null;
  lanes: LaneStatus[];
  /** agent version downloaded and waiting for the lanes to finish */
  updatePending: string | null;
}

export interface NodeView {
  id: string;
  name: string;
  accountId: string | null;
  accountName: string | null;
  lanes: LaneConfig[];
  maxSizeGiB: number;
  idleSec: number;
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  cpus: number | null;
  agentVersion: string | null;
  /** the agent is older than the one this dashboard serves */
  outdated: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  live: NodeLive;
}

export interface AccountView {
  id: string;
  name: string;
  hasKey: boolean;
  keyHint: string | null;
  createdAt: number;
  nodeCount: number;
  enabledLanes: number;
}

export interface JobView {
  id: string;
  nodeId: string;
  nodeName: string | null;
  lane: string;
  repo: string;
  revision: string;
  files: number;
  sizeBytes: number;
  startedAt: number;
  finishedAt: number | null;
  result: JobResult | null;
  url: string | null;
  infohash: string | null;
  message: string | null;
}

export interface Summary {
  nodesOnline: number;
  nodesTotal: number;
  lanesEnabled: number;
  lanesWorking: number;
  lanesIdle: number;
  lanesTrouble: number;
  rateBps: number;
  last24h: Record<JobResult, number> & { listedBytes: number };
  allTime: { listed: number; listedBytes: number; jobs: number };
  /** Pirate Face gives queue work 1 point per 10 GB verified; this estimates it from listed jobs. */
  pointsEstimate: number;
  agentVersion: string | null;
  dashboardVersion: string;
}

export interface SettingsView {
  autoUpdateAgents: boolean;
  dashboardVersion: string;
  /** agent version this dashboard ships and installs */
  agentVersion: string | null;
  agentArches: string[];
}

export interface Throughput {
  nodes: { id: string; name: string }[];
  bucketMs: number;
  points: { ts: number; values: Record<string, number> }[];
}

export interface DailyRow {
  day: string;
  listed: number;
  already_listed: number;
  refused: number;
  error: number;
  aborted: number;
  listedBytes: number;
}

export interface CreatedNode {
  node: NodeView;
  installCommand: string;
}

export type LiveEvent =
  | { type: "node"; nodeId: string; live: NodeLive }
  | { type: "job"; job: JobView }
  | { type: "log"; nodeId: string; lane: string; lines: LogLine[] }
  | { type: "nodes" }
  | { type: "accounts" };
