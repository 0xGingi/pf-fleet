import { beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "@pf-fleet/protocol";
import type { AccountView, CreatedNode, NodeView, Summary } from "@pf-fleet/protocol/api";
import { createApp } from "./app";
import { Auth } from "./auth";
import { Sealer, sha256Bytes } from "./crypto";
import { openDb } from "./db";
import { Alerter } from "./alerts";
import { Hub } from "./hub";
import { checkPirateface } from "./pypi";

const KEY = "pfct_0123456789abcdef0123456789abcdef";

function setup() {
  const db = openDb(":memory:");
  const sealer = new Sealer("x".repeat(32));
  let now = 1_800_000_000_000;
  const bin = new TextEncoder().encode("#!/bin/sh\necho 'pf-fleet-agent 0.2.0'\n");
  const bundle = { version: "0.2.0", binaries: { x86_64: { arch: "x86_64" as const, path: "/dev/null", bytes: bin, sha256: sha256Bytes(bin) } } };
  const hub = new Hub(db, sealer, bundle, () => now);
  const auth = new Auth(db, { user: "admin", password: "hunter2", secureCookie: false, sessionDays: 1 });
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://pypi.org/")) return Response.json({ info: { version: "0.2.18" } });
    posted.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  };
  const alerter = new Alerter(db, hub, fakeFetch, () => now);
  const app = createApp({
    db,
    hub,
    auth,
    sealer,
    env: { PUBLIC_URL: "https://fleet.test", WEB_DIR: "", TRUST_PROXY: false },
    dashboardVersion: "0.2.0",
    alerter,
    checkPirateface: () => checkPirateface(hub, fakeFetch, () => now),
  });
  return { app, hub, db, sealer, alerter, posted, tick: (ms: number) => (now += ms) };
}

describe("dashboard API", () => {
  const { app, hub, db, sealer, alerter, posted, tick } = setup();
  let cookie = "";
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { cookie, "x-pf-fleet": "1", "content-type": "application/json", ...init.headers } });
  const json = (method: string, path: string, body?: unknown) => call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  test("requires a session", async () => {
    expect((await app.request("/api/nodes")).status).toBe(401);
  });

  test("rejects a wrong password, accepts the right one", async () => {
    expect((await json("POST", "/api/auth/login", { username: "admin", password: "nope" })).status).toBe(401);
    const res = await json("POST", "/api/auth/login", { username: "admin", password: "hunter2" });
    expect(res.status).toBe(200);
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("/api/nodes")).status).toBe(200);
  });

  test("state changes need the CSRF header", async () => {
    const res = await app.request("/api/accounts", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  let account: AccountView;
  let node: CreatedNode;

  test("creates an account (key stored encrypted, only a hint comes back)", async () => {
    expect((await json("POST", "/api/accounts", { name: "main", key: "not-a-key" })).status).toBe(400);
    const res = await json("POST", "/api/accounts", { name: "main", key: KEY });
    expect(res.status).toBe(201);
    account = await res.json();
    expect(account).toMatchObject({ name: "main", hasKey: true, keyHint: "pfct_…cdef" });
    expect(JSON.stringify(account)).not.toContain(KEY);
  });

  test("creates a node with a one-time install command", async () => {
    const res = await json("POST", "/api/nodes", { name: "hermes", accountId: account.id });
    expect(res.status).toBe(201);
    node = await res.json();
    expect(node.installCommand).toStartWith("curl -fsSL https://fleet.test/install.sh | sh -s -- --server https://fleet.test --token ");
    expect(node.installCommand).toContain(`${node.node.id}.`);
  });

  test("enforces Pirate Face's 3 lanes per account", async () => {
    const lanes = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `h-${i + 1}`, enabled: true, drain: false }));
    const bad = await json("PATCH", `/api/nodes/${node.node.id}`, { lanes: lanes(4) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("allows 3");
    const ok = await json("PATCH", `/api/nodes/${node.node.id}`, { lanes: lanes(2), maxSizeGiB: 100 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as NodeView).lanes).toHaveLength(2);
  });

  test("rejects an agent with a bad token", async () => {
    expect((await app.request("/agent/ws")).status).toBe(401);
    expect((await app.request("/agent/ws", { headers: { authorization: `Bearer ${node.node.id}.wrong` } })).status).toBe(401);
  });

  test("an agent gets its config and reports jobs", async () => {
    const sent: (string | Uint8Array)[] = [];
    const ws = { send: (d: string | Uint8Array) => sent.push(d), close: () => {} };
    const id = node.node.id;
    hub.attach(id, ws);
    await hub.handle(id, { type: "hello", agentVersion: "0.1.0", hostname: "hermes", os: "Linux", kernel: "6", arch: "x86_64", cpus: 4, activeJobs: [], sha256: null });
    const cfg = JSON.parse(sent[0] as string) as Config;
    expect(cfg).toMatchObject({ type: "config", maxSizeGiB: 100, idleSec: 300, pirateKey: KEY });
    expect(cfg.lanes.map((l) => l.name)).toEqual(["h-1", "h-2"]);

    // the agent (0.1.0) is older than the one this dashboard ships (0.2.0): it gets the update
    const upd = JSON.parse(sent[1] as string);
    expect(upd).toMatchObject({ type: "update", version: "0.2.0", graceful: true, size: (sent[2] as Uint8Array).length });
    expect(upd.sha256).toBe(sha256Bytes(sent[2] as Uint8Array));
    // and not again on a quick reconnect (a failing install must not loop)
    expect(hub.offerUpdate(id, { graceful: true })).toBe("cooldown");

    const sys = { load1: 0, load5: 0, load15: 0, memTotal: 1, memAvailable: 1, uptime: 1, netRx: 0, netTx: 0 };
    await hub.handle(id, { type: "heartbeat", ts: 1, system: sys, uvx: "/bin/uvx", processedBytes: 0, lanes: [], updatePending: null });
    tick(5000);
    await hub.handle(id, { type: "heartbeat", ts: 2, system: sys, uvx: "/bin/uvx", processedBytes: 30e9, lanes: [], updatePending: null });

    await hub.handle(id, { type: "job_started", lane: "h-1", jobId: "j1", repo: "a/b", revision: "abc", files: 3, sizeBytes: 30e9, startedAt: 1 });
    await hub.handle(id, { type: "job_finished", lane: "h-1", jobId: "j1", result: "listed", url: "https://pirateface.co/a/b", infohash: "ff", message: null, finishedAt: Date.now() });

    const { rows, total } = await (await call("/api/jobs")).json();
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ repo: "a/b", result: "listed", nodeName: "hermes", infohash: "ff" });

    const s: Summary = await (await call("/api/stats/summary")).json();
    expect(s).toMatchObject({ nodesOnline: 1, nodesTotal: 1, lanesEnabled: 2, pointsEstimate: 3 });
    expect(s.allTime).toMatchObject({ listed: 1, listedBytes: 30e9 });

    const views: NodeView[] = await (await call("/api/nodes")).json();
    expect(views[0]).toMatchObject({ hostname: "hermes", agentVersion: "0.1.0", outdated: true });
    expect(views[0]!.live.connected).toBe(true);
  });

  test("a reconnect without a running job marks it aborted", async () => {
    const id = node.node.id;
    await hub.handle(id, { type: "job_started", lane: "h-2", jobId: "j2", repo: "c/d", revision: "", files: 1, sizeBytes: 1, startedAt: 2 });
    await hub.handle(id, { type: "hello", agentVersion: "0.1.0", hostname: "hermes", os: "Linux", kernel: "6", arch: "x86_64", cpus: 4, activeJobs: [], sha256: null });
    const { rows } = await (await call("/api/jobs?result=aborted")).json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["j2"]);
  });

  test("an account in use cannot be deleted", async () => {
    expect((await json("DELETE", `/api/accounts/${account.id}`)).status).toBe(409);
  });

  test("rotating the token gives a new install command", async () => {
    const res: CreatedNode = await (await json("POST", `/api/nodes/${node.node.id}/token`)).json();
    expect(res.installCommand).not.toBe(node.installCommand);
    expect(hub.isOnline(node.node.id)).toBe(false);
  });

  test("agent events and worker logs are stored, and logs survive a dashboard restart", async () => {
    const id = node.node.id;
    const ws = { send: () => {}, close: () => {} };
    hub.attach(id, ws);
    await hub.handle(id, { type: "event", ts: 5, level: "warn", text: "lost the dashboard connection (x); back after 2s" });
    await hub.handle(id, { type: "log", lane: "h-1", lines: [{ ts: 6, stream: "out", text: "    leased    a/b" }] });
    const evs = await (await call(`/api/nodes/${id}/events`)).json();
    expect(evs[0]).toMatchObject({ level: "warn", source: "agent", nodeName: "hermes" });
    const restarted = new Hub(db, sealer);
    expect(restarted.logTail(id, "h-1").map((l) => l.text)).toEqual(["    leased    a/b"]);
  });

  test("a new pirateface on PyPI is pinned and pushed to agents", async () => {
    const id = node.node.id;
    const sent: string[] = [];
    hub.attach(id, { send: (d: string | Uint8Array) => sent.push(String(d)), close: () => {} });
    const s = await (await json("POST", "/api/settings/check-pirateface")).json();
    expect(s).toMatchObject({ pirateVersion: "0.2.18", followPirateface: true });
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: "config", pirateVersion: "0.2.18" });
    // turning it off goes back to @latest
    await json("PATCH", "/api/settings", { followPirateface: false });
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: "config", pirateVersion: null });
    await json("PATCH", "/api/settings", { followPirateface: true });
  });

  test("alerts: webhook settings, refused jobs, offline nodes", async () => {
    expect((await json("PATCH", "/api/settings", { alertWebhookUrl: "not a url" })).status).toBe(400);
    const s = await (await json("PATCH", "/api/settings", { alertWebhookUrl: "https://discord.test/api/webhooks/1/secret" })).json();
    expect(s).toMatchObject({ alertWebhookSet: true, alertWebhookHint: "https://discord.test/…" });
    expect(JSON.stringify(s)).not.toContain("secret");

    expect((await json("POST", "/api/settings/test-alert")).status).toBe(200);
    expect(posted.at(-1)!.body).toMatchObject({ kind: "test" });

    const id = node.node.id;
    hub.attach(id, { send: () => {}, close: () => {} });
    await hub.handle(id, { type: "job_finished", lane: "h-1", jobId: "j9", result: "refused", url: null, infohash: null, message: "hashes differ", finishedAt: 9 });
    await Bun.sleep(0);
    expect(posted.at(-1)!.body).toMatchObject({ kind: "job_failed", node: "hermes" });
    expect(String(posted.at(-1)!.body.content)).toContain("hashes differ");

    // offline: nothing during the startup grace period, then one alert, then "back online"
    hub.kick(id, "test");
    hub.offline().set(id, Date.now());
    const before = posted.length;
    await alerter.tick();
    expect(posted.length).toBe(before);
    tick(5 * 60_000);
    hub.offline().set(id, Date.now() - 3 * 60_000);
    await alerter.tick();
    await alerter.tick();
    expect(posted.filter((p) => p.body.kind === "node_offline")).toHaveLength(1);
    hub.attach(id, { send: () => {}, close: () => {} });
    await alerter.tick();
    expect(posted.at(-1)!.body.kind).toBe("node_online");
  });

  test("history retention is a setting", async () => {
    expect((await json("PATCH", "/api/settings", { retentionDays: 3 })).status).toBe(400);
    expect((await (await json("PATCH", "/api/settings", { retentionDays: 30 })).json()).retentionDays).toBe(30);
  });

  test("a different build with the same version number gets the real one", async () => {
    const id = node.node.id;
    const sent: (string | Uint8Array)[] = [];
    hub.kick(id, "test");
    hub.attach(id, { send: (d: string | Uint8Array) => sent.push(d), close: () => {} });
    tick(60 * 60_000); // past the update cooldown
    const hello = { type: "hello" as const, agentVersion: "0.2.0", hostname: "hermes", os: "Linux", kernel: "6", arch: "x86_64", cpus: 4, activeJobs: [] };
    await hub.handle(id, { ...hello, sha256: "0".repeat(64) });
    expect(sent.some((d) => typeof d === "string" && d.includes('"type":"update"'))).toBe(true);
    const views: NodeView[] = await (await call("/api/nodes")).json();
    expect(views.find((n) => n.id === id)?.outdated).toBe(true);
  });
});
