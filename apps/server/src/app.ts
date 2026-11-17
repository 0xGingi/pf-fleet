import { AgentMessage, JobResult, LaneConfig, type LogLine } from "@pf-fleet/protocol";
import type { AccountView, CreatedNode, DailyRow, LiveEvent, NodeView, SettingsView, Summary, Throughput } from "@pf-fleet/protocol/api";
import { and, count, desc, eq, gte, isNull, like, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getConnInfo, serveStatic, upgradeWebSocket } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { join } from "node:path";
import { z } from "zod";
import type { Auth } from "./auth";
import { randomToken, safeEqual, type Sealer, sha256 } from "./crypto";
import { type Db, schema } from "./db";
import type { Env } from "./env";
import { type AgentSocket, type Hub, jobView, SAMPLE_BUCKET_MS } from "./hub";
import { INSTALL_SH, installCommand } from "./install";
import { ARCHES, type Arch } from "./bundle";
import { laneProblem } from "./lanes";
import { olderThan } from "./versions";

const { accounts, jobs, nodes, samples } = schema;

const PIRATE_KEY = /^pfct_[A-Za-z0-9]{16,128}$/;
const NodeName = z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, "use 1-40 letters, digits, '.', '_' or '-'");
const AccountName = z.string().trim().min(1).max(60);
const PirateKey = z.string().trim().regex(PIRATE_KEY, "a community torrent key starts with pfct_ (pirateface.co/settings)");

export interface Deps {
  db: Db;
  hub: Hub;
  auth: Auth;
  sealer: Sealer;
  env: Pick<Env, "PUBLIC_URL" | "WEB_DIR" | "TRUST_PROXY">;
  dashboardVersion: string;
}

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "send a JSON body" });
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  }
  return parsed.data;
}

/** Chart resolution: 1 min up to 6 h, 10 min up to 2 days, then hourly. */
function throughputBucket(hours: number): number {
  if (hours <= 6) return SAMPLE_BUCKET_MS;
  if (hours <= 48) return 10 * SAMPLE_BUCKET_MS;
  return 60 * SAMPLE_BUCKET_MS;
}

export function createApp(d: Deps) {
  const { db, hub, auth, sealer, env } = d;
  const bundle = hub.bundle;
  const app = new Hono<{ Variables: { nodeId: string } }>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  const clientIp = (c: Context) => {
    if (env.TRUST_PROXY) {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  // ---------- views ----------

  const nodeViews = (where?: SQL): NodeView[] =>
    db
      .select({ n: nodes, accountName: accounts.name })
      .from(nodes)
      .leftJoin(accounts, eq(nodes.accountId, accounts.id))
      .where(where)
      .orderBy(nodes.name)
      .all()
      .map(({ n, accountName }) => ({
        id: n.id,
        name: n.name,
        accountId: n.accountId,
        accountName,
        lanes: n.lanes,
        maxSizeGiB: n.maxSizeGiB,
        idleSec: n.idleSec,
        hostname: n.hostname,
        os: n.os,
        kernel: n.kernel,
        arch: n.arch,
        cpus: n.cpus,
        agentVersion: n.agentVersion,
        outdated: !!(n.agentVersion && bundle.version && olderThan(n.agentVersion, bundle.version)),
        lastSeenAt: n.lastSeenAt,
        createdAt: n.createdAt,
        live: hub.live(n.id),
      }));

  const nodeView = (id: string) => {
    const v = nodeViews(eq(nodes.id, id))[0];
    if (!v) throw new HTTPException(404, { message: "no such node" });
    return v;
  };

  const accountViews = (): AccountView[] => {
    const all = db.select().from(nodes).all();
    return db
      .select()
      .from(accounts)
      .orderBy(accounts.name)
      .all()
      .map((a) => {
        const mine = all.filter((n) => n.accountId === a.id);
        return {
          id: a.id,
          name: a.name,
          hasKey: !!a.keyEnc,
          keyHint: a.keyHint,
          createdAt: a.createdAt,
          nodeCount: mine.length,
          enabledLanes: mine.reduce((s, n) => s + n.lanes.filter((l) => l.enabled).length, 0),
        };
      });
  };

  const keyHint = (key: string) => `pfct_…${key.slice(-4)}`;

  // ---------- public ----------

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/install.sh", (c) => c.body(INSTALL_SH, 200, { "Content-Type": "text/x-shellscript; charset=utf-8" }));

  app.get("/agent/download/:arch", (c) => {
    const arch = c.req.param("arch");
    if (!(ARCHES as readonly string[]).includes(arch)) return c.json({ error: `arch must be one of ${ARCHES.join(", ")}` }, 400);
    const bin = bundle.binaries[arch as Arch];
    if (!bin) return c.json({ error: `agent binary for ${arch} is not built into this dashboard` }, 404);
    return new Response(Bun.file(bin.path), {
      headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="pf-fleet-agent"` },
    });
  });

  app.get(
    "/agent/ws",
    async (c, next) => {
      const m = /^Bearer ([^.\s]+)\.(\S+)$/.exec(c.req.header("authorization") ?? "");
      const row = m && db.select({ tokenHash: nodes.tokenHash }).from(nodes).where(eq(nodes.id, m[1]!)).get();
      if (!m || !row || !safeEqual(sha256(m[2]!), row.tokenHash)) return c.text("bad node token", 401);
      c.set("nodeId", m[1]!);
      await next();
    },
    upgradeWebSocket((c) => {
      const nodeId = c.get("nodeId");
      return {
        onOpen(_e, ws) {
          hub.attach(nodeId, ws.raw as AgentSocket);
        },
        onMessage(e, _ws) {
          let parsed;
          try {
            parsed = AgentMessage.safeParse(JSON.parse(String(e.data)));
          } catch {
            return;
          }
          if (!parsed.success) {
            console.warn(`pf-fleet: node ${nodeId} sent an unreadable message: ${parsed.error.issues[0]?.message}`);
            return;
          }
          hub.handle(nodeId, parsed.data).catch((err) => console.error(`pf-fleet: handling ${parsed.data.type} from ${nodeId}:`, err));
        },
        onClose(_e, ws) {
          hub.detach(nodeId, ws.raw as AgentSocket);
        },
      };
    }),
  );

  // ---------- auth ----------

  app.post("/api/auth/login", async (c) => {
    const { username, password } = await body(c, z.object({ username: z.string(), password: z.string() }));
    const r = await auth.login(c, clientIp(c), username, password);
    if (r === "limited") return c.json({ error: "too many attempts; wait 15 minutes" }, 429);
    if (r === "bad") return c.json({ error: "wrong username or password" }, 401);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    auth.logout(c);
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", (c) => (auth.isAuthed(c) ? c.json({ ok: true }) : c.json({ error: "sign in first" }, 401)));

  // ---------- everything else under /api needs a session ----------

  app.use("/api/*", auth.guard());

  // accounts

  app.get("/api/accounts", (c) => c.json(accountViews()));

  app.post("/api/accounts", async (c) => {
    const b = await body(c, z.object({ name: AccountName, key: PirateKey.optional() }));
    if (db.select().from(accounts).where(eq(accounts.name, b.name)).get()) throw new HTTPException(409, { message: "an account with that name exists" });
    const id = crypto.randomUUID();
    db.insert(accounts)
      .values({
        id,
        name: b.name,
        keyEnc: b.key ? await sealer.seal(b.key) : null,
        keyHint: b.key ? keyHint(b.key) : null,
        createdAt: Date.now(),
      })
      .run();
    hub.emit({ type: "accounts" });
    return c.json(accountViews().find((a) => a.id === id), 201);
  });

  app.patch("/api/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const b = await body(c, z.object({ name: AccountName.optional(), key: PirateKey.nullable().optional() }));
    if (!db.select().from(accounts).where(eq(accounts.id, id)).get()) throw new HTTPException(404, { message: "no such account" });
    const set: Partial<typeof accounts.$inferInsert> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.key !== undefined) {
      set.keyEnc = b.key ? await sealer.seal(b.key) : null;
      set.keyHint = b.key ? keyHint(b.key) : null;
    }
    if (Object.keys(set).length) db.update(accounts).set(set).where(eq(accounts.id, id)).run();
    if (b.key !== undefined) {
      for (const n of db.select({ id: nodes.id }).from(nodes).where(eq(nodes.accountId, id)).all()) await hub.sendConfig(n.id);
    }
    hub.emit({ type: "accounts" });
    hub.emit({ type: "nodes" });
    return c.json(accountViews().find((a) => a.id === id));
  });

  app.delete("/api/accounts/:id", (c) => {
    const id = c.req.param("id");
    const used = db.select({ n: count() }).from(nodes).where(eq(nodes.accountId, id)).get()?.n ?? 0;
    if (used) throw new HTTPException(409, { message: `${used} node(s) still use this account; move them first` });
    db.delete(accounts).where(eq(accounts.id, id)).run();
    hub.emit({ type: "accounts" });
    return c.json({ ok: true });
  });

  // nodes

  app.get("/api/nodes", (c) => c.json(nodeViews()));
  app.get("/api/nodes/:id", (c) => c.json(nodeView(c.req.param("id"))));

  app.post("/api/nodes", async (c) => {
    const b = await body(c, z.object({ name: NodeName, accountId: z.string().nullable().optional() }));
    if (db.select().from(nodes).where(eq(nodes.name, b.name)).get()) throw new HTTPException(409, { message: "a node with that name exists" });
    if (b.accountId && !db.select().from(accounts).where(eq(accounts.id, b.accountId)).get()) {
      throw new HTTPException(400, { message: "no such account" });
    }
    const id = crypto.randomUUID();
    const secret = randomToken();
    db.insert(nodes)
      .values({ id, name: b.name, accountId: b.accountId ?? null, tokenHash: sha256(secret), lanes: [], createdAt: Date.now() })
      .run();
    hub.emit({ type: "nodes" });
    const res: CreatedNode = { node: nodeView(id), installCommand: installCommand(env.PUBLIC_URL, `${id}.${secret}`) };
    return c.json(res, 201);
  });

  app.patch("/api/nodes/:id", async (c) => {
    const id = c.req.param("id");
    const b = await body(
      c,
      z.object({
        name: NodeName.optional(),
        accountId: z.string().nullable().optional(),
        lanes: z.array(LaneConfig).max(16).optional(),
        maxSizeGiB: z.number().int().min(0).max(100_000).optional(),
        idleSec: z.number().int().min(30).max(86_400).optional(),
      }),
    );
    const current = db.select().from(nodes).where(eq(nodes.id, id)).get();
    if (!current) throw new HTTPException(404, { message: "no such node" });
    if (b.name && b.name !== current.name && db.select().from(nodes).where(eq(nodes.name, b.name)).get()) {
      throw new HTTPException(409, { message: "a node with that name exists" });
    }
    if (b.accountId && !db.select().from(accounts).where(eq(accounts.id, b.accountId)).get()) {
      throw new HTTPException(400, { message: "no such account" });
    }
    const next = {
      id,
      name: b.name ?? current.name,
      accountId: b.accountId === undefined ? current.accountId : b.accountId,
      lanes: b.lanes ?? current.lanes,
    };
    const problem = laneProblem(next, db.select().from(nodes).all());
    if (problem) throw new HTTPException(400, { message: problem });
    db.update(nodes)
      .set({ name: next.name, accountId: next.accountId, lanes: next.lanes, maxSizeGiB: b.maxSizeGiB, idleSec: b.idleSec })
      .where(eq(nodes.id, id))
      .run();
    await hub.sendConfig(id);
    hub.emit({ type: "nodes" });
    hub.emit({ type: "accounts" });
    return c.json(nodeView(id));
  });

  app.post("/api/nodes/:id/token", (c) => {
    const id = c.req.param("id");
    nodeView(id);
    const secret = randomToken();
    db.update(nodes).set({ tokenHash: sha256(secret) }).where(eq(nodes.id, id)).run();
    hub.kick(id, "token rotated");
    hub.emit({ type: "nodes" });
    return c.json({ node: nodeView(id), installCommand: installCommand(env.PUBLIC_URL, `${id}.${secret}`) } satisfies CreatedNode);
  });

  app.delete("/api/nodes/:id", (c) => {
    const id = c.req.param("id");
    nodeView(id);
    hub.kick(id, "node deleted");
    db.delete(nodes).where(eq(nodes.id, id)).run();
    hub.emit({ type: "nodes" });
    hub.emit({ type: "accounts" });
    return c.json({ ok: true });
  });

  app.post("/api/nodes/:id/restart", async (c) => {
    const id = c.req.param("id");
    const b = await body(c, z.object({ lane: z.string().optional(), graceful: z.boolean().default(true) }));
    nodeView(id);
    const sent = hub.command(id, b.lane ? { action: "restart", lane: b.lane, graceful: b.graceful } : { action: "restart_all", graceful: b.graceful });
    if (!sent) throw new HTTPException(409, { message: "the node is offline" });
    return c.json({ ok: true }, 202);
  });

  app.post("/api/nodes/:id/update-agent", async (c) => {
    const id = c.req.param("id");
    const b = await body(c, z.object({ graceful: z.boolean().default(true) }));
    nodeView(id);
    const r = hub.offerUpdate(id, { graceful: b.graceful, force: true });
    if (r === "offline") throw new HTTPException(409, { message: "the node is offline" });
    if (r === "unavailable") throw new HTTPException(409, { message: "this dashboard has no agent build for that node's CPU" });
    return c.json({ ok: true, version: bundle.version }, 202);
  });

  // settings

  const settingsView = (): SettingsView => ({
    autoUpdateAgents: hub.autoUpdate(),
    dashboardVersion: d.dashboardVersion,
    agentVersion: bundle.version,
    agentArches: Object.keys(bundle.binaries),
  });

  app.get("/api/settings", (c) => c.json(settingsView()));

  app.patch("/api/settings", async (c) => {
    const b = await body(c, z.object({ autoUpdateAgents: z.boolean().optional() }));
    if (b.autoUpdateAgents !== undefined) {
      hub.setSetting("autoUpdateAgents", b.autoUpdateAgents);
      if (b.autoUpdateAgents) hub.updateOutdated();
    }
    return c.json(settingsView());
  });

  app.get("/api/nodes/:id/lanes/:lane/logs", (c) => c.json(hub.logTail(c.req.param("id"), c.req.param("lane")) satisfies LogLine[]));

  // jobs

  app.get("/api/jobs", (c) => {
    const q = z
      .object({
        nodeId: z.string().optional(),
        result: z.union([JobResult, z.literal("running")]).optional(),
        repo: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: q.error.issues[0]?.message ?? "bad query" });
    const { nodeId, result, repo, limit, offset } = q.data;
    let resultFilter: SQL | undefined;
    if (result === "running") resultFilter = isNull(jobs.result);
    else if (result) resultFilter = eq(jobs.result, result);
    const where = and(
      nodeId ? eq(jobs.nodeId, nodeId) : undefined,
      resultFilter,
      repo ? like(jobs.repo, `%${repo.replace(/[%_]/g, "")}%`) : undefined,
    );
    const ids = db.select({ id: jobs.id }).from(jobs).where(where).orderBy(desc(jobs.startedAt)).limit(limit).offset(offset).all();
    const total = db.select({ n: count() }).from(jobs).where(where).get()?.n ?? 0;
    return c.json({ rows: ids.map(({ id }) => jobView(db, id)).filter(Boolean), total });
  });

  // stats

  app.get("/api/stats/summary", (c) => {
    const allNodes = db.select({ id: nodes.id, lanes: nodes.lanes }).from(nodes).all();
    const states = hub.laneStates();
    const since = Date.now() - 86_400_000;
    const finished = sql`coalesce(${jobs.finishedAt}, ${jobs.startedAt})`;
    const last = db
      .select({ result: jobs.result, n: count(), bytes: sql<number>`sum(${jobs.sizeBytes})` })
      .from(jobs)
      .where(and(gte(finished, since), sql`${jobs.result} is not null`))
      .groupBy(jobs.result)
      .all();
    const all = db
      .select({ jobs: count(), listed: sql<number>`sum(${jobs.result} = 'listed')`, bytes: sql<number>`sum(case when ${jobs.result} = 'listed' then ${jobs.sizeBytes} else 0 end)` })
      .from(jobs)
      .get();
    const last24h = { listed: 0, already_listed: 0, refused: 0, error: 0, aborted: 0, listedBytes: 0 };
    for (const r of last) {
      if (r.result && r.result in last24h) last24h[r.result as JobResult] = r.n;
      if (r.result === "listed") last24h.listedBytes = r.bytes ?? 0;
    }
    const listedBytes = all?.bytes ?? 0;
    const summary: Summary = {
      nodesOnline: allNodes.filter((n) => hub.isOnline(n.id)).length,
      nodesTotal: allNodes.length,
      lanesEnabled: allNodes.reduce((s, n) => s + n.lanes.filter((l) => l.enabled).length, 0),
      lanesWorking: states.filter((s) => s === "working" || s === "draining").length,
      lanesIdle: states.filter((s) => s === "idle" || s === "starting").length,
      lanesTrouble: states.filter((s) => s === "error" || s === "backoff").length,
      rateBps: hub.totalRate(),
      last24h,
      allTime: { listed: all?.listed ?? 0, listedBytes, jobs: all?.jobs ?? 0 },
      pointsEstimate: Math.floor(listedBytes / 1e10),
      agentVersion: bundle.version,
      dashboardVersion: d.dashboardVersion,
    };
    return c.json(summary);
  });

  app.get("/api/stats/throughput", (c) => {
    const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 24) || 24, 1), 24 * 30);
    const bucketMs = throughputBucket(hours);
    const since = Math.floor((Date.now() - hours * 3_600_000) / bucketMs) * bucketMs;
    const bucket = sql<number>`(${samples.ts} / ${bucketMs}) * ${bucketMs}`;
    const rows = db
      .select({ nodeId: samples.nodeId, ts: bucket, bytes: sql<number>`sum(${samples.bytes})` })
      .from(samples)
      .where(gte(samples.ts, since))
      .groupBy(samples.nodeId, bucket)
      .all();
    const byTs = new Map<number, Record<string, number>>();
    for (let t = since; t <= Date.now(); t += bucketMs) byTs.set(t, {});
    for (const r of rows) {
      const values = byTs.get(r.ts) ?? {};
      values[r.nodeId] = r.bytes / (bucketMs / 1000); // bytes per second
      byTs.set(r.ts, values);
    }
    const res: Throughput = {
      // creation order, so a node keeps its chart colour when others are added
      nodes: db.select({ id: nodes.id, name: nodes.name }).from(nodes).orderBy(nodes.createdAt).all(),
      bucketMs,
      points: [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, values]) => ({ ts, values })),
    };
    return c.json(res);
  });

  app.get("/api/stats/daily", (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 14) || 14, 1), 365);
    const since = Date.now() - days * 86_400_000;
    const finished = sql`coalesce(${jobs.finishedAt}, ${jobs.startedAt})`;
    const day = sql<string>`strftime('%Y-%m-%d', ${finished} / 1000, 'unixepoch')`;
    const rows = db
      .select({ day, result: jobs.result, n: count(), bytes: sql<number>`sum(${jobs.sizeBytes})` })
      .from(jobs)
      .where(and(gte(finished, since), sql`${jobs.result} is not null`))
      .groupBy(day, jobs.result)
      .all();
    const out = new Map<string, DailyRow>();
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.set(key, { day: key, listed: 0, already_listed: 0, refused: 0, error: 0, aborted: 0, listedBytes: 0 });
    }
    for (const r of rows) {
      const row = out.get(r.day);
      if (!row || !r.result) continue;
      row[r.result as JobResult] = r.n;
      if (r.result === "listed") row.listedBytes = r.bytes ?? 0;
    }
    return c.json([...out.values()]);
  });

  // live updates

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: LiveEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const unsubscribe = hub.subscribe((e) => {
        queue.push(e);
        if (queue.length > 2000) queue.splice(0, queue.length - 2000);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!closed) {
        while (queue.length && !closed) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        }
        const timedOut = await Promise.race([new Promise<false>((r) => (wake = () => r(false))), Bun.sleep(20_000).then(() => true)]);
        wake = null;
        if (timedOut && !closed) await stream.writeSSE({ event: "ping", data: "" });
      }
    }),
  );

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---------- web app ----------

  if (env.WEB_DIR) {
    app.use("/*", serveStatic({ root: env.WEB_DIR }));
    app.get("*", serveStatic({ path: join(env.WEB_DIR, "index.html") }));
  }

  return app;
}
