/**
 * Agent ↔ dashboard protocol v1. See docs/protocol.md.
 * The Rust agent mirrors these in agent/src/protocol.rs; both sides test against protocol/fixtures.
 */
import { z } from "zod";

export const LANE_NAME = /^[A-Za-z0-9._-]{1,24}$/; // same rule as `pf work --name`
export const LANES_PER_ACCOUNT = 3; // Pirate Face runs at most 3 lanes per account at once

const ts = z.number().int().nonnegative();
const bytes = z.number().nonnegative();

export const JobResult = z.enum(["listed", "already_listed", "refused", "error", "aborted"]);
export type JobResult = z.infer<typeof JobResult>;

export const LaneState = z.enum(["stopped", "starting", "idle", "working", "backoff", "draining", "error"]);
export type LaneState = z.infer<typeof LaneState>;

export const ActiveJob = z.object({
  jobId: z.string(),
  repo: z.string(),
  revision: z.string(),
  files: z.number().int().nonnegative(),
  sizeBytes: bytes,
  doneBytes: bytes,
  startedAt: ts,
  rateBps: z.number().nonnegative(),
});
export type ActiveJob = z.infer<typeof ActiveJob>;

export const LaneStatus = z.object({
  name: z.string(),
  state: LaneState,
  pid: z.number().int().nullable(),
  startedAt: ts.nullable(),
  restarts: z.number().int().nonnegative(),
  lastExit: z.number().int().nullable(),
  message: z.string().nullable(),
  job: ActiveJob.nullable(),
  /** the pirateface version this lane's worker was started with (null: not running, or @latest) */
  pfVersion: z.string().nullable(),
});
export type LaneStatus = z.infer<typeof LaneStatus>;

export const SystemStats = z.object({
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  memTotal: bytes,
  memAvailable: bytes,
  uptime: z.number().nonnegative(),
  netRx: bytes,
  netTx: bytes,
});
export type SystemStats = z.infer<typeof SystemStats>;

// ---------- agent → dashboard ----------

export const Hello = z.object({
  type: z.literal("hello"),
  agentVersion: z.string(),
  hostname: z.string(),
  os: z.string(),
  kernel: z.string(),
  arch: z.string(),
  cpus: z.number().int().positive(),
  activeJobs: z.array(z.string()),
});

export const Heartbeat = z.object({
  type: z.literal("heartbeat"),
  ts,
  system: SystemStats,
  uvx: z.string().nullable(),
  processedBytes: bytes,
  lanes: z.array(LaneStatus),
  /** a downloaded agent version waiting for the lanes to finish their jobs */
  updatePending: z.string().nullable(),
});

export const JobStarted = z.object({
  type: z.literal("job_started"),
  lane: z.string(),
  jobId: z.string(),
  repo: z.string(),
  revision: z.string(),
  files: z.number().int().nonnegative(),
  sizeBytes: bytes,
  startedAt: ts,
});

export const JobFinished = z.object({
  type: z.literal("job_finished"),
  lane: z.string(),
  jobId: z.string(),
  result: JobResult,
  url: z.string().nullish(),
  infohash: z.string().nullish(),
  message: z.string().nullish(),
  finishedAt: ts,
});

export const LogLine = z.object({ ts, stream: z.enum(["out", "err", "agent"]), text: z.string() });
export type LogLine = z.infer<typeof LogLine>;

export const Log = z.object({ type: z.literal("log"), lane: z.string(), lines: z.array(LogLine) });

/** Something about the agent itself (connection, updates, lanes failing) for the node's event log. */
export const EventLevel = z.enum(["info", "warn", "error"]);
export type EventLevel = z.infer<typeof EventLevel>;
export const AgentEvent = z.object({ type: z.literal("event"), ts, level: EventLevel, text: z.string() });

export const AgentMessage = z.discriminatedUnion("type", [Hello, Heartbeat, JobStarted, JobFinished, Log, AgentEvent]);
export type AgentMessage = z.infer<typeof AgentMessage>;
export type Hello = z.infer<typeof Hello>;
export type Heartbeat = z.infer<typeof Heartbeat>;

// ---------- dashboard → agent ----------

export const LaneConfig = z.object({
  name: z.string().regex(LANE_NAME),
  enabled: z.boolean(),
  drain: z.boolean(),
});
export type LaneConfig = z.infer<typeof LaneConfig>;

export const Config = z.object({
  type: z.literal("config"),
  lanes: z.array(LaneConfig),
  maxSizeGiB: z.number().int().nonnegative(),
  idleSec: z.number().int().positive(),
  pirateKey: z.string().nullable(),
  /** pirateface version to run (the dashboard follows PyPI); null: whatever @latest resolves to */
  pirateVersion: z.string().nullable(),
});
export type Config = z.infer<typeof Config>;

export const Command = z.object({
  type: z.literal("command"),
  id: z.string(),
  action: z.enum(["restart", "restart_all"]),
  lane: z.string().optional(),
  graceful: z.boolean(),
});
export type Command = z.infer<typeof Command>;

/** A new agent binary follows this message as one binary WebSocket frame. */
export const Update = z.object({
  type: z.literal("update"),
  version: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
  /** true: install after every lane finishes its current job; false: stop the workers now */
  graceful: z.boolean(),
});
export type Update = z.infer<typeof Update>;

export const SERVER_TYPES = ["config", "command", "update"] as const;
export const ServerMessage = z.discriminatedUnion("type", [Config, Command, Update]);
export type ServerMessage = z.infer<typeof ServerMessage>;
