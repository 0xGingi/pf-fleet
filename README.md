# pf-fleet

Run [Pirate Face](https://pirateface.co) `pf work` lanes on many machines and manage
them from one web dashboard.

- **Agent** (Rust, one static ~2 MB binary per CPU type) runs on each machine as a
  systemd service. It starts `uvx --from pirateface@latest pf work --name <lane>`
  for every enabled lane, restarts crashed workers with backoff, reads their output,
  and reports status, jobs, logs and host stats to the dashboard.
- **Dashboard** (Bun + Hono + SQLite, React UI) runs in Docker. You add nodes,
  pick lanes, set each Pirate Face account's key, restart workers, and watch
  throughput, jobs and live worker output.

```
 machine A                    machine B                      your server
┌───────────────────┐        ┌───────────────────┐         ┌──────────────────────┐
│ pf-fleet-agent    │        │ pf-fleet-agent    │  wss    │ dashboard (docker)   │
│  ├ pf work lane-1 │───────▶│  ├ pf work lane-1 │────────▶│  Hono API + SSE      │
│  └ pf work lane-2 │  wss   │  …                │         │  SQLite (/data)      │
└───────────────────┘        └───────────────────┘         │  React UI            │
         └─────────────────────────────────────────────────▶└──────────────────────┘
```

Agents connect **out** to the dashboard, so nodes behind NAT work and the dashboard
never needs SSH access. If the dashboard is down, agents keep running their last
config and send what they missed when it comes back.

## Run the dashboard

```sh
curl -fsSLO https://raw.githubusercontent.com/0xGingi/pf-fleet/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/0xGingi/pf-fleet/main/.env.example -o .env
# set PUBLIC_URL (an address your machines can reach), ADMIN_PASSWORD and
# APP_SECRET (openssl rand -hex 32)
docker compose up -d
```

This runs the released image `ghcr.io/0xgingi/pf-fleet` (amd64 and arm64). From a
clone, `docker compose up -d --build` builds it locally instead; local builds are
versioned `<next>-dev`, so the next release replaces their agents automatically.

Open `http://<host>:1337` and sign in. Put it behind your reverse proxy with TLS
(and set `TRUST_PROXY=1`), or keep it on a private network such as Tailscale. The
dashboard can start and stop workers on every node, so do not expose it without TLS.

## Add a machine

1. **Accounts → Add account.** Paste the community torrent key from
   pirateface.co/settings (`pfct_…`). It is stored encrypted with `APP_SECRET` and
   only sent to that account's agents.
2. **Nodes → Add node.** Copy the install command it shows (the token in it is
   shown once) and run it on the machine as the user that should run the workers:

   ```sh
   curl -fsSL https://fleet.example.com/install.sh | sh -s -- --server https://fleet.example.com --token <nodeId>.<secret>
   ```

   It installs uv if missing, the agent in `~/.local/bin` (or `/usr/local/bin`
   as root), and a systemd service: a user service with lingering for normal
   users, a system service for root. Without systemd it prints a `nohup` line.
3. On the node's page, **add lanes**. Each lane is one `pf work --name <lane>`.

### Pirate Face rules the dashboard enforces

- One account runs at most **3 lanes at once**, across all machines.
- Lane names must be **unique per account** (the queue leases jobs per lane name).
- Lane names are 1–24 letters, digits, `.`, `_`, `-` (pf's rule).

## Day to day

| You want to | Do |
|---|---|
| Stop a lane | Switch it off. If it is mid-model you choose **stop after this job** or **stop now** (the lease lapses and the model goes back to the queue). |
| Pick up a new pirateface release | **Restart all** on the node. Workers restart after their current job; `pirateface@latest` resolves the newest version. |
| Limit model size on a slow box | Node settings → *Largest model (GiB)* (`pf work --max-size`). |
| Change an account's key | Accounts → edit. Every node on that account restarts its lanes after their current jobs. |
| Upgrade everything | `docker compose pull && docker compose up -d`. The new dashboard carries the matching agent and pushes it to your nodes (see below). |
| Move a node to another machine | **New install command**, run it on the new machine. The old agent is disconnected. |

## pirateface releases

The dashboard checks PyPI every 30 minutes and pins every lane to the newest
`pirateface` (`--from pirateface==<version>`). When a release comes out, each lane
restarts into it after its current job, so no worker keeps running an old pf until
it crashes. **Settings → pirateface** shows the version and a *Check now* button;
turning *Follow new releases* off goes back to `pirateface@latest` at each start.

## Alerts and events

**Settings → Alerts** takes a webhook URL (Discord, Slack, or anything that accepts
a JSON POST; the body has `content`, `text`, `kind`, `node`, `lane`, `message`).
It fires when:

- a node has been offline for 2 minutes (and again when it is back),
- a lane has kept crashing or erroring for 10 minutes (and when it recovers;
  waiting out a lease does not count),
- Pirate Face refuses a submission or a job ends in an error,
- an agent reports an error (uv missing, no key, a failed self-update).

Every node also has an **event log** (node page, and *Recent events* on the
overview): agent starts, connection drops and how long they lasted, updates,
worker crashes and lease waits. Worker output and events are stored in SQLite, so
they survive dashboard restarts. **Settings → History** sets how long jobs, events
and throughput are kept (180 days by default); worker output keeps the last 1000
lines per lane.

## Updates

Each dashboard image ships the agent built from the same commit. When a node
connects with an older agent, the dashboard sends it the new binary over the
agent's WebSocket. The agent checks its size and SHA-256, runs it once to make
sure it starts, swaps it over its own file, lets every lane **finish its current
job**, and re-execs into it (same PID, so systemd and `nohup` setups both carry on).
Nothing is downloaded from anywhere else and no work is lost.

- **Settings → Update agents automatically** turns this off (it is on by default).
  The node page then offers an **Update agent** button instead.
- A node is offered an update at most every 30 minutes, so a failed install
  (for example, a read-only binary directory) does not loop.
- Running the install command again on a node that already runs the agent does not
  kill it: the new binary is put in place and the agent gets `SIGHUP`, which
  restarts it into the new binary after its lanes finish their current jobs.
- To keep the dashboard itself current, run `docker compose pull && docker compose up -d`
  from cron or a systemd timer, or pin `PF_FLEET_TAG` to a minor line such as `0.2`.

## Releases

`ghcr.io/0xgingi/pf-fleet` tags:

| Tag | What |
|---|---|
| `latest`, `0.2`, `0.2.1` | Releases (`v*` git tags). |
| `edge` | Every push to `main` (version `<next>-edge.<run>`, so edge agents update in order). |

Every release also attaches the static agents (`pf-fleet-agent-x86_64`,
`pf-fleet-agent-aarch64`) and `SHA256SUMS` to its GitHub release.

To cut a release: set `version` in `agent/Cargo.toml` (the single version for the
agent and the dashboard), commit, then `git tag v0.2.0 && git push origin v0.2.0`.
The release workflow refuses a tag that does not match `Cargo.toml`, runs the full
CI, and publishes the binaries and the multi-arch image.

## Stats

- **Throughput**: bytes verified per second per node (from each agent's counter),
  kept per minute in SQLite.
- **Jobs**: every leased model with its outcome: `listed`, `already listed`,
  `refused` (Pirate Face said no, with the reason), `error`, or `aborted` (the
  worker stopped or the agent restarted mid-job).
- **Points (estimate)**: Pirate Face gives queue work 1 point per 10 GB verified.
  The dashboard estimates this from listed jobs; the site's number is the real one.

Worker output is kept in dashboard memory (last 1000 lines per lane) and in the
node's journal (`journalctl --user -u pf-fleet-agent -f`).

## Layout

```
agent/                 Rust agent (tokio current-thread, rustls/ring, static musl)
apps/server/           Bun + Hono API, WebSocket hub, SQLite via Drizzle
apps/web/              React + Vite + Tailwind + TanStack Query + Recharts
packages/protocol/     zod schemas for agent⇄dashboard and the REST/SSE shapes
protocol/fixtures/     sample messages both the TS and Rust tests must round-trip
docs/protocol.md       the wire protocol
```

## Development

```sh
bun install
cp .env.example apps/server/.env   # PUBLIC_URL=http://localhost:1337, a password, an APP_SECRET
bun run dev                        # API on :1337, UI on :5173 (proxied)
bun test packages apps/server      # protocol fixtures, lane rules, API flow
bun run typecheck
```

Agent (no local Rust needed):

```sh
docker run --rm -v "$PWD":/src -w /src/agent rust:1.98-alpine3.22 \
  sh -c 'apk add gcc musl-dev && cargo test'
```

For a local agent build to install from a dev dashboard, put binaries named
`pf-fleet-agent-x86_64` / `pf-fleet-agent-aarch64` and a `VERSION` file in
`apps/server/agent-dist/` (the Docker image does this for you).

Schema changes: edit `apps/server/src/db/schema.ts`, then
`cd apps/server && bunx drizzle-kit generate`. Migrations run at startup.

## Notes and limits

- Agents are Linux only (x86_64, aarch64). Workers need uv; the installer adds it.
- The agent caps uv/pf thread pools (`RAYON_NUM_THREADS=2` and friends) because
  shared hosts such as seedboxes often limit threads per user.
- Stopping a worker mid-job loses that job's progress: pf streams models through
  memory and cannot resume. Pirate Face also keeps the lease for up to 10 minutes,
  and the lane waits for it to lapse before taking new work. Prefer *stop after
  this job*.
- One admin login. Sessions last `SESSION_DAYS` (default 30).
