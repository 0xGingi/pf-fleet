/**
 * Webhook alerts: a node offline, a lane failing for a while, a job refused or failed, an agent
 * error. One JSON POST per alert with `content` (Discord), `text` (Slack) and structured fields.
 */
import type { LiveEvent } from "@pf-fleet/protocol/api";
import { eq, isNotNull } from "drizzle-orm";
import { type Db, schema } from "./db";
import type { Hub } from "./hub";
import type { Fetch } from "./pypi";

export const OFFLINE_AFTER_MS = 2 * 60_000;
export const LANE_FAILING_AFTER_MS = 10 * 60_000;
/** After the dashboard starts, agents need a moment to reconnect before anyone counts as offline. */
const STARTUP_GRACE_MS = 3 * 60_000;
const BURST_LIMIT = 30;
const BURST_WINDOW_MS = 10 * 60_000;

export type AlertKind = "node_offline" | "node_online" | "lane_failing" | "lane_recovered" | "job_failed" | "agent_error" | "test";

export interface Alert {
  kind: AlertKind;
  text: string;
  node?: string;
  lane?: string;
}

export class Alerter {
  private open = new Set<string>(); // keys of conditions already alerted (offline, failing lane)
  private sent: number[] = [];
  private readonly startedAt: number;

  constructor(
    private db: Db,
    private hub: Hub,
    private fetchFn: Fetch = fetch,
    private now: () => number = Date.now,
  ) {
    this.startedAt = now();
    hub.subscribe((e) => this.onLive(e));
  }

  private setting<T>(key: string, fallback: T): T {
    return this.hub.getSetting(key, fallback);
  }

  /** "nodeId/lane" -> display names */
  private laneOf(key: string): { node: string; lane: string } {
    const [nodeId = "", lane = ""] = key.split("/");
    return { node: this.nodeName(nodeId), lane };
  }

  private nodeName(id: string): string {
    return this.db.select({ name: schema.nodes.name }).from(schema.nodes).where(eq(schema.nodes.id, id)).get()?.name ?? id;
  }

  async send(alert: Alert): Promise<boolean> {
    const url = this.setting<string | null>("alertWebhookUrl", null);
    if (!url) return false;
    const now = this.now();
    this.sent = this.sent.filter((t) => now - t < BURST_WINDOW_MS);
    if (this.sent.length >= BURST_LIMIT && alert.kind !== "test") return false;
    this.sent.push(now);
    const content = `**pf-fleet** ${alert.text}`;
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: alert.kind, node: alert.node, lane: alert.lane, message: alert.text, content, text: content, ts: now }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      this.hub.setSetting("lastAlertError", null);
      return true;
    } catch (e) {
      const msg = `could not send alert: ${(e as Error).message}`;
      console.warn(`pf-fleet: ${msg}`);
      this.hub.setSetting("lastAlertError", msg);
      return false;
    }
  }

  private onLive(e: LiveEvent) {
    if (e.type === "job" && this.setting("alertJobs", true)) {
      const j = e.job;
      if (j.result === "refused" || j.result === "error") {
        void this.send({
          kind: "job_failed",
          node: j.nodeName ?? j.nodeId,
          lane: j.lane,
          text: `${j.result === "refused" ? "Pirate Face refused" : "error on"} ${j.repo} (${j.nodeName ?? j.nodeId}/${j.lane})${j.message ? `: ${j.message}` : ""}`,
        });
      }
    }
    if (e.type === "event" && e.event.source === "agent" && e.event.level === "error" && this.setting("alertAgentErrors", true)) {
      const node = e.event.nodeName ?? e.event.nodeId;
      void this.send({ kind: "agent_error", node, text: `${node}: ${e.event.text}` });
    }
  }

  /** Called every 30 s: offline nodes and lanes that keep failing. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.setting("alertOffline", true) && now - this.startedAt >= STARTUP_GRACE_MS) {
      // nodes that have connected at least once and are not connected now
      const known = this.db.select({ id: schema.nodes.id, lastSeenAt: schema.nodes.lastSeenAt }).from(schema.nodes).where(isNotNull(schema.nodes.lastSeenAt)).all();
      for (const n of known) {
        const key = `offline:${n.id}`;
        const since = this.hub.isOnline(n.id) ? null : (this.hub.offline().get(n.id) ?? this.startedAt);
        if (since !== null && now - since >= OFFLINE_AFTER_MS && !this.open.has(key)) {
          this.open.add(key);
          await this.send({ kind: "node_offline", node: this.nodeName(n.id), text: `${this.nodeName(n.id)} is offline (no agent connection for ${Math.round((now - since) / 60_000)} min)` });
        } else if (since === null && this.open.delete(key)) {
          await this.send({ kind: "node_online", node: this.nodeName(n.id), text: `${this.nodeName(n.id)} is back online` });
        }
      }
    }
    if (this.setting("alertLanes", true)) {
      const failing = this.hub.troubledLanes();
      for (const [key, t] of failing) {
        if (now - t.since >= LANE_FAILING_AFTER_MS && !this.open.has(`lane:${key}`)) {
          this.open.add(`lane:${key}`);
          const { node, lane } = this.laneOf(key);
          await this.send({ kind: "lane_failing", node, lane, text: `${node}/${lane} has been failing for ${Math.round((now - t.since) / 60_000)} min${t.message ? `: ${t.message}` : ""}` });
        }
      }
      for (const key of [...this.open].filter((k) => k.startsWith("lane:"))) {
        const laneKey = key.slice(5);
        if (!failing.has(laneKey)) {
          this.open.delete(key);
          const { node, lane } = this.laneOf(laneKey);
          await this.send({ kind: "lane_recovered", node, lane, text: `${node}/${lane} is working again` });
        }
      }
    }
  }

  start(): () => void {
    const timer = setInterval(() => void this.tick().catch((e) => console.error("pf-fleet: alert check failed:", e)), 30_000);
    return () => clearInterval(timer);
  }
}
