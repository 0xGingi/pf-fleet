import type { LaneConfig } from "@pf-fleet/protocol";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A Pirate Face account: its community torrent key (encrypted) is what the lanes work under. */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  keyEnc: text("key_enc"),
  keyHint: text("key_hint"),
  createdAt: integer("created_at").notNull(),
});

export const nodes = sqliteTable("nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  accountId: text("account_id").references(() => accounts.id),
  tokenHash: text("token_hash").notNull(),
  lanes: text("lanes", { mode: "json" }).$type<LaneConfig[]>().notNull().default([]),
  maxSizeGiB: integer("max_size_gib").notNull().default(0),
  idleSec: integer("idle_sec").notNull().default(300),
  hostname: text("hostname"),
  os: text("os"),
  kernel: text("kernel"),
  arch: text("arch"),
  cpus: integer("cpus"),
  agentVersion: text("agent_version"),
  lastSeenAt: integer("last_seen_at"),
  createdAt: integer("created_at").notNull(),
});

/** One leased model, from lease to outcome. `id` is the agent's job id. `result` is null while running. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull(),
    lane: text("lane").notNull(),
    repo: text("repo").notNull(),
    revision: text("revision").notNull().default(""),
    files: integer("files").notNull().default(0),
    sizeBytes: integer("size_bytes").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    result: text("result"),
    url: text("url"),
    infohash: text("infohash"),
    message: text("message"),
  },
  (t) => [index("jobs_started_idx").on(t.startedAt), index("jobs_node_idx").on(t.nodeId, t.startedAt)],
);

/** Bytes verified per node per minute (from the agents' processed-bytes counters). */
export const samples = sqliteTable(
  "samples",
  {
    nodeId: text("node_id").notNull(),
    ts: integer("ts").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.ts] })],
);

export const sessions = sqliteTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Dashboard-wide settings, one JSON value per key. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

/** The node event log: agent-reported (connection, updates, crashes) and dashboard-side entries. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: text("node_id").notNull(),
    ts: integer("ts").notNull(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("events_node_idx").on(t.nodeId, t.ts), index("events_ts_idx").on(t.ts)],
);

/** Worker output, kept so it survives dashboard restarts (capped per lane by maintenance). */
export const logs = sqliteTable(
  "logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: text("node_id").notNull(),
    lane: text("lane").notNull(),
    ts: integer("ts").notNull(),
    stream: text("stream").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("logs_lane_idx").on(t.nodeId, t.lane, t.id)],
);
