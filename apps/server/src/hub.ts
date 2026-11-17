/**
 * Live state: which agents are connected and their last heartbeat, and the fan-out of changes
 * to browsers (SSE). Persists jobs, throughput samples, worker logs, events and node facts.
 */
import type { AgentMessage, Command, Config, EventLevel, Heartbeat, Hello, LogLine, Update } from "@pf-fleet/protocol";
import type { EventView, JobView, LiveEvent, NodeLive } from "@pf-fleet/protocol/api";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { type AgentBundle, type Arch, agentOutdated } from "./bundle";
import type { Sealer } from "./crypto";
import { type Db, schema } from "./db";

const { accounts, events, jobs, logs, nodes, samples, settings } = schema;
/** Do not offer the same node an update more often than this (a failed install would loop). */
const UPDATE_COOLDOWN_MS = 30 * 60_000;
const LOG_KEEP = 1000;
export const SAMPLE_BUCKET_MS = 60_000;
/** A lane in one of these states with this message is waiting out a lease, not failing. */
const LEASE_WAIT = "waiting for the previous worker's Pirate Face lease";

/** The bits of a WebSocket the hub uses (Bun's ServerWebSocket fits; tests pass fakes). */
export interface AgentSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
}

interface Conn {
  ws: AgentSocket;
  hello: Hello | null;
  connectedAt: number;
  beat: Heartbeat | null;
  lastProcessed: number | null;
}

export class Hub {
  private conns = new Map<string, Conn>();
  private subs = new Set<(e: LiveEvent) => void>();
  private offered = new Map<string, number>();
  /** nodeId -> when its agent disconnected (for offline alerts) */
  private disconnectedAt = new Map<string, number>();
  /** "nodeId/lane" -> since when the lane has been failing (error or crash backoff) */
  private troubleSince = new Map<string, { since: number; message: string | null }>();

  constructor(
    private db: Db,
    private sealer: Sealer,
    readonly bundle: AgentBundle = { version: null, binaries: {} },
    private now: () => number = Date.now,
  ) {}

  // ---------- settings ----------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (row.value as T) : fallback;
  }

  /** null removes the setting, so reads fall back to their default. */
  setSetting(key: string, value: unknown) {
    if (value === null || value === undefined) {
      this.db.delete(settings).where(eq(settings.key, key)).run();
      return;
    }
    this.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }

  autoUpdate(): boolean {
    return this.getSetting("autoUpdateAgents", true);
  }

  followPirateface(): boolean {
    return this.getSetting("followPirateface", true);
  }

  /** The pirateface version lanes should run, or null for `pirateface@latest`. */
  pirateVersion(): string | null {
    return this.followPirateface() ? this.getSetting<string | null>("pirateVersion", null) : null;
  }

  // ---------- event log ----------

  addEvent(nodeId: string, level: EventLevel, source: EventView["source"], text: string, ts = this.now()) {
    const row = this.db.insert(events).values({ nodeId, ts, level, source, text }).returning({ id: events.id }).get();
    const nodeName = this.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? null;
    this.emit({ type: "event", event: { id: row.id, nodeId, nodeName, ts, level, source, text } });
  }

  // ---------- agent self-update ----------

  /**
   * Sends the node the agent binary this dashboard ships, if it is newer than what the node runs.
   * The binary follows the `update` message as one binary frame.
   */
  offerUpdate(nodeId: string, opts: { graceful: boolean; force?: boolean }): "sent" | "offline" | "current" | "unavailable" | "cooldown" {
    const conn = this.conns.get(nodeId);
    if (!conn?.hello) return "offline";
    const version = this.bundle.version;
    const bin = this.bundle.binaries[conn.hello.arch as Arch];
    if (!version || !bin) return "unavailable";
    const hello = conn.hello;
    if (!opts.force && !agentOutdated(this.bundle, { version: hello.agentVersion, sha256: hello.sha256, arch: hello.arch })) return "current";
    const last = this.offered.get(nodeId);
    if (!opts.force && last && this.now() - last < UPDATE_COOLDOWN_MS) return "cooldown";
    this.offered.set(nodeId, this.now());
    conn.ws.send(JSON.stringify({ type: "update", version, sha256: bin.sha256, size: bin.bytes.length, graceful: opts.graceful } satisfies Update));
    conn.ws.send(bin.bytes);
    this.addEvent(nodeId, "info", "dashboard", `sent agent ${version} (node runs ${conn.hello.agentVersion})`);
    return "sent";
  }

  /** Offer every connected, outdated agent the update (after their current jobs). */
  updateOutdated(): number {
    let n = 0;
    for (const id of this.conns.keys()) if (this.offerUpdate(id, { graceful: true }) === "sent") n++;
    return n;
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(e: LiveEvent) {
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        // a broken subscriber (closed stream) must not stop the others
      }
    }
  }

  isOnline(nodeId: string) {
    return this.conns.has(nodeId);
  }

  live(nodeId: string): NodeLive {
    const c = this.conns.get(nodeId);
    return {
      connected: !!c,
      connectedAt: c?.connectedAt ?? null,
      ts: c?.beat?.ts ?? null,
      system: c?.beat?.system ?? null,
      uvx: c?.beat?.uvx ?? null,
      lanes: c?.beat?.lanes ?? [],
      updatePending: c?.beat?.updatePending ?? null,
    };
  }

  logTail(nodeId: string, lane: string): LogLine[] {
    return this.db
      .select({ ts: logs.ts, stream: logs.stream, text: logs.text })
      .from(logs)
      .where(and(eq(logs.nodeId, nodeId), eq(logs.lane, lane)))
      .orderBy(desc(logs.id))
      .limit(LOG_KEEP)
      .all()
      .reverse() as LogLine[];
  }

  /** Nodes whose agent has been disconnected (since when), for alerts. */
  offline(): Map<string, number> {
    return this.disconnectedAt;
  }

  /** Lanes failing right now and since when, for alerts. */
  troubledLanes(): Map<string, { since: number; message: string | null }> {
    return this.troubleSince;
  }

  attach(nodeId: string, ws: AgentSocket) {
    const old = this.conns.get(nodeId);
    if (old && old.ws !== ws) old.ws.close(4000, "replaced by a newer connection");
    this.conns.set(nodeId, { ws, hello: null, connectedAt: this.now(), beat: null, lastProcessed: null });
    this.disconnectedAt.delete(nodeId);
    this.emit({ type: "node", nodeId, live: this.live(nodeId) });
  }

  detach(nodeId: string, ws: AgentSocket) {
    if (this.conns.get(nodeId)?.ws !== ws) return;
    this.conns.delete(nodeId);
    this.disconnectedAt.set(nodeId, this.now());
    for (const key of this.troubleSince.keys()) if (key.startsWith(`${nodeId}/`)) this.troubleSince.delete(key);
    this.emit({ type: "node", nodeId, live: this.live(nodeId) });
  }

  /** Drop a node entirely (deleted or token rotated). */
  kick(nodeId: string, reason: string) {
    this.conns.get(nodeId)?.ws.close(4001, reason);
    this.conns.delete(nodeId);
    this.disconnectedAt.delete(nodeId);
  }

  async handle(nodeId: string, msg: AgentMessage) {
    const conn = this.conns.get(nodeId);
    if (!conn) return;
    const now = this.now();
    switch (msg.type) {
      case "hello": {
        conn.hello = msg;
        this.db
          .update(nodes)
          .set({
            hostname: msg.hostname,
            os: msg.os,
            kernel: msg.kernel,
            arch: msg.arch,
            cpus: msg.cpus,
            agentVersion: msg.agentVersion,
            agentSha256: msg.sha256,
            lastSeenAt: now,
          })
          .where(eq(nodes.id, nodeId))
          .run();
        // jobs we think are running but the agent no longer has were lost (agent restarted)
        const stale = this.db
          .update(jobs)
          .set({ result: "aborted", finishedAt: now, message: "the agent restarted during this job" })
          .where(
            and(
              eq(jobs.nodeId, nodeId),
              isNull(jobs.result),
              msg.activeJobs.length ? notInArray(jobs.id, msg.activeJobs) : undefined,
            ),
          )
          .returning({ id: jobs.id })
          .all();
        for (const { id } of stale) this.emitJob(id);
        await this.sendConfig(nodeId);
        if (this.autoUpdate()) this.offerUpdate(nodeId, { graceful: true });
        this.emit({ type: "nodes" });
        break;
      }
      case "heartbeat": {
        conn.beat = msg;
        if (conn.lastProcessed !== null && msg.processedBytes > conn.lastProcessed) {
          const delta = msg.processedBytes - conn.lastProcessed;
          const ts = Math.floor(now / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS;
          this.db
            .insert(samples)
            .values({ nodeId, ts, bytes: delta })
            .onConflictDoUpdate({ target: [samples.nodeId, samples.ts], set: { bytes: sql`${samples.bytes} + ${delta}` } })
            .run();
        }
        conn.lastProcessed = msg.processedBytes;
        for (const lane of msg.lanes) {
          const key = `${nodeId}/${lane.name}`;
          const failing = lane.state === "error" || (lane.state === "backoff" && !lane.message?.startsWith(LEASE_WAIT));
          if (!failing) this.troubleSince.delete(key);
          else if (!this.troubleSince.has(key)) this.troubleSince.set(key, { since: now, message: lane.message });
        }
        this.db.update(nodes).set({ lastSeenAt: now }).where(eq(nodes.id, nodeId)).run();
        this.emit({ type: "node", nodeId, live: this.live(nodeId) });
        break;
      }
      case "job_started": {
        this.db
          .insert(jobs)
          .values({
            id: msg.jobId,
            nodeId,
            lane: msg.lane,
            repo: msg.repo,
            revision: msg.revision,
            files: msg.files,
            sizeBytes: msg.sizeBytes,
            startedAt: msg.startedAt,
          })
          .onConflictDoNothing()
          .run();
        this.emitJob(msg.jobId);
        break;
      }
      case "job_finished": {
        const outcome = {
          result: msg.result,
          finishedAt: msg.finishedAt,
          url: msg.url ?? null,
          infohash: msg.infohash ?? null,
          message: msg.message ?? null,
        };
        this.db
          .insert(jobs)
          .values({ id: msg.jobId, nodeId, lane: msg.lane, repo: "(unknown)", startedAt: msg.finishedAt, ...outcome })
          .onConflictDoUpdate({ target: jobs.id, set: outcome })
          .run();
        this.emitJob(msg.jobId);
        break;
      }
      case "log": {
        if (msg.lines.length) {
          this.db
            .insert(logs)
            .values(msg.lines.map((l) => ({ nodeId, lane: msg.lane, ts: l.ts, stream: l.stream, text: l.text })))
            .run();
        }
        this.emit({ type: "log", nodeId, lane: msg.lane, lines: msg.lines });
        break;
      }
      case "event": {
        this.addEvent(nodeId, msg.level, "agent", msg.text, msg.ts);
        break;
      }
    }
  }

  private emitJob(id: string) {
    const job = jobView(this.db, id);
    if (job) this.emit({ type: "job", job });
  }

  async configFor(nodeId: string): Promise<Config | null> {
    const row = this.db
      .select({ lanes: nodes.lanes, maxSizeGiB: nodes.maxSizeGiB, idleSec: nodes.idleSec, keyEnc: accounts.keyEnc })
      .from(nodes)
      .leftJoin(accounts, eq(nodes.accountId, accounts.id))
      .where(eq(nodes.id, nodeId))
      .get();
    if (!row) return null;
    let pirateKey: string | null = null;
    if (row.keyEnc) {
      try {
        pirateKey = await this.sealer.open(row.keyEnc);
      } catch {
        console.error(`pf-fleet: cannot decrypt the Pirate Face key for node ${nodeId} (APP_SECRET changed?); set the key again`);
      }
    }
    return { type: "config", lanes: row.lanes, maxSizeGiB: row.maxSizeGiB, idleSec: row.idleSec, pirateKey, pirateVersion: this.pirateVersion() };
  }

  async sendConfig(nodeId: string): Promise<boolean> {
    const conn = this.conns.get(nodeId);
    const cfg = conn && (await this.configFor(nodeId));
    if (!conn || !cfg) return false;
    conn.ws.send(JSON.stringify(cfg));
    return true;
  }

  /** Re-send every connected node its config (after a dashboard-wide change). */
  async sendConfigAll(): Promise<void> {
    for (const id of this.conns.keys()) await this.sendConfig(id);
  }

  command(nodeId: string, cmd: Omit<Command, "type" | "id">): boolean {
    const conn = this.conns.get(nodeId);
    if (!conn) return false;
    conn.ws.send(JSON.stringify({ type: "command", id: crypto.randomUUID(), ...cmd } satisfies Command));
    return true;
  }

  /** Sum of the lanes' current verify rates across connected agents. */
  totalRate(): number {
    let sum = 0;
    for (const c of this.conns.values()) for (const l of c.beat?.lanes ?? []) sum += l.job?.rateBps ?? 0;
    return sum;
  }

  laneStates(): string[] {
    return [...this.conns.values()].flatMap((c) => (c.beat?.lanes ?? []).map((l) => l.state));
  }
}

export function jobView(db: Db, id: string): JobView | undefined {
  return db
    .select({
      id: jobs.id,
      nodeId: jobs.nodeId,
      nodeName: nodes.name,
      lane: jobs.lane,
      repo: jobs.repo,
      revision: jobs.revision,
      files: jobs.files,
      sizeBytes: jobs.sizeBytes,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      result: jobs.result,
      url: jobs.url,
      infohash: jobs.infohash,
      message: jobs.message,
    })
    .from(jobs)
    .leftJoin(nodes, eq(jobs.nodeId, nodes.id))
    .where(eq(jobs.id, id))
    .get() as JobView | undefined;
}

